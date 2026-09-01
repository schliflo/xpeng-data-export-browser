<!--
  The opening sequence.

  One fact per screen, scroll-snapped. This exists because a dashboard answers
  questions you already have, and most of what is interesting in this export is
  something you would never have thought to ask.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import Seo from '$lib/components/app/Seo.svelte';
	import { data } from '$lib/state/dataset.svelte';
	import type { Fact } from '$lib/data/analytics/facts';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';

	const stats = $derived(data.derived);

	/** Headlines first, then habits, then the export's own oddities. */
	const cards = $derived.by<Fact[]>(() => {
		if (!stats) return [];
		return [...stats.facts.headline, ...stats.facts.habit, ...stats.facts.quirk.slice(0, 3)];
	});

	const accents = [
		'--viz-1',
		'--viz-3',
		'--viz-2',
		'--viz-4',
		'--viz-7',
		'--viz-5',
		'--viz-8',
		'--viz-6'
	];

	let container = $state<HTMLDivElement>();
	let active = $state(0);

	onMount(() => {
		if (!data.isReady) {
			goto('/');
			return;
		}

		// Track which card is in view for the progress dots.
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						active = Number((entry.target as HTMLElement).dataset.index ?? 0);
					}
				}
			},
			{ threshold: 0.6 }
		);
		container?.querySelectorAll('[data-index]').forEach((el) => observer.observe(el));
		return () => observer.disconnect();
	});

	function scrollTo(index: number) {
		container?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ behavior: 'smooth' });
	}
</script>

<Seo
	title="Your month in data"
	path="/wrapped"
	description="The highlights of a month of driving, read straight out of your own XPeng export."
	noindex
/>

{#if stats}
	<div bind:this={container} class="h-svh snap-y snap-mandatory overflow-y-auto scroll-smooth">
		{#each cards as fact, index (fact.id)}
			<section
				data-index={index}
				class="relative flex h-svh snap-start items-center justify-center px-6"
			>
				<div
					class="pointer-events-none absolute inset-0 opacity-50"
					style="background: radial-gradient(70% 60% at 50% 45%, color-mix(in oklab, var({accents[
						index % accents.length
					]}) 20%, transparent), transparent 70%)"
					aria-hidden="true"
				></div>

				<div class="relative mx-auto max-w-2xl text-center">
					<p class="text-sm font-medium tracking-widest text-muted-foreground uppercase">
						{fact.kicker}
					</p>

					<p class="mt-6 flex flex-wrap items-baseline justify-center gap-3">
						<span
							class="text-7xl font-semibold tracking-tighter tabular-nums sm:text-9xl"
							style="color: var({accents[index % accents.length]})"
						>
							{fact.value}
						</span>
						{#if fact.unit}
							<span class="text-2xl font-medium text-muted-foreground sm:text-3xl">
								{fact.unit}
							</span>
						{/if}
					</p>

					<p class="mx-auto mt-8 max-w-xl text-lg leading-relaxed text-pretty text-foreground/80">
						{fact.detail}
					</p>

					{#if index === cards.length - 1}
						<div class="mt-12 flex flex-col items-center gap-3">
							<Button size="lg" onclick={() => goto('/dash/overview')}>
								Explore all of it
								<ArrowRightIcon class="size-4" />
							</Button>
							<p class="text-xs text-muted-foreground">
								Trips, charging, battery, driving style and the raw signals
							</p>
						</div>
					{:else}
						<button
							type="button"
							class="mt-12 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
							onclick={() => scrollTo(index + 1)}
						>
							<ArrowDownIcon class="size-4 animate-bounce" />
							Keep going
						</button>
					{/if}
				</div>
			</section>
		{/each}
	</div>

	<!-- Progress rail, and an escape hatch for anyone who wants the data now. -->
	<div class="fixed top-6 right-6 z-10 flex items-center gap-3">
		{#if data.isDemo}
			<Badge variant="secondary">Demonstration data</Badge>
		{/if}
		<Button variant="ghost" size="sm" onclick={() => goto('/dash/overview')}>Skip</Button>
	</div>

	<div class="fixed top-1/2 right-6 z-10 hidden -translate-y-1/2 flex-col gap-2 sm:flex">
		{#each cards as fact, index (fact.id)}
			<button
				type="button"
				class="h-1.5 rounded-full transition-all"
				class:w-6={index === active}
				class:w-1.5={index !== active}
				style="background: {index === active
					? `var(${accents[index % accents.length]})`
					: 'var(--viz-grid)'}"
				aria-label="Go to {fact.kicker}"
				onclick={() => scrollTo(index)}
			></button>
		{/each}
	</div>
{/if}
