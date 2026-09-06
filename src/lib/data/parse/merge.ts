/**
 * Joining several exports into one timeline.
 *
 * XPeng hands out a rolling thirty days at a time, so a longer record only
 * exists as a pile of overlapping exports. Merging them is a scatter rather
 * than a search: the union of the timestamps is built once, every source row
 * learns its new position from it, and each column is written straight into
 * place. Sources are applied oldest first, so where two exports describe the
 * same second the newer one has the last word — and a value the newer export
 * left blank is still filled by the older one.
 *
 * Only one source column is materialised at a time. A year of data is several
 * hundred megabytes even packed, and holding every source in full alongside
 * the result is the difference between a merge that works and a tab that dies.
 */

import {
	COLUMNS,
	DTYPE_CTOR,
	NULL_CODE,
	type ColumnSpec,
	type TypedArray
} from '../schema/columns';
import { STREAM_IDS, type StreamId } from '../schema/streams';
import { isNullRaw, type Column, type CoverageWindow, type Dataset } from '../store/columnar';
import { mergeTimelines } from './align';

/**
 * One export, as the merge needs to see it. Columns are pulled one at a time
 * through `column()` so a stored export can stay compressed until its turn.
 */
export interface MergeSource {
	exportId: string;
	vin: string;
	vmodel: string;
	time: Uint32Array;
	/** Every column this source can supply. */
	keys: string[];
	/** Materialises one column. Called once per key, in registry order. */
	column(key: string): Column | undefined;
	available: Record<StreamId, boolean>;
	duplicateRows: number;
	unsortedStreams: string[];
	rowsParsed: number;
	bytesParsed: number;
	coverage?: CoverageWindow[];
}

function endOf(source: MergeSource): number {
	return source.time.length ? source.time[source.time.length - 1] : 0;
}

function startOf(source: MergeSource): number {
	return source.time.length ? source.time[0] : 0;
}

function windowsOf(source: MergeSource): CoverageWindow[] {
	if (source.coverage?.length) return source.coverage;
	if (!source.time.length) return [];
	return [{ startTime: startOf(source), endTime: endOf(source), exportId: source.exportId }];
}

/** Registry order first, then anything the registry has never heard of. */
function orderedKeys(sources: MergeSource[]): string[] {
	const wanted = new Set<string>();
	for (const source of sources) for (const key of source.keys) wanted.add(key);

	const keys: string[] = [];
	for (const key of COLUMNS.keys()) {
		if (wanted.delete(key)) keys.push(key);
	}
	return [...keys, ...wanted];
}

/**
 * The spec to store a key under. A registry spec wins over the placeholder an
 * older app version may have saved for an unknown signal, so a column that has
 * since been documented gains its units and scale on the next merge.
 */
function specFor(key: string, sources: MergeSource[]): ColumnSpec | null {
	const registry = COLUMNS.get(key);
	if (registry) return registry;
	for (let i = sources.length - 1; i >= 0; i--) {
		const column = sources[i].column(key);
		if (column) return column.spec;
	}
	return null;
}

function sameEncoding(a: ColumnSpec, b: ColumnSpec): boolean {
	return a.dtype === b.dtype && a.scale === b.scale && a.offset === b.offset;
}

/** Writes one source's rows into their place in the merged column. */
function scatter(target: TypedArray, spec: ColumnSpec, column: Column, map: Uint32Array): void {
	const source = column.data;
	const direct = sameEncoding(spec, column.spec);
	const from = column.spec;
	const invScale = 1 / spec.scale;
	const rounds = spec.dtype !== 'f32';
	const n = Math.min(source.length, map.length);

	for (let i = 0; i < n; i++) {
		const raw = source[i];
		if (isNullRaw(raw, from.dtype)) continue;
		if (direct) {
			target[map[i]] = raw;
			continue;
		}
		// Different storage on either side: go through physical units, which is
		// the only thing the two encodings agree on.
		const value = raw * from.scale + from.offset;
		const converted = (value - spec.offset) * invScale;
		target[map[i]] = rounds ? Math.round(converted) : converted;
	}
}

