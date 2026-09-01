/**
 * The column registry: one declarative table that drives parsing, storage,
 * sentinel filtering, unit display and charting for every signal in the export.
 *
 * Values are stored as integers in typed arrays and reconstructed as
 * `raw * scale + offset`. Each dtype reserves one code to mean "no value";
 * because the reserved codes sit outside every signal's real range, nulls
 * survive the round-trip without a separate mask.
 *
 * `sentinels` lists source values that are CAN "signal not available" markers
 * rather than measurements. They are mapped to null at parse time — leaving
 * them in makes charts unreadable (a 255 km/h plateau, a 1638 km range spike).
 */

import type { StreamId } from './streams';

export type Dtype = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'f32';

export type ColumnCategory =
	'identity' | 'motion' | 'driver' | 'battery' | 'motor' | 'thermal' | 'body' | 'tyres';

export interface ColumnSpec {
	/** Column name exactly as it appears in the CSV header. */
	key: string;
	stream: StreamId;
	dtype: Dtype;
	/** physical = raw * scale + offset */
	scale: number;
	offset: number;
	sentinels: number[];
	unit: string;
	label: string;
	category: ColumnCategory;
	/** Discrete value labels, e.g. gear positions. */
	enumLabels?: Record<number, string>;
	/** Rendering hint for the explorer. */
	step?: boolean;
	description?: string;
}

/** Reserved "no value" code per dtype. Chosen outside every real signal range. */
export const NULL_CODE: Record<Dtype, number> = {
	u8: 255,
	i8: -128,
	u16: 65535,
	i16: -32768,
	u32: 4294967295,
	f32: NaN
};

export const DTYPE_CTOR: Record<Dtype, new (n: number) => TypedArray> = {
	u8: Uint8Array,
	i8: Int8Array,
	u16: Uint16Array,
	i16: Int16Array,
	u32: Uint32Array,
	f32: Float32Array
};

export type TypedArray =
	Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Float32Array;

/** Columns present in every stream; stored once on the dataset, not per stream. */
export const KEY_COLUMNS = ['vin', 'vmodel', 'timer', 'ds'] as const;

export const GEAR_LABELS: Record<number, string> = {
	1: 'D',
	2: 'N',
	3: 'R',
	4: 'P'
};

export const GEAR = { DRIVE: 1, NEUTRAL: 2, REVERSE: 3, PARK: 4 } as const;

