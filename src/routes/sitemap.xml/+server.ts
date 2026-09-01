/**
 * The landing page is the only page worth listing: everything else is empty
 * until someone drops their own files in. Without a configured origin there is
 * no absolute URL to publish, so the sitemap is served empty but valid.
 */

import { SITE_URL } from '$lib/seo';

export const prerender = true;

export function GET(): Response {
	const entries = SITE_URL
		? [`\t<url>\n\t\t<loc>${SITE_URL}/</loc>\n\t\t<priority>1.0</priority>\n\t</url>`]
		: [];
	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>
`;
	return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
}
