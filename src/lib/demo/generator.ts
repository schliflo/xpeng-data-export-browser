/**
 * Synthetic export generator.
 *
 * Anyone can open this app without owning an XPeng, so the demo has to stand in
 * for a real month of driving: commutes with traffic, a weekend trip with a
 * fast-charge stop, overnight scheduled charging to a limit, and the slow drain
 * of a car sitting still. It is generated rather than shipped because a real
 * month is 340 MB of CSV.
 *
 * Output is a `Dataset` in exactly the shape the parser produces, so the demo
 * exercises the same analytics as real data. Everything derives from a seed, so
 * the same seed always produces the same month.
 *
 * The demo car is dual-motor, which the sample rear-drive export cannot
 * exercise, and it fast-charges once — so the front-motor and DC paths in the
 * app are covered by the data anyone can load.
 */

import { columnsForStream, GEAR, type ColumnSpec } from '../data/schema/columns';
import { localDayKey, startOfLocalDay } from '../data/analytics/daily';
import { STREAM_IDS } from '../data/schema/streams';
import { ColumnBuilder, TimeBuilder, type Column, type Dataset } from '../data/store/columnar';

/** Small deterministic PRNG; the same seed always yields the same month. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface DemoOptions {
	seed?: number;
	awd?: boolean;
	days?: number;
	/** Epoch second the window ends at; defaults to a fixed date for stability. */
	endTime?: number;
	/**
	 * Timezone the simulated driver lives in. Days are aligned to local
	 * midnight so a commute lands at breakfast time on the viewer's clock —
	 * aligning to the export window instead would put it at two in the morning.
	 */
	timeZone?: string;
}

/** One second of simulated vehicle state. */
interface Sample {
	t: number;
	speed: number;
	gear: number;
	odo: number;
	soc: number;
	chargeKw: number;
	pedal: number;
	brake: number;
	steering: number;
	longAccel: number;
	latAccel: number;
	motorRpm: number;
	torque: number;
	packTemp: number;
	rotorTemp: number;
	doors: [number, number, number, number];
	tyres: [number, number, number, number];
	awake: boolean;
}

const PACK_KWH = 82;
const NOMINAL_VOLT = 400;

/** Charge a parked car loses to its own electronics, in percent per day. */
const STANDBY_DRAIN_PER_DAY = 1.4;
/**
 * How often, and for how long, a sleeping car wakes to check in. Real exports
 * cover roughly half of every second in the window despite the car being
 * parked most of the time, because it keeps stirring; the demo matches that so
 * the gaps in its charts look like the gaps in a real one.
 */
const HOUSEKEEPING_INTERVAL = 2100;
const HOUSEKEEPING_SECONDS = 780;

interface Plan {
	kind: 'commute' | 'errand' | 'roadtrip';
	start: number;
	durationSeconds: number;
	distanceKm: number;
	peakSpeed: number;
	passengers: boolean;
}

/**
 * Local midnight for each of the `days` days ending at `endTime`, with the
 * weekday that day falls on. Journeys are placed relative to these, so the
 * simulated routine reads correctly on the viewer's clock.
 */
function localDays(endTime: number, days: number, timeZone: string) {
	const out: Array<{ start: number; weekday: number }> = [];
	const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const weekdayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone });

	for (let i = days; i >= 1; i--) {
		const probe = endTime - i * 86400;
		const start = startOfLocalDay(localDayKey(probe, timeZone), timeZone);
		out.push({
			start,
			weekday: Math.max(0, dayNames.indexOf(weekdayFormat.format(new Date(start * 1000))))
		});
	}
	return out;
}

