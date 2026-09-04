/**
 * What the service worker keeps, and how it finds it again.
 *
 * Kept apart from the worker itself so the decisions can be unit-tested: the
 * worker file sits outside the type-checked project, and a mistake in it only
 * shows up in a browser with the network switched off.
 */

/** Files only crawlers and link previews ever ask for; the app never does. */
const CRAWLER_ONLY = /\/(og\.png|robots\.txt|sitemap\.xml)$/;

/**
 * Everything worth having before the connection goes: the hashed build output,
 * the static files and the prerendered pages, minus what only search engines
 * and link previews fetch.
 */
export function precacheList(build: string[], files: string[], prerendered: string[]): string[] {
	const wanted = [...build, ...files, ...prerendered].filter((path) => !CRAWLER_ONLY.test(path));
	return Array.from(new Set(wanted));
}

/**
 * What SvelteKit serves at request time rather than from the build, so it
 * appears in none of the lists above: the public environment, which a client
 * imports on start when any page reads `$env/dynamic/public`. It exists only
 * in that case, so its absence must not fail an install.
 */
export function optionalFiles(base: string): string[] {
	return [`${base}/_app/env.js`];
}

/** Where the hashed build output lives. Its URLs change whenever the content does. */
export function immutablePrefix(base: string): string {
	return `${base}/_app/immutable/`;
}

/**
 * How to fetch an entry when filling the store. Hashed files may come from the
 * HTTP cache, since a new version means a new URL. Everything else keeps its
 * URL between versions and is fetched afresh: a stale `index.html` handed over
 * by the HTTP cache would point at chunks this version no longer has.
 */
export function fetchCacheMode(path: string, base: string): RequestCache {
	return path.startsWith(immutablePrefix(base)) ? 'default' : 'reload';
}

/**
 * The key a page navigation looks up. Prerendered pages are stored under their
 * clean path, so a trailing slash, query string or fragment must not stop
 * `/dash/overview/?tab=1` from finding `/dash/overview`.
 */
export function pageKey(url: URL): string {
	const path = url.pathname.replace(/\/+$/, '');
	return path === '' ? '/' : path;
}
