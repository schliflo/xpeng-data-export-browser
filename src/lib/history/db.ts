/**
 * Where kept exports live.
 *
 * IndexedDB, because it is the only browser store that takes tens of megabytes
 * of binary without turning it into text first. Two stores: one row per export
 * holding everything a listing needs, and one row per compressed buffer. The
 * split is what makes the library instant — showing it reads the small store
 * and never touches a byte of telemetry.
 *
 * Every call opens its own connection and closes it again. A connection held
 * open across an idle tab is the classic way to meet Safari's "connection to
 * the Indexed Database server lost", and none of these operations is frequent
 * enough for the handshake to matter.
 */

import type { ExportRecord, StoredBlob } from './codec';

const DB_NAME = 'xpeng-export-browser';
const DB_VERSION = 1;
const EXPORTS = 'exports';
const BLOBS = 'blobs';

/**
 * Resolved on each call rather than at module load: every page here is
 * prerendered in Node, where there is no such thing.
 */
function factory(): IDBFactory | null {
	const scope = globalThis as { indexedDB?: IDBFactory };
	return scope.indexedDB ?? null;
}

export function storageAvailable(): boolean {
	return factory() !== null;
}

/** A readable reason, since these all end up in front of the user. */
function describe(error: DOMException | null): Error {
	const name = error?.name ?? '';
	if (name === 'QuotaExceededError') {
		return new Error('There is no room left in this browser for another export.');
	}
	if (name === 'VersionError') {
		return new Error('Another tab is using a newer version of the local store.');
	}
	return new Error(error?.message || 'This browser would not let the app store anything.');
}

function open(): Promise<IDBDatabase> {
	const idb = factory();
	if (!idb) return Promise.reject(new Error('This browser has no local storage available.'));

	return new Promise((resolve, reject) => {
		let request: IDBOpenDBRequest;
		try {
			request = idb.open(DB_NAME, DB_VERSION);
		} catch (error) {
			// Firefox in a private window throws here rather than failing later.
			reject(error instanceof Error ? error : describe(null));
			return;
		}

		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(EXPORTS)) {
				const store = db.createObjectStore(EXPORTS, { keyPath: 'id' });
				store.createIndex('vin', 'vin');
				store.createIndex('startTime', 'startTime');
			}
			if (!db.objectStoreNames.contains(BLOBS)) {
				const store = db.createObjectStore(BLOBS, { keyPath: ['id', 'name'] });
				store.createIndex('id', 'id');
			}
		};

		request.onsuccess = () => {
			const db = request.result;
			// A future version upgrading in another tab must not be blocked.
			db.onversionchange = () => db.close();
			resolve(db);
		};
		request.onerror = () => reject(describe(request.error));
		request.onblocked = () => reject(new Error('Another tab is holding the local store open.'));
	});
}

async function withDb<T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> {
	const db = await open();
	try {
		return await work(db);
	} finally {
		db.close();
	}
}

function settle<T>(tx: IDBTransaction, value: () => T): Promise<T> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve(value());
		tx.onabort = () => reject(describe(tx.error));
		tx.onerror = () => reject(describe(tx.error));
	});
}

/**
 * Writes one export, replacing any copy already stored under the same id.
 *
 * Every buffer must be compressed before this is called: a transaction commits
 * as soon as it runs out of pending requests, and an `await` in the middle of
 * one ends it. The deletes are issued from inside a read that is still open,
 * so they are guaranteed to be processed before the writes that follow.
 */
export async function putExport(
	record: ExportRecord,
	blobs: StoredBlob[]
): Promise<{ replaced: boolean }> {
	return withDb((db) => {
		const tx = db.transaction([EXPORTS, BLOBS], 'readwrite');
		const exports = tx.objectStore(EXPORTS);
		const store = tx.objectStore(BLOBS);
		let replaced = false;

		const existing = exports.getKey(record.id);
		existing.onsuccess = () => {
			replaced = existing.result !== undefined;
		};

		// An export re-dropped after a column was renamed would otherwise leave
		// the old buffer behind, taking up room nothing can read.
		const stale = store.index('id').getAllKeys(IDBKeyRange.only(record.id));
		stale.onsuccess = () => {
			for (const key of stale.result) store.delete(key);
			exports.put(record);
			for (const blob of blobs) store.put(blob);
		};

		return settle(tx, () => ({ replaced }));
	});
}

/** Every kept export, oldest first. Buffers are not read. */
export async function listExports(): Promise<ExportRecord[]> {
	return withDb((db) => {
		const tx = db.transaction(EXPORTS, 'readonly');
		const request = tx.objectStore(EXPORTS).index('startTime').getAll();
		return settle(tx, () => request.result as ExportRecord[]);
	});
}

export async function getExport(
	id: string
): Promise<{ record: ExportRecord; blobs: StoredBlob[] } | null> {
	return withDb((db) => {
		const tx = db.transaction([EXPORTS, BLOBS], 'readonly');
		const record = tx.objectStore(EXPORTS).get(id);
		const blobs = tx.objectStore(BLOBS).index('id').getAll(IDBKeyRange.only(id));
		return settle(tx, () => {
			const found = record.result as ExportRecord | undefined;
			return found ? { record: found, blobs: blobs.result as StoredBlob[] } : null;
		});
	});
}

export async function deleteExports(ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	return withDb((db) => {
		const tx = db.transaction([EXPORTS, BLOBS], 'readwrite');
		const exports = tx.objectStore(EXPORTS);
		const store = tx.objectStore(BLOBS);

		for (const id of ids) {
			exports.delete(id);
			const keys = store.index('id').getAllKeys(IDBKeyRange.only(id));
			keys.onsuccess = () => {
				for (const key of keys.result) store.delete(key);
			};
		}

		return settle(tx, () => undefined);
	});
}

export async function clearExports(): Promise<void> {
	return withDb((db) => {
		const tx = db.transaction([EXPORTS, BLOBS], 'readwrite');
		tx.objectStore(EXPORTS).clear();
		tx.objectStore(BLOBS).clear();
		return settle(tx, () => undefined);
	});
}
