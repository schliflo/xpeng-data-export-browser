/**
 * Battery behaviour over the export window.
 *
 * Two things here are hard to see by scrolling the raw data. Phantom drain is
 * the charge a parked car loses to its own electronics, visible only by
 * comparing the state of charge before and after each sleep. And the range the
 * car predicts, divided by its state of charge, gives the full-charge range it
 * currently believes in — which drifts with temperature and driving style.
 */

import { searchTime, valueAt, type Column, type Dataset } from '../store/columnar';
import { coverageWindows, insideOneWindow, segmentAwake, type Span } from './sessions';
import type { ChargeSession } from './charging';

export interface DrainEvent {
	startTime: number;
	endTime: number;
	hours: number;
	socStart: number;
	socEnd: number;
	socLost: number;
	percentPerDay: number;
}

export interface PhantomDrain {
	events: DrainEvent[];
	/**
	 * Loss per day, pooled across every sleep rather than averaged per sleep.
	 * State of charge is reported in whole percent, so a single two-hour nap
	 * can only ever read 0% or 1% — which is either nothing or an absurd
	 * 12%/day. Pooling the charge lost over the hours slept avoids that.
	 */
	medianPercentPerDay: number;
	totalSocLost: number;
	totalSleepHours: number;
	longestSleepHours: number;
}

/**
 * Parked periods shorter than this are ignored. State of charge is reported in
 * whole percent and the loss is well under 0.1% an hour, so a short stop simply
 * reads zero; only an overnight stand is long enough to register.
 */
const MIN_PARKED_HOURS = 6;

function lastFinite(column: Column, from: number, to: number): number {
	for (let i = to; i >= from; i--) {
		const v = valueAt(column, i);
		if (!Number.isNaN(v)) return v;
	}
	return NaN;
}

function firstFinite(column: Column, from: number, to: number): number {
	for (let i = from; i <= to; i++) {
		const v = valueAt(column, i);
		if (!Number.isNaN(v)) return v;
	}
	return NaN;
}

export function phantomDrain(
	dataset: Dataset,
	sessions: ChargeSession[],
	trips: Array<{ endTime: number; startTime: number }> = []
): PhantomDrain {
	const soc = dataset.columns.get('ldcu_bms_soc_disp');
	const empty: PhantomDrain = {
		events: [],
		medianPercentPerDay: NaN,
		totalSocLost: 0,
		totalSleepHours: 0,
		longestSleepHours: 0
	};
	if (!soc) return empty;

	// Gaps that straddle two exports are not the car keeping quiet, they are
	// the record stopping. Only silences inside one covered window count.
	const windows = coverageWindows(dataset);
	const spans = segmentAwake(dataset.time);
	let longestSleepHours = 0;
	for (let i = 1; i < spans.length; i++) {
		const from = spans[i - 1].endTime;
		const to = spans[i].startTime;
		if (!insideOneWindow(windows, from, to)) continue;
		const hours = (to - from) / 3600;
		if (hours > longestSleepHours) longestSleepHours = hours;
	}

	// The car spends the gaps between journeys parked. Measuring across a whole
	// gap — rather than across each individual nap inside it — gives a window
	// long enough for the loss to exceed the reporting resolution.
	const ordered = [...trips].sort((a, b) => a.startTime - b.startTime);
	const events: DrainEvent[] = [];

	for (let i = 1; i < ordered.length; i++) {
		const from = ordered[i - 1].endTime;
		const to = ordered[i].startTime;
		const hours = (to - from) / 3600;
		if (hours < MIN_PARKED_HOURS) continue;

		// A pause spanning the hole between two exports says nothing about
		// drain: the car may have driven and charged all week unobserved.
		if (!insideOneWindow(windows, from, to)) continue;

		// Any charging in between means the change is not drain.
		if (sessions.some((s) => s.endTime >= from && s.startTime <= to)) continue;

		const fromIndex = searchTime(dataset.time, from);
		const toIndex = searchTime(dataset.time, to);
		if (fromIndex < 0 || toIndex < 0 || toIndex <= fromIndex) continue;

		const socStart = lastFinite(soc, Math.max(0, fromIndex - 600), fromIndex);
		const socEnd = firstFinite(soc, toIndex, Math.min(dataset.time.length - 1, toIndex + 600));
		if (Number.isNaN(socStart) || Number.isNaN(socEnd)) continue;

		const socLost = socStart - socEnd;
		// A rise means the car was plugged in without the charger reporting it.
		if (socLost < 0) continue;

		events.push({
			startTime: from,
			endTime: to,
			hours,
			socStart,
			socEnd,
			socLost,
			percentPerDay: (socLost / hours) * 24
		});
	}

	const totalSocLost = events.reduce((sum, e) => sum + e.socLost, 0);
	const totalSleepHours = events.reduce((sum, e) => sum + e.hours, 0);
	return {
		events,
		medianPercentPerDay: totalSleepHours > 0 ? (totalSocLost / totalSleepHours) * 24 : NaN,
		totalSocLost,
		totalSleepHours,
		longestSleepHours
	};
}

