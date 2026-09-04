/**
 * Main-thread half of the worker conversation.
 *
 * Wraps the message passing in promises and a progress callback, so the rest of
 * the app can await a dataset without knowing a worker exists. A request ends
 * in exactly one of three ways — a dataset, a restored library, or an archive —
 * and each entry point narrows to the one its caller asked for.
 */

// Inlined into the bundle rather than emitted as a file of its own: Vite
// leaves web workers out of the manifest the service worker precaches from,
// and the parser is the one thing the app cannot do without offline.
import DataWorker from './worker/data.worker?worker&inline';
import {
	unpackDataset,
	type KeptOutcome,
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

export interface DatasetResult {
	kind: 'dataset';
	dataset: Dataset;
	derived: DerivedData;
	/** What became of the copy kept in this browser; null when reopening one. */
	kept: KeptOutcome | null;
}

export interface RestoreResult {
	kind: 'restored';
	ids: string[];
	skipped: string[];
}

export interface BackupResult {
	kind: 'backup';
	blob: Blob;
	name: string;
}

export type WorkerResult = DatasetResult | RestoreResult | BackupResult;

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
): Promise<WorkerResult> {
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
						kind: 'dataset',
						dataset: unpackDataset(message.dataset as PackedDataset),
						derived: message.derived,
						kept: message.kept
					});
					cleanup();
					break;
				case 'restored':
					resolve({ kind: 'restored', ids: message.ids, skipped: message.skipped });
					cleanup();
					break;
				case 'backup':
					resolve({
						kind: 'backup',
						blob: new Blob(message.chunks as BlobPart[], { type: 'application/zip' }),
						name: message.name
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

function expect<T extends WorkerResult>(result: WorkerResult, kind: T['kind']): T {
	if (result.kind !== kind) throw new DataLoadError('The data worker answered unexpectedly.');
	return result as T;
}

export async function loadFiles(
	files: File[],
	timeZone: string,
	onProgress?: (progress: LoadProgress) => void
): Promise<DatasetResult | RestoreResult> {
	// Copied into a plain array first: a list held in reactive state is a
	// Proxy, and postMessage cannot clone one — it fails with "could not be
	// cloned" and the upload silently does nothing.
	const result = await run({ type: 'parse', files: Array.from(files), timeZone }, onProgress);
	if (result.kind === 'backup') throw new DataLoadError('The data worker answered unexpectedly.');
	return result;
}

export async function loadDemo(
	timeZone: string,
	onProgress?: (progress: LoadProgress) => void,
	options: { seed?: number; awd?: boolean } = {}
): Promise<DatasetResult> {
	const result = await run(
		{ type: 'demo', seed: options.seed ?? 20260901, awd: options.awd ?? true, timeZone },
		onProgress
	);
	return expect<DatasetResult>(result, 'dataset');
}

/** Reopens one kept export, or merges several into a single timeline. */
export async function openKept(
	ids: string[],
	timeZone: string,
	onProgress?: (progress: LoadProgress) => void
): Promise<DatasetResult> {
	const result = await run({ type: 'open', ids: Array.from(ids), timeZone }, onProgress);
	return expect<DatasetResult>(result, 'dataset');
}

export async function backupKept(
	ids: string[],
	onProgress?: (progress: LoadProgress) => void
): Promise<BackupResult> {
	const result = await run({ type: 'backup', ids: Array.from(ids) }, onProgress);
	return expect<BackupResult>(result, 'backup');
}
