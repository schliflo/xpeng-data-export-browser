<!--
  A single number with its label and context.

  Used wherever one figure is the answer, which is often better than a chart:
  "2,953 km" needs no axes. The value carries the emphasis, the label sits
  above it in muted ink, and any supporting sentence goes below.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		kicker: string;
		value: string;
		unit?: string;
		detail?: string;
		accent?: string;
		size?: 'sm' | 'md' | 'lg';
		children?: Snippet;
		class?: string;
	}

	let {
		kicker,
		value,
		unit,
		detail,
		accent = '--viz-1',
		size = 'md',
		children,
		class: className = ''
	}: Props = $props();

	const valueSize = {
		sm: 'text-2xl sm:text-3xl',
		md: 'text-4xl sm:text-5xl',
		lg: 'text-6xl sm:text-8xl'
	} as const;
</script>

<div class="flex flex-col gap-1 {className}">
	<span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
		{kicker}
	</span>
	<span class="flex items-baseline gap-2">
		<span
			class="font-semibold tracking-tight tabular-nums {valueSize[size]}"
			style="color: var({accent})"
		>
			{value}
		</span>
		{#if unit}
			<span class="text-sm font-medium text-muted-foreground sm:text-base">{unit}</span>
		{/if}
	</span>
	{#if detail}
		<p class="mt-1 text-sm leading-relaxed text-muted-foreground">{detail}</p>
	{/if}
	{@render children?.()}
</div>