function summarise(spec: ColumnSpec, data: TypedArray): Column {
	const nullCode = NULL_CODE[spec.dtype];
	const isFloat = spec.dtype === 'f32';
	let nonNull = 0;
	let minRaw = Infinity;
	let maxRaw = -Infinity;

	for (let i = 0; i < data.length; i++) {
		const raw = data[i];
		if (isFloat ? Number.isNaN(raw) : raw === nullCode) continue;
		nonNull++;
		if (raw < minRaw) minRaw = raw;
		if (raw > maxRaw) maxRaw = raw;
	}

	return {
		spec,
		data,
		nonNull,
		min: nonNull ? minRaw * spec.scale + spec.offset : NaN,
		max: nonNull ? maxRaw * spec.scale + spec.offset : NaN
	};
}

/** A dataset already in memory, presented as a merge source. */
export function sourceFromDataset(dataset: Dataset): MergeSource {
	return {
		exportId: dataset.exportId,
		vin: dataset.vin,
		vmodel: dataset.vmodel,
		time: dataset.time,
		keys: [...dataset.columns.keys()],
		column: (key) => dataset.columns.get(key),
		available: dataset.available,
		duplicateRows: dataset.duplicateRows,
		unsortedStreams: dataset.unsortedStreams,
		rowsParsed: dataset.rowsParsed,
		bytesParsed: dataset.bytesParsed,
		coverage: dataset.coverage
	};
}

export function mergeSources(sources: MergeSource[]): Dataset {
	if (sources.length === 0) throw new Error('There is nothing to open.');

	const vins = new Set(sources.map((s) => s.vin).filter(Boolean));
	if (vins.size > 1) {
		throw new Error('These exports come from different vehicles and cannot be combined.');
	}

	// Oldest first, so the newest export overwrites what it disagrees with.
	const ordered = [...sources].sort((a, b) => endOf(a) - endOf(b) || startOf(a) - startOf(b));
	const { time, maps } = mergeTimelines(
		ordered.map((s) => s.time),
		true
	);

	const columns = new Map<string, Column>();
	for (const key of orderedKeys(ordered)) {
		const spec = specFor(key, ordered);
		if (!spec) continue;

		const data = new DTYPE_CTOR[spec.dtype](time.length);
		data.fill(NULL_CODE[spec.dtype]);

		for (let s = 0; s < ordered.length; s++) {
			const column = ordered[s].column(key);
			if (!column) continue;
			scatter(data, spec, column, maps[s]);
			// Released before the next source is asked for its copy.
		}

		columns.set(key, summarise(spec, data));
	}

	const available = Object.fromEntries(
		STREAM_IDS.map((id) => [id, ordered.some((s) => s.available[id])])
	) as Record<StreamId, boolean>;

	const newest = [...ordered].reverse();
	const emptyColumns = [...columns.values()]
		.filter((column) => column.nonNull === 0)
		.map((column) => column.spec.key);

	return {
		time,
		columns,
		vin: newest.find((s) => s.vin)?.vin ?? '',
		vmodel: newest.find((s) => s.vmodel)?.vmodel ?? '',
		exportId: ordered.map((s) => s.exportId).join('+'),
		available,
		duplicateRows: ordered.reduce((sum, s) => sum + s.duplicateRows, 0),
		unsortedStreams: [...new Set(ordered.flatMap((s) => s.unsortedStreams))],
		emptyColumns,
		rowsParsed: ordered.reduce((sum, s) => sum + s.rowsParsed, 0),
		bytesParsed: ordered.reduce((sum, s) => sum + s.bytesParsed, 0),
		aligned: true,
		// One window per export, overlaps and all: what each of them accounted
		// for is worth knowing. The analysis coalesces them when it needs to
		// measure how much time is covered.
		coverage: ordered.flatMap(windowsOf).sort((a, b) => a.startTime - b.startTime)
	};
}

/** Convenience for datasets already held in memory, and for the tests. */
export function mergeDatasets(datasets: Dataset[]): Dataset {
	return mergeSources(datasets.map(sourceFromDataset));
}
