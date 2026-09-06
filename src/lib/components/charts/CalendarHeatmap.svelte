<!--
  Distance per day, laid out as a calendar.

  A month of daily totals is a magnitude encoded on a date, so the form is a
  sequential single-hue ramp on a calendar grid rather than 31 bars: the
  weekday structure of a commute is visible at a glance this way. Hovering or
  tabbing to a square names the day and its total.

  Several exports merged together leave holes between them, and a day inside a
  hole is not a day the car stood still — nothing was recorded. Those squares
  are drawn as an outline rather than a shade, so an absence never reads as a
  measurement of zero. The grid stays unbroken either way: months are labelled
  along the top, because a year of squares is no longer self-evidently a month.
-->
<script lang="ts">
	import { prettyDay, num } from '$lib/utils/format';
	import { WEEKDAYS } from '$lib/utils/format';
	import ChartTooltip from './ChartTooltip.svelte';

	interface Day {
		date: string;
		value: number;
		/** False when no export accounts for this day. */
		covered?: boolean;
	}

	interface Props {
		days: Day[];
		unit?: string;
		label?: string;
		onSelect?: (date: string) => void;
		selected?: string | null;
	}

	let { days, unit = 'km', label = 'Distance', onSelect, selected = null }: Props = $props();

	const max = $derived(Math.max(1, ...days.map((d) => d.value)));
	const hasGaps = $derived(days.some((day) => day.covered === false));

	let frame = $state<HTMLElement>();
	let hovered = $state<Day | null>(null);
	let anchor = $state({ x: 0, y: 0 });
	let frameWidth = $state(0);

	/** Weekday of a `YYYY-MM-DD` key, 0 = Sunday. */
	function weekdayOf(date: string): number {
		const [y, m, d] = date.split('-').map(Number);
		return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	}

	/**
	 * Days arranged into columns of weeks, with the first week padded so every
	 * row is the same weekday throughout.
	 */
	const weeks = $derived.by(() => {
		const columns: (Day | null)[][] = [];
		let current: (Day | null)[] = new Array(weekdayOf(days[0]?.date ?? '2026-01-01')).fill(null);
		for (const day of days) {
			current.push(day);
			if (current.length === 7) {
				columns.push(current);
				current = [];
			}
		}
		if (current.length) {
			while (current.length < 7) current.push(null);
			columns.push(current);
		}
		return columns;
	});

	const MONTHS = [
		'Jan',
		'Feb',
		'Mar',
		'Apr',
		'May',
		'Jun',
		'Jul',
		'Aug',
		'Sep',
		'Oct',
		'Nov',
		'Dec'
	];

	/** A label on the first column of each month, and the year when it turns. */
	const months = $derived.by(() => {
		let previous = '';
		return weeks.map((week) => {
			const first = week.find(Boolean);
			if (!first) return '';
			const [year, month] = first.date.split('-');
			const key = `${year}-${month}`;
			if (key === previous) return '';
			const changedYear = previous !== '' && previous.slice(0, 4) !== year;
			previous = key;
			const name = MONTHS[Number(month) - 1];
			return changedYear ? `${name} ${year}` : name;
		});
	});

	/** Five steps of one hue; the lightest means "nothing happened". */
	function tone(value: number): string {
		if (value <= 0) return 'var(--viz-grid)';
		const t = Math.min(1, value / max);
		const step = t < 0.2 ? 0.28 : t < 0.45 ? 0.46 : t < 0.7 ? 0.66 : t < 0.9 ? 0.84 : 1;
		return `color-mix(in oklab, var(--viz-1) ${step * 100}%, var(--viz-grid))`;
	}

	/**
	 * Anchors the readout to the square. Measured against the figure rather
	 * than the strip of weeks, so it is not clipped when the strip scrolls.
	 */
	function enter(day: Day, cell: HTMLElement): void {
		if (!frame) return;
		const outer = frame.getBoundingClientRect();
		const box = cell.getBoundingClientRect();
		frameWidth = outer.width;
		anchor = { x: box.left - outer.left + box.width / 2, y: box.top - outer.top };
		hovered = day;
	}

	const rank = $derived.by(() => {
		const day = hovered;
		if (!day) return null;
		const driven = days.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
		const place = driven.findIndex((d) => d.date === day.date);
		return place === -1 ? null : { place: place + 1, of: driven.length };
	});
