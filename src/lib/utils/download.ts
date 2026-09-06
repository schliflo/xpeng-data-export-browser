/**
 * Handing a file to the user.
 *
 * Nothing is fetched from anywhere: the bytes are made in the tab and offered
 * to the browser as a local object, which is why the app can write files while
 * being no more than a set of static assets.
 */

export function downloadBlob(name: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	link.rel = 'noopener';
	link.click();
	// Released on the next turn of the loop: Safari cancels a download whose
	// object URL is revoked in the same one.
	setTimeout(() => URL.revokeObjectURL(url), 0);
}
