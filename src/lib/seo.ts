/**
 * Everything the pages need to describe themselves to crawlers and to the
 * cards that link previews build.
 *
 * The public origin cannot be known at build time — the same bundle deploys to
 * a workers.dev subdomain or a custom domain — so it comes from
 * `PUBLIC_SITE_URL` when the build sets it. Without it the tags that require an
 * absolute URL are simply left out, and the social image is referenced by path,
 * which every major scraper resolves against the page it found it on.
 */

import { env } from '$env/dynamic/public';

export const SITE_NAME = 'XPeng Data Export Browser';

export const SITE_DESCRIPTION =
	'Explore a month of trips, charging, battery health and driving style from your XPeng EU Data Act export. Processed in your browser — nothing is uploaded.';

export const OG_IMAGE = '/og.png';

export const OG_IMAGE_ALT =
	'XPeng Data Export Browser: read the month your car quietly recorded, with a speed trace across the foot of the card.';

export const AUTHOR = 'schliflo';
export const AUTHOR_URL = 'https://github.com/schliflo';

/** Configured public origin, without a trailing slash, or an empty string. */
export const SITE_URL = (env.PUBLIC_SITE_URL ?? '').replace(/\/+$/, '');

/** Absolute URL for a path, or null when the origin was never configured. */
export function absolute(path: string): string | null {
	if (!SITE_URL) return null;
	return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Page title, suffixed with the site name unless it already is the name. */
export function pageTitle(title?: string): string {
	if (!title || title === SITE_NAME) return `${SITE_NAME} — explore your car's data export`;
	return `${title} · ${SITE_NAME}`;
}
