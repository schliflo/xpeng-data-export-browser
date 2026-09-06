/**
 * The narrative layer.
 *
 * Everything else in `analytics/` measures the car. This module decides what is
 * worth saying about it: the headline numbers for the opening sequence, and the
 * observations a reader would not have gone looking for — what the data reveals
 * about the household's routine, and what the export quietly leaves out.
 *
 * Each fact carries a headline value and a route, so a card can double as a way
 * into the section that explains it.
 */

import { COLUMNS } from '../schema/columns';
import type { Dataset } from '../store/columnar';
import type { Trip } from './trips';
import type { ChargingHabits } from './charging';
import type { DayBucket } from './daily';
import type { PhantomDrain, RangeEstimate, PackThermal } from './battery';
import type { DoorActivity, TyreTrend } from './doorsTyres';
import type { SpeedProfile, ExtremeEvent } from './drivingStyle';
import { localParts } from './daily';

export type FactTone = 'headline' | 'habit' | 'quirk' | 'privacy';

export interface Fact {
	id: string;
	tone: FactTone;
	/** Short label above the number. */
	kicker: string;
	/** The number itself, already formatted. */
	value: string;
	unit?: string;
	/** One or two sentences of context. */
	detail: string;
	/** Where to go to see the underlying data. */
	href?: string;
	timestamp?: number;
}

export interface FactInputs {
	dataset: Dataset;
	trips: Trip[];
	charging: ChargingHabits;
	days: DayBucket[];
	drain: PhantomDrain;
	range: RangeEstimate;
	thermal: PackThermal;
	doors: DoorActivity;
	tyres: TyreTrend;
	speed: SpeedProfile;
	hardestBrakes: ExtremeEvent[];
	timeZone: string;
	/** Seconds the exports account for — never the calendar span. */
	recordedSeconds: number;
	/** Calendar days the exports account for. */
	recordedDays: number;
	/** Exports behind these numbers; more than one means a merged record. */
	sources: number;
}

const nf = (value: number, digits = 0) =>
	Number.isFinite(value)
		? value.toLocaleString('en-GB', {
				minimumFractionDigits: digits,
				maximumFractionDigits: digits
			})
		: '—';

function duration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return '—';
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.round((seconds % 3600) / 60);
	if (hours === 0) return `${minutes} min`;
	return `${hours} h ${minutes.toString().padStart(2, '0')} min`;
}

function dayName(index: number): string {
	return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][index];
}

function formatTime(epochSeconds: number, timeZone: string): string {
	return new Intl.DateTimeFormat('en-GB', {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
		timeZone
	}).format(new Date(epochSeconds * 1000));
}

function hourLabel(hour: number): string {
	return `${hour.toString().padStart(2, '0')}:00`;
}

/** The opening sequence: the numbers that describe the record at a glance. */
export function headlineFacts(input: FactInputs): Fact[] {
	const { trips, days, charging, speed, timeZone, recordedSeconds, recordedDays, sources } = input;
	const facts: Fact[] = [];

	const totalKm = days.reduce((sum, day) => sum + day.distanceKm, 0);
	const drivingSeconds = trips.reduce((sum, trip) => sum + trip.movingSeconds, 0);

	if (totalKm > 0) {
		facts.push({
			id: 'distance',
			tone: 'headline',
			kicker:
				sources > 1
					? `Across ${sources} exports, in ${recordedDays} days you drove`
					: `In ${recordedDays} days you drove`,
			value: nf(totalKm),
			unit: 'km',
			detail: `Across ${trips.length} trips, averaging ${nf(totalKm / Math.max(1, recordedDays), 1)} km a day.`,
			href: '/dash/overview'
		});
	}

	if (drivingSeconds > 0) {
		const share = (drivingSeconds / recordedSeconds) * 100;
		facts.push({
			id: 'time-driving',
			tone: 'headline',
			kicker: 'Time behind the wheel',
			value: duration(drivingSeconds),
			detail: `That is ${nf(share, 1)}% of the time recorded. The car spent the rest of it parked.`,
			href: '/dash/trips'
		});
	}

	if (speed.maxSpeed > 0) {
		facts.push({
			id: 'top-speed',
			tone: 'headline',
			kicker: 'Your top speed',
			value: nf(speed.maxSpeed),
			unit: 'km/h',
			detail: `Reached on ${formatTime(speed.maxSpeedTime, timeZone)}.`,
			href: '/dash/driving',
			timestamp: speed.maxSpeedTime
		});
	}

	const longest = trips.reduce<Trip | null>(
		(best, trip) => (!best || trip.distanceKm > best.distanceKm ? trip : best),
		null
	);
	if (longest && Number.isFinite(longest.distanceKm)) {
		facts.push({
			id: 'longest-trip',
			tone: 'headline',
			kicker: 'Longest single trip',
			value: nf(longest.distanceKm),
			unit: 'km',
			detail: `${duration(longest.duration)} on ${formatTime(longest.startTime, timeZone)}.`,
			href: `/dash/trips?trip=${longest.index}`,
			timestamp: longest.startTime
		});
	}

	const brake = input.hardestBrakes[0];
	if (brake) {
		facts.push({
			id: 'hardest-brake',
			tone: 'headline',
			kicker: 'Hardest braking moment',
			value: nf(Math.abs(brake.value), 2),
			unit: 'g',
			detail: Number.isFinite(brake.speed)
				? `From ${nf(brake.speed)} km/h on ${formatTime(brake.time, timeZone)}. Anything past 0.6 g is an emergency stop.`
				: `On ${formatTime(brake.time, timeZone)}.`,
			href: '/dash/driving',
			timestamp: brake.time
		});
	}

	if (charging.totalKwh > 0) {
		facts.push({
			id: 'energy-charged',
			tone: 'headline',
			kicker: 'Energy you put in',
			value: nf(charging.totalKwh),
			unit: 'kWh',
			detail: `Over ${charging.sessions.length} charging sessions.`,
			href: '/dash/charging'
		});
	}

	return facts;
}

