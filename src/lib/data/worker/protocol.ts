/**
 * Messages exchanged with the data worker.
 *
 * Parsing and analysis both happen off the main thread, and the column buffers
 * come back as transferables so a 50 MB dataset moves without being copied.
 * Typed arrays cannot survive structured cloning with their `spec` attached, so
 * columns travel as plain descriptors and are reassembled on arrival.
 */

import type { ColumnSpec, TypedArray } from '../schema/columns';
import type { Column, CoverageWindow, Dataset } from '../store/columnar';
import type { DerivedData } from '../analytics';
import type { StreamId } from '../schema/streams';

export interface PackedColumn {
	spec: ColumnSpec;
	buffer: ArrayBuffer;
	nonNull: number;
	min: number;
	max: number;
}

export interface PackedDataset {
	timeBuffer: ArrayBuffer;
	columns: PackedColumn[];
	vin: string;
	vmodel: string;
	exportId: string;
	available: Record<StreamId, boolean>;
	duplicateRows: number;
	unsortedStreams: string[];
	emptyColumns: string[];
	rowsParsed: number;
	bytesParsed: number;
	aligned: boolean;
	coverage?: CoverageWindow[];
}

/**
 * What became of the copy the browser tries to keep. Storage can be refused —
 * private windows, a full disk — and that must never cost the user the export
 * they just waited for, so the outcome is reported rather than thrown.
 */
export type KeptOutcome =
	{ ok: true; id: string; bytes: number; replaced: boolean } | { ok: false; reason: string };

export type WorkerRequest =
	| { type: 'parse'; files: File[]; timeZone: string }
	| { type: 'demo'; seed: number; timeZone: string; awd: boolean }
	| { type: 'open'; ids: string[]; timeZone: string }
	| { type: 'backup'; ids: string[] };

export type WorkerResponse =
	| {
			type: 'progress';
			phase: ParsePhase;
			stream?: StreamId;
			loaded: number;
			total: number;
			detail?: string;
	  }
	| { type: 'ready'; dataset: PackedDataset; derived: DerivedData; kept: KeptOutcome | null }
	| { type: 'restored'; ids: string[]; skipped: string[] }
	| { type: 'backup'; chunks: Uint8Array[]; name: string }
	| { type: 'error'; message: string; hint?: string };

export type ParsePhase =
	| 'reading'
	| 'parsing'
	| 'joining'
	| 'analyzing'
	| 'generating'
	| 'storing'
	| 'loading'
	| 'merging'
	| 'packing'
	| 'restoring';

export const PHASE_LABELS: Record<ParsePhase, string> = {
	reading: 'Reading files',
	parsing: 'Parsing signals',
	joining: 'Lining up the timeline',
	analyzing: 'Finding patterns',
	generating: 'Building demo data',
	storing: 'Keeping a copy in this browser',
	loading: 'Reading the kept export',
	merging: 'Joining the timelines',
	packing: 'Packing the backup',
	restoring: 'Restoring from the backup'
};

/** Detaches a dataset's buffers for transfer to the main thread. */
export function packDataset(dataset: Dataset): { packed: PackedDataset; transfer: ArrayBuffer[] } {
	const transfer: ArrayBuffer[] = [];
	const timeBuffer = sliceBuffer(dataset.time);
	transfer.push(timeBuffer);

	const columns: PackedColumn[] = [];
	for (const column of dataset.columns.values()) {
		const buffer = sliceBuffer(column.data);
		transfer.push(buffer);
		columns.push({
			spec: column.spec,
			buffer,
			nonNull: column.nonNull,
			min: column.min,
			max: column.max
		});
	}

	return {
		packed: {
			timeBuffer,
			columns,
			vin: dataset.vin,
			vmodel: dataset.vmodel,
			exportId: dataset.exportId,
			available: dataset.available,
			duplicateRows: dataset.duplicateRows,
			unsortedStreams: dataset.unsortedStreams,
			emptyColumns: dataset.emptyColumns,
			rowsParsed: dataset.rowsParsed,
			bytesParsed: dataset.bytesParsed,
			aligned: dataset.aligned,
			coverage: dataset.coverage
		},
		transfer
	};
}

/**
 * The standalone buffer behind a view. Builders hand back subarrays of an
 * oversized buffer and those must be copied, but a merged or decoded column
 * already owns its buffer exactly — copying it there would briefly double the
 * memory of a dataset that may already be a gigabyte.
 */
function sliceBuffer(view: ArrayBufferView): ArrayBuffer {
	if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
		return view.buffer as ArrayBuffer;
	}
	return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

export function unpackDataset(packed: PackedDataset): Dataset {
	const columns = new Map<string, Column>();
	for (const entry of packed.columns) {
		columns.set(entry.spec.key, {
			spec: entry.spec,
			data: viewFor(entry.spec, entry.buffer),
			nonNull: entry.nonNull,
			min: entry.min,
			max: entry.max
		});
	}
	return {
		time: new Uint32Array(packed.timeBuffer),
		columns,
		vin: packed.vin,
		vmodel: packed.vmodel,
		exportId: packed.exportId,
		available: packed.available,
		duplicateRows: packed.duplicateRows,
		unsortedStreams: packed.unsortedStreams,
		emptyColumns: packed.emptyColumns,
		rowsParsed: packed.rowsParsed,
		bytesParsed: packed.bytesParsed,
		aligned: packed.aligned,
		coverage: packed.coverage
	};
}

/** The typed-array view a column's raw bytes should be read through. */
export function viewFor(spec: ColumnSpec, buffer: ArrayBuffer): TypedArray {
	switch (spec.dtype) {
		case 'u8':
			return new Uint8Array(buffer);
		case 'i8':
			return new Int8Array(buffer);
		case 'u16':
			return new Uint16Array(buffer);
		case 'i16':
			return new Int16Array(buffer);
		case 'u32':
			return new Uint32Array(buffer);
		case 'f32':
			return new Float32Array(buffer);
	}
}
