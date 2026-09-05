<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import * as Popover from '$lib/components/ui/popover';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import MadeBy from '$lib/components/app/MadeBy.svelte';
	import Seo from '$lib/components/app/Seo.svelte';
	import { SITE_NAME } from '$lib/seo';
	import { data } from '$lib/state/dataset.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { maskVin, dateOnly } from '$lib/utils/format';
	import LayoutIcon from '@lucide/svelte/icons/layout-dashboard';
	import RouteIcon from '@lucide/svelte/icons/route';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import BatteryIcon from '@lucide/svelte/icons/battery-charging';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import DoorIcon from '@lucide/svelte/icons/door-open';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import ShieldIcon from '@lucide/svelte/icons/shield-check';
	import SettingsIcon from '@lucide/svelte/icons/settings-2';

	let { children } = $props();

	const sections = [
		{ href: '/dash/overview', label: 'Overview', icon: LayoutIcon },
		{ href: '/dash/trips', label: 'Trips', icon: RouteIcon },
		{ href: '/dash/charging', label: 'Charging', icon: ZapIcon },
		{ href: '/dash/battery', label: 'Battery', icon: BatteryIcon },
		{ href: '/dash/driving', label: 'Driving style', icon: GaugeIcon },
		{ href: '/dash/doors-tyres', label: 'Doors & tyres', icon: DoorIcon },
		{ href: '/dash/explorer', label: 'Signal explorer', icon: TableIcon },
		{ href: '/dash/privacy', label: 'What it knows', icon: ShieldIcon }
	];

	const stats = $derived(data.derived);
	const section = $derived(sections.find((s) => s.href === page.url.pathname));

	/** What is on screen: a fresh drop, a kept export, or several joined up. */
	const sourceLabel = $derived.by(() => {
		if (data.source.kind === 'merged') return `${data.source.ids.length} exports merged`;
		if (data.isDemo) return 'Demonstration month';
		return data.source.kind === 'reopened' ? 'Kept export' : 'Your export';
	});

	onMount(() => {
		// The dataset is not reloaded on navigation, so a deep link opened cold
		// has nothing to show and belongs back at the start — where the exports
		// kept in this browser are listed, ready to open again.
		if (!data.isReady) goto('/');
	});
</script>

<Seo
	title={section?.label ?? 'Dashboard'}
	path={page.url.pathname}
	description="Trips, charging, battery and driving style, read out of your own XPeng export."
	noindex
/>

{#if data.isReady && stats}
	<Sidebar.Provider>
		<Sidebar.Root collapsible="icon">
			<Sidebar.Header>
				<div class="flex items-center gap-2 px-2 py-1.5">
					<a
						href="/"
						class="shrink-0 rounded-lg transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						aria-label="{SITE_NAME} — back to the start"
					>
						<img src="/favicon.svg" alt="" width="32" height="32" class="size-8" />
					</a>
					<div class="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden">
						<span class="truncate text-sm font-medium">{sourceLabel}</span>
						<span class="truncate text-xs text-muted-foreground">
							{dateOnly(stats.startTime)} – {dateOnly(stats.endTime)}
						</span>
						{#if stats.sources > 1}
							<span class="truncate text-xs text-muted-foreground">
								{stats.recordedDays} days recorded
							</span>
						{/if}
					</div>
				</div>
			</Sidebar.Header>

			<Sidebar.Content>
				<Sidebar.Group>
					<Sidebar.GroupContent>
						<Sidebar.Menu>
							{#each sections as section (section.href)}
								<Sidebar.MenuItem>
									<Sidebar.MenuButton
										isActive={page.url.pathname === section.href}
										tooltipContent={section.label}
									>
										{#snippet child({ props })}
											<a href={section.href} {...props}>
												<section.icon />
												<span>{section.label}</span>
											</a>
										{/snippet}
									</Sidebar.MenuButton>
								</Sidebar.MenuItem>
							{/each}
						</Sidebar.Menu>
					</Sidebar.GroupContent>
				</Sidebar.Group>
			</Sidebar.Content>

			<Sidebar.Footer>
				<div class="space-y-2 px-2 pb-2 group-data-[collapsible=icon]:hidden">
					<button
						type="button"
						class="w-full text-left font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
						onclick={() => (settings.revealVin = !settings.revealVin)}
						title={settings.revealVin ? 'Hide the VIN' : 'Reveal the VIN'}
					>
						{settings.revealVin ? data.dataset?.vin : maskVin(data.dataset?.vin ?? '')}
					</button>
					<a href="/wrapped" class="block text-xs text-muted-foreground hover:text-foreground">
						Replay the highlights
					</a>
					<MadeBy class="pt-1" />
				</div>
			</Sidebar.Footer>
			<Sidebar.Rail />
		</Sidebar.Root>

		<Sidebar.Inset>
			<header
				class="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur"
			>
				<Sidebar.Trigger />
				<h1 class="text-sm font-medium">
					{section?.label ?? 'Overview'}
				</h1>

				<div class="ml-auto flex items-center gap-2">
					{#if data.isDemo}
						<Badge variant="secondary">Demo data</Badge>
					{/if}
					{#if data.source.kind === 'merged'}
						<Badge variant="secondary">Merged · {data.source.ids.length}</Badge>
					{:else if data.source.kind === 'reopened'}
						<Badge variant="secondary">Reopened</Badge>
					{/if}

					<Popover.Root>
						<Popover.Trigger class={buttonVariants({ variant: 'ghost', size: 'icon' })}>
							<SettingsIcon class="size-4" />
							<span class="sr-only">Settings</span>
						</Popover.Trigger>
						<Popover.Content class="w-80 space-y-4" align="end">
							<div class="space-y-2">
								<Label for="tz">Time zone</Label>
								<Input id="tz" value={settings.timeZone} readonly class="font-mono text-xs" />
								<p class="text-xs text-muted-foreground">
									Days and hours are shown in your own zone. The export's date column is cut at
									midnight in Beijing, so it is ignored.
								</p>
							</div>

							<div class="space-y-2">
								<Label for="price">Electricity price, per kWh</Label>
								<Input
									id="price"
									type="number"
									step="0.01"
									min="0"
									bind:value={settings.pricePerKwh}
								/>
							</div>

							<div class="flex items-center justify-between">
								<Label for="vin" class="font-normal">Show the full VIN</Label>
								<Switch id="vin" bind:checked={settings.revealVin} />
							</div>

							<Button
								variant="outline"
								size="sm"
								class="w-full"
								onclick={() => {
									data.reset();
									goto('/');
								}}
							>
								Open another export
							</Button>
						</Popover.Content>
					</Popover.Root>
				</div>
			</header>

			<main class="flex-1 p-4 sm:p-6">
				{@render children()}
			</main>
		</Sidebar.Inset>
	</Sidebar.Provider>
{/if}
