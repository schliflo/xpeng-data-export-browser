/**
 * The loaded export, held in memory for the life of the tab.
 *
 * Nothing is persisted: no storage, no cookies, no upload. Reloading the page
 * genuinely discards the data, which is the behaviour the privacy claim on the
 * landing page depends on.
 */

import { goto } from '$app/navigation';
import { loadDemo, loadFiles, type LoadProgress } from '../data/client';
import type { DerivedData } from '../data/analytics';
import type { Dataset } from '../data/store/columnar';
import { PyramidCache } from '../data/store/decimate';
import { settings } from './settings.svelte';

type Status = 'empty' | 'loading' | 'ready' | 'error';

class DatasetStore {
	status = $state<Status>('empty');
	progress = $state<LoadProgress | null>(null);
	dataset = $state<Dataset | null>(null);
	derived = $state<DerivedData | null>(null);
	error = $state<{ message: string; hint?: string } | null>(null);
	/** True when the loaded data is generated rather than a real export. */
	isDemo = $state(false);

	/** Built lazily per charted column and thrown away with the dataset. */
	pyramids: PyramidCache | null = null;

	get isReady(): boolean {
		return this.status === 'ready' && this.dataset !== null && this.derived !== null;
	}

	private begin() {
		this.status = 'loading';
		this.error = null;
		this.progress = null;
		this.dataset = null;
		this.derived = null;
		this.pyramids = null;
	}

	private settle(dataset: Dataset, derived: DerivedData, isDemo: boolean) {
		this.dataset = dataset;
		this.derived = derived;
		this.pyramids = new PyramidCache(dataset.time);
		this.isDemo = isDemo;
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

	async load(files: File[]) {
		this.begin();
		try {
			const result = await loadFiles(files, settings.timeZone, (progress) => {
				this.progress = progress;
			});
			this.settle(result.dataset, result.derived, false);
			await goto('/wrapped');
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
			this.settle(result.dataset, result.derived, true);
			await goto('/wrapped');
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
		this.isDemo = false;
	}
}

export const data = new DatasetStore();
