/**
 * Turning a parsed export into something a browser can keep, and back again.
 *
 * The packed dataset is already the right shape for storage: flat buffers of
 * raw integers plus a small description of how to read them. Each buffer is
 * gzipped on its own, so a merge can decompress one signal at a time instead
 * of inflating a whole export to read a single column. The numbers a listing
 * needs — dates, distance, trip count — are copied onto the record itself, so
 * showing the library never touches a buffer at all.
 *
 * Everything carries a format version. A stored export outlives the code that
 * wrote it, and guessing at an older layout is worse than declining to read it.
 */

import { gunzipSync, gzipSync } from 'fflate';
import { COLUMNS, type ColumnSpec, type Dtype } from '../data/schema/columns';
import type { StreamId } from '../data/schema/streams';
import type { Column, CoverageWindow } from '../data/store/columnar';
import type { DerivedData } from '../data/analytics';
import { viewFor, type PackedColumn, type PackedDataset } from '../data/worker/protocol';
import type { MergeSource } from '../data/parse/merge';

export const RECORD_VERSION = 1;

/** Name of the buffer holding the shared timeline. */
export const TIME_BLOB = '_time';

export interface StoredColumn {
	key: string;
	spec: ColumnSpec;
	nonNull: number;
	min: number;
	max: number;
}

export interface ExportRecord {
	id: string;
	version: number;
	exportId: string;
	vin: string;
	vmodel: string;
	/** When this copy was made, in epoch milliseconds. */
	keptAt: number;
	isDemo: boolean;
	/** Summary fields, so the library can be listed without decompressing. */
	startTime: number;
	endTime: number;
	rows: number;
	days: number;
	distanceKm: number;
	trips: number;
	storedBytes: number;
	columns: StoredColumn[];
	available: Record<StreamId, boolean>;
	duplicateRows: number;
	unsortedStreams: string[];
	emptyColumns: string[];
	rowsParsed: number;
	bytesParsed: number;
	aligned: boolean;
	coverage: CoverageWindow[];
}

export interface StoredBlob {
	id: string;
	/** `TIME_BLOB` or a column key. */
	name: string;
	/** Gzipped raw bytes. */
	bytes: ArrayBuffer;
}

const DTYPE_BYTES: Record<Dtype, number> = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, f32: 4 };

/**
 * Compression uses the browser's own gzip rather than fflate's. Pure JavaScript
 * spends about four seconds on a month of telemetry, and the user spends all of
 * it watching a progress bar; the native codec does the same work in a fraction
 * of that. fflate stays as the fallback for anywhere `CompressionStream` is
 * missing, and the two formats are the same gzip either way.
 */
async function compress(buffer: ArrayBuffer): Promise<Uint8Array> {
	if (typeof CompressionStream === 'undefined') {
		return gzipSync(new Uint8Array(buffer), { level: 6 });
	}
	const gzip = new Blob([buffer]).stream().pipeThrough(new CompressionStream('gzip'));
	return new Uint8Array(await new Response(gzip).arrayBuffer());
}

/** The exact bytes behind a view, without the buffer it may be a window on. */
function exactBuffer(view: Uint8Array): ArrayBuffer {
	if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
		return view.buffer as ArrayBuffer;
	}
	return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function decompress(bytes: ArrayBuffer): ArrayBuffer {
	return exactBuffer(gunzipSync(new Uint8Array(bytes)));
}

export async function encodeExport(
	packed: PackedDataset,
	derived: DerivedData,
	isDemo: boolean
): Promise<{ record: ExportRecord; blobs: StoredBlob[] }> {
	const id = packed.exportId;
	const blobs: StoredBlob[] = [
		{ id, name: TIME_BLOB, bytes: exactBuffer(await compress(packed.timeBuffer)) }
	];
	const columns: StoredColumn[] = [];

	for (const column of packed.columns) {
		blobs.push({ id, name: column.spec.key, bytes: exactBuffer(await compress(column.buffer)) });
		columns.push({
			key: column.spec.key,
			spec: column.spec,
			nonNull: column.nonNull,
			min: column.min,
			max: column.max
		});
	}

	const record: ExportRecord = {
		id,
		version: RECORD_VERSION,
		exportId: packed.exportId,
		vin: packed.vin,
		vmodel: packed.vmodel,
		keptAt: Date.now(),
		isDemo,
		startTime: derived.startTime,
		endTime: derived.endTime,
		rows: packed.timeBuffer.byteLength / 4,
		days: derived.recordedDays,
		distanceKm: derived.days.reduce((sum, day) => sum + day.distanceKm, 0),
		trips: derived.trips.length,
		storedBytes: blobs.reduce((sum, blob) => sum + blob.bytes.byteLength, 0),
		columns,
		available: packed.available,
		duplicateRows: packed.duplicateRows,
		unsortedStreams: packed.unsortedStreams,
		emptyColumns: packed.emptyColumns,
		rowsParsed: packed.rowsParsed,
		bytesParsed: packed.bytesParsed,
		aligned: packed.aligned,
		coverage: derived.coverage
	};

	return { record, blobs };
}

