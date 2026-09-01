/**
 * ZIP extraction.
 *
 * XPeng delivers the export as an archive, so accepting one directly saves the
 * user unpacking 340 MB by hand. fflate streams each member, and each member is
 * surfaced as a `FileLike` so the CSV reader cannot tell the difference between
 * an archived file and a loose one.
 */

import { Unzip, UnzipInflate } from 'fflate';
import type { FileLike } from '../schema/streams';

/**
 * Streams the members of a ZIP. Members are buffered individually because the
 * CSV reader pulls at its own pace, but only one member is held at a time.
 */
export async function extractZip(file: File): Promise<FileLike[]> {
	const members = new Map<string, Uint8Array[]>();
	const sizes = new Map<string, number>();
	const done = new Set<string>();

	await new Promise<void>((resolve, reject) => {
		const unzip = new Unzip((stream) => {
			const name = stream.name;
			// Directory entries and macOS resource forks are not data.
			if (name.endsWith('/') || name.includes('__MACOSX')) return;
			if (!/\.csv$/i.test(name)) return;

			members.set(name, []);
			sizes.set(name, 0);
			stream.ondata = (err, chunk, final) => {
				if (err) {
					reject(err);
					return;
				}
				if (chunk?.length) {
					members.get(name)!.push(chunk);
					sizes.set(name, (sizes.get(name) ?? 0) + chunk.length);
				}
				if (final) done.add(name);
			};
			stream.start();
		});
		unzip.register(UnzipInflate);

		file
			.arrayBuffer()
			.then((buffer) => {
				unzip.push(new Uint8Array(buffer), true);
				resolve();
			})
			.catch(reject);
	});

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

/** Expands any ZIPs in the dropped set, leaving loose CSVs untouched. */
export async function expandDroppedFiles(files: File[]): Promise<FileLike[]> {
	const out: FileLike[] = [];
	for (const file of files) {
		if (/\.zip$/i.test(file.name)) {
			out.push(...(await extractZip(file)));
		} else {
			out.push(file);
		}
	}
	return out;
}
