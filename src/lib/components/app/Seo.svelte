<!--
  Per-page metadata.

  One component so every route describes itself the same way: a title, a
  description, what a crawler should do with the page, and the card a link
  preview will build. Only the landing page is worth indexing — the dashboard
  and the highlights deck render nothing until a file has been dropped in, so
  they ask to be left out of the index while staying crawlable.
-->
<script lang="ts">
	import {
		absolute,
		OG_IMAGE,
		OG_IMAGE_ALT,
		SITE_DESCRIPTION,
		SITE_NAME,
		pageTitle
	} from '$lib/seo';

	interface Props {
		/** Page title without the site name; omit for the landing page. */
		title?: string;
		description?: string;
		/** Route path, used for the canonical link. */
		path?: string;
		/** Pages that are empty without a loaded export ask not to be indexed. */
		noindex?: boolean;
	}

	let { title, description = SITE_DESCRIPTION, path = '/', noindex = false }: Props = $props();

	const fullTitle = $derived(pageTitle(title));
	const canonical = $derived(absolute(path));
	const image = $derived(absolute(OG_IMAGE) ?? OG_IMAGE);
</script>

<svelte:head>
	<title>{fullTitle}</title>
	<meta name="description" content={description} />
	<meta
		name="robots"
		content={noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large'}
	/>
	{#if canonical}
		<link rel="canonical" href={canonical} />
	{/if}

	<meta property="og:type" content="website" />
	<meta property="og:site_name" content={SITE_NAME} />
	<meta property="og:title" content={fullTitle} />
	<meta property="og:description" content={description} />
	<meta property="og:locale" content="en_GB" />
	{#if canonical}
		<meta property="og:url" content={canonical} />
	{/if}
	<meta property="og:image" content={image} />
	<meta property="og:image:type" content="image/png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content={OG_IMAGE_ALT} />

	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={fullTitle} />
	<meta name="twitter:description" content={description} />
	<meta name="twitter:image" content={image} />
	<meta name="twitter:image:alt" content={OG_IMAGE_ALT} />
</svelte:head>