const COLUMN_LIST: ColumnSpec[] = [
	// ── operation: motion ──────────────────────────────────────────────────
	{
		key: 'esp_vehspd',
		stream: 'operation',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		// 255 means the ESP module is asleep, not 255 km/h.
		sentinels: [255],
		unit: 'km/h',
		label: 'Speed',
		category: 'motion'
	},
	{
		// Stored as raw CAN quanta so the 0.002768 g resolution is exact.
		key: 'esp_vehlongaccel',
		stream: 'operation',
		dtype: 'i16',
		scale: 0.002768,
		offset: 0,
		sentinels: [],
		unit: 'g',
		label: 'Longitudinal g',
		category: 'motion',
		description: 'Positive accelerates, negative brakes.'
	},
	{
		key: 'esp_vehlateralaccel',
		stream: 'operation',
		dtype: 'i16',
		scale: 0.002768,
		offset: 0,
		sentinels: [],
		unit: 'g',
		label: 'Lateral g',
		category: 'motion'
	},
	{
		key: 'cdcu_totalodometer',
		stream: 'operation',
		dtype: 'u32',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: 'km',
		label: 'Odometer',
		category: 'motion',
		step: true
	},
	// ── operation: driver inputs ───────────────────────────────────────────
	{
		key: 'eps_steeringangle',
		stream: 'operation',
		dtype: 'i16',
		scale: 0.1,
		offset: 0,
		sentinels: [2496.7],
		unit: '°',
		label: 'Steering angle',
		category: 'driver'
	},
	{
		key: 'eps_steeringanglespd',
		stream: 'operation',
		dtype: 'i16',
		scale: 1,
		offset: 0,
		sentinels: [31751],
		unit: '°/s',
		label: 'Steering rate',
		category: 'driver'
	},
	{
		key: 'ldcu_accpedalsig',
		stream: 'operation',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '%',
		label: 'Accelerator',
		category: 'driver'
	},
	{
		key: 'ldcu_brkpedalst',
		stream: 'operation',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '',
		label: 'Brake pedal',
		category: 'driver',
		enumLabels: { 0: 'Released', 1: 'Pressed' },
		step: true
	},
	{
		key: 'ldcu_currentgearlev',
		stream: 'operation',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '',
		label: 'Gear',
		category: 'driver',
		enumLabels: GEAR_LABELS,
		step: true,
		description: 'Encoded 1=D, 2=N, 3=R, 4=P — not the physical lever order.'
	},

	// ── power: motors (front pair is empty on RWD cars, populated on AWD) ──
	{
		key: 'ipuf_actrotspd',
		stream: 'power',
		dtype: 'i16',
		scale: 1,
		offset: 0,
		sentinels: [49535],
		unit: 'rpm',
		label: 'Front motor speed',
		category: 'motor'
	},
	{
		key: 'ipur_actrotspd',
		stream: 'power',
		dtype: 'i16',
		scale: 1,
		offset: 0,
		sentinels: [49535],
		unit: 'rpm',
		label: 'Rear motor speed',
		category: 'motor'
	},
	{
		key: 'ipuf_acttorq',
		stream: 'power',
		dtype: 'i16',
		scale: 0.25,
		offset: 0,
		sentinels: [],
		unit: 'Nm',
		label: 'Front motor torque',
		category: 'motor'
	},
	{
		key: 'ipur_acttorq',
		stream: 'power',
		dtype: 'i16',
		scale: 0.25,
		offset: 0,
		sentinels: [],
		unit: 'Nm',
		label: 'Rear motor torque',
		category: 'motor',
		description: 'Negative means regenerative braking.'
	},
	{
		key: 'ipuf_rotoracttemp',
		stream: 'power',
		dtype: 'i16',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '°C',
		label: 'Front rotor temp',
		category: 'thermal'
	},
	{
		key: 'ipur_rotoracttemp',
		stream: 'power',
		dtype: 'i16',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '°C',
		label: 'Rear rotor temp',
		category: 'thermal'
	},
	// ── power: battery ─────────────────────────────────────────────────────
	{
		key: 'bms_battvolt',
		stream: 'power',
		dtype: 'u16',
		scale: 0.1,
		offset: 0,
		sentinels: [1023],
		unit: 'V',
		label: 'Pack voltage',
		category: 'battery'
	},
	{
		// ±3276 A of headroom so 300 kW DC fast charging fits.
		key: 'bms_battcurr',
		stream: 'power',
		dtype: 'i16',
		scale: 0.1,
		offset: 0,
		sentinels: [1676.7],
		unit: 'A',
		label: 'Pack current',
		category: 'battery',
		description: 'Positive discharges, negative charges.'
	},
	{
		key: 'ldcu_chrgpwr',
		stream: 'power',
		dtype: 'u16',
		scale: 0.1,
		offset: 0,
		sentinels: [1638.3],
		unit: 'kW',
		label: 'Charging power',
		category: 'battery',
		description: 'Non-zero only while plugged in; regen never appears here.'
	},
	{
		key: 'ldcu_bms_soc_disp',
		stream: 'power',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [255],
		unit: '%',
		label: 'State of charge',
		category: 'battery'
	},
	{
		key: 'ldcu_dstbatdisp_dynamic',
		stream: 'power',
		dtype: 'u16',
		scale: 0.1,
		offset: 0,
		sentinels: [1638.3],
		unit: 'km',
		label: 'Estimated range',
		category: 'battery'
	},
	// ── power: pack thermal ────────────────────────────────────────────────
	{
		key: 'bms_batttempmax_gb',
		stream: 'power',
		dtype: 'i16',
		scale: 1,
		offset: 0,
		sentinels: [215, -40],
		unit: '°C',
		label: 'Pack temp max',
		category: 'thermal'
	},
	{
		key: 'bms_batttempmin_gb',
		stream: 'power',
		dtype: 'i16',
		scale: 1,
		offset: 0,
		sentinels: [215, -40],
		unit: '°C',
		label: 'Pack temp min',
		category: 'thermal'
	},
	{
		key: 'bms_celltempmaxnum_gb',
		stream: 'power',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [63],
		unit: '',
		label: 'Hottest sensor #',
		category: 'thermal',
		step: true,
		description: 'A sensor index, not a temperature.'
	},
	{
		key: 'bms_celltempminnum_gb',
		stream: 'power',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [63],
		unit: '',
		label: 'Coldest sensor #',
		category: 'thermal',
		step: true,
		description: 'A sensor index, not a temperature.'
	},

	// ── status: doors ──────────────────────────────────────────────────────
	{
		key: 'ldcu_driverdoorajarst',
		stream: 'status',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '',
		label: 'Driver door',
		category: 'body',
		enumLabels: { 0: 'Closed', 1: 'Open' },
		step: true
	},
	{
		key: 'rdcu_psngrdoorajarst',
		stream: 'status',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '',
		label: 'Passenger door',
		category: 'body',
		enumLabels: { 0: 'Closed', 1: 'Open' },
		step: true
	},
	{
		key: 'ldcu_rldoorajarst',
		stream: 'status',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '',
		label: 'Rear left door',
		category: 'body',
		enumLabels: { 0: 'Closed', 1: 'Open' },
		step: true
	},
	{
		key: 'rdcu_rrdoorajarst',
		stream: 'status',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '',
		label: 'Rear right door',
		category: 'body',
		enumLabels: { 0: 'Closed', 1: 'Open' },
		step: true
	},
	// ── status: windows and tailgate (empty on the sample car) ─────────────
	{
		key: 'ldcu_flwinposstfb',
		stream: 'status',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '%',
		label: 'Front left window',
		category: 'body'
	},
	{
		key: 'frwinposstfb',
		stream: 'status',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '%',
		label: 'Front right window',
		category: 'body'
	},
	{
		key: 'ldcu_rlwinposstfb',
		stream: 'status',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '%',
		label: 'Rear left window',
		category: 'body'
	},
	{
		key: 'rrwinposstfb',
		stream: 'status',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '%',
		label: 'Rear right window',
		category: 'body'
	},
	{
		key: 'rdm_tropenersts',
		stream: 'status',
		dtype: 'u8',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '',
		label: 'Tailgate opener',
		category: 'body',
		step: true
	},
	// ── status: tyre pressures ─────────────────────────────────────────────
	// Quantised to 2.75 kPa steps. 0 and 701.25 are "no reading" markers.
	...(
		[
			['ldcu_tpmsprfl', 'Front left tyre'],
			['ldcu_tpmsprfr', 'Front right tyre'],
			['ldcu_tpmsprrl', 'Rear left tyre'],
			['ldcu_tpmsprrr', 'Rear right tyre']
		] as const
	).map(([key, label]): ColumnSpec => ({
		key,
		stream: 'status',
		dtype: 'u16',
		scale: 0.25,
		offset: 0,
		sentinels: [0, 701.25],
		unit: 'kPa',
		label,
		category: 'tyres'
	}))
];

export const COLUMNS: ReadonlyMap<string, ColumnSpec> = new Map(
	COLUMN_LIST.map((spec) => [spec.key, spec])
);

export function columnsForStream(stream: StreamId): ColumnSpec[] {
	return COLUMN_LIST.filter((spec) => spec.stream === stream);
}

/**
 * Spec for a column the registry does not know about. Foreign exports (other
 * models, newer firmware) keep working: unknown signals are stored as f32 and
 * remain fully explorable, just without units or sentinel handling.
 */
export function unknownColumnSpec(key: string, stream: StreamId): ColumnSpec {
	return {
		key,
		stream,
		dtype: 'f32',
		scale: 1,
		offset: 0,
		sentinels: [],
		unit: '',
		label: key,
		category: 'identity',
		description: 'Not in the known signal registry — shown as reported.'
	};
}

export const CATEGORY_LABELS: Record<ColumnCategory, string> = {
	identity: 'Other',
	motion: 'Motion',
	driver: 'Driver input',
	battery: 'Battery',
	motor: 'Motors',
	thermal: 'Temperatures',
	body: 'Doors & windows',
	tyres: 'Tyres'
};
