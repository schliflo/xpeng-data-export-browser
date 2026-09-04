/**
 * The data worker.
 *
 * Everything expensive happens here: reading 340 MB of CSV, building the
 * columnar store, running every analysis, and compressing the result so the
 * browser can keep it. The main thread receives only the finished buffers and
 * a small object of results, so the interface stays responsive while a month
 * of telemetry is being chewed through.
 *
 * Keeping a copy happens before the buffers are handed over, while this side
 * still owns them. It is also allowed to fail: a private window or a full disk
 * must cost the user the copy, never the export they just waited for.
 */

import { analyze } from '../analytics';
import { combineStreams } from '../parse/align';
import { mergeSources } from '../parse/merge';
import { parseStream } from '../parse/ingest';
import { expandDroppedFiles } from '../parse/zip';
import { recognizeFiles, STREAM_LABELS, type StreamId } from '../schema/streams';
import { generateDemoDataset } from '../../demo/generator';
import { backupFileName, readBackup, writeBackup, type BackupEntry } from '../../history/archive';
import { decodeExport, encodeExport, sourceFromExport } from '../../history/codec';
import { getExport, putExport, storageAvailable } from '../../history/db';
import {
	packDataset,
	unpackDataset,
	type KeptOutcome,
	type WorkerRequest,
	type WorkerResponse
} from './protocol';
import type { DerivedData } from '../analytics';
import type { PackedDataset } from './protocol';
import type { Dataset } from '../store/columnar';

function post(message: WorkerResponse, transfer?: Transferable[]) {
	self.postMessage(message, { transfer: transfer ?? [] });
}

/** Stores the export, reporting rather than throwing when it cannot. */
async function keep(
	packed: PackedDataset,
	derived: DerivedData,
	isDemo: boolean
): Promise<KeptOutcome> {
	if (!storageAvailable()) {
		return { ok: false, reason: 'This browser does not offer local storage to the page.' };
	}
	try {
		post({ type: 'progress', phase: 'storing', loaded: 0, total: 1 });
		const { record, blobs } = encodeExport(packed, derived, isDemo);
		const { replaced } = await putExport(record, blobs);
		return { ok: true, id: record.id, bytes: record.storedBytes, replaced };
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : 'The copy could not be kept.'
		};
	}
}

async function finish(dataset: Dataset, timeZone: string, isDemo: boolean) {
	post({ type: 'progress', phase: 'analyzing', loaded: 1, total: 1 });
	const derived = analyze(dataset, timeZone);
	const { packed, transfer } = packDataset(dataset);
	const kept = await keep(packed, derived, isDemo);
	post({ type: 'ready', dataset: packed, derived, kept }, transfer);
}

async function handleParse(files: File[], timeZone: string) {
	post({ type: 'progress', phase: 'reading', loaded: 0, total: 1 });

	const dropped = await expandDroppedFiles(files);

	if (dropped.backups.length) {
		if (dropped.files.length) {
			post({
				type: 'error',
				message: 'A backup has to be restored on its own.',
				hint: 'Drop the backup by itself, then drop the export files afterwards.'
			});
			return;
		}
		await handleRestore(dropped.backups);
		return;
	}

	const plan = recognizeFiles(dropped.files);
	const streams = Object.keys(plan.streams) as StreamId[];

	if (streams.length === 0) {
		post({
			type: 'error',
			message: 'No XPeng export files found.',
			hint: plan.unrecognized.length
				? `Files like "${plan.unrecognized[0]}" do not match the export naming scheme. Look for names containing "dwd_opp_gdpr_veh".`
				: 'Drop the CSV files from your export, or the ZIP exactly as you downloaded it.'
		});
		return;
	}

	const results = [];
	for (const stream of streams) {
		const files = plan.streams[stream]!;
		results.push(
			await parseStream(files, stream, ({ bytesRead, totalBytes }) => {
				post({
					type: 'progress',
					phase: 'parsing',
					stream,
					loaded: bytesRead,
					total: totalBytes,
					detail: STREAM_LABELS[stream]
				});
			})
		);
	}

	post({ type: 'progress', phase: 'joining', loaded: 1, total: 1 });
	const dataset = combineStreams(results, plan.exportIds[0] ?? 'export');

	if (dataset.time.length === 0) {
		post({
			type: 'error',
			message: 'The files were readable but contained no samples.',
			hint: 'They may be empty, or truncated during download.'
		});
		return;
	}

	await finish(dataset, timeZone, false);
}

