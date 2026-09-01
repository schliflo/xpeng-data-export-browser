/**
 * Main-thread half of the worker conversation.
 *
 * Wraps the message passing in promises and a progress callback, so the rest of
 * the app can await a dataset without knowing a worker exists.
 */

import DataWorker from './worker/data.worker?worker';
import {
	unpackDataset,
	type PackedDataset,
	type ParsePhase,
	type WorkerRequest,
	type WorkerResponse
} from './worker/protocol';
import type { DerivedData } from './analytics';
import type { Dataset } from './store/columnar';

export interface LoadProgress {
	phase: ParsePhase;
	loaded: number;
	total: number;
	detail?: string;
}

export interface LoadResult {
	dataset: Dataset;
	derived: DerivedData;
}

export class DataLoadError extends Error {
	constructor(
		message: string,
		readonly hint?: string
	) {
		super(message);
		this.name = 'DataLoadError';
	}
}

function run(
	request: WorkerRequest,
	onProgress?: (progress: LoadProgress) => void
): Promise<LoadResult> {
	return new Promise((resolve, reject) => {
		const worker = new DataWorker();

		const cleanup = () => {
			worker.onmessage = null;
			worker.terminate();
		};

		worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			const message = event.data;
			switch (message.type) {
				case 'progress':
					onProgress?.({
						phase: message.phase,
						loaded: message.loaded,
						total: message.total,
						detail: message.detail
					});
					break;
				case 'ready':
					resolve({
						dataset: unpackDataset(message.dataset as PackedDataset),
						derived: message.derived
					});
					cleanup();
					break;
				case 'error':
					reject(new DataLoadError(message.message, message.hint));
					cleanup();
					break;
			}
		};

		worker.onerror = (event) => {
			reject(new DataLoadError(event.message || 'The data worker stopped unexpectedly.'));
			cleanup();
		};

		worker.postMessage(request);
	});
}

export function loadFiles(
	files: File[],
	timeZone: string,
	onProgress?: (progress: LoadProgress) => void
): Promise<LoadResult> {
	// Copied into a plain array first: a list held in reactive state is a
	// Proxy, and postMessage cannot clone one — it fails with "could not be
	// cloned" and the upload silently does nothing.
	return run({ type: 'parse', files: Array.from(files), timeZone }, onProgress);
}

export function loadDemo(
	timeZone: string,
	onProgress?: (progress: LoadProgress) => void,
	options: { seed?: number; awd?: boolean } = {}
): Promise<LoadResult> {
	return run(
		{ type: 'demo', seed: options.seed ?? 20260901, awd: options.awd ?? true, timeZone },
		onProgress
	);
}
