/**
 * Backups: everything kept in this browser, as one file.
 *
 * Storage in a browser is not a safe place to leave the only copy. It can be
 * cleared by the user, evicted under pressure, and on Safari it simply expires
 * after a week of not visiting. So the whole library can be written out as a
 * ZIP and dropped back in anywhere — another browser, another machine, or the
 * same one after a clear-out.
 *
 * The members are already gzipped, so the archive stores them without a second
 * pass. Writing streams through fflate's `Zip`; reading deliberately does not.
 * `Zip` appends a data descriptor after each member, and the streaming reader
 * finds the end of such a member by scanning for the descriptor's signature —
 * four bytes that compressed telemetry produces by chance often enough to
 * matter. `unzipSync` reads the central directory instead, where the real
 * lengths are recorded, so it cannot be fooled.
 */

import { strFromU8, strToU8, unzipSync, Zip, ZipPassThrough } from 'fflate';
import { reviveRecord, RECORD_VERSION, type ExportRecord, type StoredBlob } from './codec';

export const BACKUP_APP = 'xpeng-data-export-browser';
export const BACKUP_FORMAT = 1;
export const MANIFEST = 'manifest.json';

export interface BackupManifest {
	app: string;
	format: number;
	createdAt: string;
	ids: string[];
}

export interface BackupEntry {
	record: ExportRecord;
	blobs: StoredBlob[];
}

export interface BackupContents {
	manifest: BackupManifest;
	entries: BackupEntry[];
	/** Exports the archive holds that this version cannot read. */
	skipped: string[];
}

/** Keeps a member name to characters every filesystem and ZIP tool accepts. */
function safeSegment(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, '_') || 'export';
}

export function backupFileName(count: number, at: Date = new Date()): string {
	const date = at.toISOString().slice(0, 10);
	// No VIN and no vehicle name: a backup often ends up in a shared folder.
	return `xpeng-exports-${count === 1 ? '' : `${count}-`}backup-${date}.zip`;
}

/**
 * The archive, as the chunks fflate emits. Kept as chunks so the caller can
 * hand them to a Blob without ever concatenating a copy of the whole thing.
 */
export function writeBackup(entries: BackupEntry[], at: Date = new Date()): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	let failure: Error | null = null;

	const zip = new Zip((error, data) => {
		if (error) {
			failure = error;
			return;
		}
		if (data.length) chunks.push(data);
	});

	const add = (name: string, data: Uint8Array) => {
		const member = new ZipPassThrough(name);
		zip.add(member);
		member.push(data, true);
	};

	const manifest: BackupManifest = {
		app: BACKUP_APP,
		format: BACKUP_FORMAT,
		createdAt: at.toISOString(),
		ids: entries.map((entry) => entry.record.id)
	};
	add(MANIFEST, strToU8(JSON.stringify(manifest, null, '\t')));

	for (const entry of entries) {
		const folder = `exports/${safeSegment(entry.record.id)}`;
		add(`${folder}/record.json`, strToU8(JSON.stringify(entry.record)));
		for (const blob of entry.blobs) {
			add(`${folder}/${safeSegment(blob.name)}.gz`, new Uint8Array(blob.bytes));
		}
	}

	zip.end();
	if (failure) throw failure;
	return chunks;
}

function parseManifest(bytes: Uint8Array): BackupManifest | null {
	try {
		const manifest = JSON.parse(strFromU8(bytes)) as BackupManifest;
		return manifest?.app === BACKUP_APP ? manifest : null;
	} catch {
		return null;
	}
}

/**
 * Whether a dropped ZIP is one of ours. Only the central directory and the
 * manifest itself are read, so this stays cheap on a file of any size.
 */
export function isBackupArchive(bytes: Uint8Array): boolean {
	try {
		const found = unzipSync(bytes, { filter: (file) => file.name === MANIFEST });
		const manifest = found[MANIFEST];
		return manifest ? parseManifest(manifest) !== null : false;
	} catch {
		return false;
	}
}

export function readBackup(bytes: Uint8Array): BackupContents {
	const files = unzipSync(bytes);
	const manifestBytes = files[MANIFEST];
	const manifest = manifestBytes ? parseManifest(manifestBytes) : null;
	if (!manifest) throw new Error('This ZIP is not a backup made by this app.');
	if (manifest.format !== BACKUP_FORMAT) {
		throw new Error(`This backup was written in a format this version cannot read.`);
	}

	// Grouped by folder rather than by the manifest's ids, so an archive that
	// was repacked by hand still restores what it actually contains.
	const folders = new Map<string, { record?: ExportRecord; blobs: StoredBlob[] }>();
	for (const [path, data] of Object.entries(files)) {
		const match = /^exports\/([^/]+)\/(.+)$/.exec(path);
		if (!match) continue;
		const [, folder, member] = match;
		let group = folders.get(folder);
		if (!group) {
			group = { blobs: [] };
			folders.set(folder, group);
		}
		if (member === 'record.json') {
			group.record = reviveRecord(JSON.parse(strFromU8(data)) as ExportRecord);
		} else if (member.endsWith('.gz')) {
			group.blobs.push({
				id: '',
				name: member.slice(0, -3),
				bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
			});
		}
	}

	const entries: BackupEntry[] = [];
	const skipped: string[] = [];
	for (const group of folders.values()) {
		const record = group.record;
		if (!record) continue;
		if (record.version !== RECORD_VERSION) {
			skipped.push(record.id);
			continue;
		}
		// The id in the record is the truth; the folder name is only a label.
		entries.push({ record, blobs: group.blobs.map((blob) => ({ ...blob, id: record.id })) });
	}

	return { manifest, entries, skipped };
}
