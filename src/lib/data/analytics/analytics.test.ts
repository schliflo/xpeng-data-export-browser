import { describe, expect, it } from 'vitest';
import { COLUMNS, GEAR, type ColumnSpec } from '../schema/columns';
import { ColumnBuilder, type Column, type Dataset } from '../store/columnar';
import { segmentAwake, sleepGaps, totalCoverage } from './sessions';
import { integrateEnergy, integrateSignal } from './energy';
import { detectTrips } from './trips';
import { detectCharging, detectChargeLimit, detectScheduledHour, localHour } from './charging';
import { bucketDays, localDayKey, startOfLocalDay } from './daily';
import { phantomDrain } from './battery';
import { topEvents } from './drivingStyle';

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
		exportId: 'DA-test',
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

/** Seconds `base`, `base+1`, … `base+n-1`. */
function ramp(base: number, n: number): number[] {
	return Array.from({ length: n }, (_, i) => base + i);
}

describe('segmentAwake', () => {
	it('splits on gaps longer than the threshold', () => {
		const time = new Uint32Array([100, 101, 102, 500, 501, 4000]);
		const spans = segmentAwake(time, 60);
		expect(spans).toHaveLength(3);
		expect(spans[0]).toMatchObject({ start: 0, end: 2, startTime: 100, endTime: 102 });
		expect(spans[1]).toMatchObject({ start: 3, end: 4 });
		expect(spans[2]).toMatchObject({ start: 5, end: 5 });
	});

	it('keeps a continuous run as one span', () => {
		const spans = segmentAwake(new Uint32Array(ramp(0, 120)), 60);
		expect(spans).toHaveLength(1);
		expect(totalCoverage(spans)).toBe(119);
	});

	it('reports the sleeping periods between spans', () => {
		const gaps = sleepGaps(segmentAwake(new Uint32Array([0, 1, 5000, 5001]), 60));
		expect(gaps).toHaveLength(1);
		expect(gaps[0].endTime - gaps[0].startTime).toBe(4999);
	});

	it('handles an empty timeline', () => {
		expect(segmentAwake(new Uint32Array([]))).toEqual([]);
	});
});

describe('energy integration', () => {
	it('matches the analytic result for a constant load', () => {
		// 400 V at 100 A is 40 kW; over an hour that is 40 kWh.
		const n = 3601;
		const dataset = makeDataset(ramp(0, n), {
			bms_battvolt: new Array(n).fill(400),
			bms_battcurr: new Array(n).fill(100)
		});
		const totals = integrateEnergy(
			dataset.time,
			dataset.columns.get('bms_battvolt')!,
			dataset.columns.get('bms_battcurr')!,
			0,
			n - 1
		);
		expect(totals.discharged).toBeCloseTo(40, 3);
		expect(totals.charged).toBe(0);
		expect(totals.peakPowerKw).toBeCloseTo(40, 3);
	});

	it('separates energy recovered from energy spent', () => {
		const dataset = makeDataset(ramp(0, 7201), {
			bms_battvolt: new Array(7201).fill(400),
			// One hour discharging at 40 kW, then one hour charging at 40 kW.
			bms_battcurr: Array.from({ length: 7201 }, (_, i) => (i <= 3600 ? 100 : -100))
		});
		const totals = integrateEnergy(
			dataset.time,
			dataset.columns.get('bms_battvolt')!,
			dataset.columns.get('bms_battcurr')!,
			0,
			7200
		);
		expect(totals.discharged).toBeCloseTo(40, 1);
		expect(totals.charged).toBeCloseTo(40, 1);
		expect(totals.peakRegenKw).toBeCloseTo(40, 3);
	});

	it('does not invent energy across a sleep gap', () => {
		// Two samples an hour apart: nothing is known in between, so nothing counts.
		const dataset = makeDataset([0, 3600], {
			bms_battvolt: [400, 400],
			bms_battcurr: [100, 100]
		});
		const totals = integrateEnergy(
			dataset.time,
			dataset.columns.get('bms_battvolt')!,
			dataset.columns.get('bms_battcurr')!,
			0,
			1
		);
		expect(totals.discharged).toBe(0);
	});

	it('integrates a single signal into kWh', () => {
		const n = 3601;
		const dataset = makeDataset(ramp(0, n), { ldcu_chrgpwr: new Array(n).fill(11) });
		const kwh = integrateSignal(dataset.time, dataset.columns.get('ldcu_chrgpwr')!, 0, n - 1);
		expect(kwh).toBeCloseTo(11, 3);
	});
});

