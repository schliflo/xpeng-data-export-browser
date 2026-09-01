/**
 * Runs every analysis over a parsed dataset once, so the UI can render from
 * plain objects without ever touching the raw sample arrays.
 */

import type { Dataset } from '../store/columnar';
import { detectTrips, type Trip } from './trips';
import { summarizeCharging, type ChargingHabits } from './charging';
import { bucketDays, punchcard, type DayBucket } from './daily';
import {
	activityBands,
	impliedRange,
	packThermal,
	phantomDrain,
	type ActivityBand,
	type PackThermal,
	type PhantomDrain,
	type RangeEstimate
} from './battery';
import { doorActivity, tyreTrend, type DoorActivity, type TyreTrend } from './doorsTyres';
import {
	ggHistogram,
	histogram,
	speedProfile,
	topEvents,
	type ExtremeEvent,
	type GgHistogram,
	type Histogram,
	type SpeedProfile
} from './drivingStyle';
import { segmentAwake, totalCoverage, type Span } from './sessions';
import { buildFacts, type Fact } from './facts';

export interface DerivedData {
	timeZone: string;
	windowDays: number;
	startTime: number;
	endTime: number;
	coverageSeconds: number;
	awakeSpans: Span[];
	trips: Trip[];
	charging: ChargingHabits;
	days: DayBucket[];
	punchcard: number[][];
	drain: PhantomDrain;
	range: RangeEstimate;
	thermal: PackThermal;
	bands: ActivityBand[];
	doors: DoorActivity;
	tyres: TyreTrend;
	speed: SpeedProfile;
	gg: GgHistogram;
	pedalHistogram: Histogram;
	hardestBrakes: ExtremeEvent[];
	hardestAccels: ExtremeEvent[];
	fastestMoments: ExtremeEvent[];
	facts: {
		headline: Fact[];
		habit: Fact[];
		quirk: Fact[];
		privacy: Fact[];
	};
	odometerStart: number;
	odometerEnd: number;
}

export function analyze(dataset: Dataset, timeZone: string): DerivedData {
	const awakeSpans = segmentAwake(dataset.time);
	const trips = detectTrips(dataset);
	const charging = summarizeCharging(dataset, timeZone, trips);
	const days = bucketDays(dataset, trips, charging.sessions, timeZone);
	const drain = phantomDrain(dataset, charging.sessions, trips);
	const range = impliedRange(dataset);
	const thermal = packThermal(dataset);
	const doors = doorActivity(dataset, timeZone);
	const tyres = tyreTrend(dataset, timeZone);
	const speed = speedProfile(dataset);
	const gg = ggHistogram(dataset);

	const hardestBrakes = topEvents(dataset, 'esp_vehlongaccel', 10, { sign: -1 });
	const hardestAccels = topEvents(dataset, 'esp_vehlongaccel', 10, { sign: 1 });
	const fastestMoments = topEvents(dataset, 'esp_vehspd', 10, { sign: 1, spacing: 600 });

	const startTime = dataset.time.length ? dataset.time[0] : 0;
	const endTime = dataset.time.length ? dataset.time[dataset.time.length - 1] : 0;
	const windowDays = Math.max(1, Math.round((endTime - startTime) / 86400));

	const odometer = dataset.columns.get('cdcu_totalodometer');
	let odometerStart = NaN;
	let odometerEnd = NaN;
	if (odometer) {
		odometerStart = Number.isFinite(odometer.min) ? odometer.min : NaN;
		odometerEnd = Number.isFinite(odometer.max) ? odometer.max : NaN;
	}

	const derived: DerivedData = {
		timeZone,
		windowDays,
		startTime,
		endTime,
		coverageSeconds: totalCoverage(awakeSpans),
		awakeSpans,
		trips,
		charging,
		days,
		punchcard: punchcard(trips, dataset, timeZone),
		drain,
		range,
		thermal,
		bands: activityBands(trips, charging.sessions),
		doors,
		tyres,
		speed,
		gg,
		pedalHistogram: histogram(dataset, 'ldcu_accpedalsig', 0, 100, 20, (v) => v > 0),
		hardestBrakes,
		hardestAccels,
		fastestMoments,
		facts: { headline: [], habit: [], quirk: [], privacy: [] },
		odometerStart,
		odometerEnd
	};

	derived.facts = buildFacts({
		dataset,
		trips,
		charging,
		days,
		drain,
		range,
		thermal,
		doors,
		tyres,
		speed,
		hardestBrakes,
		timeZone,
		windowDays
	});

	return derived;
}

export type { Trip, ChargingHabits, DayBucket, Fact, Span };
