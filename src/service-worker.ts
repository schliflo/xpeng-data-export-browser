/// <reference types="@sveltejs/kit" />
/// <reference types="vite/client" />
/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />

/**
 * Keeps the app itself available without a connection.
 *
 * Every file the app is made of — the hashed build output, the static files
 * and the prerendered pages, about a megabyte and a half in all — is stored
 * when a version of this worker installs, and served from that store from
 * then on. No telemetry is ever part of it: kept exports live in the browser's
 * database instead, which is what makes them survive a new deployment.
 *
 * A newer build ships a new worker with a new store name. It installs in the
 * background and waits; the page offers a reload, and only once that is taken
 * does it take over and clear the old store. Taking over unasked would restart
 * every open tab, and the export on screen in each of them is held in memory.
 */

import { base, build, files, prerendered, version } from '$service-worker';
import {
	fetchCacheMode,
	immutablePrefix,
	optionalFiles,
	pageKey,
	precacheList
} from '$lib/offline/precache';

const sw = self as unknown as ServiceWorkerGlobalScope;

const STORE = `app-${version}`;
const PRECACHE = precacheList(build, files, prerendered);
const OPTIONAL = optionalFiles(base);
const KNOWN = new Set([...PRECACHE, ...OPTIONAL]);
const IMMUTABLE = immutablePrefix(base);

// The dev server serves everything live and nothing is prerendered, so the
// worker registers but stays out of the way.
const DEV = import.meta.env.DEV;

sw.addEventListener('install', (event) => {
	if (DEV) return;
	event.waitUntil(fill());
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key !== STORE) await caches.delete(key);
			}
			await sw.clients.claim();
		})()
	);
});

sw.addEventListener('message', (event) => {
	if (event.data?.type === 'SKIP_WAITING') sw.skipWaiting();
});

sw.addEventListener('fetch', (event) => {
	if (DEV) return;
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== sw.location.origin) return;

	if (request.mode === 'navigate') {
		event.respondWith(page(url, request));
	} else if (KNOWN.has(url.pathname) || url.pathname.startsWith(IMMUTABLE)) {
		event.respondWith(asset(url, request));
	}
	// Anything else — SvelteKit's version check, for one — goes to the network
	// exactly as it would without a worker.
});

/**
 * Fetches every file of this build and stores it. Any failure fails the
 * install, and the browser tries again on a later visit; only a file that
 * simply does not exist is allowed to be missing.
 */
async function fill() {
	const cache = await caches.open(STORE);
	await Promise.all([
		...PRECACHE.map((path) => store(cache, path, false)),
		...OPTIONAL.map((path) => store(cache, path, true))
	]);
}

async function store(cache: Cache, path: string, optional: boolean) {
	const response = await fetch(path, { cache: fetchCacheMode(path, base) });
	if (optional && response.status === 404) return;
	if (!response.ok) throw new Error(`Could not store ${path} (${response.status})`);
	await cache.put(path, storable(response));
}

/**
 * A page: from the store, else the network, else the landing page — where the
 * app's own router takes over, and where a deep link ends up anyway once the
 * data it needs is gone from memory.
 */
async function page(url: URL, request: Request): Promise<Response> {
	const cache = await caches.open(STORE);
	const stored = await cache.match(pageKey(url));
	if (stored) return stored;
	try {
		return await fetch(request);
	} catch (error) {
		const landing = await cache.match(pageKey(new URL(`${base}/`, url)));
		if (landing) return landing;
		throw error;
	}
}

/**
 * A file of this build: from the store, else fetched and kept. A hashed file
 * never changes under its URL, so keeping it can never serve something stale.
 */
async function asset(url: URL, request: Request): Promise<Response> {
	const cache = await caches.open(STORE);
	const stored = await cache.match(url.pathname);
	if (stored) return stored;
	const response = await fetch(request);
	if (response.ok) await cache.put(url.pathname, storable(response.clone()));
	return response;
}

/**
 * A response the browser will accept for a navigation later. One that arrived
 * through a redirect is refused for navigations when replayed from a cache,
 * so it is copied into a plain response first.
 */
function storable(response: Response): Response {
	return response.redirected ? new Response(response.body, response) : response;
}
