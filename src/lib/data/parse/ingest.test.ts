import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseStream } from './ingest';
import { recognizeFiles, type FileLike } from '../schema/streams';
import { valueAt } from '../store/columnar';
import { combineStreams, verifyAlignment } from './align';

/** Wraps a fixture on disk in the minimal File-like surface the parser needs. */
function fixture(name: string, exportName: string): FileLike {
	const bytes = readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)));
	return {
		name: exportName,
		size: bytes.byteLength,
		stream: () =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					// Deliberately split mid-line to exercise the carry logic.
					const mid = Math.floor(bytes.byteLength / 2);
					controller.enqueue(new Uint8Array(bytes.subarray(0, mid)));
					controller.enqueue(new Uint8Array(bytes.subarray(mid)));
					controller.close();
				}
			})
	};
}

const PREFIX = 'DA202609011231048FFD0293_dwd_opp_gdpr_veh_';
const BASE = `${PREFIX}driving_operation_di.csv`;
const PART1 = `${PREFIX}driving_operation_di_part1.csv`;

const EXPORT_NAMES = {
	operation: ['driving_operation_di.csv', 'driving_operation_di_part1.csv'],
	status: ['driving_status_di.csv', 'driving_status_di_part1.csv'],
	power: ['driving_power_energy_di.csv', 'driving_power_energy_di_part1.csv']
} as const;

const FIXTURE_FILES = {
	operation: ['operation.csv', 'operation_part1.csv'],
	status: ['status.csv', 'status_part1.csv'],
	power: ['power.csv', 'power_part1.csv']
} as const;

/** Parses one stream from its fixtures, feeding the parts in reverse order. */
function parseFixture(stream: keyof typeof FIXTURE_FILES) {
	const files = [1, 0].map((i) =>
		fixture(FIXTURE_FILES[stream][i], PREFIX + EXPORT_NAMES[stream][i])
	);
	const plan = recognizeFiles(files);
	return parseStream(plan.streams[stream]!, stream);
}

function parseFixtureStream() {
	return parseFixture('operation');
}

describe('recognizeFiles', () => {
	it('orders the unsuffixed chunk before _partN', () => {
		const plan = recognizeFiles([
			fixture('operation_part1.csv', PART1),
			fixture('operation.csv', BASE)
		]);
		expect(plan.streams.operation?.map((f) => f.part)).toEqual([0, 1]);
		expect(plan.exportIds).toEqual(['DA202609011231048FFD0293']);
	});

	it('sorts numerically so part10 follows part9', () => {
		const mk = (n: number) => fixture('operation.csv', BASE.replace('_di.csv', `_di_part${n}.csv`));
		const plan = recognizeFiles([mk(10), mk(2), mk(9)]);
		expect(plan.streams.operation?.map((f) => f.part)).toEqual([2, 9, 10]);
	});

	it('collects files that do not match the export scheme', () => {
		const plan = recognizeFiles([fixture('operation.csv', 'holiday-photo.csv')]);
		expect(plan.unrecognized).toEqual(['holiday-photo.csv']);
		expect(plan.streams.operation).toBeUndefined();
	});

	it('matches ZIP members carrying a directory prefix', () => {
		const plan = recognizeFiles([fixture('operation.csv', `export/2026/${BASE}`)]);
		expect(plan.streams.operation).toHaveLength(1);
	});
});

describe('parseStream', () => {
	it('strips the BOM so the first column is readable', async () => {
		const result = await parseFixtureStream();
		expect(result.vin).toBe('L1NTEST00000000001');
		expect(result.vmodel).toBe('F30b');
	});

	it('drops replayed duplicate rows and concatenates the parts', async () => {
		const result = await parseFixtureStream();
		expect(result.duplicateRows).toBe(1);
		expect([...result.time]).toEqual([
			1785600000, 1785600001, 1785600002, 1785600003, 1785600004, 1785600005
		]);
	});

	it('maps CAN not-available sentinels to null', async () => {
		const result = await parseFixtureStream();
		const speed = result.columns.get('esp_vehspd')!;
		// Row index 2 carries 255, the ESP-asleep marker, not a real speed.
		expect(valueAt(speed, 2)).toBeNaN();
		expect(valueAt(speed, 3)).toBe(85);
		expect(speed.max).toBe(85);

		const angle = result.columns.get('eps_steeringangle')!;
		expect(valueAt(angle, 2)).toBeNaN();
		const rate = result.columns.get('eps_steeringanglespd')!;
		expect(valueAt(rate, 2)).toBeNaN();
	});

	it('treats empty fields as missing readings', async () => {
		const result = await parseFixtureStream();
		const longAccel = result.columns.get('esp_vehlongaccel')!;
		expect(valueAt(longAccel, 0)).toBeNaN();
		expect(valueAt(longAccel, 1)).toBeCloseTo(0.132864, 5);
	});

	it('preserves signed acceleration at CAN resolution', async () => {
		const result = await parseFixtureStream();
		const longAccel = result.columns.get('esp_vehlongaccel')!;
		expect(valueAt(longAccel, 3)).toBeCloseTo(-0.683696, 4);
	});

	it('reports columns the car never populated', async () => {
		const dataset = combineStreams(
			await Promise.all([parseFixture('operation'), parseFixture('status'), parseFixture('power')]),
			'DA-test'
		);
		// Window and tailgate signals exist in the schema but this car never fills them.
		expect(dataset.emptyColumns).toContain('ldcu_flwinposstfb');
		expect(dataset.emptyColumns).toContain('rdm_tropenersts');
		// Nor does a rear-motor-only car report the front drive unit.
		expect(dataset.emptyColumns).toContain('ipuf_acttorq');
		expect(dataset.emptyColumns).not.toContain('esp_vehspd');
		expect(dataset.emptyColumns).not.toContain('ipur_acttorq');
	});

	it('decodes the gear enum with XPeng ordering', async () => {
		const result = await parseFixtureStream();
		const gear = result.columns.get('ldcu_currentgearlev')!;
		expect(valueAt(gear, 0)).toBe(4); // P
		expect(valueAt(gear, 1)).toBe(1); // D
		expect(gear.spec.enumLabels?.[4]).toBe('P');
	});

	it('keeps the odometer monotonic across the part seam', async () => {
		const result = await parseFixtureStream();
		const odo = result.columns.get('cdcu_totalodometer')!;
		expect(valueAt(odo, 0)).toBe(3115);
		expect(valueAt(odo, 4)).toBe(3117);
	});
});

