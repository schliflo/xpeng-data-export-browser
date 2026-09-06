// Loaded before anything reaches for a database: these tests run in Node,
// which has no IndexedDB of its own.
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';
import type { ExportRecord, StoredBlob } from './codec';
import { clearExports, deleteExports, getExport, listExports, putExport } from './db';

function record(id: string, overrides: Partial<ExportRecord> = {}): ExportRecord {
	return {
		id,
		version: 1,
		exportId: id,
		vin: 'L1NTEST00000000001',
		vmodel: 'F30b',
		keptAt: 1_788_000_000_000,
		isDemo: false,
		startTime: 1_785_600_000,
		endTime: 1_785_686_400,
		rows: 2,
		days: 1,
		distanceKm: 12.5,
		trips: 3,
		storedBytes: 64,
		columns: [],
		available: { status: true, operation: true, power: true },
		duplicateRows: 0,
		unsortedStreams: [],
		emptyColumns: [],
		rowsParsed: 2,
		bytesParsed: 0,
		aligned: true,
		coverage: [{ startTime: 1_785_600_000, endTime: 1_785_686_400, exportId: id }],
		...overrides
	};
}

function blob(id: string, name: string, fill: number): StoredBlob {
	return { id, name, bytes: new Uint8Array([fill, fill, fill]).buffer as ArrayBuffer };
}

beforeEach(async () => {
	await clearExports();
});

describe('putExport', () => {
	it('stores an export with its buffers and reads them back', async () => {
		const result = await putExport(record('DA-a'), [
			blob('DA-a', '_time', 1),
			blob('DA-a', 'esp_vehspd', 2)
		]);

		expect(result.replaced).toBe(false);

		const found = await getExport('DA-a');
		expect(found?.record.distanceKm).toBe(12.5);
		expect(found?.blobs).toHaveLength(2);
		expect(new Uint8Array(found!.blobs.find((b) => b.name === 'esp_vehspd')!.bytes)).toEqual(
			new Uint8Array([2, 2, 2])
		);
	});

	it('replaces an export kept under the same id, leaving no stale buffers', async () => {
		await putExport(record('DA-a'), [blob('DA-a', '_time', 1), blob('DA-a', 'gone_signal', 9)]);
		const again = await putExport(record('DA-a', { trips: 7 }), [blob('DA-a', '_time', 3)]);

		expect(again.replaced).toBe(true);

		const found = await getExport('DA-a');
		expect(found?.record.trips).toBe(7);
		expect(found?.blobs.map((b) => b.name)).toEqual(['_time']);
		expect(new Uint8Array(found!.blobs[0].bytes)).toEqual(new Uint8Array([3, 3, 3]));
	});

	it('keeps exports from different vehicles side by side', async () => {
		await putExport(record('DA-a'), [blob('DA-a', '_time', 1)]);
		await putExport(record('DA-b', { vin: 'L1NOTHER0000000002', startTime: 1_785_000_000 }), [
			blob('DA-b', '_time', 2)
		]);

		const all = await listExports();
		expect(all.map((entry) => entry.id)).toEqual(['DA-b', 'DA-a']);
		expect(new Set(all.map((entry) => entry.vin)).size).toBe(2);
	});
});

describe('listExports', () => {
	it('returns them oldest first and never touches a buffer', async () => {
		await putExport(record('DA-late', { startTime: 1_786_000_000 }), [blob('DA-late', '_time', 1)]);
		await putExport(record('DA-early', { startTime: 1_780_000_000 }), [
			blob('DA-early', '_time', 1)
		]);

		const all = await listExports();

		expect(all.map((entry) => entry.id)).toEqual(['DA-early', 'DA-late']);
		expect(all[0]).not.toHaveProperty('bytes');
	});

	it('is empty when nothing has been kept', async () => {
		expect(await listExports()).toEqual([]);
	});
});

describe('deleteExports', () => {
	it('removes the record and its buffers, leaving the rest alone', async () => {
		await putExport(record('DA-a'), [blob('DA-a', '_time', 1), blob('DA-a', 'esp_vehspd', 2)]);
		await putExport(record('DA-b', { startTime: 1_786_000_000 }), [blob('DA-b', '_time', 3)]);

		await deleteExports(['DA-a']);

		expect(await getExport('DA-a')).toBeNull();
		expect((await listExports()).map((entry) => entry.id)).toEqual(['DA-b']);
		expect((await getExport('DA-b'))?.blobs).toHaveLength(1);
	});
});

describe('clearExports', () => {
	it('empties the library completely', async () => {
		await putExport(record('DA-a'), [blob('DA-a', '_time', 1)]);
		await clearExports();

		expect(await listExports()).toEqual([]);
		expect(await getExport('DA-a')).toBeNull();
	});
});
