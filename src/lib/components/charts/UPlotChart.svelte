<!--
  Time-series chart.

  uPlot is used here rather than an SVG chart library because these series run
  to a million points; the data handed in is already downsampled to about two
  points per pixel, and the chart is redrawn as the view changes.

  Colours come from the theme's chart tokens, resolved at mount so light and
  dark both work, and the axes are deliberately recessive so the data carries
  the contrast. Hovering reads out the sample under the pointer; when several
  panels share a cursor the others show the same instant in the corner, so one
  moment can be read across speed, power and charge at once.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type uPlot from 'uplot';
	import { settings } from '$lib/state/settings.svelte';
	import ChartTooltip from './ChartTooltip.svelte';

	export interface ChartSeries {
		label: string;
		/** CSS custom property name, e.g. `--viz-speed`. */
		color: string;
		unit?: string;
		/** Draw as steps for signals that hold a value until they change. */
		step?: boolean;
		fill?: boolean;
		values: Float64Array;
		/** Map a raw value onto a label, for enum signals. */
		format?: (value: number) => string;
	}

	interface Props {
		x: Float64Array;
		series: ChartSeries[];
		height?: number;
		/** Shared key so several charts move their cursors together. */
		syncKey?: string;
		yRange?: [number, number];
		onZoom?: (from: number, to: number) => void;
		/** Time formatting for the readout; dates alone suit daily series. */
		timeFormat?: 'instant' | 'day';
		class?: string;
	}

	let {
		x,
		series,
		height = 200,
		syncKey,
		yRange,
		onZoom,
		timeFormat = 'instant',
		class: className = ''
	}: Props = $props();

	let host = $state<HTMLDivElement>();
	let chart: uPlot | null = null;
	let uPlotLib: typeof uPlot | null = null;
	let width = $state(600);

	// Cursor state, mirrored out of uPlot so the readout can be plain markup.
	let cursorIndex = $state<number | null>(null);
	let cursorLeft = $state(0);
	let cursorTop = $state(0);
	let pointerInside = $state(false);
	// Offset of the plotting area inside the host, so the readout can be placed
	// against the sample rather than against the axes.
	let plotLeft = $state(0);
	let plotTop = $state(0);

	function cssColor(token: string, fallback: string): string {
		if (typeof window === 'undefined' || !host) return fallback;
		const value = getComputedStyle(host).getPropertyValue(token).trim();
		return value || fallback;
	}

	const instantFormat = $derived(
		new Intl.DateTimeFormat('en-GB', {
			day: 'numeric',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false,
			timeZone: settings.timeZone
		})
	);

	const dayFormat = $derived(
		new Intl.DateTimeFormat('en-GB', {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			timeZone: 'UTC'
		})
	);

	function formatTime(seconds: number): string {
		const format = timeFormat === 'day' ? dayFormat : instantFormat;
		return format.format(new Date(seconds * 1000));
	}

	/** One series value as text, honouring an enum mapping or its unit. */
	function formatValue(item: ChartSeries, raw: number | null | undefined): string {
		if (raw == null || Number.isNaN(raw)) return 'no reading';
		if (item.format) return item.format(raw);
		return `${raw.toFixed(Math.abs(raw) < 10 ? 2 : 0)}${item.unit ? ` ${item.unit}` : ''}`;
	}

	/** The values under the cursor, in the order the series were given. */
	const readout = $derived.by(() => {
		const index = cursorIndex;
		if (index === null || index < 0 || index >= x.length) return null;
		return {
			time: formatTime(x[index]),
			rows: series.map((item) => ({
				label: item.label,
				color: item.color,
				text: formatValue(item, item.values[index])
			}))
		};
	});

	/** Records where the plotting area sits, so the readout can follow a sample. */
	function measurePlot(self: uPlot): void {
		if (!host) return;
		const outer = host.getBoundingClientRect();
		const over = self.over.getBoundingClientRect();
		plotLeft = over.left - outer.left;
		plotTop = over.top - outer.top;
	}

	function buildOptions(): uPlot.Options {
		const axisColor = cssColor('--viz-axis', '#383835');
		const gridColor = cssColor('--viz-grid', '#2c2c2a');
		const labelColor = cssColor('--viz-muted', '#898781');

		return {
			width,
			height,
			// The data is pre-scaled; uPlot must not resample it again.
			pxAlign: false,
			cursor: {
				sync: syncKey ? { key: syncKey } : undefined,
				drag: { x: true, y: false, setScale: true },
				points: { size: 7 }
			},
			legend: { show: false },
			scales: {
				x: { time: true },
				y: yRange ? { range: () => yRange } : {}
			},
			axes: [
				{
					stroke: labelColor,
					grid: { stroke: gridColor, width: 1 },
					ticks: { stroke: axisColor, width: 1 },
					font: '11px Inter Variable, system-ui, sans-serif'
				},
				{
					stroke: labelColor,
					grid: { stroke: gridColor, width: 1 },
					ticks: { stroke: axisColor, width: 1 },
					font: '11px Inter Variable, system-ui, sans-serif',
					size: 48
				}
			],
			series: [
				{
					// Timestamps are epoch seconds in the viewer's timezone.
					value: (_self, raw) => (raw == null ? '' : formatTime(raw))
				},
				...series.map((s) => ({
					label: s.label,
					stroke: cssColor(s.color, '#3987e5'),
					width: 2,
					fill: s.fill
						? `color-mix(in oklab, ${cssColor(s.color, '#3987e5')} 18%, transparent)`
						: undefined,
					paths: s.step ? uPlotLib!.paths.stepped!({ align: 1 }) : undefined,
					points: { show: false },
					spanGaps: false,
					value: (_self: uPlot, raw: number | null) => formatValue(s, raw)
				}))
			],
			hooks: {
				ready: [(self: uPlot) => measurePlot(self)],
				setSize: [(self: uPlot) => measurePlot(self)],
				setCursor: [
					(self: uPlot) => {
						const index = self.cursor.idx;
						cursorIndex = index == null ? null : index;
						cursorLeft = self.cursor.left ?? 0;
						cursorTop = self.cursor.top ?? 0;
					}
				],
				setScale: [
					(self: uPlot, key: string) => {
						if (key !== 'x' || !onZoom) return;
						const { min, max } = self.scales.x;
						if (min != null && max != null) onZoom(min, max);
					}
				]
			}
		};
	}

	function chartData(): uPlot.AlignedData {
		return [x, ...series.map((s) => s.values)] as unknown as uPlot.AlignedData;
	}

	onMount(() => {
		let disposed = false;

		// uPlot touches the DOM at import time, so it stays out of the server bundle.
		import('uplot').then((module) => {
			if (disposed || !host) return;
			uPlotLib = module.default;
			chart = new uPlotLib(buildOptions(), chartData(), host);
		});

		const observer = new ResizeObserver((entries) => {
			const next = Math.floor(entries[0].contentRect.width);
			if (next > 0 && next !== width) {
				width = next;
				chart?.setSize({ width: next, height });
			}
		});
		if (host) observer.observe(host);

		return () => {
			disposed = true;
			observer.disconnect();
			chart?.destroy();
			chart = null;
		};
	});

	// Redraw whenever the data changes; the chart itself is only built once.
	$effect(() => {
		const data = chartData();
		untrack(() => chart?.setData(data));
	});
