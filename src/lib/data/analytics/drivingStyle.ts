/**
 * Driving-style distributions.
 *
 * The acceleration pair is only reported while the stability-control module is
 * awake, which is essentially "while driving" — so these histograms describe
 * the driving itself rather than the 80% of the export spent parked.
 */

import { valueAt, type Dataset } from '../store/columnar';

export interface Histogram {
	/** Left edge of each bin. */
	edges: number[];
	counts: number[];
	total: number;
	/** Seconds represented per unit count, for reading the axis as time. */
	unit: string;
}

export function histogram(
	dataset: Dataset,
	key: string,
	min: number,
	max: number,
	bins: number,
	filter?: (value: number) => boolean
): Histogram {
	const column = dataset.columns.get(key);
	const edges = Array.from({ length: bins }, (_, i) => min + ((max - min) * i) / bins);
	const counts = new Array(bins).fill(0);
	let total = 0;
	if (!column) return { edges, counts, total, unit: '' };

	const width = (max - min) / bins;
	for (let i = 0; i < dataset.time.length; i++) {
		const value = valueAt(column, i);
		if (Number.isNaN(value)) continue;
		if (filter && !filter(value)) continue;
		const bin = Math.min(bins - 1, Math.max(0, Math.floor((value - min) / width)));
		counts[bin]++;
		total++;
	}
	return { edges, counts, total, unit: column.spec.unit };
}

export interface GgHistogram {
	/** Row-major bins, `size` × `size`, indexed [lateral][longitudinal]. */
	grid: Uint32Array;
	size: number;
	extent: number;
	max: number;
	total: number;
}

/**
 * Longitudinal against lateral acceleration — the "g-g diagram" used to show
 * how much of the tyres' grip a driver actually uses. A cautious driver fills
 * a small cross; a spirited one fills a circle.
 */
export function ggHistogram(dataset: Dataset, size = 64, extent = 0.9): GgHistogram {
	const long = dataset.columns.get('esp_vehlongaccel');
	const lat = dataset.columns.get('esp_vehlateralaccel');
	const grid = new Uint32Array(size * size);
	let max = 0;
	let total = 0;
	if (!long || !lat) return { grid, size, extent, max, total };

	for (let i = 0; i < dataset.time.length; i++) {
		const x = valueAt(lat, i);
		const y = valueAt(long, i);
		if (Number.isNaN(x) || Number.isNaN(y)) continue;
		const col = Math.floor(((x + extent) / (2 * extent)) * size);
		const row = Math.floor(((y + extent) / (2 * extent)) * size);
		if (col < 0 || col >= size || row < 0 || row >= size) continue;
		const index = row * size + col;
		const next = grid[index] + 1;
		grid[index] = next;
		if (next > max) max = next;
		total++;
	}
	return { grid, size, extent, max, total };
}

export interface ExtremeEvent {
	time: number;
	index: number;
	value: number;
	speed: number;
}

/**
 * The strongest moments of a signal, keeping only one event per `spacing`
 * seconds so a single hard stop does not fill the whole list.
 */
export function topEvents(
	dataset: Dataset,
	key: string,
	count: number,
	options: { sign?: 1 | -1; spacing?: number } = {}
): ExtremeEvent[] {
	const { sign = 1, spacing = 60 } = options;
	const column = dataset.columns.get(key);
	if (!column) return [];
	const speed = dataset.columns.get('esp_vehspd');

	const candidates: ExtremeEvent[] = [];
	for (let i = 0; i < dataset.time.length; i++) {
		const value = valueAt(column, i);
		if (Number.isNaN(value)) continue;
		candidates.push({
			time: dataset.time[i],
			index: i,
			value,
			speed: speed ? valueAt(speed, i) : NaN
		});
	}
	candidates.sort((a, b) => (b.value - a.value) * sign);

	const chosen: ExtremeEvent[] = [];
	for (const candidate of candidates) {
		if (chosen.length >= count) break;
		if (chosen.some((e) => Math.abs(e.time - candidate.time) < spacing)) continue;
		chosen.push(candidate);
	}
	return chosen;
}

export interface SpeedProfile {
	histogram: Histogram;
	/** Seconds spent above each of a few notable speeds. */
	secondsAbove: Array<{ speed: number; seconds: number }>;
	maxSpeed: number;
	maxSpeedTime: number;
}

export function speedProfile(dataset: Dataset): SpeedProfile {
	const speed = dataset.columns.get('esp_vehspd');
	const thresholds = [50, 100, 120, 130, 150, 180];
	const secondsAbove = thresholds.map((s) => ({ speed: s, seconds: 0 }));
	let maxSpeed = 0;
	let maxSpeedTime = 0;

	if (speed) {
		for (let i = 0; i < dataset.time.length; i++) {
			const value = valueAt(speed, i);
			if (Number.isNaN(value)) continue;
			if (value > maxSpeed) {
				maxSpeed = value;
				maxSpeedTime = dataset.time[i];
			}
			const dt = i > 0 ? dataset.time[i] - dataset.time[i - 1] : 1;
			if (dt <= 0 || dt > 10) continue;
			for (const entry of secondsAbove) {
				if (value >= entry.speed) entry.seconds += dt;
			}
		}
	}

	return {
		// Moving only: the parked zeros would dwarf everything else.
		histogram: histogram(dataset, 'esp_vehspd', 0, 160, 32, (v) => v > 0),
		secondsAbove: secondsAbove.filter((entry) => entry.seconds > 0),
		maxSpeed,
		maxSpeedTime
	};
}