/** Patterns in how the car is used — the "you didn't know you did this" layer. */
export function habitFacts(input: FactInputs): Fact[] {
	const { trips, charging, days, doors, drain, range, timeZone } = input;
	const facts: Fact[] = [];

	if (trips.length >= 4) {
		const hours = new Array(24).fill(0);
		for (const trip of trips) hours[localParts(trip.startTime, timeZone).hour]++;
		let peak = 0;
		for (let h = 1; h < 24; h++) if (hours[h] > hours[peak]) peak = h;

		const departures = trips
			.map((trip) => localParts(trip.startTime, timeZone).hour)
			.sort((a, b) => a - b);
		const earliest = departures[0];
		const latest = departures[departures.length - 1];

		facts.push({
			id: 'departure-rhythm',
			tone: 'habit',
			kicker: 'You usually set off at',
			value: hourLabel(peak),
			detail: `${hours[peak]} of your ${trips.length} trips started in this hour. Your earliest was ${hourLabel(earliest)} and your latest ${hourLabel(latest)}.`,
			href: '/dash/overview'
		});

		// A commuter shows two peaks a working day apart; anything else is not.
		const morning = hours.slice(5, 10).reduce((a, b) => a + b, 0);
		const evening = hours.slice(15, 20).reduce((a, b) => a + b, 0);
		if (morning >= 5 && evening >= 5 && morning + evening > trips.length * 0.5) {
			facts.push({
				id: 'commute-shape',
				tone: 'habit',
				kicker: 'Trips that look like a commute',
				value: `${morning + evening}`,
				unit: `of ${trips.length}`,
				detail:
					'Two clear peaks — mornings out, evenings back — with quiet hours in between. The shape of a working week is visible in the data without anyone recording where you went.',
				href: '/dash/overview'
			});
		}
	}

	if (charging.scheduledHour !== null) {
		facts.push({
			id: 'scheduled-charging',
			tone: 'habit',
			kicker: 'Your charging starts at',
			value: hourLabel(charging.scheduledHour),
			detail: `${charging.scheduledCount} sessions began in that hour. That regularity means a charging timer, not a habit — most likely a cheap overnight tariff.`,
			href: '/dash/charging'
		});
	} else if (charging.sessions.length >= 5 && charging.plugInHour !== null) {
		facts.push({
			id: 'plug-in-habit',
			tone: 'habit',
			kicker: 'You plug in most often at',
			value: hourLabel(charging.plugInHour),
			detail: `${charging.plugInCount} of ${charging.sessions.length} sessions started around then. Spread across the day rather than fixed to one time, so this is a habit rather than a timer.`,
			href: '/dash/charging'
		});
	}

	if (charging.chargeLimit !== null) {
		facts.push({
			id: 'charge-limit',
			tone: 'habit',
			kicker: 'You stop charging at',
			value: `${charging.chargeLimit}`,
			unit: '%',
			detail:
				'Repeatedly stopping at the same point means a charge limit is set in the car. Keeping a lithium pack below full is the single easiest thing you can do for its lifespan.',
			href: '/dash/charging'
		});
	}

	if (charging.sessions.length > 0 && charging.dcSessions === 0) {
		const maxKw = Math.max(...charging.sessions.map((s) => s.maxKw));
		facts.push({
			id: 'ac-only',
			tone: 'habit',
			kicker: 'You never fast-charged',
			value: nf(maxKw, 1),
			unit: 'kW peak',
			detail:
				'Every session in this window ran through the onboard AC charger. The car is capable of far more, but it never needed it — a sign your charging fits comfortably into time spent parked.',
			href: '/dash/charging'
		});
	}

	const idleDays = days.filter((day) => day.covered && day.distanceKm === 0);
	if (idleDays.length > 0) {
		facts.push({
			id: 'idle-days',
			tone: 'habit',
			kicker: 'Days the car never moved',
			value: `${idleDays.length}`,
			detail: `${idleDays
				.map((d) => d.date)
				.slice(0, 5)
				.join(
					', '
				)}${idleDays.length > 5 ? ' and more' : ''}. A parked car still writes a full second-by-second log.`,
			href: '/dash/overview'
		});
	}

	const busiest = days.reduce<DayBucket | null>(
		(best, day) => (!best || day.distanceKm > best.distanceKm ? day : best),
		null
	);
	if (busiest && busiest.distanceKm > 0) {
		facts.push({
			id: 'busiest-day',
			tone: 'habit',
			kicker: 'Your busiest day',
			value: nf(busiest.distanceKm),
			unit: 'km',
			detail: `${busiest.date}, with ${busiest.trips} trips and ${duration(busiest.drivingSeconds)} of driving.`,
			href: '/dash/overview'
		});
	}

	if (Number.isFinite(drain.medianPercentPerDay) && drain.events.length > 2) {
		facts.push({
			id: 'phantom-drain',
			tone: 'habit',
			kicker: 'Charge lost while parked',
			value: nf(drain.medianPercentPerDay, 1),
			unit: '%/day',
			detail: `Measured across ${drain.events.length} periods where the car sat untouched. Even asleep, it keeps its systems alive.`,
			href: '/dash/battery'
		});
	}

	if (Number.isFinite(range.medianFullRange)) {
		facts.push({
			id: 'implied-range',
			tone: 'habit',
			kicker: 'Your real full-charge range',
			value: nf(range.medianFullRange),
			unit: 'km',
			detail: `Extrapolated from what the car itself predicts. It ranged between ${nf(range.minFullRange)} and ${nf(range.maxFullRange)} km depending on weather and how you were driving.`,
			href: '/dash/battery'
		});
	}

	if (doors.events.length > 0) {
		const quiet = doors.quietStretch;
		facts.push({
			id: 'door-rhythm',
			tone: 'habit',
			kicker: 'Doors opened',
			value: nf(doors.events.length),
			unit: 'times',
			detail: `Busiest at ${hourLabel(doors.busiestHour)}${
				quiet && quiet.hours >= 3
					? `, and not once in the ${quiet.hours} hours between ${hourLabel(quiet.from)} and ${hourLabel(quiet.to)}`
					: ''
			}. Every entry and exit is timestamped to the second.`,
			href: '/dash/doors-tyres'
		});
	}

	return facts;
}

