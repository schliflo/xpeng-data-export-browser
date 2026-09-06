import { describe, expect, it } from 'vitest';
import { COLUMNS, type ColumnSpec } from '../schema/columns';
import {
	coalesceWindows,
	ColumnBuilder,
	valueAt,
	type Column,
	type Dataset
} from '../store/columnar';
import { mergeDatasets } from './merge';

/** Builds a dataset from per-second column values; `null` means no reading. */
function makeDataset(
	seconds: number[],
	columns: Record<string, (number | null)[]>,
	overrides: Partial<Dataset> = {}
): Dataset {
	const built = new Map<string, Column>();
	for (const [key, values] of Object.entries(columns)) {
		const spec = COLUMNS.get(key) as ColumnSpec;
		const builder = new ColumnBuilder(spec, values.length);
		for (const value of values) builder.push(value === null ? NaN : value);
		built.set(key, builder.finish());
	}
	return {
		time: new Uint32Array(seconds),
		columns: built,
		vin: 'L1NTEST00000000001',
		vmodel: 'F30b',
		exportId: 'DA-one',
		available: { status: true, operation: true, power: true },
		duplicateRows: 0,
		unsortedStreams: [],
		emptyColumns: [],
		rowsParsed: seconds.length,
		bytesParsed: 0,
		aligned: true,
		...overrides
	};
}

/** Physical values of one merged column, NaN where nothing was recorded. */
function read(dataset: Dataset, key: string): number[] {
	const column = dataset.columns.get(key)!;
	return [...dataset.time].map((_, i) => valueAt(column, i));
}

describe('mergeDatasets', () => {
	it('lays disjoint exports end to end and records both windows', () => {
		const first = makeDataset([100, 101, 102], { esp_vehspd: [10, 11, 12] }, { exportId: 'DA-a' });
		const second = makeDataset(
			[200, 201],
			{ esp_vehspd: [20, 21] },
			{ exportId: 'DA-b', rowsParsed: 2 }
		);

		const merged = mergeDatasets([second, first]);

		expect([...merged.time]).toEqual([100, 101, 102, 200, 201]);
		expect(read(merged, 'esp_vehspd')).toEqual([10, 11, 12, 20, 21]);
		expect(merged.coverage).toEqual([
			{ startTime: 100, endTime: 102, exportId: 'DA-a' },
			{ startTime: 200, endTime: 201, exportId: 'DA-b' }
		]);
		expect(merged.exportId).toBe('DA-a+DA-b');
		expect(merged.rowsParsed).toBe(5);
	});

	it('lets the newer export win where the two overlap', () => {
		const older = makeDataset([100, 101, 102], { esp_vehspd: [10, 10, 10] }, { exportId: 'DA-a' });
		const newer = makeDataset([101, 102, 103], { esp_vehspd: [20, 20, 20] }, { exportId: 'DA-b' });

		const merged = mergeDatasets([older, newer]);

		expect([...merged.time]).toEqual([100, 101, 102, 103]);
		expect(read(merged, 'esp_vehspd')).toEqual([10, 20, 20, 20]);
	});

	it('fills a gap in the newer export from the older one', () => {
		const older = makeDataset([100, 101, 102], { esp_vehspd: [10, 10, 10] });
		const newer = makeDataset([101, 102, 103], { esp_vehspd: [null, 20, 20] });

		const merged = mergeDatasets([older, newer]);

		expect(read(merged, 'esp_vehspd')).toEqual([10, 10, 20, 20]);
	});

	it('unions the columns and leaves the rows each source never saw empty', () => {
		const first = makeDataset([100, 101], { esp_vehspd: [10, 11] });
		const second = makeDataset([200, 201], { ldcu_accpedalsig: [40, 50] });

		const merged = mergeDatasets([first, second]);

		expect([...merged.columns.keys()].sort()).toEqual(['esp_vehspd', 'ldcu_accpedalsig']);
		expect(read(merged, 'esp_vehspd')).toEqual([10, 11, NaN, NaN]);
		expect(read(merged, 'ldcu_accpedalsig')).toEqual([NaN, NaN, 40, 50]);
		expect(merged.columns.get('esp_vehspd')!.nonNull).toBe(2);
	});

	it('combines which streams were present and which columns stayed blank', () => {
		const first = makeDataset(
			[100, 101],
			{ esp_vehspd: [10, 11], ldcu_accpedalsig: [null, null] },
			{ available: { status: false, operation: true, power: false } }
		);
		const second = makeDataset(
			[200],
			{ esp_vehspd: [20], ldcu_accpedalsig: [null] },
			{ available: { status: true, operation: false, power: false } }
		);

		const merged = mergeDatasets([first, second]);

		expect(merged.available).toEqual({ status: true, operation: true, power: false });
		expect(merged.emptyColumns).toEqual(['ldcu_accpedalsig']);
		expect(merged.aligned).toBe(true);
	});

	it('keeps a single source intact', () => {
		const only = makeDataset([100, 101], { esp_vehspd: [10, 11] });
		const merged = mergeDatasets([only]);

		expect([...merged.time]).toEqual([100, 101]);
		expect(read(merged, 'esp_vehspd')).toEqual([10, 11]);
		expect(merged.coverage).toEqual([{ startTime: 100, endTime: 101, exportId: 'DA-one' }]);
	});

	it('remembers every export that went in, even where two overlap', () => {
		const older = makeDataset([100, 101, 102], { esp_vehspd: [10, 10, 10] }, { exportId: 'DA-a' });
		const newer = makeDataset([101, 102, 103], { esp_vehspd: [20, 20, 20] }, { exportId: 'DA-b' });

		const merged = mergeDatasets([older, newer]);

		expect(merged.coverage).toEqual([
			{ startTime: 100, endTime: 102, exportId: 'DA-a' },
			{ startTime: 101, endTime: 103, exportId: 'DA-b' }
		]);
		// Measuring the time covered joins them; counting the sources does not.
		expect(coalesceWindows(merged.coverage!)).toHaveLength(1);
	});

	it('refuses to combine exports from different vehicles', () => {
		const mine = makeDataset([100], { esp_vehspd: [10] });
		const theirs = makeDataset([200], { esp_vehspd: [20] }, { vin: 'L1NOTHER0000000002' });

		expect(() => mergeDatasets([mine, theirs])).toThrow(/different vehicles/);
	});

	it('carries the windows of an already merged dataset into the next merge', () => {
		const first = makeDataset([100, 101], { esp_vehspd: [10, 11] }, { exportId: 'DA-a' });
		const second = makeDataset([300, 301], { esp_vehspd: [30, 31] }, { exportId: 'DA-b' });
		const third = makeDataset([500], { esp_vehspd: [50] }, { exportId: 'DA-c' });

		const merged = mergeDatasets([mergeDatasets([first, second]), third]);

		expect(merged.coverage?.map((window) => window.exportId)).toEqual(['DA-a', 'DA-b', 'DA-c']);
	});
});
