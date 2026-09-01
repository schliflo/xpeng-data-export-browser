<script lang="ts">
	import './layout.css';
	import 'uplot/dist/uPlot.min.css';
	import { ModeWatcher } from 'mode-watcher';
	import { AUTHOR, AUTHOR_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL, absolute } from '$lib/seo';

	let { children } = $props();

	// Describes the app to search engines as what it is: a free, install-free
	// tool that runs in the browser. Serialised here because Svelte will not
	// take a nested <script> tag in markup.
	const structuredData = JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'WebApplication',
		name: SITE_NAME,
		description: SITE_DESCRIPTION,
		applicationCategory: 'UtilitiesApplication',
		operatingSystem: 'Any browser',
		browserRequirements: 'Requires JavaScript and Web Workers',
		isAccessibleForFree: true,
		offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
		author: { '@type': 'Person', name: AUTHOR, url: AUTHOR_URL },
		...(SITE_URL ? { url: SITE_URL } : {}),
		...(absolute('/og.png') ? { image: absolute('/og.png') } : {})
	});
</script>

<svelte:head>
	<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
	<link rel="icon" href="/favicon.ico" sizes="32x32" />
	<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
	<link rel="manifest" href="/site.webmanifest" />
	<meta name="color-scheme" content="dark light" />
	<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
	<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#121215" />
	<meta name="author" content={AUTHOR} />
	<meta name="application-name" content={SITE_NAME} />
	{@html `<script type="application/ld+json">${structuredData}<\/script>`}
</svelte:head>

<!-- Dark by default: the charts were stepped for a dark surface first. -->
<ModeWatcher defaultMode="dark" />

{@render children()}