/** Lays out a month of journeys before any second-by-second simulation. */
function planMonth(rand: () => number, endTime: number, days: number, timeZone: string): Plan[] {
	const plans: Plan[] = [];
	for (const { start: dayStart, weekday } of localDays(endTime, days, timeZone)) {
		const isWeekend = weekday === 0 || weekday === 6;

		// A few days the car simply does not move.
		if (rand() < 0.1) continue;

		if (isWeekend) {
			if (rand() < 0.45) {
				// The long weekend run, far enough to need a charge on the way.
				const distance = 180 + rand() * 160;
				plans.push({
					kind: 'roadtrip',
					start: dayStart + 8 * 3600 + Math.floor(rand() * 5400),
					durationSeconds: Math.round((distance / 95) * 3600),
					distanceKm: distance,
					peakSpeed: 125 + rand() * 25,
					passengers: true
				});
			} else {
				const trips = 1 + Math.floor(rand() * 2);
				for (let i = 0; i < trips; i++) {
					const distance = 6 + rand() * 22;
					plans.push({
						kind: 'errand',
						start: dayStart + (10 + i * 4) * 3600 + Math.floor(rand() * 5400),
						durationSeconds: Math.round((distance / 34) * 3600),
						distanceKm: distance,
						peakSpeed: 55 + rand() * 35,
						passengers: rand() < 0.5
					});
				}
			}
		} else {
			// Out in the morning, back in the evening, with the odd detour.
			const outbound = 22 + rand() * 12;
			plans.push({
				kind: 'commute',
				start: dayStart + 6 * 3600 + Math.floor(rand() * 3600),
				durationSeconds: Math.round((outbound / 46) * 3600),
				distanceKm: outbound,
				peakSpeed: 110 + rand() * 25,
				passengers: rand() < 0.15
			});
			plans.push({
				kind: 'commute',
				start: dayStart + 16 * 3600 + Math.floor(rand() * 7200),
				durationSeconds: Math.round((outbound / 40) * 3600),
				distanceKm: outbound + (rand() < 0.3 ? 4 + rand() * 8 : 0),
				peakSpeed: 105 + rand() * 25,
				passengers: rand() < 0.2
			});
			if (rand() < 0.25) {
				const distance = 4 + rand() * 10;
				plans.push({
					kind: 'errand',
					start: dayStart + 19 * 3600 + Math.floor(rand() * 5400),
					durationSeconds: Math.round((distance / 30) * 3600),
					distanceKm: distance,
					peakSpeed: 50 + rand() * 20,
					passengers: rand() < 0.4
				});
			}
		}
	}
	return plans.sort((a, b) => a.start - b.start);
}

/**
 * Limits on how fast the speed may change, in km/h per second.
 *
 * Without these the trace can drop a car from motorway speed to walking pace
 * between two samples, which reads out as several g of braking — a figure no
 * road car can produce and no real export contains.
 */
const MAX_ACCEL_KMH_S = 12; // ≈ 0.34 g, a confident pull away
const MAX_BRAKE_KMH_S = 11; // ≈ 0.31 g, firm but not an emergency
/** Occasional harder stops, so the braking distribution has a tail. */
const MAX_HARD_BRAKE_KMH_S = 22; // ≈ 0.62 g

/**
 * Target speed for a moment in a journey: pulling away, cruising, slowing for
 * junctions and stopping at the end. The caller rate-limits the approach to
 * this target, so the target itself may step.
 */
function targetSpeed(plan: Plan, elapsed: number, rand: () => number): number {
	const progress = elapsed / plan.durationSeconds;
	if (progress >= 1) return 0;
	let speed = plan.peakSpeed;
	// Traffic: a slow oscillation plus the occasional junction stop.
	speed *= 0.78 + 0.22 * Math.sin(elapsed / 47 + plan.start);
	if (plan.kind !== 'roadtrip') {
		const stopPhase = Math.sin(elapsed / 130 + plan.distanceKm);
		if (stopPhase > 0.93) speed = 0;
	}
	// Ease to a stop at the end rather than arriving at speed.
	if (progress > 0.97) speed = 0;
	return Math.max(0, Math.min(plan.peakSpeed, speed + (rand() - 0.5) * 2));
}

