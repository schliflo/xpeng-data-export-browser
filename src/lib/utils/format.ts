/**
 * Display formatting.
 *
 * Two things need care. The export stores everything as floats, so values
 * arrive with binary noise (`10.100000000000001`) that must never reach the
 * screen. And every date shown has to be rendered in the viewer's timezone,
 * never the file's.
 */

import { settings } from '../state/settings.svelte';

export function num(value: number, digits = 0): string {
	if (!Number.isFinite(value)) return '—';
	return value.toLocaleString('en-GB', {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	});
}

/** Rounds to the precision the signal actually has, then formats. */
export function measure(value: number, unit: string, digits = 0): string {
	if (!Number.isFinite(value)) return '—';
	return `${num(value, digits)}${unit ? ` ${unit}` : ''}`;
}

export function duration(seconds: number, style: 'long' | 'short' = 'long'): string {
	if (!Number.isFinite(seconds) || seconds < 0) return '—';
	const total = Math.round(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	if (hours === 0) {
		if (minutes === 0) return `${total} s`;
		return style === 'short' ? `${minutes}m` : `${minutes} min`;
	}
	if (style === 'short') return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
	return `${hours} h ${minutes.toString().padStart(2, '0')} min`;
}

/** Days, for spans long enough that hours stop being useful. */
export function longDuration(seconds: number): string {
	if (!Number.isFinite(seconds)) return '—';
	const days = Math.floor(seconds / 86400);
	if (days < 1) return duration(seconds);
	const hours = Math.round((seconds % 86400) / 3600);
	return `${days} d ${hours} h`;
}

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `${settings.timeZone}|${JSON.stringify(options)}`;
	let found = cache.get(key);
	if (!found) {
		found = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: settings.timeZone });
		cache.set(key, found);
	}
	return found;
}

export function dateTime(epochSeconds: number): string {
	return formatter({
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	}).format(new Date(epochSeconds * 1000));
}

export function fullDateTime(epochSeconds: number): string {
	return formatter({
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	}).format(new Date(epochSeconds * 1000));
}

export function timeOnly(epochSeconds: number): string {
	return formatter({ hour: '2-digit', minute: '2-digit', hour12: false }).format(
		new Date(epochSeconds * 1000)
	);
}

export function dateOnly(epochSeconds: number): string {
	return formatter({ day: 'numeric', month: 'short', year: 'numeric' }).format(
		new Date(epochSeconds * 1000)
	);
}

/** `YYYY-MM-DD` rendered for reading. */
export function prettyDay(dayKey: string): string {
	const [year, month, day] = dayKey.split('-').map(Number);
	return new Intl.DateTimeFormat('en-GB', {
		weekday: 'short',
		day: 'numeric',
		month: 'short'
	}).format(new Date(Date.UTC(year, month - 1, day)));
}

export function hourLabel(hour: number): string {
	return `${hour.toString().padStart(2, '0')}:00`;
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Shows enough of the VIN to recognise it without publishing it. */
export function maskVin(vin: string): string {
	if (vin.length < 8) return vin;
	return `${vin.slice(0, 4)} … ${vin.slice(-4)}`;
}

export function bytes(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return '—';
	const units = ['B', 'kB', 'MB', 'GB'];
	let value = count;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${num(value, value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export function percent(fraction: number, digits = 0): string {
	if (!Number.isFinite(fraction)) return '—';
	return `${num(fraction * 100, digits)}%`;
}
