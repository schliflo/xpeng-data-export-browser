/**
 * Verification against a real XPeng export.
 *
 * Runs only when a `.samples/` directory is present — that data contains a real
 * VIN and is never committed, so this suite skips itself everywhere else. It is
 * the check that the parser survives 340 MB and that the analytics agree with
 * what the files independently say.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { recognizeFiles, type FileLike, type StreamId } from '../schema/streams';
import { parseStream } from './ingest';
import { combineStreams } from './align';
import { analyze } from '../analytics';

const SAMPLES = new URL('../../../../.samples', import.meta.url).pathname;
const hasSamples = existsSync(SAMPLES) && readdirSync(SAMPLES).some((f) => f.endsWith('.csv'));

function diskFile(path: string, name: string): FileLike {
	return {
		name,
		size: statSync(path).size,
		stream: () => Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>
	};
}

describe.skipIf(!hasSamples)('real export', () => {
	const files = readdirSync(SAMPLES)
		.filter((name) => name.endsWith('.csv'))
		.map((name) => diskFile(join(SAMPLES, name), name));

	const plan = recognizeFiles(files);

	it('recognises all three streams and their parts', () => {
		expect(Object.keys(plan.streams).sort()).toEqual(['operation', 'power', 'status']);
		for (const stream of Object.keys(plan.streams) as StreamId[]) {
			expect(plan.streams[stream]!.map((f) => f.part)).toEqual([0, 1]);
		}
		expect(plan.unrecognized).toEqual([]);
	});

	it('parses the whole export and agrees with the source files', { timeout: 600_000 }, async () => {
		const started = Date.now();
		const results = [];
		for (const stream of Object.keys(plan.streams) as StreamId[]) {
			results.push(await parseStream(plan.streams[stream]!, stream));
		}
		const dataset = combineStreams(results, plan.exportIds[0]);
		const parseSeconds = (Date.now() - started) / 1000;

		// The three streams carry the same timestamps, so the fast path applies.
		expect(dataset.aligned).toBe(true);
		expect(dataset.time.length).toBe(1_194_640);
		expect(dataset.duplicateRows).toBeGreaterThan(0);

		// Signals this rear-drive car never reports.
		expect(dataset.emptyColumns).toEqual(
			expect.arrayContaining([
				'ipuf_actrotspd',
				'ipuf_acttorq',
				'ipuf_rotoracttemp',
				'ldcu_flwinposstfb',
				'rdm_tropenersts'
			])
		);

		// Sentinels must be gone: no 255 km/h, no 1638 km of range, no 215 °C.
		// 148 km/h in the first chunk, 150 in the continuation.
		expect(dataset.columns.get('esp_vehspd')!.max).toBe(150);
		expect(dataset.columns.get('ldcu_bms_soc_disp')!.max).toBeLessThanOrEqual(100);
		expect(dataset.columns.get('ldcu_dstbatdisp_dynamic')!.max).toBeLessThan(600);
		expect(dataset.columns.get('bms_batttempmax_gb')!.max).toBeLessThan(60);
		expect(dataset.columns.get('ldcu_tpmsprfl')!.max).toBeLessThan(300);

		const odo = dataset.columns.get('cdcu_totalodometer')!;
		expect(odo.min).toBe(3115);
		expect(odo.max).toBe(6068);

		const derived = analyze(dataset, 'Europe/Berlin');
		const analyzeSeconds = (Date.now() - started) / 1000 - parseSeconds;

		// The window is a rolling 30 days.
		expect(derived.windowDays).toBe(30);
		expect(derived.days.length).toBe(31);

		// 2,953 km of driving, which is the odometer's own difference.
		const distance = derived.days.reduce((sum, day) => sum + day.distanceKm, 0);
		expect(distance).toBeGreaterThan(2900);
		expect(distance).toBeLessThanOrEqual(2953);

		// Charging in this window was AC only — the onboard charger never went
		// above its 11 kW rating, so nothing here is a DC fast charge.
		expect(derived.charging.sessions.length).toBeGreaterThan(20);
		expect(derived.charging.dcSessions).toBe(0);
		expect(Math.max(...derived.charging.sessions.map((s) => s.maxKw))).toBeLessThan(15);

		// This owner charges to full about as often as they stop at 90%, so
		// there is no limit to report and the detector must not invent one.
		expect(derived.charging.chargeLimit).toBeNull();
		expect(derived.charging.scheduledHour).toBeNull();
		expect(derived.charging.plugInHour).not.toBeNull();

		// Energy in against distance covered has to land somewhere sane.
		const consumption = (derived.charging.totalKwh / distance) * 100;
		expect(consumption).toBeGreaterThan(14);
		expect(consumption).toBeLessThan(30);

		// Charging must not be chopped up by the naps the car takes mid-charge.
		const fragments = derived.charging.sessions.filter((s) => s.socGain >= 1 && s.duration < 900);
		expect(fragments.length).toBeLessThan(derived.charging.sessions.length / 3);

		// Standby drain is small but real, and must be measurable.
		expect(derived.drain.events.length).toBeGreaterThan(5);
		expect(derived.drain.medianPercentPerDay).toBeGreaterThan(0);
		expect(derived.drain.medianPercentPerDay).toBeLessThan(15);

		// The predicted full-charge range must stay inside believable bounds.
		expect(derived.range.medianFullRange).toBeGreaterThan(300);
		expect(derived.range.medianFullRange).toBeLessThan(600);

		// One stream really does arrive out of order and has to be sorted.
		expect(dataset.unsortedStreams).toContain('status');

		expect(derived.speed.maxSpeed).toBe(150);
		expect(Math.abs(derived.hardestBrakes[0].value)).toBeGreaterThan(0.6);
		expect(derived.doors.events.length).toBeGreaterThan(100);
		expect(derived.trips.length).toBeGreaterThan(30);

		// Every headline fact must have found a real number to show.
		for (const fact of derived.facts.headline) expect(fact.value).not.toBe('—');

		const heap = process.memoryUsage().heapUsed / 1024 / 1024;
		console.info(
			`real export: parse ${parseSeconds.toFixed(1)}s, analyze ${analyzeSeconds.toFixed(1)}s, ` +
				`${dataset.time.length.toLocaleString()} samples, heap ${heap.toFixed(0)} MB, ` +
				`${derived.trips.length} trips, ${derived.charging.sessions.length} charges, ` +
				`${distance.toFixed(0)} km`
		);

		// Budget: the whole export should be ready in well under a minute.
		expect(parseSeconds).toBeLessThan(60);
	});
});