/**
 * What the export itself reveals — about its own construction, and about how
 * much of the car's life it records.
 */
export function quirkFacts(input: FactInputs): Fact[] {
	const { dataset, tyres, thermal, timeZone, recordedSeconds } = input;
	const facts: Fact[] = [];

	const coverage = (dataset.time.length / recordedSeconds) * 100;
	facts.push({
		id: 'sample-count',
		tone: 'quirk',
		kicker: 'Moments recorded',
		value: nf(dataset.time.length),
		detail: `One sample per second, covering ${nf(coverage)}% of the time recorded. The gaps are when the car was asleep — it stops logging rather than recording zeros.`,
		href: '/dash/explorer'
	});

	if (dataset.emptyColumns.length > 0) {
		const labels = dataset.emptyColumns.map((key) => COLUMNS.get(key)?.label ?? key).slice(0, 4);
		facts.push({
			id: 'empty-columns',
			tone: 'quirk',
			kicker: 'Signals recorded as blank',
			value: `${dataset.emptyColumns.length}`,
			detail: `${labels.join(', ')}${dataset.emptyColumns.length > labels.length ? ' and others' : ''} appear in every row of the file and are empty in all of them. The export uses one schema for the whole fleet, so your car simply has nothing to say in these columns.`,
			href: '/dash/explorer'
		});
	}

	if (dataset.duplicateRows > 0) {
		facts.push({
			id: 'duplicate-rows',
			tone: 'quirk',
			kicker: 'Rows delivered twice',
			value: nf(dataset.duplicateRows),
			detail:
				'Identical rows repeated back to back — the fingerprint of a data pipeline that replays batches when it is unsure a delivery succeeded. Counting them as real would inflate every total.',
			href: '/dash/privacy'
		});
	}

	facts.push({
		id: 'beijing-time',
		tone: 'quirk',
		kicker: 'Your day starts at',
		value: '18:00',
		detail:
			'The file carries a date column alongside each timestamp, and it rolls over at midnight in Beijing — early evening where you are. Grouped by that column, an evening drive lands on the next day. This app ignores it and works from the timestamps.',
		href: '/dash/privacy'
	});

	if (Number.isFinite(thermal.maxSpread) && thermal.maxSpread > 0) {
		facts.push({
			id: 'pack-spread',
			tone: 'quirk',
			kicker: 'Widest temperature spread',
			value: nf(thermal.maxSpread),
			unit: '°C',
			detail: `Between the warmest and coolest part of the battery, on ${formatTime(thermal.maxSpreadTime, timeZone)}. The pack reports which sensor was which — but not where in the car they sit.`,
			href: '/dash/battery'
		});
	}

	if (Number.isFinite(tyres.temperatureCorrelation)) {
		const strength = Math.abs(tyres.temperatureCorrelation);
		if (strength > 0.3) {
			facts.push({
				id: 'tyre-weather',
				tone: 'quirk',
				kicker: 'Your tyres track the weather',
				value: tyres.temperatureCorrelation.toFixed(2),
				unit: 'correlation',
				detail:
					'Daily tyre pressure moves with battery temperature, which follows the outside air. Your car has been keeping an unintentional weather diary.',
				href: '/dash/doors-tyres'
			});
		}
	}

	return facts;
}

