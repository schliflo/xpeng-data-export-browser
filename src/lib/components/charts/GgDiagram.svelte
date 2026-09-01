<!--
  The g-g diagram: cornering force against braking and acceleration.

  Every second of driving is one point; plotted together they trace the
  envelope of forces the car was actually asked for. Cautious driving fills a
  narrow cross, committed driving fills a circle. Drawn on a canvas because
  there are hundreds of thousands of points, with density on a single-hue ramp.

  The canvas cannot carry hit targets, so the pointer is mapped back onto a
  cell: hovering names the forces that spot stands for and how long the car
  spent there, which is the only way to read a number off a density plot.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { duration, num } from '$lib/utils/format';
	import ChartTooltip from './ChartTooltip.svelte';

	interface Props {
		grid: Uint32Array;
		size: number;
		extent: number;
		max: number;
		total: number;
		height?: number;
	}

	let { grid, size, extent, max, total, height = 320 }: Props = $props();

	let canvas = $state<HTMLCanvasElement>();
	let box = $state<HTMLDivElement>();
	let pixels = $state(320);
	let hovered = $state<{ col: number; row: number } | null>(null);

	const cellSize = $derived(pixels / size);

	/** Physical forces at the centre of the hovered cell. */
	const reading = $derived.by(() => {
		const cell = hovered;
		if (!cell) return null;
		const lateral = ((cell.col + 0.5) / size) * 2 * extent - extent;
		const longitudinal = ((cell.row + 0.5) / size) * 2 * extent - extent;
		const count = grid[cell.row * size + cell.col];
		return {
			lateral,
			longitudinal,
			count,
			share: total > 0 ? (count / total) * 100 : 0,
			// A cell is a small square of force, so "0.02 g" would overstate the
			// precision; the words are what the position actually means.
			longWord: longitudinal >= 0 ? 'accelerating' : 'braking',
			latWord: lateral >= 0 ? 'left' : 'right',
			// Where the cell sits on the canvas, for the marker and the readout.
			left: cell.col * cellSize,
			top: (size - 1 - cell.row) * cellSize
		};
	});

	function draw() {
		if (!canvas) return;
		const context = canvas.getContext('2d');
		if (!context) return;

		const dpr = window.devicePixelRatio || 1;
		const side = pixels;
		canvas.width = side * dpr;
		canvas.height = side * dpr;
		canvas.style.width = `${side}px`;
		canvas.style.height = `${side}px`;
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		context.clearRect(0, 0, side, side);

		const styles = getComputedStyle(canvas);
		const hue = styles.getPropertyValue('--viz-2').trim() || '#d95926';
		const gridColor = styles.getPropertyValue('--viz-grid').trim() || '#2c2c2a';
		const axisColor = styles.getPropertyValue('--viz-axis').trim() || '#383835';
		const muted = styles.getPropertyValue('--viz-muted').trim() || '#898781';

		// Rings at quarter-g intervals give the forces a readable scale.
		context.strokeStyle = gridColor;
		context.lineWidth = 1;
		for (let g = 0.25; g <= extent; g += 0.25) {
			context.beginPath();
			context.arc(side / 2, side / 2, (g / extent) * (side / 2), 0, Math.PI * 2);
			context.stroke();
		}

		context.strokeStyle = axisColor;
		context.beginPath();
		context.moveTo(side / 2, 0);
		context.lineTo(side / 2, side);
		context.moveTo(0, side / 2);
		context.lineTo(side, side / 2);
		context.stroke();

		// Density on a square-root scale: without it the idle cluster at the
		// origin is the only thing visible and the interesting edge vanishes.
		const cell = side / size;
		for (let row = 0; row < size; row++) {
			for (let col = 0; col < size; col++) {
				const count = grid[row * size + col];
				if (count === 0) continue;
				const t = Math.sqrt(count / max);
				context.fillStyle = `color-mix(in oklab, ${hue} ${Math.max(12, t * 100)}%, transparent)`;
				// Longitudinal g points up, so the row axis is inverted.
				const y = side - (row + 1) * cell;
				context.fillRect(col * cell, y, cell + 0.5, cell + 0.5);
			}
		}

		context.fillStyle = muted;
		context.font = '10px Inter Variable, system-ui, sans-serif';
		context.textAlign = 'center';
		context.fillText('accelerating', side / 2, 12);
		context.fillText('braking', side / 2, side - 4);
		context.textAlign = 'left';
		context.fillText('right', 4, side / 2 - 6);
		context.textAlign = 'right';
		context.fillText('left', side - 4, side / 2 - 6);
	}

	/** Maps the pointer back onto the cell it is over. */
	function track(event: PointerEvent): void {
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const col = Math.floor(((event.clientX - rect.left) / rect.width) * size);
		// The top of the canvas is the highest longitudinal g, so rows count up.
		const row = size - 1 - Math.floor(((event.clientY - rect.top) / rect.height) * size);
		if (col < 0 || col >= size || row < 0 || row >= size) {
			hovered = null;
			return;
		}
		hovered = { col, row };
	}

	onMount(() => {
		const observer = new ResizeObserver((entries) => {
			const next = Math.floor(Math.min(entries[0].contentRect.width, height));
			if (next > 0 && next !== pixels) pixels = next;
		});
		if (box) observer.observe(box);
		return () => observer.disconnect();
	});

	$effect(() => {
		void pixels;
		void grid;
		draw();
	});
</script>

<figure class="flex flex-col items-center gap-2">
	<div bind:this={box} class="flex w-full justify-center" style="min-height: {height}px">
		<div
			class="relative"
			style="width: {pixels}px; height: {pixels}px"
			role="img"
			aria-label="Cornering force against braking and acceleration, {num(total)} seconds of driving"
			onpointermove={track}
			onpointerleave={() => (hovered = null)}
		>
			<canvas bind:this={canvas} class="rounded-lg"></canvas>

			{#if reading}
				<span
					class="pointer-events-none absolute rounded-[2px] ring-1 ring-foreground/60"
					style="left: {reading.left}px; top: {reading.top}px; width: {cellSize}px; height: {cellSize}px"
				></span>

				<ChartTooltip x={reading.left + cellSize / 2} y={reading.top} bounds={pixels}>
					<p class="font-medium tabular-nums">
						{num(Math.abs(reading.longitudinal), 2)} g {reading.longWord}
						<span class="text-muted-foreground">·</span>
						{num(Math.abs(reading.lateral), 2)} g {reading.latWord}
					</p>
					<p class="mt-0.5 flex items-center gap-2">
						<span class="size-2 shrink-0 rounded-full" style="background: var(--viz-2)"></span>
						{#if reading.count > 0}
							<span class="font-medium tabular-nums">{duration(reading.count, 'short')}</span>
							<span class="text-muted-foreground tabular-nums">
								{num(reading.share, 2)}% of driving
							</span>
						{:else}
							<span class="text-muted-foreground">never went here</span>
						{/if}
					</p>
				</ChartTooltip>
			{/if}
		</div>
	</div>
	<figcaption class="text-center text-xs text-muted-foreground">
		{num(total)} seconds of driving. Rings mark quarter-g steps; the outer edge is
		{num(extent, 1)} g.
	</figcaption>
</figure>
