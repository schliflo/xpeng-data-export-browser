/**
 * Runs every analysis over a parsed dataset once, so the UI can render from
 * plain objects without ever touching the raw sample arrays.
 */

import type { CoverageWindow, Dataset } from '../store/columnar';
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
import {
	coverageWindows,
	coveredSeconds,
	segmentAwake,
	totalCoverage,
	type Span
} from './sessions';
import { buildFacts, type Fact } from './facts';

export interface DerivedData {
	timeZone: string;
	/** Calendar days from the first sample to the last, holes included. */
	windowDays: number;
	startTime: number;
	endTime: number;
	/** Seconds the car was awake and logging. */
	coverageSeconds: number;
	/** The stretches of time this data accounts for; several once merged. */
	coverage: CoverageWindow[];
	/** Seconds inside those stretches — the honest denominator for shares. */
	recordedSeconds: number;
	/** Calendar days an export actually covers. */
	recordedDays: number;
	/** How many exports were merged to produce this. */
	sources: number;
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

	const coverage = coverageWindows(dataset);
	const recordedDays = days.filter((day) => day.covered).length;

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
		coverage,
		recordedSeconds: Math.max(1, coveredSeconds(coverage)),
		recordedDays,
		// The exports behind this, not the windows: two that overlap still
		// came from two files.
		sources: dataset.coverage?.length ?? 1,
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
		recordedSeconds: derived.recordedSeconds,
		recordedDays,
		sources: derived.sources
	});

	return derived;
}

export type { Trip, ChargingHabits, DayBucket, Fact, Span, CoverageWindow };