/** What the export says about you, and what it conspicuously omits. */
export function privacyFacts(input: FactInputs): Fact[] {
	const { dataset, doors } = input;
	const facts: Fact[] = [];

	facts.push({
		id: 'no-gps',
		tone: 'privacy',
		kicker: 'Location records included',
		value: 'None',
		detail:
			'There is not one coordinate anywhere in this export. A connected car plainly knows where it has been — navigation, charging maps and roadside assistance all depend on it — but none of that is in the data you were given.',
		href: '/dash/privacy'
	});

	if (dataset.vin) {
		facts.push({
			id: 'vin-repetition',
			tone: 'privacy',
			kicker: 'Times your VIN appears',
			value: nf(dataset.rowsParsed),
			detail:
				'Your vehicle identification number is repeated on every single row of every file. It identifies the car, and through registration, you. This app keeps it masked and never sends it anywhere.',
			href: '/dash/privacy'
		});
	}

	if (doors.events.length > 0) {
		facts.push({
			id: 'routine-exposure',
			tone: 'privacy',
			kicker: 'Your routine, reconstructed',
			value: `${doors.events.length} events`,
			detail:
				'Door openings alone show when you leave, when you come back, whether anyone sat in the back, and which days you did not go out at all. No location data is needed to describe a life in detail.',
			href: '/dash/doors-tyres'
		});
	}

	facts.push({
		id: 'second-resolution',
		tone: 'privacy',
		kicker: 'Recording resolution',
		value: '1 second',
		detail:
			'Speed, pedal position, steering angle and braking are all sampled every second the car is awake. That is fine enough to reconstruct individual manoeuvres, not merely journeys.',
		href: '/dash/driving'
	});

	return facts;
}

export function buildFacts(input: FactInputs): {
	headline: Fact[];
	habit: Fact[];
	quirk: Fact[];
	privacy: Fact[];
} {
	return {
		headline: headlineFacts(input),
		habit: habitFacts(input),
		quirk: quirkFacts(input),
		privacy: privacyFacts(input)
	};
}
