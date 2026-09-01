<!--
  File intake.

  Accepts the CSVs loose or the ZIP exactly as XPeng delivers it. Nothing is
  uploaded: the files are handed to a worker in this tab and read there.
-->
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { data } from '$lib/state/dataset.svelte';
	import { bytes } from '$lib/utils/format';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import FileIcon from '@lucide/svelte/icons/file-spreadsheet';

	let dragging = $state(false);
	let input = $state<HTMLInputElement>();
	let picked = $state<File[]>([]);

	function accept(list: FileList | null) {
		if (!list) return;
		picked = [...list].filter((file) => /\.(csv|zip)$/i.test(file.name));
		if (picked.length) data.load(picked);
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		accept(event.dataTransfer?.files ?? null);
	}
</script>

<div
	class={[
		'relative rounded-2xl border-2 border-dashed p-8 text-center transition-colors sm:p-12',
		dragging ? 'border-primary bg-primary/5' : 'border-border/70 bg-card/40 hover:border-primary/50'
	]}
	ondragover={(e) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={onDrop}
	role="region"
	aria-label="Drop your export files here"
>
	<input
		bind:this={input}
		type="file"
		multiple
		accept=".csv,.zip"
		class="sr-only"
		onchange={(e) => accept(e.currentTarget.files)}
	/>

	<div class="flex flex-col items-center gap-4">
		<div class="rounded-full bg-primary/10 p-4 text-primary">
			<UploadIcon class="size-7" />
		</div>

		<div class="space-y-1">
			<p class="text-lg font-medium">Drop your export here</p>
			<p class="text-sm text-muted-foreground">The ZIP from XPeng, or the CSV files inside it</p>
		</div>

		<Button onclick={() => input?.click()} size="lg">Choose files</Button>

		{#if picked.length}
			<ul class="mt-2 space-y-1 text-left text-xs text-muted-foreground">
				{#each picked as file (file.name)}
					<li class="flex items-center gap-2">
						<FileIcon class="size-3.5 shrink-0" />
						<span class="truncate">{file.name}</span>
						<span class="tabular-nums">{bytes(file.size)}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
