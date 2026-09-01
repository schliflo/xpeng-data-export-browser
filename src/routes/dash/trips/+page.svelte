<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import BigStat from '$lib/components/charts/BigStat.svelte';
	import TripDetail from '$lib/components/app/TripDetail.svelte';
	import { data } from '$lib/state/dataset.svelte';
	import { dateTime, duration, num, percent, fullDateTime } from '$lib/utils/format';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowUpDownIcon from '@lucide/svelte/icons/arrow-up-down';

	const stats = $derived(data.derived!);

	const selectedIndex = $derived.by(() => {
		const raw = page.url.searchParams.get('trip');
		if (raw === null) return null;
		const index = Number(raw);
		return Number.isInteger(index) && index >= 0 && index < stats.trips.length ? index : null;
	});
	const trip = $derived(selectedIndex === null ? null : stats.trips[selectedIndex]);

	type SortKey = 'startTime' | 'distanceKm' | 'duration' | 'maxSpeed' | 'consumption';
	let sortKey = $state<SortKey>('startTime');
	let ascending = $state(false);

	const sorted = $derived.by(() => {
		const list = [...stats.trips];
		list.sort((a, b) => {
			const left = a[sortKey];
			const right = b[sortKey];
			// Trips missing a value sort last whichever way the column is ordered.
			if (Number.isNaN(left)) return 1;
			if (Number.isNaN(right)) return -1;
			return ascending ? left - right : right - left;
		});
		return list;
	});

	function sortBy(key: SortKey) {
		if (sortKey === key) ascending = !ascending;
		else {
			sortKey = key;
			ascending = key === 'startTime' ? false : false;
		}
	}

	const columns: Array<{ key: SortKey; label: string; align?: string }> = [
		{ key: 'startTime', label: 'Started' },
		{ key: 'distanceKm', label: 'Distance', align: 'text-right' },
		{ key: 'duration', label: 'Duration', align: 'text-right' },
		{ key: 'maxSpeed', label: 'Top speed', align: 'text-right' },
		{ key: 'consumption', label: 'kWh/100 km', align: 'text-right' }
	];
</script>

{#if trip}
	<div class="mx-auto max-w-5xl space-y-6">
		<div class="flex items-center gap-3">
			<Button variant="ghost" size="sm" onclick={() => goto('/dash/trips')}>
				<ArrowLeftIcon class="size-4" />
				All trips
			</Button>
			<span class="text-sm text-muted-foreground">{fullDateTime(trip.startTime)}</span>
		</div>

		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<Card.Root>
				<Card.Content>
					<BigStat
						kicker="Distance"
						value={num(trip.distanceKm, 1)}
						unit="km"
						size="sm"
						accent="--viz-1"
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Content>
					<BigStat
						kicker="Duration"
						value={duration(trip.duration, 'short')}
						size="sm"
						accent="--viz-3"
						detail="{duration(trip.movingSeconds, 'short')} actually moving"
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Content>
					<BigStat
						kicker="Top speed"
						value={num(trip.maxSpeed)}
						unit="km/h"
						size="sm"
						accent="--viz-2"
						detail="Average {num(trip.avgSpeed)} km/h while moving"
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Content>
					<BigStat
						kicker="Energy used"
						value={num(trip.energyKwh - trip.regenKwh, 1)}
						unit="kWh"
						size="sm"
						accent="--viz-4"
						detail={Number.isFinite(trip.regenShare)
							? `${percent(trip.regenShare)} came back through regeneration`
							: undefined}
					/>
				</Card.Content>
			</Card.Root>
		</div>

		<Card.Root>
			<Card.Header>
				<Card.Title>Second by second</Card.Title>
				<Card.Description>
					Drag across any panel to zoom; the cursor is shared between them.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<TripDetail {trip} />
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Forces</Card.Title>
			</Card.Header>
			<Card.Content class="grid gap-6 sm:grid-cols-3">
				<BigStat
					kicker="Hardest acceleration"
					value={num(trip.peakAccel, 2)}
					unit="g"
					size="sm"
					accent="--viz-3"
				/>
				<BigStat
					kicker="Hardest braking"
					value={num(trip.peakBrake, 2)}
					unit="g"
					size="sm"
					accent="--viz-8"
				/>
				<BigStat
					kicker="Hardest cornering"
					value={num(trip.peakLateral, 2)}
					unit="g"
					size="sm"
					accent="--viz-7"
				/>
			</Card.Content>
		</Card.Root>
	</div>
{:else}
	<div class="mx-auto max-w-6xl space-y-6">
		<div class="grid gap-4 sm:grid-cols-3">
			<Card.Root>
				<Card.Content>
					<BigStat kicker="Trips" value={num(stats.trips.length)} size="sm" accent="--viz-1" />
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Content>
					<BigStat
						kicker="Longest"
						value={num(Math.max(...stats.trips.map((t) => t.distanceKm)), 0)}
						unit="km"
						size="sm"
						accent="--viz-3"
					/>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Content>
					<BigStat
						kicker="Median trip"
						value={num(
							[...stats.trips.map((t) => t.distanceKm)].sort((a, b) => a - b)[
								Math.floor(stats.trips.length / 2)
							] ?? NaN,
							1
						)}
						unit="km"
						size="sm"
						accent="--viz-4"
					/>
				</Card.Content>
			</Card.Root>
		</div>

		<Card.Root>
			<Card.Header>
				<Card.Title>Every trip</Card.Title>
				<Card.Description>
					Segmented from gear and odometer movement. Select one to see it in detail.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="overflow-x-auto">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								{#each columns as column (column.key)}
									<Table.Head class={column.align}>
										<button
											type="button"
											class="inline-flex items-center gap-1 transition-colors hover:text-foreground"
											onclick={() => sortBy(column.key)}
										>
											{column.label}
											<ArrowUpDownIcon class="size-3 opacity-50" />
										</button>
									</Table.Head>
								{/each}
								<Table.Head class="text-right">Charge</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each sorted as row (row.index)}
								<Table.Row
									class="cursor-pointer hover:bg-muted/50"
									onclick={() => goto(`/dash/trips?trip=${row.index}`)}
								>
									<Table.Cell class="font-medium">{dateTime(row.startTime)}</Table.Cell>
									<Table.Cell class="text-right tabular-nums">{num(row.distanceKm, 1)}</Table.Cell>
									<Table.Cell class="text-right tabular-nums">
										{duration(row.duration, 'short')}
									</Table.Cell>
									<Table.Cell class="text-right tabular-nums">{num(row.maxSpeed)}</Table.Cell>
									<Table.Cell class="text-right tabular-nums">
										{Number.isFinite(row.consumption) ? num(row.consumption, 1) : '—'}
									</Table.Cell>
									<Table.Cell class="text-right">
										{#if Number.isFinite(row.socStart)}
											<Badge variant="secondary" class="tabular-nums">
												{num(row.socStart)}% → {num(row.socEnd)}%
											</Badge>
										{:else}
											—
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			</Card.Content>
		</Card.Root>
	</div>
{/if}
