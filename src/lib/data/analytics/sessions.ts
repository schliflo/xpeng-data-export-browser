/**
 * Segmentation of the timeline.
 *
 * The car only logs while it is awake, so the 30-day export covers roughly 46%
 * of wall-clock time and contains gaps of up to a day. Everything downstream
 * works on spans rather than on a continuous series: charts break their lines
 * at these boundaries instead of drawing a straight edge across a night, and
 * trips and charging sessions are searched for inside them.
 */

import { coalesceWindows, type CoverageWindow, type Dataset } from '../store/columnar';

export interface Span {
	/** Inclusive start index into the dataset's time array. */
	start: number;
	/** Inclusive end index. */
	end: number;
	startTime: number;
	endTime: number;
}

/** Default gap, in seconds, that separates one awake period from the next. */
export const AWAKE_GAP_SECONDS = 60;

export function segmentAwake(time: Uint32Array, gapSeconds = AWAKE_GAP_SECONDS): Span[] {
	const spans: Span[] = [];
	if (time.length === 0) return spans;

	let start = 0;
	for (let i = 1; i < time.length; i++) {
		if (time[i] - time[i - 1] > gapSeconds) {
			spans.push({ start, end: i - 1, startTime: time[start], endTime: time[i - 1] });
			start = i;
		}
	}
	spans.push({
		start,
		end: time.length - 1,
		startTime: time[start],
		endTime: time[time.length - 1]
	});
	return spans;
}

export function spanDuration(span: Span): number {
	return span.endTime - span.startTime;
}

/** Total seconds the car was awake and logging. */
export function totalCoverage(spans: Span[]): number {
	return spans.reduce((sum, span) => sum + spanDuration(span), 0);
}

/**
 * The gaps between awake spans — the periods the car spent asleep. These are
 * where phantom drain shows up and where a naive chart would draw a false line.
 */
export function sleepGaps(spans: Span[]): Span[] {
	const gaps: Span[] = [];
	for (let i = 1; i < spans.length; i++) {
		gaps.push({
			start: spans[i - 1].end,
			end: spans[i].start,
			startTime: spans[i - 1].endTime,
			endTime: spans[i].startTime
		});
	}
	return gaps;
}

/**
 * The stretches of time the data can speak for, in order and without overlaps.
 *
 * A single export accounts for everything between its first and last sample.
 * A merged one has a window per export and holes in between, and those holes
 * are not silence — they are absence. Nothing downstream may read a hole as a
 * car that sat still for three weeks.
 */
export function coverageWindows(dataset: Dataset): CoverageWindow[] {
	if (dataset.coverage?.length) return coalesceWindows(dataset.coverage);
	if (dataset.time.length === 0) return [];
	return [
		{
			startTime: dataset.time[0],
			endTime: dataset.time[dataset.time.length - 1],
			exportId: dataset.exportId
		}
	];
}

/** True when the whole interval falls inside one window, holes excluded. */
export function insideOneWindow(windows: CoverageWindow[], from: number, to: number): boolean {
	return windows.some((window) => from >= window.startTime && to <= window.endTime);
}

/** Seconds accounted for by the coverage windows. */
export function coveredSeconds(windows: CoverageWindow[]): number {
	return windows.reduce((sum, window) => sum + (window.endTime - window.startTime), 0);
}