describe('detectTrips', () => {
	it('finds a drive and measures it from the odometer', () => {
		const n = 600;
		const dataset = makeDataset(ramp(1000, n + 400), {
			// 100 s parked, 600 s driving, then parked again.
			ldcu_currentgearlev: [
				...new Array(100).fill(GEAR.PARK),
				...new Array(n).fill(GEAR.DRIVE),
				...new Array(300).fill(GEAR.PARK)
			],
			esp_vehspd: [...new Array(100).fill(0), ...new Array(n).fill(60), ...new Array(300).fill(0)],
			cdcu_totalodometer: [
				...new Array(100).fill(1000),
				...Array.from({ length: n }, (_, i) => 1000 + Math.floor((i * 10) / n)),
				...new Array(300).fill(1010)
			]
		});
		const trips = detectTrips(dataset);
		expect(trips).toHaveLength(1);
		expect(trips[0].distanceKm).toBeCloseTo(9, 0);
		expect(trips[0].maxSpeed).toBe(60);
		expect(trips[0].movingSeconds).toBeGreaterThan(500);
	});

	it('ignores shuffling that covers no ground', () => {
		const dataset = makeDataset(ramp(0, 200), {
			ldcu_currentgearlev: [...new Array(50).fill(GEAR.REVERSE), ...new Array(150).fill(GEAR.PARK)],
			esp_vehspd: [...new Array(50).fill(2), ...new Array(150).fill(0)],
			cdcu_totalodometer: new Array(200).fill(1000)
		});
		expect(detectTrips(dataset)).toHaveLength(0);
	});

	it('does not split a trip at a traffic light', () => {
		// Stopped for 30 s mid-drive, which is below the park-settle threshold.
		const dataset = makeDataset(ramp(0, 700), {
			ldcu_currentgearlev: [
				...new Array(300).fill(GEAR.DRIVE),
				...new Array(30).fill(GEAR.DRIVE),
				...new Array(300).fill(GEAR.DRIVE),
				...new Array(70).fill(GEAR.PARK)
			],
			esp_vehspd: [
				...new Array(300).fill(50),
				...new Array(30).fill(0),
				...new Array(300).fill(50),
				...new Array(70).fill(0)
			],
			cdcu_totalodometer: Array.from({ length: 700 }, (_, i) => 1000 + Math.floor(i / 70))
		});
		expect(detectTrips(dataset)).toHaveLength(1);
	});

	it('reports regeneration as a share of gross energy', () => {
		const n = 700;
		const dataset = makeDataset(ramp(0, n), {
			ldcu_currentgearlev: [...new Array(600).fill(GEAR.DRIVE), ...new Array(100).fill(GEAR.PARK)],
			esp_vehspd: [...new Array(600).fill(50), ...new Array(100).fill(0)],
			cdcu_totalodometer: Array.from({ length: n }, (_, i) => 1000 + Math.floor(i / 100)),
			bms_battvolt: new Array(n).fill(400),
			// Half the drive pulling, half recovering.
			bms_battcurr: Array.from({ length: n }, (_, i) => (i < 300 ? 100 : i < 600 ? -50 : 0))
		});
		const [trip] = detectTrips(dataset);
		expect(trip.energyKwh).toBeGreaterThan(0);
		expect(trip.regenKwh).toBeGreaterThan(0);
		expect(trip.regenShare).toBeGreaterThan(0.2);
		expect(trip.regenShare).toBeLessThan(0.5);
	});
});

