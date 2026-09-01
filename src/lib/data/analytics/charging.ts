/**
 * Charging session detection.
 *
 * `ldcu_chrgpwr` reports the power flowing in from the plug and is zero at all
 * other times — regeneration never appears there, so it separates charging
 * from braking cleanly without having to reason about the sign of pack current.
 *
 * Two habits worth reading out of the sessions: a charge limit shows up as an
 * end-of-charge state of charge that repeats across many sessions, and a
 * scheduled charge shows up as sessions that keep starting at the same minute.
 */

import { valueAt, type Dataset } from '../store/columnar';
import { integrateEnergy, integrateSignal } from './energy';

/** Power above which the plug counts as delivering, in kW. */
const ACTIVE_KW = 0.05;
/**
 * Longest break that can still be the same plug-in. The car sleeps for up to
 * a couple of hours at a time while charging and stops logging entirely, which
 * would otherwise chop one overnight charge into several — and those fragments
 * then masquerade as deliberate stopping points.
 */
const MERGE_GAP_SECONDS = 4 * 3600;
/** Below these, a session is a top-up blip rather than a charge. */
const MIN_SESSION_SECONDS = 300;
const MIN_SESSION_SOC_GAIN = 1;
/** Above this power the car must be on a DC charger, not its onboard charger. */
export const DC_THRESHOLD_KW = 22;

export interface ChargeSession {
	index: number;
	start: number;
	end: number;
	startTime: number;
	endTime: number;
	duration: number;
	socStart: number;
	socEnd: number;
	socGain: number;
	/** Energy measured at the plug. */
	kwhDelivered: number;
	/** Energy measured at the pack, which excludes charging losses. */
	kwhIntoPack: number;
	avgKw: number;
	maxKw: number;
	isDc: boolean;
	rangeStart: number;
	rangeEnd: number;
}

export interface ChargingHabits {
	sessions: ChargeSession[];
	totalKwh: number;
	/** Most common end-of-charge state of charge, when one clearly repeats. */
	chargeLimit: number | null;
	/** Local hour that sessions repeatedly start at, when one clearly repeats. */
	scheduledHour: number | null;
	scheduledCount: number;
	/** The most common plug-in hour, whether or not it looks scheduled. */
	plugInHour: number | null;
	plugInCount: number;
	dcSessions: number;
	acSessions: number;
	/** Sessions dropped as top-up blips; kept so the UI can explain the count. */
	blipsIgnored: number;
}

export function detectCharging(dataset: Dataset): ChargeSession[] {
	const power = dataset.columns.get('ldcu_chrgpwr');
	if (!power) return [];

	const { time } = dataset;
	const soc = dataset.columns.get('ldcu_bms_soc_disp');
	const range = dataset.columns.get('ldcu_dstbatdisp_dynamic');
	const volt = dataset.columns.get('bms_battvolt');
	const current = dataset.columns.get('bms_battcurr');

	// Contiguous runs of delivered power, joined across the gaps where the car
	// slept mid-charge. A break only ends the session if the car actually left,
	// which the odometer settles without needing the trip list.
	const odometer = dataset.columns.get('cdcu_totalodometer');
	const runs: Array<{ start: number; end: number }> = [];
	let start = -1;
	let last = -1;

	const carMoved = (from: number, to: number): boolean => {
		if (!odometer) return false;
		const before = valueAt(odometer, from);
		const after = valueAt(odometer, to);
		if (Number.isNaN(before) || Number.isNaN(after)) return false;
		return after > before;
	};

	for (let i = 0; i < time.length; i++) {
		const kw = valueAt(power, i);
		if (!Number.isNaN(kw) && kw > ACTIVE_KW) {
			if (start === -1) {
				start = i;
			} else if (time[i] - time[last] > MERGE_GAP_SECONDS || carMoved(last, i)) {
				runs.push({ start, end: last });
				start = i;
			}
			last = i;
		}
	}
	if (start !== -1) runs.push({ start, end: last });

	const sessions: ChargeSession[] = [];
	for (const run of runs) {
		const duration = time[run.end] - time[run.start];
		let maxKw = 0;
		for (let i = run.start; i <= run.end; i++) {
			const kw = valueAt(power, i);
			if (!Number.isNaN(kw) && kw > maxKw) maxKw = kw;
		}

		const socStart = soc ? firstFinite(soc, run.start, run.end) : NaN;
		const socEnd = soc ? lastFinite(soc, run.start, run.end) : NaN;
		const socGain = Number.isNaN(socStart) || Number.isNaN(socEnd) ? NaN : socEnd - socStart;

		// A brief plug-in that moved no charge is maintenance, not a session.
		if (duration < MIN_SESSION_SECONDS && !(socGain >= MIN_SESSION_SOC_GAIN)) continue;

		const kwhDelivered = integrateSignal(time, power, run.start, run.end);
		const kwhIntoPack =
			volt && current ? integrateEnergy(time, volt, current, run.start, run.end).charged : NaN;

		sessions.push({
			index: sessions.length,
			start: run.start,
			end: run.end,
			startTime: time[run.start],
			endTime: time[run.end],
			duration,
			socStart,
			socEnd,
			socGain,
			kwhDelivered,
			kwhIntoPack,
			avgKw: duration > 0 ? (kwhDelivered * 3600) / duration : NaN,
			maxKw,
			isDc: maxKw > DC_THRESHOLD_KW,
			rangeStart: range ? firstFinite(range, run.start, run.end) : NaN,
			rangeEnd: range ? lastFinite(range, run.start, run.end) : NaN
		});
	}

	return sessions;
}

