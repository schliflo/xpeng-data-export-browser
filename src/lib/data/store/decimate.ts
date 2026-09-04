/**
 * Downsampling for the time-series charts.
 *
 * A month at one sample a second is well over a million points, and no chart
 * can draw that per frame. Averaging would hide exactly what matters — a
 * half-second braking spike disappears into its neighbours — so each bucket
 * keeps its minimum and maximum instead. The envelope stays truthful at every
 * zoom level, and the raw samples are used once the view is narrow enough.
 */

import { NULL_CODE, type ColumnSpec } from '../schema/columns';
import type { Column } from './columnar';

/**
 * Bucket sizes, each four times coarser than the last. Steps this close matter:
 * a wider ladder makes the chart lurch between far too much detail and far too
 * little as the view is zoomed. The coarsest levels only ever get built for a
 * merged timeline of several exports, where a whole year has to fit on a chart
 * a thousand pixels wide.
 */
const LEVEL_FACTORS = [4, 16, 64, 256, 1024, 4096, 16384, 65536];

export interface PyramidLevel {
	factor: number;
	/** Two entries per bucket: the minimum then the maximum. */
	values: Float32Array;
	/** Timestamp of each bucket's first sample. */
	times: Uint32Array;
}

export interface Pyramid {
	spec: ColumnSpec;
	levels: PyramidLevel[];
}

function buildLevel(
	time: Uint32Array,
	data: ArrayLike<number>,
	spec: ColumnSpec,
	factor: number
): PyramidLevel {
	const buckets = Math.ceil(data.length / factor);
	const values = new Float32Array(buckets * 2);
	const times = new Uint32Array(buckets);
	const nullCode = NULL_CODE[spec.dtype];
	const isFloat = spec.dtype === 'f32';
	const { scale, offset } = spec;

	for (let b = 0; b < buckets; b++) {
		const start = b * factor;
		const end = Math.min(start + factor, data.length);
		let min = Infinity;
		let max = -Infinity;
		for (let i = start; i < end; i++) {
			const raw = data[i];
			if (isFloat ? Number.isNaN(raw) : raw === nullCode) continue;
			const value = raw * scale + offset;
			if (value < min) min = value;
			if (value > max) max = value;
		}
		// An entirely empty bucket stays empty, so gaps survive downsampling.
		values[b * 2] = min === Infinity ? NaN : min;
		values[b * 2 + 1] = max === -Infinity ? NaN : max;
		times[b] = time[start];
	}

	return { factor, values, times };
}

/**
 * Builds the pyramid for a column. Costs one pass per level over the data and
 * is cached by the caller, so it happens once per column per session.
 */
export function buildPyramid(time: Uint32Array, column: Column): Pyramid {
	const levels: PyramidLevel[] = [];
	let source: ArrayLike<number> = column.data;
	let sourceTime = time;

	for (const factor of LEVEL_FACTORS) {
		if (column.data.length < factor * 2) break;
		levels.push(buildLevel(time, column.data, column.spec, factor));
		void source;
		void sourceTime;
	}

	return { spec: column.spec, levels };
}

export interface Series {
	/** Timestamps in seconds, ascending. */
	x: Float64Array;
	/** Values, with NaN wherever there was no reading. */
	y: Float64Array;
}

/**
 * Picks a resolution for the requested window and returns plottable arrays.
 *
 * The target is roughly two points per pixel; below that the chart looks
 * chunky, far above it there is nothing left to see. Where a level is used,
 * each bucket contributes its minimum and maximum in time order, so peaks stay
 * visible however far out the view is zoomed.
 */
export function selectSeries(
	time: Uint32Array,
	column: Column,
	pyramid: Pyramid | null,
	fromTime: number,
	toTime: number,
	pixelWidth: number
): Series {
	const from = lowerBound(time, fromTime);
	const to = upperBound(time, toTime);
	const count = Math.max(0, to - from);
	// Each bucket draws two points, so this many buckets fills the width twice.
	const bucketBudget = Math.max(64, pixelWidth);

	if (count <= bucketBudget || !pyramid || pyramid.levels.length === 0) {
		return rawSeries(time, column, from, to);
	}

	// The finest level that still fits the width — most detail without excess.
	let chosen = pyramid.levels[pyramid.levels.length - 1];
	for (const level of pyramid.levels) {
		if (count / level.factor <= bucketBudget) {
			chosen = level;
			break;
		}
	}

	const startBucket = Math.max(0, Math.floor(from / chosen.factor));
	const endBucket = Math.min(chosen.times.length, Math.ceil(to / chosen.factor));
	const buckets = Math.max(0, endBucket - startBucket);

	const x = new Float64Array(buckets * 2);
	const y = new Float64Array(buckets * 2);
	for (let b = 0; b < buckets; b++) {
		const index = startBucket + b;
		const t = chosen.times[index];
		const next = index + 1 < chosen.times.length ? chosen.times[index + 1] : t + chosen.factor;
		// Both extremes are drawn inside the bucket's own span so the line
		// spans the true range without shifting anything in time.
		x[b * 2] = t;
		x[b * 2 + 1] = t + Math.max(1, (next - t) / 2);
		y[b * 2] = chosen.values[index * 2];
		y[b * 2 + 1] = chosen.values[index * 2 + 1];
	}
	return { x, y };
}

function rawSeries(time: Uint32Array, column: Column, from: number, to: number): Series {
	const n = Math.max(0, to - from);
	const x = new Float64Array(n);
	const y = new Float64Array(n);
	const { scale, offset, dtype } = column.spec;
	const nullCode = NULL_CODE[dtype];
	const isFloat = dtype === 'f32';

	for (let i = 0; i < n; i++) {
		const index = from + i;
		x[i] = time[index];
		const raw = column.data[index];
		y[i] = (isFloat ? Number.isNaN(raw) : raw === nullCode) ? NaN : raw * scale + offset;
	}
	return { x, y };
}

/**
 * Splits a series wherever the car stopped logging, by inserting a break. A
 * line drawn straight across a night of sleep would imply the car was doing
 * something during it.
 */
export function breakAtGaps(series: Series, gapSeconds: number): Series {
	let breaks = 0;
	for (let i = 1; i < series.x.length; i++) {
		if (series.x[i] - series.x[i - 1] > gapSeconds) breaks++;
	}
	if (breaks === 0) return series;

	const x = new Float64Array(series.x.length + breaks);
	const y = new Float64Array(series.y.length + breaks);
	let out = 0;
	for (let i = 0; i < series.x.length; i++) {
		if (i > 0 && series.x[i] - series.x[i - 1] > gapSeconds) {
			x[out] = series.x[i - 1] + 1;
			y[out] = NaN;
			out++;
		}
		x[out] = series.x[i];
		y[out] = series.y[i];
		out++;
	}
	return { x: x.subarray(0, out), y: y.subarray(0, out) };
}

export function lowerBound(time: Uint32Array, value: number): number {
	let lo = 0;
	let hi = time.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (time[mid] < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export function upperBound(time: Uint32Array, value: number): number {
	let lo = 0;
	let hi = time.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (time[mid] <= value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Caches pyramids so a column is only ever reduced once. */
export class PyramidCache {
	private readonly cache = new Map<string, Pyramid>();

	constructor(private readonly time: Uint32Array) {}

	get(column: Column): Pyramid {
		let pyramid = this.cache.get(column.spec.key);
		if (!pyramid) {
			pyramid = buildPyramid(this.time, column);
			this.cache.set(column.spec.key, pyramid);
		}
		return pyramid;
	}

	clear(): void {
		this.cache.clear();
	}
}