/**
 * Moves `current` towards `target` without exceeding what tyres can deliver.
 *
 * The approach is proportional rather than flat-out: a driver eases off as the
 * gap closes. Holding the limit instead would put every sample at one of two
 * accelerations, which shows up as stripes on the g-g diagram.
 */
function approachSpeed(current: number, target: number, hardStop: boolean): number {
	const delta = target - current;
	const eased = delta * 0.22;
	if (delta >= 0) return current + Math.min(eased, MAX_ACCEL_KMH_S);
	const limit = hardStop ? MAX_HARD_BRAKE_KMH_S : MAX_BRAKE_KMH_S;
	return current + Math.max(eased, -limit);
}

export function generateDemoDataset(options: DemoOptions = {}): Dataset {
	const {
		seed = 20260901,
		awd = true,
		days = 30,
		// A fixed default so the demo is identical on every visit.
		endTime = Math.floor(Date.UTC(2026, 7, 31, 16, 0, 0) / 1000),
		timeZone = 'Europe/Berlin'
	} = options;

	const rand = mulberry32(seed);
	const startTime = endTime - days * 86400;
	const plans = planMonth(rand, endTime, days, timeZone);

	/**
	 * Outside temperature: a daily swing around a base that wanders from day to
	 * day, the way weather actually behaves. A single sine would make the tyre
	 * pressure chart a perfect repeating wave, which no month ever is.
	 */
	const weatherRand = mulberry32(seed ^ 0x5f3a);
	const dailyBase: number[] = [];
	let base = 17;
	for (let day = 0; day <= days + 1; day++) {
		base += (weatherRand() - 0.5) * 4.5;
		base = Math.max(9, Math.min(27, base));
		dailyBase.push(base);
	}
	const ambientAt = (t: number): number => {
		const offset = (t - startTime) / 86400;
		const day = Math.max(0, Math.min(dailyBase.length - 2, Math.floor(offset)));
		const blend = offset - day;
		const settled = dailyBase[day] * (1 - blend) + dailyBase[day + 1] * blend;
		// Coldest before dawn, warmest mid-afternoon.
		const hour = (((t % 86400) + 86400) % 86400) / 3600;
		return settled + 5.5 * Math.sin(((hour - 9) / 24) * Math.PI * 2);
	};

	// Charging is scheduled overnight and stops at a limit, as most people set up.
	const CHARGE_LIMIT = 90;
	const SCHEDULED_HOUR = 2;
	const AC_KW = 10.6;

	const samples: Sample[] = [];
	let odo = 12480;
	let soc = 74;
	let tyreBase = 250;
	const doorsClosed: [number, number, number, number] = [0, 0, 0, 0];

	/** Emits one second of state. */
	const emit = (s: Sample) => samples.push(s);

	// Local midnights, so the charging timer keeps to the driver's clock.
	const midnights = localDays(endTime, days + 1, timeZone).map((d) => d.start);
	const nextScheduledCharge = (after: number): number => {
		for (const midnight of midnights) {
			const at = midnight + SCHEDULED_HOUR * 3600;
			if (at >= after) return at;
		}
		return Infinity;
	};

	let cursor = startTime;
	let planIndex = 0;
	// The car wakes briefly every couple of hours even when it is not used.
	let nextHousekeeping = startTime + 3600;

	while (cursor < endTime) {
		const plan = plans[planIndex];
		const chargeDue = soc < CHARGE_LIMIT - 8;
		// The charging timer fires at the same wall-clock hour every night.
		const chargeStart = nextScheduledCharge(cursor);

		// Overnight scheduled charging, whenever the car is home and low enough.
		if (chargeDue && cursor <= chargeStart && (!plan || plan.start > chargeStart + 600)) {
			const ambient = ambientAt(cursor);
			const targetSoc = CHARGE_LIMIT;
			let t = chargeStart;
			let packTemp = ambient + 6;
			while (soc < targetSoc && t < endTime) {
				const kw = AC_KW * (soc > 85 ? 0.55 : 1);
				soc = Math.min(targetSoc, soc + (kw / PACK_KWH) * (100 / 3600));
				packTemp += (ambient + 8 - packTemp) * 0.0004;
				emit({
					t,
					speed: 0,
					gear: GEAR.PARK,
					odo,
					soc,
					chargeKw: kw,
					pedal: 0,
					brake: 0,
					steering: NaN,
					longAccel: NaN,
					latAccel: NaN,
					motorRpm: 0,
					torque: 0,
					packTemp,
					rotorTemp: ambient + 2,
					doors: doorsClosed,
					tyres: tyreVector(tyreBase, ambient, rand),
					awake: true
				});
				t += 1;
			}
			cursor = t + 300;
			continue;
		}

		if (!plan) break;

		// A journey cannot begin while the car is still finishing the last one;
		// overlapping them would leave a gap in the speed trace where the
		// earlier samples win on timestamp.
		if (plan.start - 60 < cursor) {
			planIndex++;
			if (planIndex >= plans.length) break;
			continue;
		}

		// Housekeeping wake-ups while the car waits for its next journey. A
		// parked car keeps its systems alive, so charge drains slowly the whole
		// time — not only during the minutes it happens to be logging.
		if (nextHousekeeping < plan.start && nextHousekeeping > cursor) {
			const ambient = ambientAt(nextHousekeeping);
			soc -= ((nextHousekeeping - cursor) / 86400) * STANDBY_DRAIN_PER_DAY;
			for (let t = nextHousekeeping; t < nextHousekeeping + HOUSEKEEPING_SECONDS; t++) {
				soc -= STANDBY_DRAIN_PER_DAY / 86400;
				emit({
					t,
					speed: 0,
					gear: GEAR.PARK,
					odo,
					soc,
					chargeKw: 0,
					pedal: 0,
					brake: 0,
					steering: NaN,
					longAccel: NaN,
					latAccel: NaN,
					motorRpm: 0,
					torque: 0,
					packTemp: ambient + 4,
					rotorTemp: ambient,
					doors: doorsClosed,
					tyres: tyreVector(tyreBase, ambient, rand),
					awake: true
				});
			}
			cursor = nextHousekeeping + HOUSEKEEPING_SECONDS;
			nextHousekeeping = cursor + HOUSEKEEPING_INTERVAL;
			continue;
		}

		// The journey itself.
		const ambient = ambientAt(plan.start);
		let packTemp = ambient + 5;
		let rotorTemp = ambient + 3;
		let prevSpeed = 0;
		let travelled = 0;
		const startOdo = odo;

		// Doors before departure: driver always, others sometimes. Both rear
		// doors get used, since the point of the doors view is that passengers
		// leave a trace of their own.
		const boarding: [number, number, number, number] = [
			1,
			plan.passengers ? 1 : 0,
			plan.passengers && rand() < 0.5 ? 1 : 0,
			plan.passengers && rand() < 0.35 ? 1 : 0
		];
		for (let t = plan.start - 40; t < plan.start; t++) {
			const open = t < plan.start - 25 ? boarding : doorsClosed;
			emit({
				t,
				speed: 0,
				gear: GEAR.PARK,
				odo,
				soc,
				chargeKw: 0,
				pedal: 0,
				brake: 0,
				steering: NaN,
				longAccel: NaN,
				latAccel: NaN,
				motorRpm: 0,
				torque: 0,
				packTemp,
				rotorTemp,
				doors: open,
				tyres: tyreVector(tyreBase, ambient, rand),
				awake: true
			});
		}

		// A road trip stops once for a fast charge partway through.
		const fastChargeAt =
			plan.kind === 'roadtrip' ? plan.start + Math.floor(plan.durationSeconds * 0.55) : -1;

		// The charging stop consumes real time, so the rest of the journey has
		// to be pushed back by it rather than overlapping what was just emitted.
		let stoppedFor = 0;

		for (let elapsed = 0; elapsed <= plan.durationSeconds; elapsed++) {
			const t = plan.start + elapsed + stoppedFor;
			if (t >= endTime) break;

			if (plan.start + elapsed === fastChargeAt) {
				// Pull off the road first: the charger cannot be reached at speed.
				let approach = t;
				while (prevSpeed > 0) {
					const slowing = Math.max(0, prevSpeed - MAX_BRAKE_KMH_S);
					emit({
						t: approach,
						speed: slowing,
						gear: GEAR.DRIVE,
						odo,
						soc,
						chargeKw: 0,
						pedal: 0,
						brake: 1,
						steering: 0,
						longAccel: (slowing - prevSpeed) / 3.6 / 9.80665,
						latAccel: 0,
						motorRpm: slowing * 78,
						torque: 0,
						packTemp,
						rotorTemp,
						doors: doorsClosed,
						tyres: tyreVector(tyreBase, ambient, rand),
						awake: true
					});
					prevSpeed = slowing;
					approach += 1;
					stoppedFor += 1;
				}

				// A DC stop: high power tapering as the pack fills.
				const stopSeconds = 1500 + Math.floor(rand() * 600);
				for (let c = 0; c < stopSeconds; c++) {
					const fraction = soc / 100;
					const kw = Math.max(35, 175 * (1 - Math.pow(fraction, 2.4)));
					soc = Math.min(96, soc + (kw / PACK_KWH) * (100 / 3600));
					packTemp += 0.004;
					emit({
						t: approach + c,
						speed: 0,
						gear: GEAR.PARK,
						odo,
						soc,
						chargeKw: kw,
						pedal: 0,
						brake: 0,
						steering: NaN,
						longAccel: NaN,
						latAccel: NaN,
						motorRpm: 0,
						torque: 0,
						packTemp,
						rotorTemp,
						doors: doorsClosed,
						tyres: tyreVector(tyreBase, ambient, rand),
						awake: true
					});
				}
				stoppedFor += stopSeconds;
				// The car is stationary again, so the drive resumes from a stop
				// rather than jumping back to the speed it arrived at.
				prevSpeed = 0;
				continue;
			}

			// A few stops each journey are harder than the rest, which is what
			// gives the braking distribution its tail.
			const hardStop = Math.sin(elapsed / 311 + plan.start / 700) > 0.985;
			const speed = approachSpeed(prevSpeed, targetSpeed(plan, elapsed, rand), hardStop);
			const accelMs2 = (speed - prevSpeed) / 3.6;
			const longAccel = accelMs2 / 9.80665;
			// Cornering scales with speed and wanders along the route. Two
			// frequencies keep the bends from repeating on a fixed period.
			const latAccel =
				(Math.sin(elapsed / 23 + plan.start / 1000) * 0.6 +
					Math.sin(elapsed / 7.3 + plan.distanceKm) * 0.4) *
				0.26 *
				Math.min(1, speed / 70);
			const steering = latAccel * 220 + (rand() - 0.5) * 4;

			travelled += speed / 3600;
			odo = startOdo + Math.floor(travelled);

			// Power: rolling resistance and drag, plus what acceleration costs.
			const dragKw = 0.35 + Math.pow(speed / 100, 3) * 11 + speed * 0.05;
			const inertiaKw = (2100 * accelMs2 * (speed / 3.6)) / 1000;
			const powerKw = dragKw + inertiaKw;
			soc = Math.max(4, soc - (powerKw / PACK_KWH) * (100 / 3600));

			const motorRpm = speed * 78;
			const torque = (powerKw * 9550) / Math.max(400, motorRpm);
			rotorTemp += (ambient + 12 + Math.abs(powerKw) * 0.35 - rotorTemp) * 0.0025;
			packTemp += (ambient + 7 + Math.abs(powerKw) * 0.05 - packTemp) * 0.0009;

			emit({
				t,
				speed,
				gear: speed > 0.5 || elapsed < plan.durationSeconds - 5 ? GEAR.DRIVE : GEAR.PARK,
				odo,
				soc,
				chargeKw: 0,
				pedal: Math.max(0, Math.min(100, powerKw > 0 ? powerKw * 1.6 + rand() * 3 : 0)),
				brake: accelMs2 < -0.7 ? 1 : 0,
				steering,
				longAccel,
				latAccel,
				motorRpm,
				torque: powerKw >= 0 ? torque : -Math.abs(torque),
				packTemp,
				rotorTemp,
				doors: doorsClosed,
				tyres: tyreVector(tyreBase, ambient, rand),
				awake: true
			});
			prevSpeed = speed;
		}

		// Bring the car to a stop before parking it. Without this a journey cut
		// short at the end of the export window would appear to go from speed
		// straight to standstill in a single second.
		let stopClock = plan.start + plan.durationSeconds + stoppedFor;
		while (prevSpeed > 0) {
			const speed = Math.max(0, prevSpeed - MAX_BRAKE_KMH_S);
			stopClock += 1;
			emit({
				t: stopClock,
				speed,
				gear: GEAR.DRIVE,
				odo,
				soc,
				chargeKw: 0,
				pedal: 0,
				brake: 1,
				steering: 0,
				longAccel: (speed - prevSpeed) / 3.6 / 9.80665,
				latAccel: 0,
				motorRpm: speed * 78,
				torque: 0,
				packTemp,
				rotorTemp,
				doors: doorsClosed,
				tyres: tyreVector(tyreBase, ambient, rand),
				awake: true
			});
			prevSpeed = speed;
		}

		// Doors again on arrival.
		const arrival = stopClock;
		for (let t = arrival + 1; t < arrival + 40; t++) {
			const open = t > arrival + 8 && t < arrival + 25 ? boarding : doorsClosed;
			emit({
				t,
				speed: 0,
				gear: GEAR.PARK,
				odo,
				soc,
				chargeKw: 0,
				pedal: 0,
				brake: 0,
				steering: NaN,
				longAccel: NaN,
				latAccel: NaN,
				motorRpm: 0,
				torque: 0,
				packTemp,
				rotorTemp,
				doors: open,
				tyres: tyreVector(tyreBase, ambient, rand),
				awake: true
			});
		}

		// Tyres lose a little pressure over the month.
		tyreBase -= 0.02;
		cursor = arrival + 60;
		nextHousekeeping = cursor + HOUSEKEEPING_INTERVAL;
		planIndex++;
		if (planIndex >= plans.length) break;
	}

	samples.sort((a, b) => a.t - b.t);
	return buildDataset(samples, awd, seed);
}

