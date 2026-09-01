/**
 * Crawler instructions, generated rather than static so the sitemap can be
 * pointed at wherever this deploys. The `Sitemap:` directive only accepts an
 * absolute URL, so it appears only once a public origin has been configured.
 */

import { SITE_URL } from '$lib/seo';

export const prerender = true;

export function GET(): Response {
	const lines = [
		'# Every page here is static; the vehicle data never leaves the browser.',
		'User-agent: *',
		'Allow: /',
		'',
		'# The dashboard and the highlights deck show nothing without a loaded',
		'# export and carry a noindex tag; they stay crawlable so it is seen.'
	];
	if (SITE_URL) lines.push('', `Sitemap: ${SITE_URL}/sitemap.xml`);

	return new Response(`${lines.join('\n')}\n`, {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
}
