import { describe, expect, it } from 'vitest';
import { fetchCacheMode, optionalFiles, pageKey, precacheList } from './precache';

describe('precacheList', () => {
	it('joins build output, static files and prerendered pages in that order', () => {
		const list = precacheList(
			['/_app/immutable/entry/start.abc.js', '/_app/immutable/assets/0.def.css'],
			['/favicon.svg', '/site.webmanifest'],
			['/', '/wrapped', '/dash/overview']
		);
		expect(list).toEqual([
			'/_app/immutable/entry/start.abc.js',
			'/_app/immutable/assets/0.def.css',
			'/favicon.svg',
			'/site.webmanifest',
			'/',
			'/wrapped',
			'/dash/overview'
		]);
	});

	it('leaves out what only crawlers and link previews fetch', () => {
		const list = precacheList(
			[],
			['/og.png', '/icon-192.png'],
			['/', '/robots.txt', '/sitemap.xml']
		);
		expect(list).toEqual(['/icon-192.png', '/']);
	});

	it('lists a path once even when several sources name it', () => {
		const list = precacheList(['/a.js', '/a.js'], ['/a.js'], ['/']);
		expect(list).toEqual(['/a.js', '/']);
	});
});

describe('optionalFiles', () => {
	it('names the public environment module SvelteKit serves at request time', () => {
		expect(optionalFiles('')).toEqual(['/_app/env.js']);
		expect(optionalFiles('/app')).toEqual(['/app/_app/env.js']);
	});

	it('is fetched afresh, since its URL never changes', () => {
		for (const path of optionalFiles('')) expect(fetchCacheMode(path, '')).toBe('reload');
	});
});

describe('fetchCacheMode', () => {
	it('lets hashed build output come from the HTTP cache', () => {
		expect(fetchCacheMode('/_app/immutable/entry/start.abc.js', '')).toBe('default');
	});

	it('refetches pages and static files, whose URLs outlive their content', () => {
		expect(fetchCacheMode('/', '')).toBe('reload');
		expect(fetchCacheMode('/dash/overview', '')).toBe('reload');
		expect(fetchCacheMode('/site.webmanifest', '')).toBe('reload');
	});

	it('honours a base path', () => {
		expect(fetchCacheMode('/app/_app/immutable/x.js', '/app')).toBe('default');
		expect(fetchCacheMode('/_app/immutable/x.js', '/app')).toBe('reload');
	});
});

describe('pageKey', () => {
	it('strips a trailing slash, the query string and the fragment', () => {
		expect(pageKey(new URL('https://example.test/dash/overview/?tab=1#top'))).toBe(
			'/dash/overview'
		);
	});

	it('leaves a clean path alone', () => {
		expect(pageKey(new URL('https://example.test/wrapped'))).toBe('/wrapped');
	});

	it('keeps the root as a single slash', () => {
		expect(pageKey(new URL('https://example.test/'))).toBe('/');
		expect(pageKey(new URL('https://example.test/?utm=1'))).toBe('/');
	});

	it('matches the root of a deployment under a base path', () => {
		expect(pageKey(new URL('https://example.test/app/'))).toBe('/app');
	});
});
