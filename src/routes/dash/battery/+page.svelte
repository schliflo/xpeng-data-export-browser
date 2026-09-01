<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import BigStat from '$lib/components/charts/BigStat.svelte';
	import UPlotChart, { type ChartSeries } from '$lib/components/charts/UPlotChart.svelte';
	import { data } from '$lib/state/dataset.svelte';
	import { breakAtGaps, selectSeries } from '$lib/data/store/decimate';
	import { AWAKE_GAP_SECONDS } from '$lib/data/analytics/sessions';
	import { dateTime, duration, num } from '$lib/utils/format';

	const stats = $derived(data.derived!);
	const dataset = $derived(data.dataset!);

	/**
	 * The whole month of charge on one chart. It is downsampled to roughly two
	 * points per pixel and broken wherever the car stopped logging, so the line
	 * never invents a value for a night it slept through.
	 */
	const socSeries = $derived.by(() => {
		const column = dataset.columns.get('ldcu_bms_soc_disp');
		if (!column || column.nonNull === 0) return null;
		const pyramid = data.pyramids?.get(column) ?? null;
		const raw = selectSeries(dataset.time, column, pyramid, stats.startTime, stats.endTime, 1200);
		return breakAtGaps(raw, AWAKE_GAP_SECONDS * 5);
	});

	const rangeSeries = $derived.by(() => {
		const column = dataset.columns.get('ldcu_dstbatdisp_dynamic');
		if (!column || column.nonNull === 0) return null;
		const pyramid = data.pyramids?.get(column) ?? null;
		const raw = selectSeries(dataset.time, column, pyramid, stats.startTime, stats.endTime, 1200);
		return breakAtGaps(raw, AWAKE_GAP_SECONDS * 5);
	});

	const tempSeries = $derived.by(() => {
		const hot = dataset.columns.get('bms_batttempmax_gb');
		const cold = dataset.columns.get('bms_batttempmin_gb');
		if (!hot || !cold || hot.nonNull === 0) return null;
		const hotPyramid = data.pyramids?.get(hot) ?? null;
		const coldPyramid = data.pyramids?.get(cold) ?? null;
		const a = breakAtGaps(
			selectSeries(dataset.time, hot, hotPyramid, stats.startTime, stats.endTime, 1200),
			AWAKE_GAP_SECONDS * 5
		);
		const b = breakAtGaps(
			selectSeries(dataset.time, cold, coldPyramid, stats.startTime, stats.endTime, 1200),
			AWAKE_GAP_SECONDS * 5
		);
		// Both lines must share an x vector to sit on one chart.
		if (a.x.length !== b.x.length) return null;
		return { x: a.x, hot: a.y, cold: b.y };
	});

	const socChart = $derived<ChartSeries[]>(
		socSeries
			? [{ label: 'Charge', color: '--viz-soc', unit: '%', fill: true, values: socSeries.y }]
			: []
	);
</script>

<div class="mx-auto max-w-6xl space-y-6">
	<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<Card.Root>
			<Card.Content>
				<BigStat
					kicker="Full-charge range"
					value={num(stats.range.medianFullRange)}
					unit="km"
					size="sm"
					accent="--viz-3"
					detail="Typically {num(stats.range.minFullRange)}–{num(
						stats.range.maxFullRange
					)} km, from the car's own estimate"
				/>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Content>
				<BigStat
					kicker="Lost while parked"
					value={num(stats.drain.medianPercentPerDay, 1)}
					unit="%/day"
					size="sm"
					accent="--viz-5"
					detail="Across {stats.drain.events.length} long stands, totalling {num(
						stats.drain.totalSleepHours
					)} hours"
				/>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Content>
				<BigStat
					kicker="Pack temperature"
					value="{num(stats.thermal.minTemp)}–{num(stats.thermal.maxTemp)}"
					unit="°C"
					size="sm"
					accent="--viz-2"
					detail="Widest spread within the pack was {num(stats.thermal.maxSpread)} °C"
				/>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Content>
				<BigStat
					kicker="Charge range used"
					value="{num(Math.min(...stats.days.map((d) => d.socMin).filter(Number.isFinite)))}–{num(
						Math.max(...stats.days.map((d) => d.socMax).filter(Number.isFinite))
					)}"
					unit="%"
					size="sm"
					accent="--viz-4"
					detail="The band the battery actually lived in this month"
				/>
			</Card.Content>
		</Card.Root>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>A month of charge</Card.Title>
			<Card.Description>
				Every discharge and recharge. The line breaks where the car was asleep — it records nothing
				then, and drawing across the gap would imply otherwise.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if socSeries}
				<UPlotChart
					x={socSeries.x}
					series={socChart}
					height={220}
					syncKey="battery"
					yRange={[0, 100]}
				/>
			{/if}
		</Card.Content>
	</Card.Root>

	<div class="grid gap-6 lg:grid-cols-2">
		<Card.Root>
			<Card.Header>
				<Card.Title>Predicted range</Card.Title>
				<Card.Description>What the car told you it had left.</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if rangeSeries}
					<UPlotChart
						x={rangeSeries.x}
						series={[
							{ label: 'Range', color: '--viz-1', unit: 'km', fill: true, values: rangeSeries.y }
						]}
						height={200}
						syncKey="battery"
					/>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Pack temperature</Card.Title>
				<Card.Description>
					Warmest and coolest parts of the battery. The gap between them is the pack working to stay
					even.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if tempSeries}
					<UPlotChart
						x={tempSeries.x}
						series={[
							{ label: 'Warmest', color: '--viz-8', unit: '°C', values: tempSeries.hot },
							{ label: 'Coolest', color: '--viz-1', unit: '°C', values: tempSeries.cold }
						]}
						height={200}
						syncKey="battery"
					/>
					<div class="mt-2 flex gap-4 text-xs text-muted-foreground">
						<span class="flex items-center gap-1.5">
							<span class="h-0.5 w-3 rounded-full" style="background: var(--viz-8)"></span>
							Warmest
						</span>
						<span class="flex items-center gap-1.5">
							<span class="h-0.5 w-3 rounded-full" style="background: var(--viz-1)"></span>
							Coolest
						</span>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>

	{#if stats.drain.events.length > 0}
		<Card.Root>
			<Card.Header>
				<Card.Title>Charge lost standing still</Card.Title>
				<Card.Description>
					Long periods with no driving and no charging. A parked car still runs its systems, and the
					charge quietly goes down.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="overflow-x-auto">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Parked from</Table.Head>
								<Table.Head class="text-right">For</Table.Head>
								<Table.Head class="text-right">Charge</Table.Head>
								<Table.Head class="text-right">Lost</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each stats.drain.events.slice(0, 12) as event (event.startTime)}
								<Table.Row>
									<Table.Cell>{dateTime(event.startTime)}</Table.Cell>
									<Table.Cell class="text-right tabular-nums">
										{duration(event.hours * 3600, 'short')}
									</Table.Cell>
									<Table.Cell class="text-right tabular-nums">
										{num(event.socStart)}% → {num(event.socEnd)}%
									</Table.Cell>
									<Table.Cell class="text-right tabular-nums">
										{num(event.socLost)}%
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			</Card.Content>
		</Card.Root>
	{/if}
</div>
