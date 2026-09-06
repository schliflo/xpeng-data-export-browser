/**
 * ZIP extraction.
 *
 * XPeng delivers the export as an archive, so accepting one directly saves the
 * user unpacking 340 MB by hand. fflate streams each member, and each member is
 * surfaced as a `FileLike` so the CSV reader cannot tell the difference between
 * an archived file and a loose one.
 *
 * A dropped ZIP may also be one of this app's own backups, which is a different
 * thing entirely: not files to parse but exports already parsed, to be put back
 * into storage. Both arrive the same way, so they are told apart here.
 */

import { Unzip, UnzipInflate } from 'fflate';
import { isBackupArchive } from '../../history/archive';
import type { FileLike } from '../schema/streams';

/**
 * The CSV members of an archive. Each is buffered as it is inflated, because
 * the CSV reader pulls at its own pace rather than the archive's.
 */
export function extractZipBytes(bytes: Uint8Array): FileLike[] {
	const members = new Map<string, Uint8Array[]>();
	const sizes = new Map<string, number>();
	let failure: unknown = null;

	const unzip = new Unzip((stream) => {
		const name = stream.name;
		// Directory entries and macOS resource forks are not data.
		if (name.endsWith('/') || name.includes('__MACOSX')) return;
		if (!/\.csv$/i.test(name)) return;

		members.set(name, []);
		sizes.set(name, 0);
		stream.ondata = (err, chunk, final) => {
			if (err) {
				failure = err;
				return;
			}
			if (chunk?.length) {
				members.get(name)!.push(chunk);
				sizes.set(name, (sizes.get(name) ?? 0) + chunk.length);
			}
			void final;
		};
		stream.start();
	});
	unzip.register(UnzipInflate);
	unzip.push(bytes, true);
	if (failure) throw failure;

	return [...members.entries()].map(([name, chunks]) => {
		const size = sizes.get(name) ?? 0;
		return {
			name,
			size,
			stream: () =>
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (const chunk of chunks) controller.enqueue(chunk);
						controller.close();
					}
				})
		} satisfies FileLike;
	});
}

export async function extractZip(file: File): Promise<FileLike[]> {
	return extractZipBytes(new Uint8Array(await file.arrayBuffer()));
}

export interface ExpandedDrop {
	/** CSVs to parse, loose or unpacked. */
	files: FileLike[];
	/** Backup archives to restore, as raw bytes. */
	backups: Uint8Array[];
}

/** Expands any ZIPs in the dropped set, leaving loose CSVs untouched. */
export async function expandDroppedFiles(files: File[]): Promise<ExpandedDrop> {
	const out: FileLike[] = [];
	const backups: Uint8Array[] = [];

	for (const file of files) {
		if (!/\.zip$/i.test(file.name)) {
			out.push(file);
			continue;
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (isBackupArchive(bytes)) backups.push(bytes);
		else out.push(...extractZipBytes(bytes));
	}

	return { files: out, backups };
}
