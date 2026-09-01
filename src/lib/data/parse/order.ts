/**
 * Putting a stream in order.
 *
 * The export is *mostly* sorted by time, but not reliably: it is assembled from
 * warehouse partitions, and a real export was found to contain one block of an
 * earlier day emitted after a later one. It also repeats rows, because the
 * delivery pipeline replays batches it is unsure about.
 *
 * Rather than assume, we check. An already-sorted stream takes a single pass;
 * a jumbled one is sorted first. Either way the result is ascending and unique.
 */

export interface RowOrder {
	/** Row indices to keep, ascending in time and free of repeats. */
	keep: Uint32Array;
	/** Rows dropped because another row already covered that second. */
	duplicates: number;
	/** True when the source needed reordering. */
	wasUnsorted: boolean;
}

export function orderRows(time: Uint32Array, length: number): RowOrder {
	let sorted = true;
	for (let i = 1; i < length; i++) {
		if (time[i] < time[i - 1]) {
			sorted = false;
			break;
		}
	}

	let sequence: Uint32Array;
	if (sorted) {
		sequence = null as unknown as Uint32Array;
	} else {
		sequence = new Uint32Array(length);
		for (let i = 0; i < length; i++) sequence[i] = i;
		// Tie-break on the original position so the result is deterministic
		// regardless of whether the engine's typed-array sort is stable.
		sequence.sort((a, b) => time[a] - time[b] || a - b);
	}

	const keep = new Uint32Array(length);
	let kept = 0;
	let previous = -1;
	for (let i = 0; i < length; i++) {
		const index = sorted ? i : sequence[i];
		const t = time[index];
		if (t === previous) continue;
		keep[kept++] = index;
		previous = t;
	}

	return {
		keep: keep.subarray(0, kept),
		duplicates: length - kept,
		wasUnsorted: !sorted
	};
}
