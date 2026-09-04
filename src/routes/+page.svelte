<script lang="ts">
	import DropZone from '$lib/components/app/DropZone.svelte';
	import ParseProgress from '$lib/components/app/ParseProgress.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import MadeBy from '$lib/components/app/MadeBy.svelte';
	import Seo from '$lib/components/app/Seo.svelte';
	import { data } from '$lib/state/dataset.svelte';
	import ShieldIcon from '@lucide/svelte/icons/shield-check';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import DoorIcon from '@lucide/svelte/icons/door-open';
	import AlertIcon from '@lucide/svelte/icons/triangle-alert';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';

	const highlights = [
		{
			icon: GaugeIcon,
			title: 'Every trip, second by second',
			body: 'Speed, pedal, steering and braking at one sample a second — enough to replay individual manoeuvres, not just journeys.'
		},
		{
			icon: ZapIcon,
			title: 'What charging really costs',
			body: 'Sessions found automatically, energy integrated from pack voltage and current, and the range your car actually believes in.'
		},
		{
			icon: DoorIcon,
			title: 'The routine you never told anyone',
			body: 'Door openings alone redraw your week: when you leave, when you return, and the days you never went out.'
		}
	];
</script>

<Seo />

<main class="relative min-h-svh overflow-hidden">
	<!-- A quiet field of light behind the fold, so the page has depth without noise. -->
	<div
		class="pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-60"
		style="background: radial-gradient(60% 100% at 50% 0%, color-mix(in oklab, var(--viz-1) 22%, transparent), transparent 70%)"
		aria-hidden="true"
	></div>

	<div class="relative mx-auto max-w-5xl px-6 py-16 sm:py-24">
		{#if data.status === 'loading'}
			<div class="flex min-h-[60svh] items-center justify-center">
				<ParseProgress />
			</div>
		{:else}
			<header class="mx-auto max-w-3xl text-center">
				<Badge variant="secondary" class="mb-6 gap-1.5">
					<ShieldIcon class="size-3.5" />
					Runs entirely in your browser
				</Badge>

				<h1 class="text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
					Your car has been keeping
					<span
						class="bg-clip-text text-transparent"
						style="background-image: linear-gradient(100deg, var(--viz-1), var(--viz-3))"
						>a very detailed diary</span
					>
				</h1>

				<p class="mx-auto mt-6 max-w-2xl text-lg text-pretty text-muted-foreground">
					Under the EU Data Act you can ask XPeng for the data your vehicle records. What arrives is
					a few hundred megabytes of raw CSV. Drop it in here and read it.
				</p>
			</header>

			<div class="mx-auto mt-12 max-w-2xl">
				<DropZone />

				{#if data.status === 'error' && data.error}
					<div
						class="mt-4 flex gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-left"
						role="alert"
					>
						<AlertIcon class="mt-0.5 size-5 shrink-0 text-destructive" />
						<div class="space-y-1 text-sm">
							<p class="font-medium">{data.error.message}</p>
							{#if data.error.hint}
								<p class="text-muted-foreground">{data.error.hint}</p>
							{/if}
						</div>
					</div>
				{/if}

				<div class="mt-6 flex flex-col items-center gap-3">
					<p class="text-sm text-muted-foreground">Haven't requested your export yet?</p>
					<Button variant="secondary" size="lg" onclick={() => data.loadDemoData()}>
						Explore a demonstration month
						<ArrowRightIcon class="size-4" />
					</Button>
				</div>
			</div>

			<section class="mt-20 grid gap-4 sm:grid-cols-3">
				{#each highlights as item (item.title)}
					<Card.Root class="bg-card/50">
						<Card.Header>
							<item.icon class="mb-2 size-5 text-primary" />
							<Card.Title class="text-base">{item.title}</Card.Title>
						</Card.Header>
						<Card.Content>
							<p class="text-sm leading-relaxed text-muted-foreground">{item.body}</p>
						</Card.Content>
					</Card.Root>
				{/each}
			</section>

			<section class="mt-16 grid gap-8 sm:grid-cols-2">
				<div class="space-y-3">
					<h2 class="flex items-center gap-2 text-lg font-medium">
						<ShieldIcon class="size-5 text-primary" />
						Nothing leaves this tab
					</h2>
					<p class="text-sm leading-relaxed text-muted-foreground">
						There is no server to send anything to. The files are read by a worker inside this page,
						held in memory, and forgotten the moment you close it — no upload, no storage, no
						analytics. After the first visit your browser keeps the app's own files, so it opens
						without a connection; the export is never among them. Your vehicle identification number
						appears on every row of the export; here it stays masked unless you ask to see it.
					</p>
				</div>

				<div class="space-y-3">
					<h2 class="text-lg font-medium">Getting your data</h2>
					<p class="text-sm leading-relaxed text-muted-foreground">
						Request it from XPeng's data centre at
						<a
							href="https://www.xpeng.com/data-act"
							class="text-primary underline underline-offset-4"
							target="_blank"
							rel="noreferrer noopener">xpeng.com/data-act</a
						>. You will receive files named
						<code class="rounded bg-muted px-1 py-0.5 text-xs">…_dwd_opp_gdpr_veh_…_di.csv</code>,
						covering a rolling thirty days. Drop them in exactly as they arrive.
					</p>
				</div>
			</section>

			<footer class="mt-16 flex flex-col items-center gap-2 border-t pt-8 text-center">
				<MadeBy />
				<p class="text-xs text-muted-foreground">
					Open source under the
					<a
						href="https://github.com/schliflo/xpeng-data-export-browser/blob/main/LICENSE"
						class="underline underline-offset-4 hover:text-foreground"
						target="_blank"
						rel="noreferrer noopener">MIT licence</a
					>. Not affiliated with XPeng. Your export stays on this device.
				</p>
			</footer>
		{/if}
	</div>
</main>
