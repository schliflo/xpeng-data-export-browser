/**
 * Columnar storage for the parsed export.
 *
 * Every signal becomes one typed array of raw integers plus the spec needed to
 * turn them back into physical values. At 1 Hz over 30 days this keeps a full
 * export in roughly 50 MB instead of the ~340 MB of source CSV.
 */

import {
	DTYPE_CTOR,
	NULL_CODE,
	type ColumnSpec,
	type Dtype,
	type TypedArray
} from '../schema/columns';
import type { StreamId } from '../schema/streams';

export interface Column {
	spec: ColumnSpec;
	data: TypedArray;
	/** How many entries hold a real reading. Zero means the car never reported it. */
	nonNull: number;
	min: number;
	max: number;
}

export interface Dataset {
	/** Unix epoch seconds, ascending and unique. Shared by every column. */
	time: Uint32Array;
	columns: Map<string, Column>;
	vin: string;
	vmodel: string;
	exportId: string;
	available: Record<StreamId, boolean>;
	/** Source rows dropped as exact repeats — surfaced as a data-quality fact. */
	duplicateRows: number;
	/** Streams whose rows arrived out of chronological order and were sorted. */
	unsortedStreams: string[];
	/** Registry columns the export contained but never populated. */
	emptyColumns: string[];
	rowsParsed: number;
	bytesParsed: number;
	/** True when all streams shared one timeline; false when merge-joined. */
	aligned: boolean;
}

export function isNullRaw(raw: number, dtype: Dtype): boolean {
	return dtype === 'f32' ? Number.isNaN(raw) : raw === NULL_CODE[dtype];
}

/** Physical value at `i`, or NaN where the signal had no reading. */
export function valueAt(column: Column, i: number): number {
	const raw = column.data[i];
	if (isNullRaw(raw, column.spec.dtype)) return NaN;
	return raw * column.spec.scale + column.spec.offset;
}

/** Decodes a range into a Float64Array with NaN gaps, ready for charting. */
export function decodeRange(column: Column, start = 0, end = column.data.length): Float64Array {
	const { scale, offset, dtype } = column.spec;
	const out = new Float64Array(end - start);
	const nullCode = NULL_CODE[dtype];
	const isFloat = dtype === 'f32';
	for (let i = start; i < end; i++) {
		const raw = column.data[i];
		out[i - start] = (isFloat ? Number.isNaN(raw) : raw === nullCode) ? NaN : raw * scale + offset;
	}
	return out;
}

/**
 * Growable typed-array builder. Capacity doubles as needed and the buffer is
 * trimmed once, so parsing never holds two full copies of a stream.
 */
export class ColumnBuilder {
	readonly spec: ColumnSpec;
	private buffer: TypedArray;
	private length = 0;
	private nonNull = 0;
	private minRaw = Infinity;
	private maxRaw = -Infinity;
	private readonly nullCode: number;
	private readonly invScale: number;
	private readonly sentinelRaw: Set<number>;

	constructor(spec: ColumnSpec, capacity: number) {
		this.spec = spec;
		this.buffer = new DTYPE_CTOR[spec.dtype](Math.max(capacity, 1));
		this.nullCode = NULL_CODE[spec.dtype];
		this.invScale = 1 / spec.scale;
		// Compare sentinels in raw space so float noise in the CSV cannot miss them.
		this.sentinelRaw = new Set(
			spec.sentinels.map((s) => Math.round((s - spec.offset) * this.invScale))
		);
	}

	/** Appends a physical value; NaN records a null. */
	push(value: number): void {
		if (this.length >= this.buffer.length) this.grow();
		if (Number.isNaN(value)) {
			this.buffer[this.length++] = this.nullCode;
			return;
		}
		const raw =
			this.spec.dtype === 'f32'
				? (value - this.spec.offset) * this.invScale
				: Math.round((value - this.spec.offset) * this.invScale);
		if (this.sentinelRaw.has(raw)) {
			this.buffer[this.length++] = this.nullCode;
			return;
		}
		this.buffer[this.length++] = raw;
		this.nonNull++;
		if (raw < this.minRaw) this.minRaw = raw;
		if (raw > this.maxRaw) this.maxRaw = raw;
	}

	pushNull(): void {
		if (this.length >= this.buffer.length) this.grow();
		this.buffer[this.length++] = this.nullCode;
	}

	private grow(): void {
		const next = new DTYPE_CTOR[this.spec.dtype](this.buffer.length * 2);
		next.set(this.buffer as never);
		this.buffer = next;
	}

	get size(): number {
		return this.length;
	}

	finish(): Column {
		const { scale, offset } = this.spec;
		return {
			spec: this.spec,
			data: this.buffer.subarray(0, this.length),
			nonNull: this.nonNull,
			min: this.nonNull ? this.minRaw * scale + offset : NaN,
			max: this.nonNull ? this.maxRaw * scale + offset : NaN
		};
	}

	/**
	 * Builds the column from a chosen subset of rows, in the given order.
	 * Used to put an out-of-order export back in sequence and to drop repeats
	 * without ever holding two copies of the whole dataset.
	 */
	gather(indices: Uint32Array): Column {
		const { scale, offset, dtype } = this.spec;
		const source = this.buffer;
		const out = new DTYPE_CTOR[dtype](indices.length);
		const nullCode = NULL_CODE[dtype];
		const isFloat = dtype === 'f32';

		let nonNull = 0;
		let minRaw = Infinity;
		let maxRaw = -Infinity;
		for (let i = 0; i < indices.length; i++) {
			const raw = source[indices[i]];
			out[i] = raw;
			if (isFloat ? Number.isNaN(raw) : raw === nullCode) continue;
			nonNull++;
			if (raw < minRaw) minRaw = raw;
			if (raw > maxRaw) maxRaw = raw;
		}

		// The staging buffer is no longer needed once the column is built.
		this.buffer = new DTYPE_CTOR[dtype](0);
		this.length = 0;

		return {
			spec: this.spec,
			data: out,
			nonNull,
			min: nonNull ? minRaw * scale + offset : NaN,
			max: nonNull ? maxRaw * scale + offset : NaN
		};
	}
}

/** Growable Uint32Array for the shared time index. */
export class TimeBuilder {
	private buffer: Uint32Array;
	private length = 0;

	constructor(capacity: number) {
		this.buffer = new Uint32Array(Math.max(capacity, 1));
	}

	push(t: number): void {
		if (this.length >= this.buffer.length) {
			const next = new Uint32Array(this.buffer.length * 2);
			next.set(this.buffer);
			this.buffer = next;
		}
		this.buffer[this.length++] = t;
	}

	get size(): number {
		return this.length;
	}

	last(): number {
		return this.length ? this.buffer[this.length - 1] : -1;
	}

	finish(): Uint32Array {
		return this.buffer.subarray(0, this.length);
	}
}

/** Index of the last sample at or before `t`, or -1. Time must be ascending. */
export function searchTime(time: Uint32Array, t: number): number {
	let lo = 0;
	let hi = time.length - 1;
	let best = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (time[mid] <= t) {
			best = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return best;
}
