import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { analyze } from '../data/analytics';
import { packDataset } from '../data/worker/protocol';
import { generateDemoDataset } from '../demo/generator';
import { encodeExport, RECORD_VERSION } from './codec';
import {
	BACKUP_FORMAT,
	backupFileName,
	isBackupArchive,
	readBackup,
	writeBackup,
	type BackupEntry
} from './archive';

const ZONE = 'Europe/Berlin';

function entry(seed = 7): BackupEntry {
	const dataset = generateDemoDataset({ seed, days: 3, timeZone: ZONE });
	const derived = analyze(dataset, ZONE);
	const { packed } = packDataset(dataset);
	return encodeExport(packed, derived, true);
}

function archive(entries: BackupEntry[]): Uint8Array {
	const chunks = writeBackup(entries, new Date('2026-09-04T10:00:00Z'));
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

describe('writeBackup', () => {
	it('round-trips every export it was given', () => {
		const first = entry(7);
		const second = entry(21);
		const bytes = archive([first, second]);

		expect(isBackupArchive(bytes)).toBe(true);

		const contents = readBackup(bytes);
		expect(contents.manifest.format).toBe(BACKUP_FORMAT);
		expect(contents.manifest.ids).toEqual([first.record.id, second.record.id]);
		expect(contents.skipped).toEqual([]);
		expect(contents.entries).toHaveLength(2);

		const restored = contents.entries.find((e) => e.record.id === first.record.id)!;
		expect(restored.record).toEqual(first.record);
		expect(restored.blobs).toHaveLength(first.blobs.length);

		for (const blob of first.blobs) {
			const back = restored.blobs.find((b) => b.name === blob.name)!;
			expect(back.id).toBe(first.record.id);
			expect(new Uint8Array(back.bytes)).toEqual(new Uint8Array(blob.bytes));
		}
	});

	it('names the file by date and count, and never by vehicle', () => {
		const name = backupFileName(3, new Date('2026-09-04T10:00:00Z'));

		expect(name).toBe('xpeng-exports-3-backup-2026-09-04.zip');
		expect(backupFileName(1, new Date('2026-09-04T10:00:00Z'))).toBe(
			'xpeng-exports-backup-2026-09-04.zip'
		);
	});
});

describe('isBackupArchive', () => {
	it('rejects an ordinary ZIP of export CSVs', () => {
		const zip = zipSync({
			'DA123_dwd_opp_gdpr_veh_driving_status_di.csv': strToU8('vin,vmodel,timer\n')
		});

		expect(isBackupArchive(zip)).toBe(false);
	});

	it('rejects bytes that are not a ZIP at all', () => {
		expect(isBackupArchive(strToU8('not an archive'))).toBe(false);
	});
});

describe('readBackup', () => {
	it('skips an export written in a format it cannot read', () => {
		const only = entry(7);
		const future: BackupEntry = {
			record: { ...only.record, version: RECORD_VERSION + 1 },
			blobs: only.blobs
		};

		const contents = readBackup(archive([future]));

		expect(contents.entries).toEqual([]);
		expect(contents.skipped).toEqual([future.record.id]);
	});

	it('refuses a ZIP that is not one of ours', () => {
		const zip = zipSync({ 'notes.txt': strToU8('hello') });

		expect(() => readBackup(zip)).toThrow(/not a backup/);
	});
});
