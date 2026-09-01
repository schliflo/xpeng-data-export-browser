<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import BigStat from '$lib/components/charts/BigStat.svelte';
	import Punchcard from '$lib/components/charts/Punchcard.svelte';
	import UPlotChart from '$lib/components/charts/UPlotChart.svelte';
	import { data } from '$lib/state/dataset.svelte';
	import { COLUMNS } from '$lib/data/schema/columns';
	import { duration, hourLabel, num } from '$lib/utils/format';

	const stats = $derived(data.derived!);
	const doors = $derived(stats.doors);
	const tyres = $derived(stats.tyres);

	const doorLabels: Record<string, string> = {
		ldcu_driverdoorajarst: 'Driver',
		rdcu_psngrdoorajarst: 'Passenger',
		ldcu_rldoorajarst: 'Rear left',
		rdcu_rrdoorajarst: 'Rear right'
	};

	/** Daily median pressure per wheel, plotted as four lines over the month. */
	const tyreChart = $derived.by(() => {
		const days = tyres.days.filter((day) => day.pressures.some((p) => !Number.isNaN(p)));
		if (days.length < 2) return null;
		const x = Float64Array.from(
			days.map((day) => {
				const [y, m, d] = day.date.split('-').map(Number);
				return Date.UTC(y, m - 1, d) / 1000;
			})
		);
		return {
			x,
			series: tyres.labels.map((label, wheel) => ({
				label,
				color: `--viz-${wheel + 1}`,
				unit: 'kPa',
				values: Float64Array.from(days.map((day) => day.pressures[wheel]))
			}))
		};
	});

	const rearHigher = $derived.by(() => {
		const front = (tyres.drift[0] + tyres.drift[1]) / 2;
		const rear = (tyres.drift[2] + tyres.drift[3]) / 2;
		return { front, rear };
	});
</script>

<div class="mx-auto max-w-6xl space-y-6">
	<Card.Root>
		<Card.Header>
			<Card.Title>Your car knows your schedule</Card.Title>
			<Card.Description>
				Every door opening, by weekday and hour. No location data is needed to see the shape of a
				week: this is only which door opened, and when.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-6">
			<Punchcard
				grid={doors.grid}
				label="Door openings"
				formatValue={(value) => `${num(value)} openings`}
			/>

			<div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
				<BigStat
					kicker="Openings recorded"
					value={num(doors.events.length)}
					size="sm"
					accent="--viz-1"
				/>
				<BigStat
					kicker="Busiest hour"
					value={hourLabel(doors.busiestHour)}
					size="sm"
					accent="--viz-3"
					detail="{num(doors.busiestHourCount)} openings"
				/>
				{#if doors.quietStretch && doors.quietStretch.hours >= 3}
					<BigStat
						kicker="Never once between"
						value="{hourLabel(doors.quietStretch.from)}–{hourLabel(doors.quietStretch.to)}"
						size="sm"
						accent="--viz-7"
						detail="{doors.quietStretch.hours} hours of complete quiet, every day"
					/>
				{/if}
				{#if doors.longestOpen}
					<BigStat
						kicker="Longest left open"
						value={duration(doors.longestOpen.openSeconds, 'short')}
						size="sm"
						accent="--viz-5"
						detail="{doorLabels[doors.longestOpen.door] ?? 'A door'} door"
					/>
				{/if}
			</div>

			<div class="grid gap-4 sm:grid-cols-4">
				{#each Object.entries(doors.perDoor) as [key, count] (key)}
					<div class="rounded-lg border bg-muted/40 p-3">
						<p class="text-xs text-muted-foreground">{doorLabels[key] ?? key}</p>
						<p class="mt-1 text-xl font-semibold tabular-nums">{num(count)}</p>
					</div>
				{/each}
			</div>

			<p class="border-l-2 pl-4 text-sm leading-relaxed text-muted-foreground">
				Rear doors opening means someone else was in the car. Taken together with the times, this is
				a month of a household's comings and goings, recorded to the second — from a signal that
				exists to warn you a door is ajar.
			</p>
		</Card.Content>
	</Card.Root>

	{#if tyreChart}
		<Card.Root>
			<Card.Header>
				<Card.Title>Tyre pressure, and the weather</Card.Title>
				<Card.Description>
					Daily median for each wheel. Pressure follows air temperature, so this doubles as a record
					of how warm the month was.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<UPlotChart x={tyreChart.x} series={tyreChart.series} height={220} timeFormat="day" />

				<div class="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
					{#each tyreChart.series as series (series.label)}
						<span class="flex items-center gap-1.5">
							<span class="h-0.5 w-3 rounded-full" style="background: var({series.color})"></span>
							{series.label}
						</span>
					{/each}
				</div>

				<div class="mt-6 grid gap-6 sm:grid-cols-3">
					<BigStat
						kicker="Pressure range"
						value="{num(tyres.minPressure)}–{num(tyres.maxPressure)}"
						unit="kPa"
						size="sm"
						accent="--viz-1"
						detail="Reported in steps of 2.75 kPa, which is why the lines look like stairs"
					/>
					<BigStat
						kicker="Change over the month"
						value="{rearHigher.front >= 0 ? '+' : ''}{num(rearHigher.front, 1)}"
						unit="kPa front"
						size="sm"
						accent="--viz-2"
						detail="Rear {rearHigher.rear >= 0 ? '+' : ''}{num(rearHigher.rear, 1)} kPa"
					/>
					{#if Number.isFinite(tyres.temperatureCorrelation)}
						<BigStat
							kicker="Tracks temperature"
							value={tyres.temperatureCorrelation.toFixed(2)}
							size="sm"
							accent="--viz-temp"
							detail="Correlation with battery temperature, which follows the outside air"
						/>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	{#if data.dataset && data.dataset.emptyColumns.length > 0}
		<Card.Root>
			<Card.Header>
				<Card.Title>Signals your car never filled in</Card.Title>
				<Card.Description>
					These columns exist in every row of the export and are empty in all of them.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="flex flex-wrap gap-2">
					{#each data.dataset.emptyColumns as key (key)}
						<span class="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
							{COLUMNS.get(key)?.label ?? key}
						</span>
					{/each}
				</div>
				<p class="mt-4 text-sm leading-relaxed text-muted-foreground">
					The export uses one schema for every model XPeng sells, so a car reports blanks wherever
					it has no such hardware. Window positions and the tailgate opener are in the file for
					vehicles that report them; yours does not.
				</p>
			</Card.Content>
		</Card.Root>
	{/if}
</div>