describe('detectCharging', () => {
	/** One charging session of `seconds` at `kw`, starting at `base`. */
	function chargeAt(base: number, seconds: number, kw: number, socFrom: number, socTo: number) {
		return {
			time: ramp(base, seconds),
			power: new Array(seconds).fill(kw),
			soc: Array.from({ length: seconds }, (_, i) =>
				Math.round(socFrom + ((socTo - socFrom) * i) / Math.max(1, seconds - 1))
			)
		};
	}

	it('finds a session and measures the energy delivered', () => {
		const c = chargeAt(0, 3601, 11, 20, 60);
		const dataset = makeDataset(c.time, { ldcu_chrgpwr: c.power, ldcu_bms_soc_disp: c.soc });
		const [session] = detectCharging(dataset);
		expect(session.kwhDelivered).toBeCloseTo(11, 1);
		expect(session.maxKw).toBe(11);
		expect(session.isDc).toBe(false);
		expect(session.socGain).toBe(40);
	});

	it('classifies a fast charge as DC', () => {
		const c = chargeAt(0, 1200, 150, 20, 60);
		const dataset = makeDataset(c.time, { ldcu_chrgpwr: c.power, ldcu_bms_soc_disp: c.soc });
		expect(detectCharging(dataset)[0].isDc).toBe(true);
	});

	it('merges a session interrupted by a short logging gap', () => {
		const first = chargeAt(0, 1800, 11, 20, 40);
		const second = chargeAt(2000, 1800, 11, 40, 60);
		const dataset = makeDataset([...first.time, ...second.time], {
			ldcu_chrgpwr: [...first.power, ...second.power],
			ldcu_bms_soc_disp: [...first.soc, ...second.soc]
		});
		expect(detectCharging(dataset)).toHaveLength(1);
	});

	it('drops a top-up blip that moved no charge', () => {
		const dataset = makeDataset(ramp(0, 60), {
			ldcu_chrgpwr: new Array(60).fill(10),
			ldcu_bms_soc_disp: new Array(60).fill(90)
		});
		expect(detectCharging(dataset)).toHaveLength(0);
	});

	it('reads a charge limit off repeated stopping points', () => {
		const sessions = [70, 80, 90].flatMap((start) =>
			[0, 1, 2].map((n) => ({
				socEnd: 90,
				socGain: 90 - start,
				index: n
			}))
		) as never;
		expect(detectChargeLimit(sessions)).toBe(90);
	});

	it('reports no limit when the car charges to full', () => {
		const sessions = [0, 1, 2, 3].map(() => ({ socEnd: 100, socGain: 40 })) as never;
		expect(detectChargeLimit(sessions)).toBeNull();
	});

	it('spots a scheduled charging hour', () => {
		// Six sessions all starting at 02:00 Berlin time on consecutive days.
		const base = Date.UTC(2026, 7, 3, 0, 0, 0) / 1000; // 02:00 CEST
		const sessions = Array.from({ length: 6 }, (_, i) => ({
			startTime: base + i * 86400
		})) as never;
		const result = detectScheduledHour(sessions, 'Europe/Berlin');
		expect(result.hour).toBe(2);
		expect(result.count).toBe(6);
	});

	it('reports no schedule when starts are spread out', () => {
		const base = Date.UTC(2026, 7, 3, 0, 0, 0) / 1000;
		const sessions = Array.from({ length: 8 }, (_, i) => ({
			startTime: base + i * 86400 + i * 3600
		})) as never;
		expect(detectScheduledHour(sessions, 'Europe/Berlin').hour).toBeNull();
	});
});

describe('local time handling', () => {
	it('reads the hour in the viewer timezone, not UTC', () => {
		// 2026-08-03 00:00 UTC is 02:00 in Berlin.
		const t = Date.UTC(2026, 7, 3, 0, 0, 0) / 1000;
		expect(localHour(t, 'Europe/Berlin')).toBe(2);
		expect(localHour(t, 'UTC')).toBe(0);
	});

	it('assigns an evening drive to the local day, not the warehouse day', () => {
		// 2026-08-02 19:00 Berlin. The export's own `ds` key would already have
		// rolled over to the 3rd, because it cuts the day at midnight in UTC+8.
		const t = Date.UTC(2026, 7, 2, 17, 0, 0) / 1000;
		expect(localDayKey(t, 'Europe/Berlin')).toBe('2026-08-02');
	});

	it('finds the exact start of a local day', () => {
		const start = startOfLocalDay('2026-08-02', 'Europe/Berlin');
		expect(localDayKey(start, 'Europe/Berlin')).toBe('2026-08-02');
		expect(localDayKey(start - 1, 'Europe/Berlin')).toBe('2026-08-01');
	});

	it('finds the start of a day that begins a daylight-saving change', () => {
		// Clocks go back on 2026-10-25 in Berlin, making the day 25 hours long.
		const start = startOfLocalDay('2026-10-25', 'Europe/Berlin');
		expect(localDayKey(start, 'Europe/Berlin')).toBe('2026-10-25');
		expect(localDayKey(start - 1, 'Europe/Berlin')).toBe('2026-10-24');
	});
});

