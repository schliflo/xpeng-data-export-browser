/**
 * Doors and tyres.
 *
 * The door signals are the most revealing part of the export: a second-by-second
 * record of every time someone got in or out, for a month. Aggregated by hour
 * and weekday they redraw the household's routine, which is worth showing
 * plainly rather than burying.
 *
 * Tyre pressures move with temperature, so their daily medians tell a slow
 * story about the weather and about how well the tyres hold air.
 */

import { valueAt, type Dataset } from '../store/columnar';
import { dayBoundaries, localParts } from './daily';

export const DOOR_COLUMNS = [
	'ldcu_driverdoorajarst',
	'rdcu_psngrdoorajarst',
	'ldcu_rldoorajarst',
	'rdcu_rrdoorajarst'
] as const;

export type DoorKey = (typeof DOOR_COLUMNS)[number];

export interface DoorEvent {
	door: DoorKey;
	time: number;
	index: number;
	/** Seconds the door stayed open, when a close was recorded. */
	openSeconds: number;
}

export interface DoorActivity {
	events: DoorEvent[];
	/** Openings by weekday (0 = Sunday) and local hour. */
	grid: number[][];
	perDoor: Record<string, number>;
	busiestHour: number;
	busiestHourCount: number;
	quietestHours: number[];
	/** The longest run of hours in which no door was ever opened. */
	quietStretch: QuietStretch | null;
	longestOpen: DoorEvent | null;
}

export function doorActivity(dataset: Dataset, timeZone: string): DoorActivity {
	const events: DoorEvent[] = [];
	const perDoor: Record<string, number> = {};

	for (const key of DOOR_COLUMNS) {
		const column = dataset.columns.get(key);
		if (!column || column.nonNull === 0) continue;
		perDoor[key] = 0;

		let previous = 0;
		let openedAt = -1;
		for (let i = 0; i < dataset.time.length; i++) {
			const value = valueAt(column, i);
			if (Number.isNaN(value)) continue;
			// A rising edge is someone opening the door.
			if (value === 1 && previous === 0) {
				openedAt = i;
			} else if (value === 0 && previous === 1 && openedAt !== -1) {
				events.push({
					door: key,
					time: dataset.time[openedAt],
					index: openedAt,
					openSeconds: dataset.time[i] - dataset.time[openedAt]
				});
				perDoor[key]++;
				openedAt = -1;
			}
			previous = value;
		}
		if (openedAt !== -1) {
			events.push({ door: key, time: dataset.time[openedAt], index: openedAt, openSeconds: NaN });
			perDoor[key]++;
		}
	}

	events.sort((a, b) => a.time - b.time);

	const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
	const hourTotals = new Array(24).fill(0);
	for (const event of events) {
		const { hour, weekday } = localParts(event.time, timeZone);
		grid[weekday][hour]++;
		hourTotals[hour]++;
	}

	let busiestHour = 0;
	for (let h = 1; h < 24; h++) if (hourTotals[h] > hourTotals[busiestHour]) busiestHour = h;

	const longestOpen = events.reduce<DoorEvent | null>((best, event) => {
		if (!Number.isFinite(event.openSeconds)) return best;
		return !best || event.openSeconds > best.openSeconds ? event : best;
	}, null);

	return {
		events,
		grid,
		perDoor,
		busiestHour,
		busiestHourCount: hourTotals[busiestHour],
		quietestHours: hourTotals
			.map((count, hour) => ({ count, hour }))
			.filter((entry) => entry.count === 0)
			.map((entry) => entry.hour),
		quietStretch: longestQuietStretch(hourTotals),
		longestOpen
	};
}

export interface QuietStretch {
	/** First hour of the run, and the hour it ends before. */
	from: number;
	to: number;
	hours: number;
}

/**
 * The longest unbroken run of hours with no door activity. Hours wrap around
 * midnight, so the search runs over two concatenated days — otherwise a quiet
 * night that starts at 23:00 would be reported as two separate stretches.
 */
export function longestQuietStretch(hourTotals: number[]): QuietStretch | null {
	let best: QuietStretch | null = null;
	let runStart = -1;

	for (let i = 0; i < 48; i++) {
		const quiet = hourTotals[i % 24] === 0;
		if (quiet) {
			if (runStart === -1) runStart = i;
			const length = i - runStart + 1;
			// A run longer than a day means there was no activity at all.
			if (length <= 24 && (!best || length > best.hours)) {
				best = { from: runStart % 24, to: (i + 1) % 24, hours: length };
			}
		} else {
			runStart = -1;
		}
	}
	return best;
}

