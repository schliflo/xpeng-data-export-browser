<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import BigStat from '$lib/components/charts/BigStat.svelte';
	import CalendarHeatmap from '$lib/components/charts/CalendarHeatmap.svelte';
	import Punchcard from '$lib/components/charts/Punchcard.svelte';
	import { data } from '$lib/state/dataset.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { duration, num, percent, prettyDay } from '$lib/utils/format';

	const stats = $derived(data.derived!);
	const dataset = $derived(data.dataset!);

	const totalKm = $derived(stats.days.reduce((sum, day) => sum + day.distanceKm, 0));
	const drivingSeconds = $derived(stats.trips.reduce((sum, trip) => sum + trip.movingSeconds, 0));
	// Measured against the time the exports actually account for, not the
	// calendar span: a merged record has holes that were never recorded.
	const coverage = $derived(dataset.time.length / stats.recordedSeconds);
	const consumption = $derived(totalKm > 0 ? (stats.charging.totalKwh / totalKm) * 100 : NaN);

	const calendar = $derived(
		stats.days.map((day) => ({ date: day.date, value: day.distanceKm, covered: day.covered }))
	);

	let selectedDay = $state<string | null>(null);
	const dayDetail = $derived(stats.days.find((day) => day.date === selectedDay) ?? null);
</script>

<div class="mx-auto max-w-6xl space-y-6">
	<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<Card.Root>
			<Card.Content>
				<BigStat
					kicker="Distance"
					value={num(totalKm)}
					unit="km"
					size="sm"
					accent="--viz-1"
					detail="{num(stats.trips.length)} trips over {stats.recordedDays} days"
				/>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Content>
				<BigStat
					kicker="Time driving"
					value={duration(drivingSeconds, 'short')}
					size="sm"
					accent="--viz-3"
					detail="{percent(drivingSeconds / stats.recordedSeconds, 1)} of the time recorded"
				/>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Content>
				<BigStat
					kicker="Energy charged"
					value={num(stats.charging.totalKwh)}
					unit="kWh"
					size="sm"
					accent="--viz-4"
					detail={Number.isFinite(consumption)
						? `About ${num(consumption, 1)} kWh per 100 km, costing ${settings.formatCurrency(
								stats.charging.totalKwh * settings.pricePerKwh
							)}`
						: `${stats.charging.sessions.length} sessions`}
				/>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Content>
				<BigStat
					kicker="Odometer"
					value={num(stats.odometerEnd)}
					unit="km"
					size="sm"
					accent="--viz-7"
					detail={stats.sources > 1
						? `Rose by ${num(stats.odometerEnd - stats.odometerStart)} km, including driving between the exports`
						: `Rose by ${num(stats.odometerEnd - stats.odometerStart)} km in this window`}
				/>
			</Card.Content>
		</Card.Root>
	</div>

	<div class="grid gap-6 lg:grid-cols-2">
		<Card.Root>
			<Card.Header>
				<Card.Title>Every day recorded</Card.Title>
				<Card.Description>
					Distance driven per day. Select a day to see what happened.
					{#if stats.sources > 1}
						Outlined days fall between exports and were never recorded.
					{/if}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<CalendarHeatmap
					days={calendar}
					selected={selectedDay}
					onSelect={(date) => (selectedDay = selectedDay === date ? null : date)}
				/>

				{#if dayDetail}
					<div class="mt-4 rounded-lg border bg-muted/40 p-4">
						<p class="font-medium">{prettyDay(dayDetail.date)}</p>
						<dl
							class="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-muted-foreground sm:grid-cols-4"
						>
							<div>
								<dt class="inline">Distance</dt>
								<dd class="inline text-foreground tabular-nums">
									{num(dayDetail.distanceKm, 1)} km
								</dd>
							</div>
							<div>
								<dt class="inline">Trips</dt>
								<dd class="inline text-foreground tabular-nums">{dayDetail.trips}</dd>
							</div>
							<div>
								<dt class="inline">Driving</dt>
								<dd class="inline text-foreground tabular-nums">
									{duration(dayDetail.drivingSeconds, 'short')}
								</dd>
							</div>
							<div>
								<dt class="inline">Charged</dt>
								<dd class="inline text-foreground tabular-nums">
									{num(dayDetail.chargedKwh, 1)} kWh
								</dd>
							</div>
						</dl>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Your week, as the car saw it</Card.Title>
				<Card.Description>Time spent driving, by weekday and hour.</Card.Description>
			</Card.Header>
			<Card.Content>
				<Punchcard
					grid={stats.punchcard}
					label="Driving"
					formatValue={(value) => duration(value, 'short')}
				/>
			</Card.Content>
		</Card.Root>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>What the recording covers</Card.Title>
			<Card.Description>
				The car logs once a second, but only while it is awake.
				{#if stats.sources > 1}
					These {stats.sources} exports cover {stats.recordedDays} days between them.
				{/if}
			</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-6 sm:grid-cols-3">
			<BigStat
				kicker="Samples recorded"
				value={num(dataset.time.length)}
				size="sm"
				accent="--viz-3"
				detail="{percent(coverage)} of every second the exports cover"
			/>
			<BigStat
				kicker="Longest silence"
				value={duration(stats.drain.longestSleepHours * 3600, 'short')}
				size="sm"
				accent="--viz-5"
				detail="The longest the car went without writing anything"
			/>
			<BigStat
				kicker="Signals reported"
				value={num([...dataset.columns.values()].filter((column) => column.nonNull > 0).length)}
				size="sm"
				accent="--viz-7"
				detail="{dataset.emptyColumns.length} more exist in the file but were never filled"
			/>
		</Card.Content>
	</Card.Root>
</div>
