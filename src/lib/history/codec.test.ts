import { describe, expect, it } from 'vitest';
import { analyze } from '../data/analytics';
import { packDataset, unpackDataset } from '../data/worker/protocol';
import { valueAt, type Dataset } from '../data/store/columnar';
import { mergeSources } from '../data/parse/merge';
import { generateDemoDataset } from '../demo/generator';
import {
	RECORD_VERSION,
	StoredFormatError,
	decodeExport,
	encodeExport,
	estimateOpen,
	sourceFromExport,
	specToUse
} from './codec';

const ZONE = 'Europe/Berlin';

/** A few demo days, kept small so the round trip stays quick. */
function sample(days = 3, seed = 7): Dataset {
	return generateDemoDataset({ seed, days, timeZone: ZONE });
}

async function keep(dataset: Dataset) {
	const derived = analyze(dataset, ZONE);
	const { packed } = packDataset(dataset);
	return encodeExport(packed, derived, true);
}

describe('encodeExport', () => {
	it('summarises the export without needing its buffers', async () => {
		const dataset = sample();
		const { record, blobs } = await keep(dataset);

		expect(record.version).toBe(RECORD_VERSION);
		expect(record.id).toBe(dataset.exportId);
		expect(record.vin).toBe(dataset.vin);
		expect(record.rows).toBe(dataset.time.length);
		expect(record.trips).toBeGreaterThan(0);
		expect(record.distanceKm).toBeGreaterThan(0);
		expect(record.startTime).toBe(dataset.time[0]);
		expect(blobs).toHaveLength(dataset.columns.size + 1);
		expect(record.storedBytes).toBeGreaterThan(0);
	});

	it('compresses to a fraction of the raw size', async () => {
		const dataset = sample();
		const raw = [...dataset.columns.values()].reduce(
			(sum, column) => sum + column.data.byteLength,
			dataset.time.byteLength
		);
		const { record } = await keep(dataset);

		expect(record.storedBytes).toBeLessThan(raw / 4);
	});
});

describe('decodeExport', () => {
	it('returns every sample and reading unchanged', async () => {
		const dataset = sample();
		const { record, blobs } = await keep(dataset);
		const restored = unpackDataset(decodeExport(record, blobs));

		expect(restored.time).toEqual(dataset.time);
		expect(restored.columns.size).toBe(dataset.columns.size);
		expect(restored.vin).toBe(dataset.vin);
		expect(restored.aligned).toBe(dataset.aligned);
		expect(restored.emptyColumns).toEqual(dataset.emptyColumns);

		for (const [key, column] of dataset.columns) {
			const back = restored.columns.get(key);
			expect(back?.data).toEqual(column.data);
			expect(back?.nonNull).toBe(column.nonNull);
		}
	});

	it('produces the same analysis it was stored with', async () => {
		const dataset = sample();
		const before = analyze(dataset, ZONE);
		const { record, blobs } = await keep(dataset);
		const after = analyze(unpackDataset(decodeExport(record, blobs)), ZONE);

		expect(after.trips.length).toBe(before.trips.length);
		expect(after.charging.totalKwh).toBeCloseTo(before.charging.totalKwh, 6);
		expect(after.recordedDays).toBe(before.recordedDays);
		expect(after.facts.headline.map((fact) => fact.value)).toEqual(
			before.facts.headline.map((fact) => fact.value)
		);
	});

	it('refuses a record written in a format it does not know', async () => {
		const { record, blobs } = await keep(sample());
		const future = { ...record, version: RECORD_VERSION + 1 };

		expect(() => decodeExport(future, blobs)).toThrow(StoredFormatError);
	});
});

describe('specToUse', () => {
	it('takes the registry entry when the two agree on storage', async () => {
		const { record } = await keep(sample());
		const stored = record.columns.find((column) => column.key === 'esp_vehspd')!;
		const outdated = { ...stored.spec, label: 'Speed, as labelled last year' };

		expect(specToUse(outdated).label).toBe('Speed');
	});

	it('keeps the stored entry when the registry would read the bytes differently', async () => {
		const { record } = await keep(sample());
		const stored = record.columns.find((column) => column.key === 'esp_vehspd')!;
		const rescaled = { ...stored.spec, scale: stored.spec.scale * 2 };

		expect(specToUse(rescaled).scale).toBe(stored.spec.scale * 2);
	});
});

describe('sourceFromExport', () => {
	it('merges straight out of storage, one column at a time', async () => {
		const first = sample(3, 11);
		const second = generateDemoDataset({
			seed: 21,
			days: 3,
			timeZone: ZONE,
			// A fortnight later, so the two do not overlap.
			endTime: first.time[first.time.length - 1] + 14 * 86400
		});

		const a = await keep(first);
		const b = await keep(second);
		const merged = mergeSources([
			sourceFromExport(a.record, a.blobs),
			sourceFromExport(b.record, b.blobs)
		]);

		expect(merged.time.length).toBe(first.time.length + second.time.length);
		expect(merged.coverage).toHaveLength(2);

		const speed = merged.columns.get('esp_vehspd')!;
		const original = first.columns.get('esp_vehspd')!;
		expect(valueAt(speed, 0)).toBe(valueAt(original, 0));
	});
});

describe('estimateOpen', () => {
	it('adds up the memory the chosen exports would take', async () => {
		const { record } = await keep(sample());
		const estimate = estimateOpen([record, record]);

		expect(estimate.rows).toBe(record.rows * 2);
		expect(estimate.bytes).toBeGreaterThan(estimate.rows * 4);
	});
});
