<!--
  Activity by weekday and hour.

  Two categorical axes with a magnitude at each crossing, so the form is a
  matrix on a single-hue ramp. It is the clearest way to show a routine: the
  commute appears as two vertical bands on weekdays and nothing at night.
  Hovering a cell names the hour it stands for and what happened in it.
-->
<script lang="ts">
	import { num, WEEKDAYS } from '$lib/utils/format';
	import ChartTooltip from './ChartTooltip.svelte';

	interface Props {
		/** Seven rows of 24 values, indexed [weekday][hour]. */
		grid: number[][];
		label?: string;
		unit?: string;
		/** Turns a raw cell value into its tooltip text. */
		formatValue?: (value: number) => string;
	}

	let {
		grid,
		label = 'Driving activity',
		unit = '',
		formatValue = (value: number) => `${num(value)}${unit ? ` ${unit}` : ''}`
	}: Props = $props();

	const max = $derived(Math.max(1, ...grid.flat()));

	let frame = $state<HTMLElement>();
	let hovered = $state<{ day: number; hour: number; value: number } | null>(null);
	let anchor = $state({ x: 0, y: 0 });
	let frameWidth = $state(0);

	function tone(value: number): string {
		if (value <= 0) return 'var(--viz-grid)';
		const t = Math.min(1, Math.sqrt(value / max));
		return `color-mix(in oklab, var(--viz-3) ${Math.max(18, t * 100)}%, var(--viz-grid))`;
	}

	/**
	 * Resolves the pointer onto a cell and anchors the readout to it. Measured
	 * against the whole figure, so a sideways scroll of the matrix cannot clip
	 * the card.
	 */
	function track(event: PointerEvent): void {
		const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-hour]');
		if (!cell || !frame) {
			hovered = null;
			return;
		}
		const day = Number(cell.dataset.day);
		const hour = Number(cell.dataset.hour);
		const outer = frame.getBoundingClientRect();
		const box = cell.getBoundingClientRect();
		frameWidth = outer.width;
		anchor = { x: box.left - outer.left + box.width / 2, y: box.top - outer.top };
		hovered = { day, hour, value: grid[day][hour] };
	}

	/** Where this hour ranks against every other hour of the week. */
	const share = $derived.by(() => {
		const cell = hovered;
		if (!cell || cell.value <= 0) return null;
		const total = grid.flat().reduce((a, b) => a + b, 0);
		return total > 0 ? (cell.value / total) * 100 : null;
	});
</script>

<figure bind:this={frame} class="relative flex flex-col gap-2">
	<div
		class="overflow-x-auto"
		role="img"
		aria-label="{label}, by weekday and hour"
		onpointermove={track}
		onpointerleave={() => (hovered = null)}
	>
		<div class="min-w-[520px]">
			<div class="flex gap-[3px] pl-9">
				{#each Array(24) as _, hour (hour)}
					<span class="w-4 text-center text-[9px] leading-none text-muted-foreground">
						{hour % 6 === 0 ? hour : ''}
					</span>
				{/each}
			</div>

			{#each grid as row, day (day)}
				<div class="mt-[3px] flex items-center gap-[3px]">
					<span class="w-9 shrink-0 text-[10px] text-muted-foreground">{WEEKDAYS[day]}</span>
					{#each row as value, hour (hour)}
						<span
							data-day={day}
							data-hour={hour}
							class="h-4 w-4 shrink-0 rounded-[3px] transition-transform hover:scale-125"
							style="background: {tone(value)}"
						></span>
					{/each}
				</div>
			{/each}
		</div>
	</div>

	{#if hovered}
		<ChartTooltip x={anchor.x} y={anchor.y} bounds={frameWidth}>
			<p class="font-medium tabular-nums">
				{WEEKDAYS[hovered.day]}
				{hovered.hour.toString().padStart(2, '0')}:00–{((hovered.hour + 1) % 24)
					.toString()
					.padStart(2, '0')}:00
			</p>
			<p class="mt-0.5 flex items-center gap-2">
				<span class="size-2 shrink-0 rounded-full" style="background: {tone(hovered.value)}"></span>
				{#if hovered.value > 0}
					<span class="font-medium tabular-nums">{formatValue(hovered.value)}</span>
					{#if share !== null}
						<span class="text-muted-foreground tabular-nums">{num(share, 1)}% of the week</span>
					{/if}
				{:else}
					<span class="text-muted-foreground">nothing, all month</span>
				{/if}
			</p>
		</ChartTooltip>
	{/if}

	<figcaption class="flex items-center gap-2 text-xs text-muted-foreground">
		<span>{label}, by hour of the day</span>
		<span class="ml-auto flex items-center gap-1">
			<span>less</span>
			{#each [0, 0.35, 0.6, 0.8, 1] as step (step)}
				<span
					class="h-3 w-3 rounded-[2px]"
					style="background: color-mix(in oklab, var(--viz-3) {Math.max(
						12,
						step * 100
					)}%, var(--viz-grid))"
				></span>
			{/each}
			<span>more</span>
		</span>
	</figcaption>
</figure>
