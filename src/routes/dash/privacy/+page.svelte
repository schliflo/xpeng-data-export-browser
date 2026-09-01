<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import BigStat from '$lib/components/charts/BigStat.svelte';
	import { data } from '$lib/state/dataset.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { bytes, maskVin, num } from '$lib/utils/format';
	import ShieldIcon from '@lucide/svelte/icons/shield-check';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';

	const stats = $derived(data.derived!);
	const dataset = $derived(data.dataset!);

	const accents = ['--viz-8', '--viz-5', '--viz-2', '--viz-4', '--viz-7', '--viz-1'];
</script>

<div class="mx-auto max-w-5xl space-y-6">
	<Card.Root class="overflow-hidden">
		<div
			class="h-1"
			style="background: linear-gradient(90deg, var(--viz-8), var(--viz-5), var(--viz-2))"
		></div>
		<Card.Header>
			<Card.Title class="text-2xl">What this file knows about you</Card.Title>
			<Card.Description class="text-base">
				None of the findings below required a single map coordinate.
			</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-8 sm:grid-cols-2">
			{#each stats.facts.privacy as fact, index (fact.id)}
				<BigStat
					kicker={fact.kicker}
					value={fact.value}
					unit={fact.unit}
					size="sm"
					accent={accents[index % accents.length]}
					detail={fact.detail}
				/>
			{/each}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Your identifier</Card.Title>
			<Card.Description>
				The vehicle identification number appears on every row of every file.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			<div class="flex flex-wrap items-center gap-3">
				<code class="rounded-md bg-muted px-3 py-2 font-mono text-sm">
					{settings.revealVin ? dataset.vin : maskVin(dataset.vin)}
				</code>
				<Button
					variant="outline"
					size="sm"
					onclick={() => (settings.revealVin = !settings.revealVin)}
				>
					{#if settings.revealVin}
						<EyeOffIcon class="size-4" />
						Hide it
					{:else}
						<EyeIcon class="size-4" />
						Show it
					{/if}
				</Button>
				<Badge variant="secondary">Model {dataset.vmodel}</Badge>
			</div>
			<p class="text-sm leading-relaxed text-muted-foreground">
				Repeated {num(dataset.rowsParsed)} times across your export, it accounts for roughly
				{bytes(dataset.rowsParsed * 18)} of the file on its own. It identifies the car, and through a
				registration record, its owner. If you share a screenshot of your data, this is the field to remove
				— which is why it is masked here by default.
			</p>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Curiosities in the file itself</Card.Title>
			<Card.Description>What the export reveals about how it was put together.</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-8 sm:grid-cols-2">
			{#each stats.facts.quirk as fact, index (fact.id)}
				<BigStat
					kicker={fact.kicker}
					value={fact.value}
					unit={fact.unit}
					size="sm"
					accent={accents[(index + 3) % accents.length]}
					detail={fact.detail}
				/>
			{/each}

			{#if dataset.unsortedStreams.length > 0}
				<BigStat
					kicker="Files out of order"
					value={`${dataset.unsortedStreams.length}`}
					size="sm"
					accent="--viz-2"
					detail="One block of an earlier day was written after a later one. The rows are sorted here before anything is measured; read in file order, a day would appear twice."
				/>
			{/if}

			{#if !dataset.aligned}
				<BigStat
					kicker="Timelines"
					value="Merged"
					size="sm"
					accent="--viz-5"
					detail="The three files did not share the same timestamps, so they were joined on time rather than assumed to line up row for row."
				/>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root class="border-primary/30">
		<Card.Header>
			<Card.Title class="flex items-center gap-2">
				<ShieldIcon class="size-5 text-primary" />
				How this app handles it
			</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-3 text-sm leading-relaxed text-muted-foreground">
			<p>
				Your files were read by a worker inside this browser tab. There is no server to receive
				them: the app is a set of static files, and after they load, nothing is sent anywhere. You
				can confirm it — open your browser's network panel and reload with the data loaded, or
				disconnect from the network entirely and keep using the page.
			</p>
			<p>
				Nothing is written to storage either. Closing this tab discards the
				{num(dataset.time.length)} samples currently in memory, and reopening it starts from an empty
				page.
			</p>
			<p>
				The export covers a rolling {stats.windowDays} days. If you want a longer record, request a new
				export before the old one ages out, and keep the files yourself — this window is all that was
				given to you.
			</p>
		</Card.Content>
	</Card.Root>
</div>
