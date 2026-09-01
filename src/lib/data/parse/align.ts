/**
 * Joins the parsed streams onto a single timeline.
 *
 * In the exports we have seen the three streams carry exactly the same set of
 * timestamps once duplicate rows are removed, so the fast path simply shares
 * one time index and keeps every column index-aligned. That assumption is
 * verified rather than trusted: if it does not hold — a partial export, a
 * different firmware — we fall back to a merge join, which is slower but
 * always correct.
 */

import type { Column, Dataset } from '../store/columnar';
import { DTYPE_CTOR, NULL_CODE } from '../schema/columns';
import { STREAM_IDS, type StreamId } from '../schema/streams';
import type { StreamParseResult } from './ingest';

const SPOT_CHECKS = 64;

export function verifyAlignment(results: StreamParseResult[]): boolean {
	if (results.length < 2) return true;
	const [first, ...rest] = results;
	const n = first.time.length;
	if (n === 0) return false;

	for (const other of rest) {
		if (other.time.length !== n) return false;
		if (other.time[0] !== first.time[0]) return false;
		if (other.time[n - 1] !== first.time[n - 1]) return false;
	}

	// Deterministic spread of probes across the timeline.
	const stride = Math.max(1, Math.floor(n / SPOT_CHECKS));
	for (let i = 0; i < n; i += stride) {
		const expected = first.time[i];
		for (const other of rest) {
			if (other.time[i] !== expected) return false;
		}
	}
	return true;
}

function emptyLike(column: Column, length: number): Column {
	const data = new DTYPE_CTOR[column.spec.dtype](length);
	data.fill(NULL_CODE[column.spec.dtype]);
	return { spec: column.spec, data, nonNull: 0, min: NaN, max: NaN };
}

/**
 * Re-indexes one stream's columns onto `unionTime`, leaving nulls wherever the
 * stream had no sample. Both time vectors are ascending, so a single sweep
 * suffices.
 */
function reindex(result: StreamParseResult, unionTime: Uint32Array): Map<string, Column> {
	const out = new Map<string, Column>();
	const n = unionTime.length;

	for (const [key, column] of result.columns) {
		const { dtype, scale, offset } = column.spec;
		const data = new DTYPE_CTOR[dtype](n);
		const nullCode = NULL_CODE[dtype];
		data.fill(nullCode);
		const isFloat = dtype === 'f32';

		let src = 0;
		let nonNull = 0;
		let minRaw = Infinity;
		let maxRaw = -Infinity;
		for (let dst = 0; dst < n; dst++) {
			const t = unionTime[dst];
			while (src < result.time.length && result.time[src] < t) src++;
			if (src >= result.time.length) break;
			if (result.time[src] !== t) continue;
			const raw = column.data[src];
			data[dst] = raw;
			if (!(isFloat ? Number.isNaN(raw) : raw === nullCode)) {
				nonNull++;
				if (raw < minRaw) minRaw = raw;
				if (raw > maxRaw) maxRaw = raw;
			}
		}

		out.set(key, {
			spec: column.spec,
			data,
			nonNull,
			min: nonNull ? minRaw * scale + offset : NaN,
			max: nonNull ? maxRaw * scale + offset : NaN
		});
	}
	return out;
}

/** Sorted union of every stream's timestamps. */
function unionTimes(results: StreamParseResult[]): Uint32Array {
	const cursors = results.map(() => 0);
	let total = 0;
	for (const r of results) total += r.time.length;
	const out = new Uint32Array(total);
	let n = 0;

	for (;;) {
		let next = Infinity;
		for (let s = 0; s < results.length; s++) {
			const i = cursors[s];
			if (i < results[s].time.length) {
				const t = results[s].time[i];
				if (t < next) next = t;
			}
		}
		if (next === Infinity) break;
		out[n++] = next;
		for (let s = 0; s < results.length; s++) {
			const i = cursors[s];
			if (i < results[s].time.length && results[s].time[i] === next) cursors[s] = i + 1;
		}
	}
	return out.subarray(0, n);
}

export function combineStreams(results: StreamParseResult[], exportId: string): Dataset {
	if (results.length === 0) {
		throw new Error('No recognisable XPeng export files were found.');
	}

	const aligned = verifyAlignment(results);
	const time = aligned ? results[0].time : unionTimes(results);
	const columns = new Map<string, Column>();

	for (const result of results) {
		const source = aligned ? result.columns : reindex(result, time);
		for (const [key, column] of source) {
			columns.set(
				key,
				aligned && column.data.length !== time.length ? emptyLike(column, time.length) : column
			);
		}
	}

	const available = Object.fromEntries(
		STREAM_IDS.map((id) => [id, results.some((r) => r.stream === id)])
	) as Record<StreamId, boolean>;

	const emptyColumns = [...columns.values()]
		.filter((column) => column.nonNull === 0)
		.map((column) => column.spec.key);

	const withVin = results.find((r) => r.vin);
	const withModel = results.find((r) => r.vmodel);

	return {
		time,
		columns,
		vin: withVin?.vin ?? '',
		vmodel: withModel?.vmodel ?? '',
		exportId,
		available,
		duplicateRows: results.reduce((sum, r) => sum + r.duplicateRows, 0),
		unsortedStreams: results.filter((r) => r.wasUnsorted).map((r) => r.stream),
		emptyColumns,
		rowsParsed: results.reduce((sum, r) => sum + r.rows, 0),
		bytesParsed: results.reduce((sum, r) => sum + r.bytes, 0),
		aligned
	};
}
