<!--
  The readout that follows the pointer across a chart.

  Every chart in the app shares it, so a hovered bar, cell or sample is
  described the same way everywhere: a heading naming the point, then the
  numbers. It is positioned against whatever element the chart marks it up
  inside, clamped to stay on screen, and never intercepts the pointer.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** Anchor point, in pixels relative to the nearest positioned ancestor. */
		x: number;
		y: number;
		/** Width of that ancestor, so the card can be kept inside it. */
		bounds?: number;
		children: Snippet;
	}

	let { x, y, bounds = Number.POSITIVE_INFINITY, children }: Props = $props();

	let width = $state(0);
	let height = $state(0);

	// Sits above the anchor by default and drops below it when there is no room,
	// which is what happens near the top of a tall chart.
	const below = $derived(y - height - 12 < 0);
	const left = $derived(
		Number.isFinite(bounds)
			? Math.max(width / 2 + 4, Math.min(x, bounds - width / 2 - 4))
			: Math.max(width / 2 + 4, x)
	);
</script>

<div
	bind:clientWidth={width}
	bind:clientHeight={height}
	class="pointer-events-none absolute z-30 min-w-max rounded-lg border bg-popover/95 px-3 py-2 text-xs whitespace-nowrap text-popover-foreground shadow-lg backdrop-blur"
	style="left: {left}px; top: {below ? y + 12 : y - 12}px; transform: translate(-50%, {below
		? '0'
		: '-100%'})"
	role="tooltip"
>
	{@render children()}
</div>
