import { describe, expect, it } from 'vitest';
import { generateDemoDataset } from './generator';
import { analyze } from '../data/analytics';
import { valueAt } from '../data/store/columnar';
import { localParts } from '../data/analytics/daily';

const TZ = 'Europe/Berlin';

describe('generateDemoDataset', () => {
	const dataset = generateDemoDataset({ seed: 7 });

	it('is deterministic for a given seed', () => {
		const again = generateDemoDataset({ seed: 7 });
		expect(again.time.length).toBe(dataset.time.length);
		expect([...again.time.slice(0, 500)]).toEqual([...dataset.time.slice(0, 500)]);
		const key = 'esp_vehspd';
		expect([...again.columns.get(key)!.data.slice(0, 500)]).toEqual([
			...dataset.columns.get(key)!.data.slice(0, 500)
		]);
	});

	it('differs for a different seed', () => {
		const other = generateDemoDataset({ seed: 8 });
		expect(other.time.length).not.toBe(dataset.time.length);
	});

	it('produces a strictly ascending, unique timeline', () => {
		for (let i = 1; i < dataset.time.length; i++) {
			expect(dataset.time[i]).toBeGreaterThan(dataset.time[i - 1]);
		}
	});

	it('covers roughly a month without filling every second', () => {
		const span = dataset.time[dataset.time.length - 1] - dataset.time[0];
		expect(span).toBeGreaterThan(25 * 86400);
		expect(span).toBeLessThanOrEqual(31 * 86400);
		// A real car sleeps most of the month; so should the demo.
		expect(dataset.time.length / span).toBeLessThan(0.6);
	});

	it('leaves the window and tailgate signals empty, as the real export does', () => {
		expect(dataset.emptyColumns).toContain('ldcu_flwinposstfb');
		expect(dataset.emptyColumns).toContain('rdm_tropenersts');
	});

	it('populates the front motor for a dual-motor car', () => {
		expect(dataset.emptyColumns).not.toContain('ipuf_acttorq');
		const rwd = generateDemoDataset({ seed: 7, awd: false });
		expect(rwd.emptyColumns).toContain('ipuf_acttorq');
		expect(rwd.emptyColumns).not.toContain('ipur_acttorq');
	});

	it('keeps the odometer monotonic', () => {
		const odo = dataset.columns.get('cdcu_totalodometer')!;
		let previous = -Infinity;
		for (let i = 0; i < odo.data.length; i += 97) {
			const value = valueAt(odo, i);
			if (Number.isNaN(value)) continue;
			expect(value).toBeGreaterThanOrEqual(previous);
			previous = value;
		}
	});

	it('keeps the state of charge within a plausible band', () => {
		const soc = dataset.columns.get('ldcu_bms_soc_disp')!;
		expect(soc.min).toBeGreaterThanOrEqual(0);
		expect(soc.max).toBeLessThanOrEqual(100);
	});

	it('never exceeds forces a road car can actually produce', () => {
		// A car on ordinary tyres tops out near 1 g. Anything past that means
		// the speed trace is stepping rather than accelerating.
		const long = dataset.columns.get('esp_vehlongaccel')!;
		const lat = dataset.columns.get('esp_vehlateralaccel')!;
		expect(Math.abs(long.min)).toBeLessThan(1);
		expect(Math.abs(long.max)).toBeLessThan(1);
		expect(Math.abs(lat.min)).toBeLessThan(1);
		expect(Math.abs(lat.max)).toBeLessThan(1);

		// And it should still brake hard enough to be interesting.
		expect(Math.abs(long.min)).toBeGreaterThan(0.3);
	});

	it('changes speed at a believable rate', () => {
		const speed = dataset.columns.get('esp_vehspd')!;
		let worst = 0;
		for (let i = 1; i < dataset.time.length; i++) {
			if (dataset.time[i] - dataset.time[i - 1] !== 1) continue;
			const a = valueAt(speed, i);
			const b = valueAt(speed, i - 1);
			if (Number.isNaN(a) || Number.isNaN(b)) continue;
			worst = Math.max(worst, Math.abs(a - b));
		}
		// Under 25 km/h in one second is roughly 0.7 g.
		expect(worst).toBeLessThanOrEqual(25);
	});
});