export const TYRE_COLUMNS = [
	'ldcu_tpmsprfl',
	'ldcu_tpmsprfr',
	'ldcu_tpmsprrl',
	'ldcu_tpmsprrr'
] as const;

export interface TyreDay {
	date: string;
	/** Median pressure per wheel in kPa, NaN where nothing was reported. */
	pressures: number[];
	ambientProxy: number;
}

export interface TyreTrend {
	days: TyreDay[];
	labels: string[];
	/** Change in kPa from the first day with a reading to the last. */
	drift: number[];
	minPressure: number;
	maxPressure: number;
	/** Correlation between pressure and pack temperature, -1 to 1. */
	temperatureCorrelation: number;
}

function median(values: number[]): number {
	if (!values.length) return NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

export function tyreTrend(dataset: Dataset, timeZone: string): TyreTrend {
	const columns = TYRE_COLUMNS.map((key) => dataset.columns.get(key));
	const packTemp = dataset.columns.get('bms_batttempmin_gb');
	const boundaries = dayBoundaries(dataset, timeZone);
	const days: TyreDay[] = [];

	let cursor = 0;
	for (let d = 0; d < boundaries.length; d++) {
		const start = boundaries[d].start;
		const end = d + 1 < boundaries.length ? boundaries[d + 1].start : Infinity;
		const samples: number[][] = columns.map(() => []);
		const temps: number[] = [];

		while (cursor < dataset.time.length && dataset.time[cursor] < start) cursor++;
		// Sample every five minutes; pressures move far slower than 1 Hz.
		let next = start;
		for (let i = cursor; i < dataset.time.length && dataset.time[i] < end; i++) {
			if (dataset.time[i] < next) continue;
			next = dataset.time[i] + 300;
			for (let c = 0; c < columns.length; c++) {
				const column = columns[c];
				if (!column) continue;
				const value = valueAt(column, i);
				if (!Number.isNaN(value)) samples[c].push(value);
			}
			if (packTemp) {
				const temp = valueAt(packTemp, i);
				if (!Number.isNaN(temp)) temps.push(temp);
			}
		}

		days.push({
			date: boundaries[d].date,
			pressures: samples.map(median),
			ambientProxy: median(temps)
		});
	}

	const withReadings = days.filter((day) => day.pressures.some((p) => !Number.isNaN(p)));
	const first = withReadings[0];
	const last = withReadings[withReadings.length - 1];
	const drift = TYRE_COLUMNS.map((_, i) =>
		first && last ? last.pressures[i] - first.pressures[i] : NaN
	);

	const all = days.flatMap((day) => day.pressures).filter((p) => !Number.isNaN(p));

	// Correlate the average pressure against the coldest cell, which tracks
	// ambient temperature closely enough to explain most of the movement.
	const pairs = days
		.map((day) => ({
			pressure: median(day.pressures.filter((p) => !Number.isNaN(p))),
			temp: day.ambientProxy
		}))
		.filter((p) => !Number.isNaN(p.pressure) && !Number.isNaN(p.temp));

	return {
		days,
		labels: ['Front left', 'Front right', 'Rear left', 'Rear right'],
		drift,
		minPressure: all.length ? Math.min(...all) : NaN,
		maxPressure: all.length ? Math.max(...all) : NaN,
		temperatureCorrelation: correlation(
			pairs.map((p) => p.temp),
			pairs.map((p) => p.pressure)
		)
	};
}

export function correlation(xs: number[], ys: number[]): number {
	const n = Math.min(xs.length, ys.length);
	if (n < 3) return NaN;
	let sumX = 0;
	let sumY = 0;
	for (let i = 0; i < n; i++) {
		sumX += xs[i];
		sumY += ys[i];
	}
	const meanX = sumX / n;
	const meanY = sumY / n;
	let num = 0;
	let dx = 0;
	let dy = 0;
	for (let i = 0; i < n; i++) {
		const a = xs[i] - meanX;
		const b = ys[i] - meanY;
		num += a * b;
		dx += a * a;
		dy += b * b;
	}
	const denom = Math.sqrt(dx * dy);
	return denom === 0 ? NaN : num / denom;
}
