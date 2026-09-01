<!--
  One trip, second by second.

  Panels sharing a cursor: what the car was doing, what it cost, and what the
  driver was asking of it. They are separate panels rather than one chart with
  several axes, because a shared vertical scale between km/h and kW would be
  meaningless. Hovering any of them reads out that second in all of them.

  There is no gear panel: the car has a single-speed reduction gear, so the
  selector only ever says which way it is pointing, which the speed trace and
  the trip itself already make plain.
-->
<script lang="ts">
	import UPlotChart, { type ChartSeries } from '$lib/components/charts/UPlotChart.svelte';
	import { data } from '$lib/state/dataset.svelte';
	import { decodeRange } from '$lib/data/store/columnar';
	import { instantPowerKw } from '$lib/data/analytics/energy';
	import type { Trip } from '$lib/data/analytics/trips';

	interface Props {
		trip: Trip;
	}

	let { trip }: Props = $props();

	const dataset = $derived(data.dataset!);

	/** A trip is at most a couple of hours, so its samples plot directly. */
	const x = $derived.by(() => {
		const out = new Float64Array(trip.end - trip.start + 1);
		for (let i = 0; i < out.length; i++) out[i] = dataset.time[trip.start + i];
		return out;
	});

	function column(key: string): Float64Array | null {
		const found = dataset.columns.get(key);
		if (!found || found.nonNull === 0) return null;
		return decodeRange(found, trip.start, trip.end + 1);
	}

	const powerSeries = $derived.by(() => {
		const volt = dataset.columns.get('bms_battvolt');
		const current = dataset.columns.get('bms_battcurr');
		if (!volt || !current) return null;
		const out = new Float64Array(trip.end - trip.start + 1);
		for (let i = 0; i < out.length; i++) {
			out[i] = instantPowerKw(volt, current, trip.start + i);
		}
		return out;
	});

	const panels = $derived.by(() => {
		const built: Array<{ title: string; height: number; series: ChartSeries[] }> = [];

		const speed = column('esp_vehspd');
		if (speed) {
			built.push({
				title: 'Speed',
				height: 170,
				series: [{ label: 'Speed', color: '--viz-speed', unit: 'km/h', fill: true, values: speed }]
			});
		}

		if (powerSeries) {
			built.push({
				title: 'Power drawn from the battery, negative while recovering',
				height: 150,
				series: [{ label: 'Power', color: '--viz-2', unit: 'kW', fill: true, values: powerSeries }]
			});
		}

		const soc = column('ldcu_bms_soc_disp');
		if (soc) {
			built.push({
				title: 'State of charge',
				height: 120,
				series: [{ label: 'Charge', color: '--viz-soc', unit: '%', step: true, values: soc }]
			});
		}

		const pedal = column('ldcu_accpedalsig');
		const brake = column('ldcu_brkpedalst');
		if (pedal || brake) {
			const series: ChartSeries[] = [];
			if (pedal)
				series.push({ label: 'Accelerator', color: '--viz-accel', unit: '%', values: pedal });
			if (brake)
				series.push({
					label: 'Brake',
					color: '--viz-brake',
					step: true,
					values: brake.map((v) => (Number.isNaN(v) ? NaN : v * 100)) as unknown as Float64Array,
					format: (value) => (value > 50 ? 'pressed' : 'released')
				});
			built.push({ title: 'What the driver was doing', height: 130, series });
		}

		const steering = column('eps_steeringangle');
		if (steering) {
			built.push({
				title: 'Steering angle',
				height: 120,
				series: [{ label: 'Steering', color: '--viz-7', unit: '°', values: steering }]
			});
		}

		return built;
	});

	// One key per trip so panels sync with each other but not across trips.
	const syncKey = $derived(`trip-${trip.index}`);
</script>

<div class="space-y-4">
	{#each panels as panel (panel.title)}
		<figure class="space-y-1">
			<figcaption class="flex items-center gap-3 text-xs text-muted-foreground">
				<span>{panel.title}</span>
				{#if panel.series.length > 1}
					<span class="ml-auto flex items-center gap-3">
						{#each panel.series as series (series.label)}
							<span class="flex items-center gap-1.5">
								<span class="h-0.5 w-3 rounded-full" style="background: var({series.color})"></span>
								{series.label}
							</span>
						{/each}
					</span>
				{/if}
			</figcaption>
			<UPlotChart {x} series={panel.series} height={panel.height} {syncKey} />
		</figure>
	{/each}
</div>