describe('status stream', () => {
	it('discards both tyre-pressure not-available markers', async () => {
		const result = await parseFixture('status');
		const fl = result.columns.get('ldcu_tpmsprfl')!;
		expect(valueAt(fl, 0)).toBe(255.75);
		// 701.25 is the unpaired-sensor code and 0 means no measurement.
		expect(valueAt(fl, 2)).toBeNaN();
		expect(valueAt(fl, 4)).toBeNaN();
		expect(fl.max).toBe(255.75);
	});

	it('keeps tyre pressures on their 2.75 kPa grid', async () => {
		const result = await parseFixture('status');
		const rr = result.columns.get('ldcu_tpmsprrr')!;
		expect(valueAt(rr, 0)).toBe(264);
		expect(valueAt(rr, 0) % 2.75).toBeCloseTo(0, 6);
	});

	it('records door state per door', async () => {
		const result = await parseFixture('status');
		expect(valueAt(result.columns.get('ldcu_driverdoorajarst')!, 1)).toBe(1);
		expect(valueAt(result.columns.get('ldcu_rldoorajarst')!, 2)).toBe(1);
		// An asleep ECU leaves its doors unreported rather than reporting "closed".
		expect(valueAt(result.columns.get('ldcu_driverdoorajarst')!, 3)).toBeNaN();
	});
});

describe('power stream', () => {
	it('nulls every signal of an invalid frame', async () => {
		const result = await parseFixture('power');
		// Row 3 is a wake-up frame with every signal at its invalid code.
		expect(valueAt(result.columns.get('ldcu_bms_soc_disp')!, 3)).toBeNaN();
		expect(valueAt(result.columns.get('ipur_actrotspd')!, 3)).toBeNaN();
		expect(valueAt(result.columns.get('ldcu_chrgpwr')!, 3)).toBeNaN();
		expect(valueAt(result.columns.get('bms_batttempmax_gb')!, 3)).toBeNaN();
		expect(valueAt(result.columns.get('bms_celltempminnum_gb')!, 3)).toBeNaN();
		expect(valueAt(result.columns.get('ldcu_dstbatdisp_dynamic')!, 3)).toBeNaN();
	});

	it('keeps the sign convention of pack current', async () => {
		const result = await parseFixture('power');
		const current = result.columns.get('bms_battcurr')!;
		expect(valueAt(current, 1)).toBeCloseTo(354.5, 1); // accelerating
		expect(valueAt(current, 2)).toBeCloseTo(-91.5, 1); // regenerating
		expect(valueAt(current, 4)).toBeCloseTo(-15.2, 1); // charging
	});

	it('rounds away the float noise in charging power', async () => {
		const result = await parseFixture('power');
		expect(valueAt(result.columns.get('ldcu_chrgpwr')!, 4)).toBeCloseTo(10.1, 6);
	});

	it('stores motor torque at its quarter-newton-metre resolution', async () => {
		const result = await parseFixture('power');
		const torque = result.columns.get('ipur_acttorq')!;
		expect(valueAt(torque, 1)).toBe(311.5);
		expect(valueAt(torque, 2)).toBe(-89.5);
	});
});

describe('alignment', () => {
	it('accepts streams that share a timeline', async () => {
		const a = await parseFixtureStream();
		const b = await parseFixtureStream();
		expect(verifyAlignment([a, b])).toBe(true);
	});

	it('rejects streams of differing length', async () => {
		const a = await parseFixtureStream();
		const short = await parseStream(
			recognizeFiles([fixture('operation.csv', BASE)]).streams.operation!,
			'operation'
		);
		expect(verifyAlignment([a, short])).toBe(false);
	});

	it('merge-joins misaligned streams onto a union timeline', async () => {
		const full = await parseFixtureStream();
		const partial = await parseStream(
			recognizeFiles([fixture('operation_part1.csv', PART1)]).streams.operation!,
			'operation'
		);
		// Pretend the partial stream is a different family so both are combined.
		partial.stream = 'status';
		const dataset = combineStreams([full, partial], 'DA-test');
		expect(dataset.aligned).toBe(false);
		expect(dataset.time.length).toBe(6);
	});
});