/** Pressures follow temperature, with each wheel holding air slightly differently. */
function tyreVector(
	base: number,
	ambient: number,
	rand: () => number
): [number, number, number, number] {
	const thermal = (ambient - 15) * 0.9;
	const jitter = () => (rand() - 0.5) * 1.5;
	// Quantised to the 2.75 kPa the sensors actually report.
	const quantise = (v: number) => Math.round(v / 2.75) * 2.75;
	return [
		quantise(base + thermal + jitter()),
		quantise(base + thermal + 1 + jitter()),
		quantise(base + thermal + 6 + jitter()),
		quantise(base + thermal + 6.5 + jitter())
	];
}

function buildDataset(samples: Sample[], awd: boolean, seed: number): Dataset {
	const timeBuilder = new TimeBuilder(samples.length);
	const builders = new Map<string, ColumnBuilder>();
	const specs = new Map<string, ColumnSpec>();
	for (const stream of STREAM_IDS) {
		for (const spec of columnsForStream(stream)) {
			builders.set(spec.key, new ColumnBuilder(spec, samples.length));
			specs.set(spec.key, spec);
		}
	}

	const push = (key: string, value: number) => builders.get(key)!.push(value);

	let previous = -1;
	for (const sample of samples) {
		if (sample.t <= previous) continue;
		previous = sample.t;
		timeBuilder.push(sample.t);

		const moving = sample.speed > 0 || sample.gear !== GEAR.PARK;

		push('esp_vehspd', Math.round(sample.speed));
		// The stability module only reports acceleration while it is awake.
		push('esp_vehlongaccel', moving ? sample.longAccel : NaN);
		push('esp_vehlateralaccel', moving ? sample.latAccel : NaN);
		push('cdcu_totalodometer', sample.odo);
		push('eps_steeringangle', moving ? sample.steering : NaN);
		push('eps_steeringanglespd', moving ? sample.steering * 0.4 : NaN);
		push('ldcu_accpedalsig', Math.round(sample.pedal));
		push('ldcu_brkpedalst', sample.brake);
		push('ldcu_currentgearlev', sample.gear);

		const powerKw = (sample.torque * sample.motorRpm) / 9550;
		const current =
			sample.chargeKw > 0
				? -(sample.chargeKw * 1000) / NOMINAL_VOLT
				: (powerKw * 1000) / NOMINAL_VOLT;

		// A dual-motor car splits torque front to rear; a rear-drive one
		// leaves the front columns empty exactly as the real export does.
		push('ipuf_actrotspd', awd ? sample.motorRpm : NaN);
		push('ipuf_acttorq', awd ? sample.torque * 0.4 : NaN);
		push('ipuf_rotoracttemp', awd ? sample.rotorTemp - 3 : NaN);
		push('ipur_actrotspd', sample.motorRpm);
		push('ipur_acttorq', awd ? sample.torque * 0.6 : sample.torque);
		push('ipur_rotoracttemp', sample.rotorTemp);

		push('bms_battvolt', NOMINAL_VOLT - sample.soc * 0.05 + (sample.soc > 50 ? 12 : 0));
		push('bms_battcurr', current);
		push('ldcu_chrgpwr', sample.chargeKw);
		push('ldcu_bms_soc_disp', Math.round(sample.soc));
		push('bms_batttempmax_gb', Math.round(sample.packTemp + 2));
		push('bms_batttempmin_gb', Math.round(sample.packTemp - 1));
		push('bms_celltempmaxnum_gb', 14);
		push('bms_celltempminnum_gb', 3);
		// The car's range estimate is not a fixed ratio: it drops in the cold and
		// recovers in mild weather, which is what makes the estimate worth
		// charting rather than simply computing.
		const efficiency = Math.max(3.7, Math.min(5.2, 3.7 + (sample.packTemp - 18) * 0.075));
		push('ldcu_dstbatdisp_dynamic', Math.round(sample.soc * efficiency));

		push('ldcu_driverdoorajarst', sample.doors[0]);
		push('rdcu_psngrdoorajarst', sample.doors[1]);
		push('ldcu_rldoorajarst', sample.doors[2]);
		push('rdcu_rrdoorajarst', sample.doors[3]);
		// Window and tailgate feedback is absent on this model, as in the real export.
		push('ldcu_flwinposstfb', NaN);
		push('ldcu_rlwinposstfb', NaN);
		push('frwinposstfb', NaN);
		push('rrwinposstfb', NaN);
		push('rdm_tropenersts', NaN);

		push('ldcu_tpmsprfl', sample.tyres[0]);
		push('ldcu_tpmsprfr', sample.tyres[1]);
		push('ldcu_tpmsprrl', sample.tyres[2]);
		push('ldcu_tpmsprrr', sample.tyres[3]);
	}

	const columns = new Map<string, Column>();
	for (const [key, builder] of builders) columns.set(key, builder.finish());

	const emptyColumns = [...columns.values()]
		.filter((column) => column.nonNull === 0)
		.map((column) => column.spec.key);

	const time = timeBuilder.finish();
	return {
		time,
		columns,
		vin: 'DEMO0000000000000',
		vmodel: awd ? 'DEMO-AWD' : 'DEMO-RWD',
		exportId: `DEMO${seed}`,
		available: { status: true, operation: true, power: true },
		duplicateRows: 0,
		unsortedStreams: [],
		emptyColumns,
		rowsParsed: time.length,
		bytesParsed: 0,
		aligned: true
	};
}
