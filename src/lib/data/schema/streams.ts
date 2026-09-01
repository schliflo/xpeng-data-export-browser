/**
 * Recognition of XPeng EU Data Act export files.
 *
 * An export consists of up to three CSV streams. Each stream is chunked at
 * exactly 1,000,000 data rows: the unsuffixed file is chunk 0, `_part1` is
 * chunk 1, and so on. Sorting must be numeric on the part index, not lexical,
 * so that `_part10` lands after `_part9`.
 */

export const STREAM_IDS = ['status', 'operation', 'power'] as const;
export type StreamId = (typeof STREAM_IDS)[number];

export const STREAM_LABELS: Record<StreamId, string> = {
	status: 'Doors & tyres',
	operation: 'Driving',
	power: 'Battery & power'
};

/** Maps the `veh_<name>_di` fragment of a filename onto our stream id. */
const FILE_FRAGMENT_TO_STREAM: Record<string, StreamId> = {
	driving_status: 'status',
	driving_operation: 'operation',
	driving_power_energy: 'power'
};

const FILENAME_RE =
	/^(?<exportId>DA[A-Za-z0-9]+)_dwd_opp_gdpr_veh_(?<fragment>driving_status|driving_operation|driving_power_energy)_di(?:_part(?<part>\d+))?\.csv$/i;

export interface RecognizedFile {
	file: FileLike;
	stream: StreamId;
	exportId: string;
	/** 0 for the unsuffixed base file, N for `_partN`. */
	part: number;
}

/** The subset of `File` we depend on, so ZIP members can stand in for real files. */
export interface FileLike {
	name: string;
	size: number;
	stream(): ReadableStream<Uint8Array>;
}

export interface ExportPlan {
	exportIds: string[];
	streams: Partial<Record<StreamId, RecognizedFile[]>>;
	/** Files we could not match against the export naming scheme. */
	unrecognized: string[];
}

export function recognizeFiles(files: FileLike[]): ExportPlan {
	const streams: Partial<Record<StreamId, RecognizedFile[]>> = {};
	const unrecognized: string[] = [];
	const exportIds = new Set<string>();

	for (const file of files) {
		// ZIP members arrive with directory prefixes; match on the basename.
		const basename = file.name.split('/').pop() ?? file.name;
		const match = FILENAME_RE.exec(basename);
		if (!match?.groups) {
			unrecognized.push(file.name);
			continue;
		}
		const stream = FILE_FRAGMENT_TO_STREAM[match.groups.fragment.toLowerCase()];
		const exportId = match.groups.exportId;
		exportIds.add(exportId);
		(streams[stream] ??= []).push({
			file,
			stream,
			exportId,
			part: match.groups.part ? Number(match.groups.part) : 0
		});
	}

	for (const list of Object.values(streams)) {
		list.sort((a, b) => a.part - b.part);
	}

	return { exportIds: [...exportIds], streams, unrecognized };
}

export function isZip(name: string): boolean {
	return /\.zip$/i.test(name);
}