function firstFinite(column: Parameters<typeof valueAt>[0], from: number, to: number): number {
	for (let i = from; i <= to; i++) {
		const v = valueAt(column, i);
		if (!Number.isNaN(v)) return v;
	}
	return NaN;
}

function lastFinite(column: Parameters<typeof valueAt>[0], from: number, to: number): number {
	for (let i = to; i >= from; i--) {
		const v = valueAt(column, i);
		if (!Number.isNaN(v)) return v;
	}
	return NaN;
}

/** How long the car must stay put for a charge to count as having finished. */
const SETTLE_AFTER_CHARGE_SECONDS = 1800;

/**
 * A charge limit is the level the car stops at *of its own accord*.
 *
 * Most sessions end because someone unplugged and drove away, and those say
 * nothing about a limit — in a real export they cluster at every level from
 * 25% upwards and drown out the signal. Only sessions after which the car
 * stayed parked reveal where charging actually stopped by itself.
 */
export function detectChargeLimit(
	sessions: ChargeSession[],
	trips: Array<{ startTime: number }> = []
): number | null {
	const counts = new Map<number, number>();
	for (const session of sessions) {
		if (Number.isNaN(session.socEnd) || session.socGain < MIN_SESSION_SOC_GAIN) continue;
		const drovePromptly = trips.some(
			(trip) =>
				trip.startTime >= session.endTime &&
				trip.startTime - session.endTime < SETTLE_AFTER_CHARGE_SECONDS
		);
		if (drovePromptly) continue;
		const bucket = Math.round(session.socEnd);
		counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
	}

	let best: number | null = null;
	let bestCount = 0;
	for (const [value, count] of counts) {
		if (count > bestCount || (count === bestCount && best !== null && value > best)) {
			best = value;
			bestCount = count;
		}
	}
	// Charging to full is the absence of a limit, not a limit at 100%.
	if (best === null || bestCount < 3 || best >= 99) return null;
	return best;
}

/**
 * Scheduled charging shows up as sessions repeatedly beginning in the same
 * local hour. Reported only when it accounts for a real share of sessions.
 */
export function detectScheduledHour(
	sessions: ChargeSession[],
	timeZone: string
): { hour: number | null; count: number } {
	if (sessions.length < 4) return { hour: null, count: 0 };
	const counts = new Array(24).fill(0);
	for (const session of sessions) {
		counts[localHour(session.startTime, timeZone)]++;
	}
	let hour = 0;
	for (let h = 1; h < 24; h++) if (counts[h] > counts[hour]) hour = h;
	const share = counts[hour] / sessions.length;
	if (counts[hour] < 3 || share < 0.3) return { hour: null, count: counts[hour] };
	return { hour, count: counts[hour] };
}

const hourFormatters = new Map<string, Intl.DateTimeFormat>();

export function localHour(epochSeconds: number, timeZone: string): number {
	let formatter = hourFormatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone });
		hourFormatters.set(timeZone, formatter);
	}
	return Number(formatter.format(new Date(epochSeconds * 1000)));
}

export function summarizeCharging(
	dataset: Dataset,
	timeZone: string,
	trips: Array<{ startTime: number }> = []
): ChargingHabits {
	const sessions = detectCharging(dataset);
	const scheduled = detectScheduledHour(sessions, timeZone);

	const hourCounts = new Array(24).fill(0);
	for (const session of sessions) hourCounts[localHour(session.startTime, timeZone)]++;
	let plugInHour = 0;
	for (let h = 1; h < 24; h++) if (hourCounts[h] > hourCounts[plugInHour]) plugInHour = h;

	return {
		sessions,
		totalKwh: sessions.reduce(
			(sum, s) => sum + (Number.isFinite(s.kwhDelivered) ? s.kwhDelivered : 0),
			0
		),
		chargeLimit: detectChargeLimit(sessions, trips),
		scheduledHour: scheduled.hour,
		scheduledCount: scheduled.count,
		plugInHour: sessions.length ? plugInHour : null,
		plugInCount: sessions.length ? hourCounts[plugInHour] : 0,
		dcSessions: sessions.filter((s) => s.isDc).length,
		acSessions: sessions.filter((s) => !s.isDc).length,
		blipsIgnored: 0
	};
}
