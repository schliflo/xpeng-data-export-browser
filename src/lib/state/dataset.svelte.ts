/**
 * The loaded export, held in memory for the life of the tab.
 *
 * Nothing is uploaded: no server, no cookies, no analytics. A copy is kept in
 * this browser's own storage so the export can be reopened later — and that
 * copy is the only thing that outlives the tab. Removing it is a click, and
 * nothing about it ever leaves the device.
 */

import { goto } from '$app/navigation';
import { toast } from 'svelte-sonner';
import { loadDemo, loadFiles, openKept, type LoadProgress } from '../data/client';
import type { KeptOutcome } from '../data/worker/protocol';
import type { DerivedData } from '../data/analytics';
import type { Dataset } from '../data/store/columnar';
import { PyramidCache } from '../data/store/decimate';
import { history } from './history.svelte';
import { settings } from './settings.svelte';

type Status = 'empty' | 'loading' | 'ready' | 'error';

/** Where the data on screen came from, which is what the labels report. */
export type SourceKind = 'fresh' | 'reopened' | 'merged';

export interface DataSource {
	kind: SourceKind;
	/** The exports behind it: one, or several once merged. */
	ids: string[];
	demo: boolean;
}

class DatasetStore {
	status = $state<Status>('empty');
	progress = $state<LoadProgress | null>(null);
	dataset = $state<Dataset | null>(null);
	derived = $state<DerivedData | null>(null);
	error = $state<{ message: string; hint?: string } | null>(null);
	source = $state<DataSource>({ kind: 'fresh', ids: [], demo: false });

	/** Built lazily per charted column and thrown away with the dataset. */
	pyramids: PyramidCache | null = null;

	get isReady(): boolean {
		return this.status === 'ready' && this.dataset !== null && this.derived !== null;
	}

	/** True when the data is generated rather than a real export. */
	get isDemo(): boolean {
		return this.source.demo;
	}

	private begin() {
		this.status = 'loading';
		this.error = null;
		this.progress = null;
		this.dataset = null;
		this.derived = null;
		this.pyramids = null;
	}

	private settle(dataset: Dataset, derived: DerivedData, source: DataSource) {
		this.dataset = dataset;
		this.derived = derived;
		this.pyramids = new PyramidCache(dataset.time);
		this.source = source;
		this.progress = null;
		this.status = 'ready';
	}

	private fail(error: unknown) {
		this.error = {
			message: error instanceof Error ? error.message : 'Something went wrong.',
			hint: error instanceof Error && 'hint' in error ? (error.hint as string) : undefined
		};
		this.status = 'error';
		this.progress = null;
	}

	/**
	 * Says what happened to the copy. The first one is worth announcing, since
	 * it changes what closing the tab means; a failure is worth announcing
	 * because the export on screen is then the only copy there is.
	 */
	private async afterKeep(kept: KeptOutcome | null) {
		if (!kept) return;

		if (!kept.ok) {
			toast('This export was not kept', {
				description: `${kept.reason} You can still read it now, but it will be gone when the tab closes.`,
				duration: 8000,
				closeButton: true
			});
			return;
		}

		const first = history.entries.length === 0;
		await history.requestPersistence();
		await history.refresh();

		if (first) {
			toast('Kept in this browser', {
				description:
					'This export is now stored on your device, so you can reopen it without dropping the files in again. Remove it whenever you like from the start page.',
				duration: 8000,
				closeButton: true
			});
		}
	}

	async load(files: File[]) {
		this.begin();
		try {
			const result = await loadFiles(files, settings.timeZone, (progress) => {
				this.progress = progress;
			});

			if (result.kind === 'restored') {
				this.status = 'empty';
				this.progress = null;
				await history.refresh();
				const count = result.ids.length;
				toast(count === 1 ? 'Restored one export' : `Restored ${count} exports`, {
					description: result.skipped.length
						? `${result.skipped.length} could not be read by this version of the app.`
						: 'They are listed below, ready to open.'
				});
				return;
			}

			this.settle(result.dataset, result.derived, {
				kind: 'fresh',
				ids: [result.dataset.exportId],
				demo: false
			});
			await goto('/wrapped');
			await this.afterKeep(result.kept);
		} catch (error) {
			this.fail(error);
		}
	}

	async loadDemoData() {
		this.begin();
		try {
			const result = await loadDemo(settings.timeZone, (progress) => {
				this.progress = progress;
			});
			this.settle(result.dataset, result.derived, {
				kind: 'fresh',
				ids: [result.dataset.exportId],
				demo: true
			});
			await goto('/wrapped');
			await this.afterKeep(result.kept);
		} catch (error) {
			this.fail(error);
		}
	}

	/**
	 * Reopens exports already kept here. Several at once are merged into one
	 * timeline, which is the only way to see more than the thirty days any
	 * single export covers.
	 */
	async open(ids: string[]) {
		if (ids.length === 0) return;
		this.begin();
		try {
			const known = history.entries.filter((entry) => ids.includes(entry.id));
			const result = await openKept(ids, settings.timeZone, (progress) => {
				this.progress = progress;
			});
			this.settle(result.dataset, result.derived, {
				kind: ids.length > 1 ? 'merged' : 'reopened',
				ids,
				demo: known.length > 0 && known.every((entry) => entry.isDemo)
			});
			// Straight to the dashboard: the opening sequence is for the moment
			// an export is first read, not for every time it is picked up again.
			await goto('/dash/overview');
		} catch (error) {
			this.fail(error);
		}
	}

	reset() {
		this.status = 'empty';
		this.dataset = null;
		this.derived = null;
		this.error = null;
		this.progress = null;
		this.pyramids = null;
		this.source = { kind: 'fresh', ids: [], demo: false };
	}
}

export const data = new DatasetStore();