export interface RangeEstimate {
	/** Sampled (state of charge, predicted range) pairs while parked. */
	points: Array<{ soc: number; range: number; time: number; impliedFull: number }>;
	/** Median implied full-charge range in km. */
	medianFullRange: number;
	minFullRange: number;
	maxFullRange: number;
}

/**
 * The car's own range prediction, extrapolated to a full battery. Sampled only
 * at a healthy state of charge, since the estimate is noisy near empty.
 */
export function impliedRange(dataset: Dataset): RangeEstimate {
	const soc = dataset.columns.get('ldcu_bms_soc_disp');
	const range = dataset.columns.get('ldcu_dstbatdisp_dynamic');
	const empty: RangeEstimate = {
		points: [],
		medianFullRange: NaN,
		minFullRange: NaN,
		maxFullRange: NaN
	};
	if (!soc || !range) return empty;

	const points: RangeEstimate['points'] = [];
	// One sample every ten minutes is plenty to show the trend.
	const stride = 600;
	let nextTime = 0;

	for (let i = 0; i < dataset.time.length; i++) {
		const t = dataset.time[i];
		if (t < nextTime) continue;
		const s = valueAt(soc, i);
		const r = valueAt(range, i);
		// Below a third the estimate turns pessimistic and near full it turns
		// optimistic, so both ends are excluded rather than skewing the result.
		if (Number.isNaN(s) || Number.isNaN(r) || s < 30 || s > 95 || r <= 0) continue;
		points.push({ soc: s, range: r, time: t, impliedFull: (r / s) * 100 });
		nextTime = t + stride;
	}

	const implied = points.map((p) => p.impliedFull).sort((a, b) => a - b);
	// Reported as a spread of typical values, not absolute extremes: a single
	// optimistic moment right after charging is not a range the car can do.
	const percentile = (p: number) =>
		implied.length ? implied[Math.min(implied.length - 1, Math.floor(implied.length * p))] : NaN;

	return {
		points,
		medianFullRange: percentile(0.5),
		minFullRange: percentile(0.1),
		maxFullRange: percentile(0.9)
	};
}

export interface PackThermal {
	minTemp: number;
	maxTemp: number;
	/** Largest spread between the hottest and coldest cell seen at one moment. */
	maxSpread: number;
	maxSpreadTime: number;
}

export function packThermal(dataset: Dataset): PackThermal {
	const hot = dataset.columns.get('bms_batttempmax_gb');
	const cold = dataset.columns.get('bms_batttempmin_gb');
	const result: PackThermal = {
		minTemp: NaN,
		maxTemp: NaN,
		maxSpread: NaN,
		maxSpreadTime: 0
	};
	if (!hot || !cold) return result;

	let minTemp = Infinity;
	let maxTemp = -Infinity;
	let maxSpread = -Infinity;
	let maxSpreadTime = 0;

	for (let i = 0; i < dataset.time.length; i++) {
		const h = valueAt(hot, i);
		const c = valueAt(cold, i);
		if (!Number.isNaN(h) && h > maxTemp) maxTemp = h;
		if (!Number.isNaN(c) && c < minTemp) minTemp = c;
		if (!Number.isNaN(h) && !Number.isNaN(c)) {
			const spread = h - c;
			if (spread > maxSpread) {
				maxSpread = spread;
				maxSpreadTime = dataset.time[i];
			}
		}
	}

	return {
		minTemp: minTemp === Infinity ? NaN : minTemp,
		maxTemp: maxTemp === -Infinity ? NaN : maxTemp,
		maxSpread: maxSpread === -Infinity ? NaN : maxSpread,
		maxSpreadTime
	};
}

/** Coloured bands for the state-of-charge timeline. */
export type ActivityKind = 'drive' | 'charge' | 'idle';

export interface ActivityBand {
	kind: ActivityKind;
	startTime: number;
	endTime: number;
}

export function activityBands(
	trips: Array<{ startTime: number; endTime: number }>,
	sessions: ChargeSession[]
): ActivityBand[] {
	const bands: ActivityBand[] = [
		...trips.map((t) => ({ kind: 'drive' as const, startTime: t.startTime, endTime: t.endTime })),
		...sessions.map((s) => ({
			kind: 'charge' as const,
			startTime: s.startTime,
			endTime: s.endTime
		}))
	];
	return bands.sort((a, b) => a.startTime - b.startTime);
}

export type { Span };