</script>

<figure bind:this={frame} class="relative flex flex-col gap-3">
	<div
		class="overflow-x-auto pb-1"
		role="group"
		aria-label="{label} per day"
		onpointerleave={() => (hovered = null)}
	>
		<div class="mx-auto flex w-max flex-col gap-1">
			<div class="flex gap-2 pl-8 text-[10px] text-muted-foreground">
				{#each months as month, m (m)}
					<span class="w-6 shrink-0 leading-none whitespace-nowrap">{month}</span>
				{/each}
			</div>

			<div class="flex items-end gap-2">
				<div class="flex w-7 shrink-0 flex-col gap-[4px] text-[10px] text-muted-foreground">
					{#each WEEKDAYS as day, i (day)}
						<span class="flex h-6 items-center leading-none">{i % 2 === 1 ? day : ''}</span>
					{/each}
				</div>
				{#each weeks as week, w (w)}
					<div class="flex shrink-0 flex-col gap-[4px]">
						{#each week as day, d (d)}
							{#if day}
								<button
									type="button"
									class={[
										'h-6 w-6 rounded-[5px] transition-transform hover:scale-115 focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none',
										day.covered === false && 'border border-dashed border-border'
									]}
									class:ring-2={selected === day.date}
									style="background: {day.covered === false ? 'transparent' : tone(day.value)}"
									aria-label={day.covered === false
										? `${prettyDay(day.date)}, not recorded`
										: `${prettyDay(day.date)}, ${num(day.value, 1)} ${unit}`}
									onpointerenter={(event) => enter(day, event.currentTarget)}
									onfocus={(event) => enter(day, event.currentTarget)}
									onblur={() => (hovered = null)}
									onclick={() => onSelect?.(day.date)}
								></button>
							{:else}
								<span class="h-6 w-6"></span>
							{/if}
						{/each}
					</div>
				{/each}
			</div>
		</div>
	</div>

	{#if hovered}
		<ChartTooltip x={anchor.x} y={anchor.y} bounds={frameWidth}>
			<p class="font-medium">{prettyDay(hovered.date)}</p>
			<p class="mt-0.5 flex items-center gap-2">
				{#if hovered.covered === false}
					<span class="size-2 shrink-0 rounded-full border border-dashed border-border"></span>
					<span class="text-muted-foreground">no export covers this day</span>
				{:else}
					<span class="size-2 shrink-0 rounded-full" style="background: {tone(hovered.value)}"
					></span>
					{#if hovered.value > 0}
						<span class="font-medium tabular-nums">{num(hovered.value, 1)} {unit}</span>
						{#if rank}
							<span class="text-muted-foreground">
								{rank.place === 1 ? 'the busiest day' : `${rank.place} of ${rank.of} days driven`}
							</span>
						{/if}
					{:else}
						<span class="text-muted-foreground">the car did not move</span>
					{/if}
				{/if}
			</p>
		</ChartTooltip>
	{/if}

	<figcaption class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
		<span>{label}</span>
		{#if hasGaps}
			<span class="flex items-center gap-1">
				<span class="h-3 w-3 rounded-[2px] border border-dashed border-border"></span>
				not recorded
			</span>
		{/if}
		<span class="ml-auto flex items-center gap-1">
			<span>0</span>
			{#each [0, 0.3, 0.55, 0.78, 1] as step (step)}
				<span
					class="h-3 w-3 rounded-[2px]"
					style="background: color-mix(in oklab, var(--viz-1) {step * 100}%, var(--viz-grid))"
				></span>
			{/each}
			<span>{num(max)} {unit}</span>
		</span>
	</figcaption>
</figure>
