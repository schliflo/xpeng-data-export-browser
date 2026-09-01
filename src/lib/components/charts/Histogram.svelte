<!--
  Distribution of a signal.

  Bars share a baseline and a single hue, because the comparison is between
  positions on one continuous scale rather than between named categories. The
  bar tops are rounded and the fills separated by a hairline gap, so adjacent
  bins stay countable. Hovering a column names its range and how much of the
  month landed in it; the rest of the bars recede so the one being read stands
  out.
-->
<script lang="ts">
	import { duration, num } from '$lib/utils/format';
	import ChartTooltip from './ChartTooltip.svelte';

	interface Props {
		edges: number[];
		counts: number[];
		unit?: string;
		label?: string;
		accent?: string;
		height?: number;
		/** Total observations, used to show each bar as a share. */
		total?: number;
		/** Counts are 1 Hz samples, so they can be read as seconds. */
		countsAreSeconds?: boolean;
		formatBin?: (from: number, to: number) => string;
	}

	let {
		edges,
		counts,
		unit = '',
		label = '',
		accent = '--viz-1',
		height = 160,
		total,
		countsAreSeconds = false,
		formatBin
	}: Props = $props();

	const max = $derived(Math.max(1, ...counts));
	const sum = $derived(total ?? counts.reduce((a, b) => a + b, 0));
	const width = $derived(edges.length > 1 ? edges[1] - edges[0] : 1);

	let bars = $state<HTMLDivElement>();
	let hovered = $state<number | null>(null);
	let anchor = $state({ x: 0, y: 0 });
	let plotWidth = $state(0);

	/**
	 * Counts come from 1 Hz samples, so a count is a number of seconds. Saying
	 * "3 h 12 m" is more use than "11,520" when the bar height is time spent.
	 */
	const peakLabel = $derived.by(() => {
		if (!countsAreSeconds) return `peak ${num(max)}`;
		return `peak ${duration(max, 'short')}`;
	});

	function binRange(index: number): string {
		const from = edges[index];
		const to = from + width;
		return formatBin ? formatBin(from, to) : `${num(from)}–${num(to)}${unit ? ` ${unit}` : ''}`;
	}

	function binAmount(index: number): string {
		return countsAreSeconds
			? duration(counts[index], 'short')
			: `${num(counts[index])} ${counts[index] === 1 ? 'sample' : 'samples'}`;
	}

	const share = $derived(hovered === null || sum <= 0 ? 0 : (counts[hovered] / sum) * 100);

	/** Resolves the pointer onto a bar and anchors the readout to its top. */
	function track(event: PointerEvent): void {
		const column = (event.target as HTMLElement).closest<HTMLElement>('[data-bin]');
		if (!column || !bars) {
			hovered = null;
			return;
		}
		const index = Number(column.dataset.bin);
		const outer = bars.getBoundingClientRect();
		const box = column.getBoundingClientRect();
		plotWidth = outer.width;
		anchor = {
			x: box.left - outer.left + box.width / 2,
			y: outer.height - Math.max(2, (counts[index] / max) * outer.height)
		};
		hovered = index;
	}
</script>

<figure class="flex flex-col gap-2">
	<div
		bind:this={bars}
		class="relative flex items-end gap-[2px]"
		style="height: {height}px"
		role="img"
		aria-label="{label || 'Distribution'}, {counts.length} bins"
		onpointermove={track}
		onpointerleave={() => (hovered = null)}
	>
		<!-- The tallest bar is labelled so the height means something without
		     spending a whole axis on it. -->
		<span
			class="pointer-events-none absolute top-0 right-0 text-[10px] text-muted-foreground tabular-nums"
		>
			{peakLabel}
		</span>
		{#each counts as count, i (i)}
			<div
				data-bin={i}
				class="relative flex flex-1 items-end transition-opacity"
				style="height: 100%; opacity: {hovered === null || hovered === i ? 1 : 0.45}"
			>
				<div
					class="w-full rounded-t-[4px]"
					style="height: {Math.max(
						count > 0 ? 2 : 0,
						(count / max) * 100
					)}%; background: var({accent})"
				></div>
			</div>
		{/each}

		{#if hovered !== null}
			<ChartTooltip x={anchor.x} y={anchor.y} bounds={plotWidth}>
				<p class="font-medium tabular-nums">{binRange(hovered)}</p>
				<p class="mt-0.5 flex items-center gap-2">
					<span class="size-2 shrink-0 rounded-full" style="background: var({accent})"></span>
					<span class="font-medium tabular-nums">{binAmount(hovered)}</span>
					<span class="text-muted-foreground tabular-nums">{num(share, 1)}%</span>
				</p>
			</ChartTooltip>
		{/if}
	</div>

	<div class="flex justify-between text-[10px] text-muted-foreground tabular-nums">
		<span>{num(edges[0])}</span>
		<span>{num(edges[Math.floor(edges.length / 2)])}</span>
		<span>{num(edges[edges.length - 1] + width)}{unit ? ` ${unit}` : ''}</span>
	</div>

	{#if label}
		<figcaption class="text-xs text-muted-foreground">{label}</figcaption>
	{/if}
</figure>
