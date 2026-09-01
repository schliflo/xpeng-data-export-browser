/**
 * Segmentation of the timeline.
 *
 * The car only logs while it is awake, so the 30-day export covers roughly 46%
 * of wall-clock time and contains gaps of up to a day. Everything downstream
 * works on spans rather than on a continuous series: charts break their lines
 * at these boundaries instead of drawing a straight edge across a night, and
 * trips and charging sessions are searched for inside them.
 */

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
