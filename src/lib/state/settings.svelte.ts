/**
 * Viewing preferences.
 *
 * Held in memory only, like everything else here. The timezone defaults to the
 * browser's, which is what makes "your day" mean the driver's day rather than
 * the warehouse partition the export was cut on.
 */

class Settings {
	/** Timezone used for every date, hour and day boundary in the app. */
	timeZone = $state(
		typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'
	);

	/** Electricity price for the cost estimates, in the chosen currency. */
	pricePerKwh = $state(0.32);
	currency = $state('EUR');

	/** The VIN is a direct identifier, so it stays hidden until asked for. */
	revealVin = $state(false);

	/** Whether to list signals the car never reported. */
	showEmptySignals = $state(false);

	formatCurrency(amount: number): string {
		if (!Number.isFinite(amount)) return '—';
		return amount.toLocaleString('en-GB', {
			style: 'currency',
			currency: this.currency,
			maximumFractionDigits: amount >= 100 ? 0 : 2
		});
	}
}

export const settings = new Settings();
