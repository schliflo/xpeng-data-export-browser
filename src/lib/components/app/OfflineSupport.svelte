<!--
  Says when the app has been stored for offline use, and when a newer version
  is waiting.

  SvelteKit registers the service worker itself; this only listens to it. The
  reload that applies an update is never automatic: the export lives in memory,
  and a page that restarted on its own would throw it away mid-read.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { toast } from 'svelte-sonner';

	onMount(() => {
		if (dev || !('serviceWorker' in navigator)) return;
		const container = navigator.serviceWorker;

		let reloadRequested = false;
		let registration: ServiceWorkerRegistration | undefined;

		const offerUpdate = (waiting: ServiceWorker) => {
			toast('A newer version is available', {
				description: 'Reload to use it. An export you have open will need to be dropped in again.',
				duration: Number.POSITIVE_INFINITY,
				closeButton: true,
				action: {
					label: 'Reload',
					onClick: () => {
						reloadRequested = true;
						waiting.postMessage({ type: 'SKIP_WAITING' });
					}
				}
			});
		};

		const watchInstall = (worker: ServiceWorker) => {
			worker.addEventListener('statechange', () => {
				if (worker.state === 'installed' && container.controller) offerUpdate(worker);
			});
		};

		const onUpdateFound = () => {
			if (registration?.installing) watchInstall(registration.installing);
		};

		// The new worker takes over only after the reload was asked for; other
		// tabs get the same event and must not restart on someone else's click.
		const onControllerChange = () => {
			if (reloadRequested) location.reload();
		};
		container.addEventListener('controllerchange', onControllerChange);

		(async () => {
			// A registration that already has an active worker means this is a
			// return visit, not the install that first makes the app available.
			const firstInstall = !(await container.getRegistration())?.active;

			registration = await container.ready;
			if (firstInstall) {
				toast('Ready to work offline', {
					description:
						'The app is now stored in this browser and opens without a connection. Your export is not.'
				});
			}
			if (registration.waiting) offerUpdate(registration.waiting);
			if (registration.installing) watchInstall(registration.installing);
			registration.addEventListener('updatefound', onUpdateFound);
		})();

		return () => {
			container.removeEventListener('controllerchange', onControllerChange);
			registration?.removeEventListener('updatefound', onUpdateFound);
		};
	});
</script>
