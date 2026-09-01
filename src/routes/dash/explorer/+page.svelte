<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { Label } from '$lib/components/ui/label';
	import UPlotChart, { type ChartSeries } from '$lib/components/charts/UPlotChart.svelte';
	import { data } from '$lib/state/dataset.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { breakAtGaps, selectSeries } from '$lib/data/store/decimate';
	import { AWAKE_GAP_SECONDS } from '$lib/data/analytics/sessions';
	import { CATEGORY_LABELS, type ColumnCategory } from '$lib/data/schema/columns';
	import { valueAt } from '$lib/data/store/columnar';
	import { dateTime, num } from '$lib/utils/format';
	import DownloadIcon from '@lucide/svelte/icons/download';

	const dataset = $derived(data.dataset!);
	const stats = $derived(data.derived!);

	let picked = $state<string[]>(['esp_vehspd']);
	let from = $state<number | null>(null);
	let to = $state<number | null>(null);

	const window = $derived({
		from: from ?? stats.startTime,
		to: to ?? stats.endTime
	});

	/** Signals grouped by what they describe, empty ones optional. */
	const groups = $derived.by(() => {
		const byCategory = new Map<
			ColumnCategory,
			Array<{ key: string; label: string; empty: boolean }>
		>();
		for (const column of dataset.columns.values()) {
			const empty = column.nonNull === 0;
			if (empty && !settings.showEmptySignals) continue;
			const list = byCategory.get(column.spec.category) ?? [];
			list.push({ key: column.spec.key, label: column.spec.label, empty });
			byCategory.set(column.spec.category, list);
		}
		return [...byCategory.entries()]
			.map(([category, items]) => ({
				category,
				label: CATEGORY_LABELS[category],
				items: items.sort((a, b) => a.label.localeCompare(b.label))
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	});

	const series = $derived.by<{ x: Float64Array; series: ChartSeries[] } | null>(() => {
		if (picked.length === 0) return null;
		let x: Float64Array | null = null;
		const built: ChartSeries[] = [];

		picked.forEach((key, index) => {
			const column = dataset.columns.get(key);
			if (!column) return;
			const pyramid = data.pyramids?.get(column) ?? null;
			const raw = selectSeries(dataset.time, column, pyramid, window.from, window.to, 1200);
			const broken = breakAtGaps(raw, AWAKE_GAP_SECONDS * 5);
			// All selected signals share one timeline, so the first sets the x axis.
			if (!x) x = broken.x;
			if (broken.x.length !== x.length) return;
			built.push({
				label: column.spec.label,
				color: `--viz-${(index % 8) + 1}`,
				unit: column.spec.unit,
				step: column.spec.step,
				fill: picked.length === 1,
				values: broken.y
			});
		});

		return x && built.length ? { x, series: built } : null;
	});

	function toggle(key: string) {
		picked = picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key];
	}

	/**
	 * Writes the visible window back out as CSV. Everything happens in the tab,
	 * so this is a local file save rather than a download from a server.
	 */
	function exportWindow() {
		const keys = picked.filter((key) => dataset.columns.has(key));
		if (!keys.length) return;
		const columns = keys.map((key) => dataset.columns.get(key)!);
		const lines: string[] = [`time,${keys.join(',')}`];

		for (let i = 0; i < dataset.time.length; i++) {
			const t = dataset.time[i];
			if (t < window.from || t > window.to) continue;
			const values = columns.map((column) => {
				const value = valueAt(column, i);
				return Number.isNaN(value) ? '' : String(Math.round(value * 1000) / 1000);
			});
			lines.push(`${new Date(t * 1000).toISOString()},${values.join(',')}`);
		}

		const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `xpeng-signals-${new Date(window.from * 1000).toISOString().slice(0, 10)}.csv`;
		link.click();
		URL.revokeObjectURL(url);
	}

	function resetZoom() {
		from = null;
		to = null;
	}
</script>

<div class="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[280px_1fr]">
	<Card.Root class="h-fit">
		<Card.Header>
			<Card.Title class="text-base">Signals</Card.Title>
			<Card.Description>Pick any combination to plot together.</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			<div class="flex items-center justify-between">
				<Label for="empty" class="text-xs font-normal">Show never-reported</Label>
				<Switch id="empty" bind:checked={settings.showEmptySignals} />
			</div>

			<div class="max-h-[60svh] space-y-4 overflow-y-auto pr-1">
				{#each groups as group (group.category)}
					<div class="space-y-1">
						<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
							{group.label}
						</p>
						{#each group.items as item (item.key)}
							<button
								type="button"
								class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
								class:bg-muted={picked.includes(item.key)}
								onclick={() => toggle(item.key)}
								disabled={item.empty}
							>
								<span
									class="size-2 shrink-0 rounded-full"
									style="background: {picked.includes(item.key)
										? `var(--viz-${(picked.indexOf(item.key) % 8) + 1})`
										: 'var(--viz-grid)'}"
								></span>
								<span class="truncate" class:opacity-40={item.empty}>{item.label}</span>
								{#if item.empty}
									<span class="ml-auto text-[10px] text-muted-foreground">empty</span>
								{/if}
							</button>
						{/each}
					</div>
				{/each}
			</div>
		</Card.Content>
	</Card.Root>

	<div class="space-y-6">
		<Card.Root>
			<Card.Header class="flex-row items-start justify-between gap-4 space-y-0">
				<div>
					<Card.Title>
						{picked.length === 0 ? 'Choose a signal' : 'Raw signals'}
					</Card.Title>
					<Card.Description>
						{dateTime(window.from)} – {dateTime(window.to)} · drag to zoom
					</Card.Description>
				</div>
				<div class="flex shrink-0 gap-2">
					{#if from !== null}
						<Button variant="outline" size="sm" onclick={resetZoom}>Reset zoom</Button>
					{/if}
					<Button variant="outline" size="sm" onclick={exportWindow} disabled={!picked.length}>
						<DownloadIcon class="size-4" />
						Save as CSV
					</Button>
				</div>
			</Card.Header>
			<Card.Content>
				{#if series}
					{#key picked.join(',')}
						<UPlotChart
							x={series.x}
							series={series.series}
							height={360}
							onZoom={(min, max) => {
								from = Math.round(min);
								to = Math.round(max);
							}}
						/>
					{/key}
					<div class="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
						{#each series.series as item (item.label)}
							<span class="flex items-center gap-1.5">
								<span class="h-0.5 w-3 rounded-full" style="background: var({item.color})"></span>
								{item.label}{item.unit ? ` (${item.unit})` : ''}
							</span>
						{/each}
					</div>
				{:else}
					<p class="py-16 text-center text-sm text-muted-foreground">
						Select one or more signals from the list.
					</p>
				{/if}
			</Card.Content>
		</Card.Root>

		{#if picked.length}
			<Card.Root>
				<Card.Header>
					<Card.Title class="text-base">What these signals contain</Card.Title>
				</Card.Header>
				<Card.Content>
					<div class="grid gap-4 sm:grid-cols-2">
						{#each picked as key (key)}
							{@const column = dataset.columns.get(key)}
							{#if column}
								<div class="space-y-1 rounded-lg border p-3">
									<p class="font-medium">{column.spec.label}</p>
									<p class="font-mono text-xs text-muted-foreground">{column.spec.key}</p>
									<dl class="mt-2 space-y-0.5 text-xs text-muted-foreground">
										<div>
											<dt class="inline">Range</dt>
											<dd class="inline text-foreground tabular-nums">
												{num(column.min, 2)} – {num(column.max, 2)}
												{column.spec.unit}
											</dd>
										</div>
										<div>
											<dt class="inline">Reported in</dt>
											<dd class="inline text-foreground tabular-nums">
												{num((column.nonNull / dataset.time.length) * 100, 1)}% of samples
											</dd>
										</div>
									</dl>
									{#if column.spec.description}
										<p class="mt-2 text-xs leading-relaxed text-muted-foreground">
											{column.spec.description}
										</p>
									{/if}
								</div>
							{/if}
						{/each}
					</div>
				</Card.Content>
			</Card.Root>
		{/if}
	</div>
</div>