/**
 * The spec to read a stored column through. The registry's entry is preferred
 * where the two agree on storage, so a signal that has since been given a
 * label or a unit gains it — but a registry that has changed how a value is
 * stored must never be used to reinterpret bytes written under the old rules.
 */
export function specToUse(stored: ColumnSpec): ColumnSpec {
	const current = COLUMNS.get(stored.key);
	if (!current) return stored;
	const compatible =
		current.dtype === stored.dtype &&
		current.scale === stored.scale &&
		current.offset === stored.offset;
	return compatible ? current : stored;
}

export class StoredFormatError extends Error {
	constructor(readonly version: number) {
		super(`This export was kept in a format this version cannot read (${version}).`);
		this.name = 'StoredFormatError';
	}
}

function checkVersion(record: ExportRecord): void {
	if (record.version !== RECORD_VERSION) throw new StoredFormatError(record.version);
}

/**
 * JSON has no NaN. A column the car never reported has no range, and written
 * into a backup that becomes `null` — which would quietly behave as zero in
 * any arithmetic that reached it. Reading one puts the record back the way
 * storage would have kept it.
 */
export function reviveRecord(record: ExportRecord): ExportRecord {
	return {
		...record,
		columns: record.columns.map((column) => ({
			...column,
			min: column.min ?? NaN,
			max: column.max ?? NaN
		}))
	};
}

function blobMap(blobs: StoredBlob[]): Map<string, StoredBlob> {
	return new Map(blobs.map((blob) => [blob.name, blob]));
}

export function decodeExport(record: ExportRecord, blobs: StoredBlob[]): PackedDataset {
	checkVersion(record);
	const byName = blobMap(blobs);
	const time = byName.get(TIME_BLOB);
	if (!time) throw new Error('The kept copy is missing its timeline and cannot be opened.');

	const columns: PackedColumn[] = [];
	for (const stored of record.columns) {
		const blob = byName.get(stored.key);
		if (!blob) continue;
		columns.push({
			spec: specToUse(stored.spec),
			buffer: decompress(blob.bytes),
			nonNull: stored.nonNull,
			min: stored.min,
			max: stored.max
		});
	}

	return {
		timeBuffer: decompress(time.bytes),
		columns,
		vin: record.vin,
		vmodel: record.vmodel,
		exportId: record.exportId,
		available: record.available,
		duplicateRows: record.duplicateRows,
		unsortedStreams: record.unsortedStreams,
		emptyColumns: record.emptyColumns,
		rowsParsed: record.rowsParsed,
		bytesParsed: record.bytesParsed,
		aligned: record.aligned,
		coverage: record.coverage
	};
}

/**
 * A stored export presented to the merge, one column at a time. Only the
 * timeline is inflated up front; every signal waits until it is asked for and
 * is dropped again as soon as the merge moves on.
 */
export function sourceFromExport(record: ExportRecord, blobs: StoredBlob[]): MergeSource {
	checkVersion(record);
	const byName = blobMap(blobs);
	const time = byName.get(TIME_BLOB);
	if (!time) throw new Error('The kept copy is missing its timeline and cannot be opened.');

	const specs = new Map(record.columns.map((column) => [column.key, column]));

	return {
		exportId: record.exportId,
		vin: record.vin,
		vmodel: record.vmodel,
		time: new Uint32Array(decompress(time.bytes)),
		keys: record.columns.map((column) => column.key),
		column(key: string): Column | undefined {
			const stored = specs.get(key);
			const blob = byName.get(key);
			if (!stored || !blob) return undefined;
			const spec = specToUse(stored.spec);
			return {
				spec,
				data: viewFor(spec, decompress(blob.bytes)),
				nonNull: stored.nonNull,
				min: stored.min,
				max: stored.max
			};
		},
		available: record.available,
		duplicateRows: record.duplicateRows,
		unsortedStreams: record.unsortedStreams,
		rowsParsed: record.rowsParsed,
		bytesParsed: record.bytesParsed,
		coverage: record.coverage
	};
}

/** Memory one row of this export occupies once inflated. */
export function bytesPerRow(record: ExportRecord): number {
	return record.columns.reduce((sum, column) => sum + DTYPE_BYTES[column.spec.dtype], 4);
}

/**
 * What opening these would cost. Exports overlap — a rolling window requested
 * weekly repeats three weeks of every four — and how much cannot be known
 * without reading the timelines, so this is deliberately an upper bound.
 */
export function estimateOpen(records: ExportRecord[]): { rows: number; bytes: number } {
	let rows = 0;
	let bytes = 0;
	for (const record of records) {
		rows += record.rows;
		bytes += record.rows * bytesPerRow(record);
	}
	return { rows, bytes };
}
