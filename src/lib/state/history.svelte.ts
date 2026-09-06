/**
 * The library of exports kept in this browser.
 *
 * Only the summaries live here — dates, distance, size. The telemetry itself
 * stays compressed in storage until something asks for it, so listing a year
 * of exports costs no more than listing one.
 */

import { browser } from '$app/environment';
import { backupKept } from '../data/client';
import { estimateOpen, type ExportRecord } from '../history/codec';
import { clearExports, deleteExports, listExports, storageAvailable } from '../history/db';
import { downloadBlob } from '../utils/download';

export interface VehicleGroup {
	vin: string;
	vmodel: string;
	isDemo: boolean;
	entries: ExportRecord[];
}

type Status = 'unknown' | 'ready' | 'unavailable';

/** Asked at most once a session, and only after something was actually kept. */
let persistenceRequested = false;

class HistoryStore {
	status = $state<Status>('unknown');
	entries = $state<ExportRecord[]>([]);
	usage = $state<{ used: number; quota: number } | null>(null);
	busy = $state(false);
	error = $state<string | null>(null);

	/** Exports by vehicle, newest first, and the newest vehicle first. */
	get groups(): VehicleGroup[] {
		const byVin = new Map<string, VehicleGroup>();
		for (const entry of this.entries) {
			let group = byVin.get(entry.vin);
			if (!group) {
				group = { vin: entry.vin, vmodel: entry.vmodel, isDemo: entry.isDemo, entries: [] };
				byVin.set(entry.vin, group);
			}
			group.entries.push(entry);
			// A vehicle counts as a demonstration only if nothing real was kept
			// under the same identity.
			group.isDemo = group.isDemo && entry.isDemo;
		}

		const groups = [...byVin.values()];
		for (const group of groups) group.entries.sort((a, b) => b.startTime - a.startTime);
		return groups.sort((a, b) => b.entries[0].startTime - a.entries[0].startTime);
	}

	get totalBytes(): number {
		return this.entries.reduce((sum, entry) => sum + entry.storedBytes, 0);
	}

	async refresh(): Promise<void> {
		if (!browser || !storageAvailable()) {
			this.status = 'unavailable';
			return;
		}
		try {
			this.entries = await listExports();
			this.status = 'ready';
			this.error = null;
			await this.measure();
		} catch (error) {
			this.status = 'unavailable';
			this.error = error instanceof Error ? error.message : 'The local store could not be read.';
		}
	}

	private async measure(): Promise<void> {
		if (!navigator.storage?.estimate) return;
		try {
			const estimate = await navigator.storage.estimate();
			this.usage = { used: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
		} catch {
			this.usage = null;
		}
	}

	/**
	 * Asks the browser to treat this data as worth keeping. It only ever helps:
	 * a refusal changes nothing, and on Safari even a yes does not survive a
	 * week of not visiting — which is what backups are for.
	 */
	async requestPersistence(): Promise<void> {
		if (persistenceRequested || !browser || !navigator.storage?.persist) return;
		persistenceRequested = true;
		try {
			await navigator.storage.persist();
		} catch {
			// Nothing to do: storage stays best-effort.
		}
	}

	async remove(ids: string[]): Promise<void> {
		this.busy = true;
		try {
			await deleteExports(ids);
			await this.refresh();
		} finally {
			this.busy = false;
		}
	}

	async removeAll(): Promise<void> {
		this.busy = true;
		try {
			await clearExports();
			await this.refresh();
		} finally {
			this.busy = false;
		}
	}

	/** Writes the chosen exports out as one archive and hands it to the user. */
	async backup(ids: string[]): Promise<void> {
		this.busy = true;
		try {
			const result = await backupKept(ids);
			downloadBlob(result.name, result.blob);
		} finally {
			this.busy = false;
		}
	}

	estimate(ids: string[]): { rows: number; bytes: number } {
		const wanted = new Set(ids);
		return estimateOpen(this.entries.filter((entry) => wanted.has(entry.id)));
	}
}

export const history = new HistoryStore();
