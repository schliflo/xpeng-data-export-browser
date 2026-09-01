/**
 * Energy integration from the high-voltage pack.
 *
 * The export has no energy counter, but it does have pack voltage and current
 * at 1 Hz, and their product is instantaneous DC power. Integrating that over a
 * span gives kWh. Current is positive while discharging and negative while
 * charging, which lets one pass separate energy drawn from energy recovered.
 *
 * Samples are integrated trapezoidally and any interval longer than
 * `MAX_INTERVAL_SECONDS` is skipped, so a sleep gap in the middle of a span
 * cannot invent energy that was never moved.
 */

import { valueAt, type Column } from '../store/columnar';

const MAX_INTERVAL_SECONDS = 10;

export interface EnergyTotals {
	/** kWh taken out of the pack. */
	discharged: number;
	/** kWh put back in, by regeneration or by charging. */
	charged: number;
	/** Highest instantaneous discharge power seen, in kW. */
	peakPowerKw: number;
	/** Highest instantaneous recovery power seen, in kW. */
	peakRegenKw: number;
}

export function instantPowerKw(volt: Column, current: Column, i: number): number {
	const v = valueAt(volt, i);
	const a = valueAt(current, i);
	if (Number.isNaN(v) || Number.isNaN(a)) return NaN;
	return (v * a) / 1000;
}

export function integrateEnergy(
	time: Uint32Array,
	volt: Column,
	current: Column,
	start: number,
	end: number
): EnergyTotals {
	let discharged = 0;
	let charged = 0;
	let peakPowerKw = 0;
	let peakRegenKw = 0;

	let prevPower = NaN;
	let prevTime = 0;

	for (let i = start; i <= end; i++) {
		const power = instantPowerKw(volt, current, i);
		if (Number.isNaN(power)) {
			prevPower = NaN;
			continue;
		}
		if (power > peakPowerKw) peakPowerKw = power;
		if (-power > peakRegenKw) peakRegenKw = -power;

		const t = time[i];
		if (!Number.isNaN(prevPower)) {
			const dt = t - prevTime;
			if (dt > 0 && dt <= MAX_INTERVAL_SECONDS) {
				// Trapezoid in kW·s, converted to kWh.
				const kWh = (((power + prevPower) / 2) * dt) / 3600;
				if (kWh >= 0) discharged += kWh;
				else charged += -kWh;
			}
		}
		prevPower = power;
		prevTime = t;
	}

	return { discharged, charged, peakPowerKw, peakRegenKw };
}

/** Integrates a single non-negative signal (such as charging power) into kWh. */
export function integrateSignal(
	time: Uint32Array,
	signal: Column,
	start: number,
	end: number
): number {
	let total = 0;
	let prev = NaN;
	let prevTime = 0;

	for (let i = start; i <= end; i++) {
		const value = valueAt(signal, i);
		if (Number.isNaN(value)) {
			prev = NaN;
			continue;
		}
		const t = time[i];
		if (!Number.isNaN(prev)) {
			const dt = t - prevTime;
			if (dt > 0 && dt <= MAX_INTERVAL_SECONDS) {
				total += (((value + prev) / 2) * dt) / 3600;
			}
		}
		prev = value;
		prevTime = t;
	}
	return total;
}