async function handleRestore(backups: Uint8Array[]) {
	post({ type: 'progress', phase: 'restoring', loaded: 0, total: 1 });
	const ids: string[] = [];
	const skipped: string[] = [];

	for (const bytes of backups) {
		const contents = readBackup(bytes);
		skipped.push(...contents.skipped);
		for (let i = 0; i < contents.entries.length; i++) {
			const entry = contents.entries[i];
			post({
				type: 'progress',
				phase: 'restoring',
				loaded: i,
				total: contents.entries.length
			});
			await putExport(entry.record, entry.blobs);
			ids.push(entry.record.id);
		}
	}

	post({ type: 'restored', ids, skipped });
}

async function handleOpen(ids: string[], timeZone: string) {
	const found: BackupEntry[] = [];
	for (let i = 0; i < ids.length; i++) {
		post({ type: 'progress', phase: 'loading', loaded: i, total: ids.length });
		const entry = await getExport(ids[i]);
		if (entry) found.push(entry);
	}

	if (found.length === 0) {
		post({
			type: 'error',
			message: 'That export is no longer kept in this browser.',
			hint: 'It may have been removed, or the browser may have cleared its storage.'
		});
		return;
	}

	let dataset: Dataset;
	if (found.length === 1) {
		dataset = unpackDataset(decodeExport(found[0].record, found[0].blobs));
	} else {
		post({ type: 'progress', phase: 'merging', loaded: 1, total: 1 });
		dataset = mergeSources(found.map((entry) => sourceFromExport(entry.record, entry.blobs)));
	}

	post({ type: 'progress', phase: 'analyzing', loaded: 1, total: 1 });
	const derived = analyze(dataset, timeZone);
	const { packed, transfer } = packDataset(dataset);
	post({ type: 'ready', dataset: packed, derived, kept: null }, transfer);
}

async function handleBackup(ids: string[]) {
	const entries: BackupEntry[] = [];
	for (let i = 0; i < ids.length; i++) {
		post({ type: 'progress', phase: 'packing', loaded: i, total: ids.length });
		const entry = await getExport(ids[i]);
		if (entry) entries.push(entry);
	}

	if (entries.length === 0) {
		post({ type: 'error', message: 'There is nothing kept in this browser to back up.' });
		return;
	}

	const chunks = writeBackup(entries);
	// Buffers can repeat across chunks, and a transfer list may not.
	const transfer = [...new Set(chunks.map((chunk) => chunk.buffer as ArrayBuffer))];
	post({ type: 'backup', chunks, name: backupFileName(entries.length) }, transfer);
}

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
	const request = event.data;
	try {
		switch (request.type) {
			case 'parse':
				await handleParse(request.files, request.timeZone);
				break;
			case 'demo': {
				post({ type: 'progress', phase: 'generating', loaded: 0, total: 1 });
				const dataset = generateDemoDataset({
					seed: request.seed,
					awd: request.awd,
					timeZone: request.timeZone
				});
				await finish(dataset, request.timeZone, true);
				break;
			}
			case 'open':
				await handleOpen(request.ids, request.timeZone);
				break;
			case 'backup':
				await handleBackup(request.ids);
				break;
		}
	} catch (error) {
		post({
			type: 'error',
			message:
				error instanceof Error ? error.message : 'Something went wrong while reading the export.',
			hint: 'If the files came from a ZIP, try extracting them and dropping the CSVs directly.'
		});
	}
});