describe('bucketDays', () => {
	it('groups distance onto local days and keeps empty days', () => {
		const base = Date.UTC(2026, 7, 2, 8, 0, 0) / 1000;
		const dataset = makeDataset([base, base + 86400 * 2], {
			ldcu_bms_soc_disp: [80, 60]
		});
		const trips = [
			{
				startTime: base,
				distanceKm: 12,
				movingSeconds: 600,
				maxSpeed: 80,
				energyKwh: 3,
				regenKwh: 1
			}
		] as never;
		const days = bucketDays(dataset, trips, [], 'Europe/Berlin');
		expect(days.map((d) => d.date)).toEqual(['2026-08-02', '2026-08-03', '2026-08-04']);
		expect(days[0].distanceKm).toBe(12);
		expect(days[1].distanceKm).toBe(0);
	});
});

describe('coverage across merged exports', () => {
	/** Two short recordings ten days apart, with the battery lower afterwards. */
	function twoWindows(overrides: Partial<Dataset> = {}): Dataset {
		return makeDataset(
			[0, 1, 2, 864000, 864001, 864002],
			{ ldcu_bms_soc_disp: [80, 80, 80, 70, 70, 70] },
			overrides
		);
	}

	const trips = [
		{ startTime: 0, endTime: 2 },
		{ startTime: 864000, endTime: 864002 }
	];

	it('reads a long silence as drain when one export covers it', () => {
		const drain = phantomDrain(twoWindows(), [], trips);

		expect(drain.events).toHaveLength(1);
		expect(drain.events[0].socLost).toBeCloseTo(10, 6);
		expect(drain.longestSleepHours).toBeCloseTo(239.99, 1);
	});

	it('ignores the same silence when it falls between two exports', () => {
		const dataset = twoWindows({
			coverage: [
				{ startTime: 0, endTime: 2, exportId: 'DA-a' },
				{ startTime: 864000, endTime: 864002, exportId: 'DA-b' }
			]
		});

		const drain = phantomDrain(dataset, [], trips);

		expect(drain.events).toEqual([]);
		expect(drain.longestSleepHours).toBe(0);
	});

	it('marks the days no export accounts for', () => {
		const dataset = twoWindows({
			coverage: [
				{ startTime: 0, endTime: 2, exportId: 'DA-a' },
				{ startTime: 864000, endTime: 864002, exportId: 'DA-b' }
			]
		});

		const days = bucketDays(dataset, [], [], 'UTC');

		expect(days).toHaveLength(11);
		expect(days[0].covered).toBe(true);
		expect(days[days.length - 1].covered).toBe(true);
		expect(days.filter((day) => day.covered)).toHaveLength(2);
	});

	it('treats a single export as covering everything between its ends', () => {
		const days = bucketDays(twoWindows(), [], [], 'UTC');

		expect(days.every((day) => day.covered)).toBe(true);
	});
});

describe('topEvents', () => {
	it('takes the strongest moments, one per spacing window', () => {
		const dataset = makeDataset(ramp(1000, 6), {
			esp_vehspd: [10, 90, 80, 20, 70, 30]
		});

		const events = topEvents(dataset, 'esp_vehspd', 2, { spacing: 3 });

		expect(events.map((event) => event.value)).toEqual([90, 70]);
		expect(events.map((event) => event.time)).toEqual([1001, 1004]);
	});

	it('finds the lowest values when asked for the other sign', () => {
		const dataset = makeDataset(ramp(1000, 4), { esp_vehlongaccel: [0.1, -0.9, -0.2, 0.4] });

		const events = topEvents(dataset, 'esp_vehlongaccel', 1, { sign: -1 });

		expect(events[0].value).toBeCloseTo(-0.9, 2);
	});

	it('returns nothing for a signal the car never reported', () => {
		const dataset = makeDataset(ramp(1000, 3), { esp_vehspd: [null, null, null] });

		expect(topEvents(dataset, 'esp_vehspd', 5)).toEqual([]);
	});
});
