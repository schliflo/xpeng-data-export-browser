<!--
  Progress while the export is read.

  A month of telemetry is a few hundred megabytes, so this runs for a few
  seconds and needs to say what it is doing rather than spin silently.
-->
<script lang="ts">
	import { Progress } from '$lib/components/ui/progress';
	import { data } from '$lib/state/dataset.svelte';
	import { PHASE_LABELS } from '$lib/data/worker/protocol';
	import { bytes } from '$lib/utils/format';

	const progress = $derived(data.progress);
	const fraction = $derived(
		progress && progress.total > 0 ? Math.min(1, progress.loaded / progress.total) : 0
	);
</script>

<div class="mx-auto w-full max-w-md space-y-4 text-center">
	<div class="space-y-1">
		<p class="text-lg font-medium">
			{progress ? PHASE_LABELS[progress.phase] : 'Getting started'}
		</p>
		{#if progress?.detail}
			<p class="text-sm text-muted-foreground">{progress.detail}</p>
		{/if}
	</div>

	<Progress value={fraction * 100} max={100} />

	{#if progress && progress.phase === 'parsing' && progress.total > 0}
		<p class="text-xs text-muted-foreground tabular-nums">
			{bytes(progress.loaded)} of {bytes(progress.total)}
		</p>
	{/if}

	<p class="text-xs text-muted-foreground">
		Everything is happening in this browser tab. Nothing is being uploaded.
	</p>
</div>
