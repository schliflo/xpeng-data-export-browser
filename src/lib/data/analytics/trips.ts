/**
 * Trip detection.
 *
 * A trip runs from the moment the car leaves Park with the odometer moving to
 * the moment it has been back in Park for a while. The odometer is the
 * authority on distance because it is monotonic and survives the stretches
 * where the ESP module stops reporting speed.
 */

import { GEAR } from '../schema/columns';
import { valueAt, type Column, type Dataset } from '../store/columnar';
import { integrateEnergy } from './energy';
import { segmentAwake, type Span } from './sessions';

/** Time in Park before a trip is considered finished. */
const PARK_SETTLE_SECONDS = 120;
/** Trips shorter than this are treated as shuffling in a parking space. */
const MIN_TRIP_SECONDS = 30;
const MIN_TRIP_KM = 0.2;

export interface Trip {
	index: number;
	start: number;
	end: number;
	startTime: number;
	endTime: number;
	/** Wall-clock seconds from first to last sample. */
	duration: number;
	/** Seconds with the car actually rolling. */
	movingSeconds: number;
	distanceKm: number;
	avgSpeed: number;
	maxSpeed: number;
	maxSpeedTime: number;
	socStart: number;
	socEnd: number;
	energyKwh: number;
	regenKwh: number;
	/** Share of gross energy that came back through regeneration, 0–1. */
	regenShare: number;
	/** kWh per 100 km, or NaN for a trip too short to be meaningful. */
	consumption: number;
	peakAccel: number;
	peakBrake: number;
	peakLateral: number;
	maxSpeedIndex: number;
}

function firstFinite(column: Column | undefined, from: number, to: number): number {
	if (!column) return NaN;
	for (let i = from; i <= to; i++) {
		const v = valueAt(column, i);
		if (!Number.isNaN(v)) return v;
	}
	return NaN;
}

function lastFinite(column: Column | undefined, from: number, to: number): number {
	if (!column) return NaN;
	for (let i = to; i >= from; i--) {
		const v = valueAt(column, i);
		if (!Number.isNaN(v)) return v;
	}
	return NaN;
}

/** Index ranges where the car was out of Park and moving. */
function candidateSpans(dataset: Dataset, awake: Span[]): Span[] {
	const gear = dataset.columns.get('ldcu_currentgearlev');
	const speed = dataset.columns.get('esp_vehspd');
	const odo = dataset.columns.get('cdcu_totalodometer');
	const { time } = dataset;
	const spans: Span[] = [];

	for (const span of awake) {
		let start = -1;
		let lastActive = -1;

		for (let i = span.start; i <= span.end; i++) {
			const g = gear ? valueAt(gear, i) : NaN;
			const v = speed ? valueAt(speed, i) : NaN;
			// "In motion" is a gear out of Park, or any reported road speed —
			// either is enough, since the two modules sleep independently.
			const driving =
				(!Number.isNaN(g) && (g === GEAR.DRIVE || g === GEAR.REVERSE || g === GEAR.NEUTRAL)) ||
				(!Number.isNaN(v) && v > 0);

			if (driving) {
				if (start === -1) start = i;
				lastActive = i;
			} else if (start !== -1 && time[i] - time[lastActive] >= PARK_SETTLE_SECONDS) {
				spans.push({
					start,
					end: lastActive,
					startTime: time[start],
					endTime: time[lastActive]
				});
				start = -1;
				lastActive = -1;
			}
		}

		if (start !== -1) {
			spans.push({ start, end: lastActive, startTime: time[start], endTime: time[lastActive] });
		}
	}

	// Keep only spans that actually covered ground.
	return spans.filter((span) => {
		if (span.endTime - span.startTime < MIN_TRIP_SECONDS) return false;
		if (!odo) return true;
		const from = firstFinite(odo, span.start, span.end);
		const to = lastFinite(odo, span.start, span.end);
		return !Number.isNaN(from) && !Number.isNaN(to) && to - from >= MIN_TRIP_KM;
	});
}

export function detectTrips(dataset: Dataset): Trip[] {
	const awake = segmentAwake(dataset.time);
	const spans = candidateSpans(dataset, awake);

	const speed = dataset.columns.get('esp_vehspd');
	const odo = dataset.columns.get('cdcu_totalodometer');
	const soc = dataset.columns.get('ldcu_bms_soc_disp');
	const volt = dataset.columns.get('bms_battvolt');
	const current = dataset.columns.get('bms_battcurr');
	const longAccel = dataset.columns.get('esp_vehlongaccel');
	const latAccel = dataset.columns.get('esp_vehlateralaccel');
	const { time } = dataset;

	return spans.map((span, index) => {
		let maxSpeed = 0;
		let maxSpeedIndex = span.start;
		let movingSeconds = 0;
		let peakAccel = 0;
		let peakBrake = 0;
		let peakLateral = 0;

		for (let i = span.start; i <= span.end; i++) {
			if (speed) {
				const v = valueAt(speed, i);
				if (!Number.isNaN(v)) {
					if (v > maxSpeed) {
						maxSpeed = v;
						maxSpeedIndex = i;
					}
					if (v > 0 && i > span.start) {
						const dt = time[i] - time[i - 1];
						if (dt > 0 && dt <= 10) movingSeconds += dt;
					}
				}
			}
			if (longAccel) {
				const a = valueAt(longAccel, i);
				if (!Number.isNaN(a)) {
					if (a > peakAccel) peakAccel = a;
					if (-a > peakBrake) peakBrake = -a;
				}
			}
			if (latAccel) {
				const a = valueAt(latAccel, i);
				if (!Number.isNaN(a)) {
					const mag = Math.abs(a);
					if (mag > peakLateral) peakLateral = mag;
				}
			}
		}

		const odoStart = firstFinite(odo, span.start, span.end);
		const odoEnd = lastFinite(odo, span.start, span.end);
		const distanceKm =
			Number.isNaN(odoStart) || Number.isNaN(odoEnd) ? NaN : Math.max(0, odoEnd - odoStart);

		const energy =
			volt && current
				? integrateEnergy(time, volt, current, span.start, span.end)
				: { discharged: NaN, charged: NaN, peakPowerKw: NaN, peakRegenKw: NaN };

		const gross = energy.discharged + energy.charged;
		const duration = span.endTime - span.startTime;

		return {
			index,
			start: span.start,
			end: span.end,
			startTime: span.startTime,
			endTime: span.endTime,
			duration,
			movingSeconds,
			distanceKm,
			avgSpeed: movingSeconds > 0 ? (distanceKm / movingSeconds) * 3600 : NaN,
			maxSpeed,
			maxSpeedTime: time[maxSpeedIndex],
			maxSpeedIndex,
			socStart: firstFinite(soc, span.start, span.end),
			socEnd: lastFinite(soc, span.start, span.end),
			energyKwh: energy.discharged,
			regenKwh: energy.charged,
			regenShare: gross > 0 ? energy.charged / gross : NaN,
			consumption:
				distanceKm >= 1 && Number.isFinite(energy.discharged)
					? ((energy.discharged - energy.charged) / distanceKm) * 100
					: NaN,
			peakAccel,
			peakBrake,
			peakLateral
		};
	});
}
