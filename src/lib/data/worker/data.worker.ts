/**
 * The data worker.
 *
 * Everything expensive happens here: reading 340 MB of CSV, building the
 * columnar store and running every analysis. The main thread receives only the
 * finished buffers and a small object of results, so the interface stays
 * responsive while a month of telemetry is being chewed through.
 */

import { analyze } from '../analytics';
import { combineStreams } from '../parse/align';
import { parseStream } from '../parse/ingest';
import { expandDroppedFiles } from '../parse/zip';
import { recognizeFiles, STREAM_LABELS, type StreamId } from '../schema/streams';
import { generateDemoDataset } from '../../demo/generator';
import { packDataset, type WorkerRequest, type WorkerResponse } from './protocol';
import type { Dataset } from '../store/columnar';

let current: Dataset | null = null;

function post(message: WorkerResponse, transfer?: Transferable[]) {
	self.postMessage(message, { transfer: transfer ?? [] });
}

async function handleParse(files: File[], timeZone: string) {
	post({ type: 'progress', phase: 'reading', loaded: 0, total: 1 });

	const expanded = await expandDroppedFiles(files);
	const plan = recognizeFiles(expanded);
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

	finish(dataset, timeZone);
}

function finish(dataset: Dataset, timeZone: string) {
	post({ type: 'progress', phase: 'analyzing', loaded: 1, total: 1 });
	const derived = analyze(dataset, timeZone);
	current = dataset;
	const { packed, transfer } = packDataset(dataset);
	post({ type: 'ready', dataset: packed, derived }, transfer);
	// The buffers were detached by the transfer, so the worker's own copy is
	// gone; keep only what a re-analysis would need.
	current = null;
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
				finish(dataset, request.timeZone);
				break;
			}
			case 'retime': {
				if (!current) return;
				post({ type: 'derived', derived: analyze(current, request.timeZone) });
				break;
			}
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
