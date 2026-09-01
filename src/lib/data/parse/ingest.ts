/**
 * Turns the CSV lines of one stream into columnar arrays.
 *
 * Responsibilities beyond plain parsing:
 *  - concatenating the `_partN` chunks into a single continuous series
 *  - dropping exact repeat rows (the export pipeline replays batches, so a few
 *    thousand rows per file arrive twice with an identical timestamp)
 *  - mapping CAN "not available" sentinels to null via the column registry
 *  - counting how many readings each column actually carried, so signals this
 *    car never reports can be hidden instead of drawn as empty charts
 */

import { COLUMNS, columnsForStream, unknownColumnSpec, type ColumnSpec } from '../schema/columns';
import type { RecognizedFile, StreamId } from '../schema/streams';
import { ColumnBuilder, TimeBuilder, type Column } from '../store/columnar';
import { parseField, parseHeader, readLines } from './csv';
import { orderRows } from './order';

export interface StreamParseResult {
	stream: StreamId;
	time: Uint32Array;
	columns: Map<string, Column>;
	vin: string;
	vmodel: string;
	duplicateRows: number;
	/** True when the source file had to be reordered before use. */
	wasUnsorted: boolean;
	rows: number;
	bytes: number;
}

export interface IngestProgress {
	stream: StreamId;
	bytesRead: number;
	totalBytes: number;
	rows: number;
}

/** Average bytes per source row, used to pre-size the builders. */
const BYTES_PER_ROW_ESTIMATE = 95;

export async function parseStream(
	files: RecognizedFile[],
	stream: StreamId,
	onProgress?: (progress: IngestProgress) => void
): Promise<StreamParseResult> {
	const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);
	const capacity = Math.max(1024, Math.ceil(totalBytes / BYTES_PER_ROW_ESTIMATE));

	const timeBuilder = new TimeBuilder(capacity);
	const builders = new Map<string, ColumnBuilder>();
	// Known columns are created up front so a signal that is absent from this
	// export still exists (all null) rather than vanishing from the UI.
	for (const spec of columnsForStream(stream)) {
		builders.set(spec.key, new ColumnBuilder(spec, capacity));
	}

	let vin = '';
	let vmodel = '';
	let duplicateRows = 0;
	let rows = 0;
	let bytesBefore = 0;

	for (const { file } of files) {
		let header: string[] | null = null;
		let fieldPlan: (ColumnBuilder | null)[] = [];
		// Builders with no field in this chunk's header; padded once per row.
		let absentBuilders: ColumnBuilder[] = [];
		let vinIndex = -1;
		let vmodelIndex = -1;
		let timerIndex = -1;

		for await (const line of readLines(file, {
			onProgress: onProgress
				? (bytesRead) =>
						onProgress({
							stream,
							bytesRead: bytesBefore + bytesRead,
							totalBytes,
							rows
						})
				: undefined
		})) {
			if (header === null) {
				header = parseHeader(line);
				vinIndex = header.indexOf('vin');
				vmodelIndex = header.indexOf('vmodel');
				timerIndex = header.indexOf('timer');
				if (timerIndex === -1) {
					throw new Error(`${file.name} has no "timer" column — is this an XPeng export?`);
				}
				// Resolve each field position to its builder once per file, so the
				// hot loop never touches the header again. Column order is not
				// assumed to be stable between exports.
				fieldPlan = header.map((name) => {
					if (name === 'vin' || name === 'vmodel' || name === 'timer' || name === 'ds') {
						return null;
					}
					let builder = builders.get(name);
					if (!builder) {
						const spec: ColumnSpec = COLUMNS.get(name) ?? unknownColumnSpec(name, stream);
						builder = new ColumnBuilder(spec, capacity);
						builders.set(name, builder);
						// Backfill so a column first seen in a later chunk stays aligned.
						for (let i = 0; i < timeBuilder.size; i++) builder.pushNull();
					}
					return builder;
				});
				const present = new Set(fieldPlan.filter((b): b is ColumnBuilder => b !== null));
				absentBuilders = [...builders.values()].filter((b) => !present.has(b));
				continue;
			}

			const fields = line.split(',');
			const t = Number(fields[timerIndex]);
			if (!Number.isFinite(t)) continue;

			if (!vin && vinIndex !== -1) vin = fields[vinIndex] ?? '';
			if (!vmodel && vmodelIndex !== -1) vmodel = fields[vmodelIndex] ?? '';

			timeBuilder.push(t);
			for (let i = 0; i < fieldPlan.length; i++) {
				const builder = fieldPlan[i];
				if (builder) builder.push(parseField(fields[i] ?? ''));
			}
			// Columns absent from this chunk's header still need a slot.
			for (let i = 0; i < absentBuilders.length; i++) absentBuilders[i].pushNull();
			rows++;
		}

		bytesBefore += file.size;
	}

	// The export is only mostly sorted and does repeat rows, so the timeline is
	// put straight here rather than assumed during the read.
	const rawTime = timeBuilder.finish();
	const order = orderRows(rawTime, rawTime.length);
	duplicateRows = order.duplicates;

	const time = new Uint32Array(order.keep.length);
	for (let i = 0; i < order.keep.length; i++) time[i] = rawTime[order.keep[i]];

	const columns = new Map<string, Column>();
	for (const [key, builder] of builders) {
		columns.set(key, builder.gather(order.keep));
	}

	return {
		stream,
		time,
		columns,
		vin,
		vmodel,
		duplicateRows,
		wasUnsorted: order.wasUnsorted,
		rows,
		bytes: totalBytes
	};
}
