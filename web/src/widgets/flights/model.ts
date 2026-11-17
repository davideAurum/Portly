/**
 * Flight tracker model: which flights a widget tracks (typed in, plus those found in the
 * calendar), how they sort, when one drops off, and how its status reads. Pure, so it is tested
 * without React.
 */
import {
  FLIGHT_DONE_HIDE_MS,
  bestTime,
  detectFlightsInText,
  type CalendarEvent,
  type FlightInfo,
  type FlightStatus,
} from '@portly/shared';

export interface TrackedFlight {
  ident: string;
  date: string;
  /** Where it came from: typed in the settings, or found in a calendar event. */
  source: 'manual' | 'calendar';
}

export function flightKey(f: { ident: string; date: string }): string {
  return `${f.ident}@${f.date}`;
}

/** `YYYY-MM-DD` of a moment in the given zone (the browser's when null). */
export function localDateOf(ms: number, timeZone?: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  }
}

/** `YYYY-MM-DD` shifted by whole days (calendar arithmetic, no zones). */
export function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Flights named in calendar events: the event's start date (in its own zone) is the departure date. */
export function flightsFromEvents(events: readonly CalendarEvent[]): TrackedFlight[] {
  const out: TrackedFlight[] = [];
  for (const event of events) {
    if (event.status === 'cancelled') continue;
    const idents = new Set([...detectFlightsInText(event.title), ...detectFlightsInText(event.location ?? '')]);
    if (idents.size === 0) continue;
    const date = event.allDay ? event.start.slice(0, 10) : localDateOf(Date.parse(event.start), event.timezone);
    for (const ident of idents) out.push({ ident, date, source: 'calendar' });
  }
  return out;
}

/** Typed-in flights first, then calendar ones not typed in or dismissed; one per flight and date. */
export function mergeFlights(manual: readonly { ident: string; date: string }[], fromCalendar: readonly TrackedFlight[], dismissed: readonly string[]): TrackedFlight[] {
  const seen = new Set<string>();
  const hidden = new Set(dismissed);
  const out: TrackedFlight[] = [];
  for (const f of manual) {
    const key = flightKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ident: f.ident, date: f.date, source: 'manual' });
  }
  for (const f of fromCalendar) {
    const key = flightKey(f);
    if (seen.has(key) || hidden.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** True when a flight is long over (arrived or cancelled 6 h ago, or its date two days past). */
export function isDone(flight: TrackedFlight, status: FlightStatus | undefined, now: number): boolean {
  if (flight.date < addDays(localDateOf(now), -2)) return true;
  const info = status?.flight;
  if (!info) return false;
  if (info.phase === 'arrived' || info.phase === 'cancelled') {
    const at = Date.parse(bestTime(info.arrival) ?? bestTime(info.departure) ?? '');
    return !Number.isNaN(at) && now - at > FLIGHT_DONE_HIDE_MS;
  }
  return false;
}

/** Departure order: best known departure time, else the date. */
export function sortTime(flight: TrackedFlight, status: FlightStatus | undefined): number {
  const out = status?.flight ? bestTime(status.flight.departure) : null;
  const ms = out === null ? NaN : Date.parse(out);
  return Number.isNaN(ms) ? Date.parse(`${flight.date}T12:00:00Z`) : ms;
}

export type StatusTone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';

/** The badge: what is happening, in a word or two, and how it should look. */
export function statusBadge(info: FlightInfo, now: number): { label: string; tone: StatusTone } {
  const late = (minutes: number | null) => minutes !== null && minutes >= 15;
  switch (info.phase) {
    case 'cancelled':
      return { label: 'Cancelled', tone: 'danger' };
    case 'diverted':
      return { label: 'Diverted', tone: 'danger' };
    case 'arrived':
      return { label: 'Arrived', tone: 'neutral' };
    case 'landed':
      return { label: 'Landed', tone: 'success' };
    case 'airborne':
      return late(info.arrivalDelayMin) ? { label: `In the air · ${delayText(info.arrivalDelayMin)}`, tone: 'warning' } : { label: 'In the air', tone: 'accent' };
    case 'taxiing':
      return { label: 'Departed gate', tone: 'accent' };
    case 'scheduled': {
      if (late(info.departureDelayMin)) return { label: `Delayed ${delayText(info.departureDelayMin)}`, tone: 'warning' };
      const out = Date.parse(bestTime(info.departure) ?? '');
      if (!Number.isNaN(out) && out - now < 3 * 3_600_000 && out > now) return { label: 'On time', tone: 'success' };
      return { label: 'Scheduled', tone: 'neutral' };
    }
  }
}

/** "25m", "1h 40m". */
export function delayText(minutes: number | null): string {
  if (minutes === null) return '';
  const m = Math.abs(minutes);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 === 0 ? '' : ` ${m % 60}m`}`;
}

/** What the row says when FlightAware has no flight to show yet. */
export function lookupNote(status: FlightStatus): string {
  switch (status.state) {
    case 'too_early':
      return 'Tracking starts two days before departure.';
    case 'too_old':
      return 'This flight is too far in the past.';
    case 'not_found':
      return 'FlightAware has no such flight on this date.';
    case 'found':
      return '';
  }
}