</script>

<div
	bind:this={host}
	class="relative w-full {className}"
	style="height: {height}px"
	role="img"
	aria-label="{series.map((s) => s.label).join(', ')} over time"
	onpointerenter={() => (pointerInside = true)}
	onpointerleave={() => {
		pointerInside = false;
		// The cursor survives on synced charts; here there is nothing to read.
		if (!syncKey) cursorIndex = null;
	}}
>
	{#if readout && pointerInside}
		<ChartTooltip x={plotLeft + cursorLeft} y={plotTop + cursorTop} bounds={width}>
			<p class="font-medium tabular-nums">{readout.time}</p>
			<dl class="mt-1 space-y-0.5">
				{#each readout.rows as row (row.label)}
					<div class="flex items-center gap-2">
						<span class="size-2 shrink-0 rounded-full" style="background: var({row.color})"></span>
						<dt class="text-muted-foreground">{row.label}</dt>
						<dd class="ml-auto font-medium tabular-nums">{row.text}</dd>
					</div>
				{/each}
			</dl>
		</ChartTooltip>
	{:else if readout && syncKey}
		<!-- Another panel is being hovered; this one reports the same instant. -->
		<div
			class="pointer-events-none absolute top-1 right-1 z-20 flex flex-wrap items-center justify-end gap-x-3 gap-y-0.5 rounded-md bg-background/80 px-2 py-1 text-[11px] backdrop-blur"
		>
			{#each readout.rows as row (row.label)}
				<span class="flex items-center gap-1.5">
					<span class="size-2 shrink-0 rounded-full" style="background: var({row.color})"></span>
					<span class="font-medium tabular-nums">{row.text}</span>
				</span>
			{/each}
		</div>
	{/if}
</div>

<style>
	/* uPlot ships its own stylesheet; these keep it in the app's palette. */
	:global(.u-cursor-x),
	:global(.u-cursor-y) {
		border-color: var(--viz-muted);
	}
	:global(.u-select) {
		background: color-mix(in oklab, var(--viz-1) 18%, transparent);
	}
</style>