describe('demo data through the analytics', () => {
	const derived = analyze(generateDemoDataset({ seed: 7 }), TZ);

	it('recovers a month of trips', () => {
		expect(derived.trips.length).toBeGreaterThan(20);
		const distance = derived.days.reduce((sum, day) => sum + day.distanceKm, 0);
		expect(distance).toBeGreaterThan(500);
	});

	it('recovers charging sessions, including a fast charge', () => {
		expect(derived.charging.sessions.length).toBeGreaterThan(3);
		expect(derived.charging.dcSessions).toBeGreaterThan(0);
		expect(derived.charging.acSessions).toBeGreaterThan(0);
	});

	it('detects the charge limit that was simulated', () => {
		expect(derived.charging.chargeLimit).toBe(90);
	});

	it('detects the scheduled overnight charging hour', () => {
		expect(derived.charging.scheduledHour).not.toBeNull();
	});

	it('finds door events and a daily rhythm', () => {
		expect(derived.doors.events.length).toBeGreaterThan(20);
		expect(derived.doors.grid.flat().reduce((a, b) => a + b, 0)).toBe(derived.doors.events.length);
	});

	it('measures energy consumption in a believable range', () => {
		const withConsumption = derived.trips.filter((t) => Number.isFinite(t.consumption));
		expect(withConsumption.length).toBeGreaterThan(5);
		const mean =
			withConsumption.reduce((sum, t) => sum + t.consumption, 0) / withConsumption.length;
		// An electric car of this size sits somewhere near 12–30 kWh/100 km.
		expect(mean).toBeGreaterThan(8);
		expect(mean).toBeLessThan(40);
	});

	it('produces headline facts with real numbers', () => {
		const ids = derived.facts.headline.map((f) => f.id);
		expect(ids).toContain('distance');
		expect(ids).toContain('top-speed');
		for (const fact of derived.facts.headline) {
			expect(fact.value).not.toBe('—');
			expect(fact.detail.length).toBeGreaterThan(10);
		}
	});

	it('always reports the absence of location data', () => {
		expect(derived.facts.privacy.map((f) => f.id)).toContain('no-gps');
	});

	it('places the simulated routine at believable hours of the day', () => {
		// Days must align to local midnight, not to the export window's start,
		// or every commute lands in the middle of the night.
		const hours = derived.trips.map((trip) => localParts(trip.startTime, TZ).hour);
		const overnight = hours.filter((hour) => hour >= 1 && hour <= 4).length;
		expect(overnight / hours.length).toBeLessThan(0.1);

		const daytime = hours.filter((hour) => hour >= 6 && hour <= 21).length;
		expect(daytime / hours.length).toBeGreaterThan(0.8);
	});

	it('loses a measurable amount of charge while parked', () => {
		expect(derived.drain.events.length).toBeGreaterThan(3);
		expect(derived.drain.medianPercentPerDay).toBeGreaterThan(0.3);
		expect(derived.drain.medianPercentPerDay).toBeLessThan(6);
	});

	it('varies its range estimate with conditions', () => {
		expect(derived.range.maxFullRange - derived.range.minFullRange).toBeGreaterThan(10);
	});

	it('runs its charging timer at the same hour every night', () => {
		const scheduled = derived.charging.sessions.filter(
			(session) => localParts(session.startTime, TZ).hour === 2
		);
		expect(scheduled.length).toBeGreaterThan(3);
	});

	it('follows the viewer timezone when it changes', () => {
		const tokyo = analyze(generateDemoDataset({ seed: 7, timeZone: 'Asia/Tokyo' }), 'Asia/Tokyo');
		const hours = tokyo.trips.map((trip) => localParts(trip.startTime, 'Asia/Tokyo').hour);
		const daytime = hours.filter((hour) => hour >= 6 && hour <= 21).length;
		expect(daytime / hours.length).toBeGreaterThan(0.8);
	});
});
