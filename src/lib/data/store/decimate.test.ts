import { describe, expect, it } from 'vitest';
import { COLUMNS, type ColumnSpec } from '../schema/columns';
import { ColumnBuilder } from './columnar';
import { breakAtGaps, buildPyramid, selectSeries } from './decimate';

function column(values: (number | null)[], key = 'esp_vehspd') {
	const spec = COLUMNS.get(key) as ColumnSpec;
	const builder = new ColumnBuilder(spec, values.length);
	for (const value of values) builder.push(value === null ? NaN : value);
	return builder.finish();
}

describe('decimation', () => {
	const n = 20000;
	const time = new Uint32Array(Array.from({ length: n }, (_, i) => 1000 + i));

	it('keeps a brief spike visible when zoomed out', () => {
		// A one-second spike in nearly six hours of otherwise flat data is
		// exactly what averaging would erase.
		const values = new Array(n).fill(30);
		values[12345] = 148;
		const col = column(values);
		const pyramid = buildPyramid(time, col);

		const series = selectSeries(time, col, pyramid, time[0], time[n - 1], 800);
		expect(series.x.length).toBeLessThan(n / 4);
		expect(Math.max(...series.y)).toBe(148);
	});

	it('returns raw samples once the window is small enough', () => {
		const col = column(Array.from({ length: n }, (_, i) => i % 100));
		const pyramid = buildPyramid(time, col);
		const series = selectSeries(time, col, pyramid, 1000, 1300, 800);
		expect(series.x.length).toBe(301);
		expect(series.y[5]).toBe(5);
	});

	it('stays close to two points per pixel at any width', () => {
		const col = column(Array.from({ length: n }, (_, i) => i % 60));
		const pyramid = buildPyramid(time, col);
		for (const width of [200, 800, 2000]) {
			const series = selectSeries(time, col, pyramid, time[0], time[n - 1], width);
			expect(series.x.length).toBeLessThanOrEqual(width * 2);
			// And not so sparse that the chart looks blocky.
			expect(series.x.length).toBeGreaterThan(width / 4);
		}
	});

	it('leaves a gap where the signal had no readings', () => {
		const values: (number | null)[] = new Array(n).fill(20);
		for (let i = 5000; i < 9000; i++) values[i] = null;
		const col = column(values);
		const pyramid = buildPyramid(time, col);
		const series = selectSeries(time, col, pyramid, time[0], time[n - 1], 600);
		expect(series.y.some((v) => Number.isNaN(v))).toBe(true);
	});

	it('never draws a line across a sleep gap', () => {
		const sparse = new Uint32Array([0, 1, 2, 90000, 90001]);
		const series = { x: Float64Array.from(sparse), y: Float64Array.from([1, 2, 3, 4, 5]) };
		const broken = breakAtGaps(series, 60);
		expect(broken.x.length).toBe(6);
		expect(broken.y[3]).toBeNaN();
	});

	it('leaves a continuous series untouched', () => {
		const series = { x: Float64Array.from([0, 1, 2]), y: Float64Array.from([1, 2, 3]) };
		expect(breakAtGaps(series, 60)).toBe(series);
	});

	it('is monotonic in time after decimation', () => {
		const col = column(Array.from({ length: n }, (_, i) => (i * 7) % 140));
		const pyramid = buildPyramid(time, col);
		const series = selectSeries(time, col, pyramid, time[0], time[n - 1], 500);
		for (let i = 1; i < series.x.length; i++) {
			expect(series.x[i]).toBeGreaterThanOrEqual(series.x[i - 1]);
		}
	});
});
