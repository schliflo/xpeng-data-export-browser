/**
 * Per-day and per-hour aggregation.
 *
 * Days are always derived from `timer` in the viewer's own timezone. The `ds`
 * column in the export looks like a date but is a warehouse partition key cut
 * at midnight in UTC+8, which for a European driver splits the day at six in
 * the evening — using it would put an evening drive on the following day.
 *
 * Resolving a timezone per sample would mean a million `Intl` calls, so day
 * boundaries are computed once and the samples swept between them.
 */

import { valueAt, type Dataset } from '../store/columnar';
import type { Trip } from './trips';
import type { ChargeSession } from './charging';

export interface DayBucket {
	/** Local calendar day as `YYYY-MM-DD`. */
	date: string;
	startTime: number;
	endTime: number;
	distanceKm: number;
	drivingSeconds: number;
	trips: number;
	chargedKwh: number;
	energyKwh: number;
	maxSpeed: number;
	socMin: number;
	socMax: number;
}

const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>();

function dayKeyFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = dayKeyFormatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-CA', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			timeZone
		});
		dayKeyFormatters.set(timeZone, formatter);
	}
	return formatter;
}

/** Local calendar day of an instant, as `YYYY-MM-DD`. */
export function localDayKey(epochSeconds: number, timeZone: string): string {
	return dayKeyFormatter(timeZone).format(new Date(epochSeconds * 1000));
}

export interface LocalParts {
	hour: number;
	weekday: number;
	dayKey: string;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

export function localParts(epochSeconds: number, timeZone: string): LocalParts {
	let formatter = partFormatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-GB', {
			hour: 'numeric',
			hour12: false,
			weekday: 'short',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			timeZone
		});
		partFormatters.set(timeZone, formatter);
	}
	const parts = formatter.formatToParts(new Date(epochSeconds * 1000));
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	return {
		hour: Number(get('hour')) % 24,
		weekday: Math.max(0, weekdayNames.indexOf(get('weekday'))),
		dayKey: `${get('year')}-${get('month')}-${get('day')}`
	};
}

/** Every local day between the first and last sample, including empty ones. */
export function enumerateDays(dataset: Dataset, timeZone: string): string[] {
	if (dataset.time.length === 0) return [];
	const days: string[] = [];
	const first = dataset.time[0];
	const last = dataset.time[dataset.time.length - 1];
	const seen = new Set<string>();
	// Step in half-days so a daylight-saving shift cannot skip a date.
	for (let t = first; t <= last + 43200; t += 43200) {
		const key = localDayKey(t, timeZone);
		if (!seen.has(key)) {
			seen.add(key);
			days.push(key);
		}
	}
	return days;
}

export interface DayBoundary {
	date: string;
	/** Epoch second at which this local day begins. */
	start: number;
}

/**
 * Start instant of every local day the dataset spans. Resolving the boundaries
 * up front lets per-sample loops advance a cursor instead of formatting dates,
 * and it stays correct across daylight-saving changes because each day's start
 * is found by binary search rather than by adding 86,400 seconds.
 */
export function dayBoundaries(dataset: Dataset, timeZone: string): DayBoundary[] {
	const days = enumerateDays(dataset, timeZone);
	return days.map((date) => ({ date, start: startOfLocalDay(date, timeZone) }));
}

/** Epoch second at which the given local calendar date begins. */
export function startOfLocalDay(date: string, timeZone: string): number {
	const [year, month, day] = date.split('-').map(Number);
	// Start from the UTC instant of that wall-clock date, then correct by the
	// zone's offset there; one refinement settles zones up to ±14 hours.
	let guess = Date.UTC(year, month - 1, day) / 1000;
	for (let i = 0; i < 2; i++) {
		guess -= zoneOffsetSeconds(guess, timeZone);
		if (localDayKey(guess, timeZone) === date) break;
	}
	// Walk to the exact first second of the day in case of a DST transition.
	while (localDayKey(guess - 1, timeZone) === date) guess -= 1;
	while (localDayKey(guess, timeZone) !== date) guess += 1;
	return guess;
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Seconds the zone is ahead of UTC at the given instant. */
function zoneOffsetSeconds(epochSeconds: number, timeZone: string): number {
	let formatter = offsetFormatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-GB', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false,
			timeZone
		});
		offsetFormatters.set(timeZone, formatter);
	}
	const parts = formatter.formatToParts(new Date(epochSeconds * 1000));
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
	const asUtc =
		Date.UTC(
			get('year'),
			get('month') - 1,
			get('day'),
			get('hour') % 24,
			get('minute'),
			get('second')
		) / 1000;
	return asUtc - epochSeconds;
}

export function bucketDays(
	dataset: Dataset,
	trips: Trip[],
	sessions: ChargeSession[],
	timeZone: string
): DayBucket[] {
	const buckets = new Map<string, DayBucket>();
	const ensure = (key: string): DayBucket => {
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = {
				date: key,
				startTime: 0,
				endTime: 0,
				distanceKm: 0,
				drivingSeconds: 0,
				trips: 0,
				chargedKwh: 0,
				energyKwh: 0,
				maxSpeed: 0,
				socMin: Infinity,
				socMax: -Infinity
			};
			buckets.set(key, bucket);
		}
		return bucket;
	};

	for (const day of enumerateDays(dataset, timeZone)) ensure(day);

	for (const trip of trips) {
		const bucket = ensure(localDayKey(trip.startTime, timeZone));
		if (Number.isFinite(trip.distanceKm)) bucket.distanceKm += trip.distanceKm;
		bucket.drivingSeconds += trip.movingSeconds;
		bucket.trips += 1;
		if (trip.maxSpeed > bucket.maxSpeed) bucket.maxSpeed = trip.maxSpeed;
		if (Number.isFinite(trip.energyKwh)) bucket.energyKwh += trip.energyKwh - trip.regenKwh;
	}

	for (const session of sessions) {
		const bucket = ensure(localDayKey(session.startTime, timeZone));
		if (Number.isFinite(session.kwhDelivered)) bucket.chargedKwh += session.kwhDelivered;
	}

	// State-of-charge envelope needs a sweep over the raw samples. Day
	// boundaries are resolved once so the loop itself never touches Intl.
	const soc = dataset.columns.get('ldcu_bms_soc_disp');
	if (soc && dataset.time.length) {
		const days = dayBoundaries(dataset, timeZone);
		let d = 0;
		let bucket = days.length ? ensure(days[0].date) : null;
		for (let i = 0; i < dataset.time.length; i++) {
			const t = dataset.time[i];
			while (d + 1 < days.length && t >= days[d + 1].start) {
				d++;
				bucket = ensure(days[d].date);
			}
			const value = valueAt(soc, i);
			if (Number.isNaN(value) || !bucket) continue;
			if (value < bucket.socMin) bucket.socMin = value;
			if (value > bucket.socMax) bucket.socMax = value;
		}
	}

	const result = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
	for (const bucket of result) {
		if (bucket.socMin === Infinity) bucket.socMin = NaN;
		if (bucket.socMax === -Infinity) bucket.socMax = NaN;
	}
	return result;
}

/** Driving seconds by local weekday and hour, for the activity punchcard. */
export function punchcard(trips: Trip[], dataset: Dataset, timeZone: string): number[][] {
	const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
	for (const trip of trips) {
		// Walk the trip hour by hour so a long drive spreads across its cells.
		for (let t = trip.startTime; t <= trip.endTime; t += 300) {
			const { hour, weekday } = localParts(t, timeZone);
			grid[weekday][hour] += Math.min(300, trip.endTime - t + 1);
		}
	}
	void dataset;
	return grid;
}
