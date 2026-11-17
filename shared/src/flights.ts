/**
 * Flight tracker contracts (`/api/flights/*`, §7 Flights, §8 FlightAware). Flight status comes from
 * FlightAware AeroAPI with the user's own key, which only the server holds (vault secret
 * `flightaware:key`); the in-browser backend has no flight tracker.
 *
 * Also here, because both the widget and its tests use them: the flight-number grammar
 * ({@link normalizeFlightIdent}), the refresh policy that keeps AeroAPI costs low
 * ({@link flightRefreshMs}), and the calendar scan ({@link detectFlightsInText}).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Flight numbers and dates
// ---------------------------------------------------------------------------

/**
 * A flight number as the user writes it, normalized: airline code (IATA two characters with at
 * least one letter, or ICAO three letters), 1–4 digits, an optional suffix letter. `UA123`,
 * `B6 615`, `ual 123` → `UA123`, `B6615`, `UAL123`.
 */
export const FLIGHT_IDENT_RE = /^(?:[A-Z]{3}|[A-Z][A-Z0-9]|[0-9][A-Z])\d{1,4}[A-Z]?$/;

/** Uppercases and drops spaces and dashes; null when the result is not a flight number. */
export function normalizeFlightIdent(raw: string): string | null {
  const ident = raw.trim().toUpperCase().replace(/[\s-]+/g, '');
  return FLIGHT_IDENT_RE.test(ident) ? ident : null;
}

export const FlightIdentSchema = z
  .string()
  .max(20)
  .transform((value, ctx) => {
    const ident = normalizeFlightIdent(value);
    if (ident === null) {
      ctx.addIssue({ code: 'custom', message: 'Must be a flight number such as UA123' });
      return z.NEVER;
    }
    return ident;
  });

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** The departure date, local to the departure airport, `YYYY-MM-DD`. */
export const FlightDateSchema = z.string().regex(DATE_RE, { message: 'Must be a date (YYYY-MM-DD)' });

/** `GET /api/flights/status?ident=&date=` */
export const FlightStatusQuerySchema = z.object({ ident: FlightIdentSchema, date: FlightDateSchema });
export type FlightStatusQuery = z.output<typeof FlightStatusQuerySchema>;

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

/** `GET /api/flights/key` → `{configured}` (the key itself is never returned). */
export interface FlightsKeyStatus {
  configured: boolean;
}

/** `PUT /api/flights/key {key}` (checked with FlightAware before it is stored). */
export const FlightsKeyUpdateSchema = z.object({ key: z.string().trim().min(1).max(200) }).strict();
export type FlightsKeyUpdate = z.output<typeof FlightsKeyUpdateSchema>;

/** AeroAPI keys are long runs of letters and digits; this catches paste mistakes, not a format. */
export const FLIGHTAWARE_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** Trims and drops a pasted `x-apikey:` prefix. */
export function cleanFlightAwareKey(raw: string): string {
  return raw.trim().replace(/^x-apikey\s*:\s*/i, '');
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface FlightAirport {
  /** IATA code when there is one ("DEN"), else ICAO or FlightAware's code. */
  code: string;
  name: string | null;
  city: string | null;
  /** IANA zone ("America/Denver"); times are shown in it. */
  timezone: string | null;
}

/** One end of the flight. All times ISO-8601 UTC or null. */
export interface FlightEnd {
  /** Gate departure / arrival (block out / block in). */
  scheduled: string | null;
  estimated: string | null;
  actual: string | null;
  /** Takeoff (at the origin) or landing (at the destination), actual only. */
  runway: string | null;
  gate: string | null;
  terminal: string | null;
}

export const FLIGHT_PHASES = ['scheduled', 'taxiing', 'airborne', 'landed', 'arrived', 'cancelled', 'diverted'] as const;
export type FlightPhase = (typeof FLIGHT_PHASES)[number];

export interface FlightInfo {
  /** The flight number as shown (IATA when known: "UA123"). */
  ident: string;
  /** Airline name is not in AeroAPI's answer; the operator code is ("UAL"/"UA"). */
  operator: string | null;
  origin: FlightAirport | null;
  destination: FlightAirport | null;
  departure: FlightEnd;
  arrival: FlightEnd;
  phase: FlightPhase;
  /** FlightAware's own summary ("En Route / On Time"), plain text. */
  statusText: string;
  /** 0–100 while under way. */
  progressPercent: number | null;
  /** Minutes late (negative = early); null when unknown. */
  departureDelayMin: number | null;
  arrivalDelayMin: number | null;
  baggageClaim: string | null;
  aircraftType: string | null;
  /** The flight's page on flightaware.com. */
  url: string | null;
}

export const FLIGHT_LOOKUP_STATES = ['found', 'not_found', 'too_early', 'too_old'] as const;
export type FlightLookupState = (typeof FLIGHT_LOOKUP_STATES)[number];

/** `GET /api/flights/status` */
export interface FlightStatus {
  ident: string;
  date: string;
  /**
   * `too_early`: FlightAware has no data this far ahead (tracking starts {@link FLIGHT_LOOKAHEAD_DAYS}
   * days before; nothing was asked); `too_old`: past what it keeps; `not_found`: no such flight that day.
   */
  state: FlightLookupState;
  flight: FlightInfo | null;
  /** When tracking can start, for `too_early`. */
  availableFrom: string | null;
  /** When FlightAware was last asked (ISO-8601). */
  fetchedAt: string;
}

/** AeroAPI answers for flights scheduled up to 2 days ahead and back about 10 days. */
export const FLIGHT_LOOKAHEAD_DAYS = 2;
export const FLIGHT_LOOKBACK_DAYS = 9;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Best known time of one end: actual, else estimated, else scheduled. */
export function bestTime(end: FlightEnd): string | null {
  return end.actual ?? end.estimated ?? end.scheduled;
}

/**
 * How long one answer stays good (server cache and widget refetch). Each AeroAPI call costs money
 * (the free monthly credit covers about a thousand), so a flight is asked about rarely while it is
 * far off, every 5–10 minutes around departure and in the air, and not again once it is over.
 * A typical flight tracked from two days out costs about 80 calls.
 */
export function flightRefreshMs(status: Pick<FlightStatus, 'state' | 'flight' | 'availableFrom'>, now: number): number {
  switch (status.state) {
    case 'too_early': {
      const from = status.availableFrom === null ? NaN : Date.parse(status.availableFrom);
      const wait = Number.isNaN(from) ? 6 * HOUR : from - now;
      return Math.min(12 * HOUR, Math.max(HOUR, wait));
    }
    case 'too_old':
      return 24 * HOUR;
    case 'not_found':
      return HOUR;
    case 'found':
      break;
  }
  const flight = status.flight;
  if (flight === null) return HOUR;
  switch (flight.phase) {
    case 'arrived':
    case 'cancelled':
      return 6 * HOUR;
    case 'scheduled': {
      const out = bestTime(flight.departure);
      const until = out === null ? NaN : Date.parse(out) - now;
      if (Number.isNaN(until) || until > 24 * HOUR) return 3 * HOUR;
      if (until > 6 * HOUR) return HOUR;
      if (until > HOUR) return 15 * MINUTE;
      return 5 * MINUTE;
    }
    case 'airborne': {
      const on = bestTime(flight.arrival);
      const left = on === null ? NaN : Date.parse(on) - now;
      return !Number.isNaN(left) && left > 45 * MINUTE ? 10 * MINUTE : 5 * MINUTE;
    }
    default:
      return 5 * MINUTE;
  }
}

/** A flight that is over (arrived, cancelled) more than this long ago drops off the widget. */
export const FLIGHT_DONE_HIDE_MS = 6 * HOUR;

// ---------------------------------------------------------------------------
// Calendar scan
// ---------------------------------------------------------------------------

/**
 * IATA codes of airlines common enough that `XX 123` in an event title is a flight. A code outside
 * this list counts only next to the word "flight".
 */
const KNOWN_AIRLINES: ReadonlySet<string> = new Set([
  'AA', 'AC', 'AF', 'AI', 'AM', 'AS', 'AV', 'AY', 'AZ', 'B6', 'BA', 'BR', 'CA', 'CI', 'CM', 'CX', 'CZ', 'DL', 'EI', 'EK', 'ET',
  'EY', 'F9', 'FI', 'FR', 'G3', 'G4', 'HA', 'IB', 'JL', 'JQ', 'KE', 'KL', 'LA', 'LH', 'LO', 'LX', 'MH', 'MU', 'MX', 'NH', 'NK',
  'NZ', 'OS', 'OZ', 'PD', 'QF', 'QR', 'SA', 'SK', 'SN', 'SQ', 'SY', 'TK', 'TP', 'U2', 'UA', 'UX', 'VA', 'VB', 'VS', 'VY', 'W6',
  'WN', 'WS', 'XY', 'Y4',
]);

/** Airline names as booking emails and calendars write them → IATA code. */
const AIRLINE_NAMES: readonly (readonly [RegExp, string])[] = [
  [/american(?:\s+airlines)?/, 'AA'],
  [/united(?:\s+airlines)?/, 'UA'],
  [/delta(?:\s+air\s+lines)?/, 'DL'],
  [/southwest(?:\s+airlines)?/, 'WN'],
  [/alaska(?:\s+airlines)?/, 'AS'],
  [/jetblue(?:\s+airways)?/, 'B6'],
  [/spirit(?:\s+airlines)?/, 'NK'],
  [/frontier(?:\s+airlines)?/, 'F9'],
  [/hawaiian(?:\s+airlines)?/, 'HA'],
  [/air\s+canada/, 'AC'],
  [/westjet/, 'WS'],
  [/british\s+airways/, 'BA'],
  [/lufthansa/, 'LH'],
  [/air\s+france/, 'AF'],
  [/klm/, 'KL'],
  [/aer\s+lingus/, 'EI'],
  [/virgin\s+atlantic/, 'VS'],
  [/emirates/, 'EK'],
  [/qantas/, 'QF'],
];

const NAME_SOURCE = AIRLINE_NAMES.map(([re]) => `(${re.source})`).join('|');
/** "United flight 123", "Delta Air Lines 4567", "JetBlue #615". */
const NAME_RE = new RegExp(`\\b(?:${NAME_SOURCE})(?:\\s+flight)?\\s*(?:#|no\\.?\\s*)?\\s*(\\d{1,4})\\b`, 'gi');
/** "UA 123", "UA123", "B6-615": a code must be upper case in the text. */
const CODE_RE = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]|[0-9][A-Z])[\s-]?(\d{1,4})(?![A-Za-z0-9])/g;
const FLIGHT_WORD_RE = /\bflight\b|\bflt\b|✈/i;

/** Flight numbers found in one piece of text (an event title or location), normalized, unique. */
export function detectFlightsInText(text: string): string[] {
  const input = text.slice(0, 500);
  const found = new Set<string>();
  const flightWord = FLIGHT_WORD_RE.test(input);
  for (const match of input.matchAll(NAME_RE)) {
    // "Delta 5 review" is not a flight: a bare name needs "flight", "Airlines" or "#" with it.
    if (!flightWord && !/airlines?|air\s+lines|airways|#/i.test(match[0])) continue;
    const groups = match.slice(1, AIRLINE_NAMES.length + 1);
    const index = groups.findIndex((g) => g !== undefined);
    const number = match[AIRLINE_NAMES.length + 1];
    const code = index >= 0 ? AIRLINE_NAMES[index]?.[1] : undefined;
    if (code !== undefined && number !== undefined) found.add(`${code}${Number(number)}`);
  }
  for (const match of input.matchAll(CODE_RE)) {
    const code = match[1];
    const number = match[2];
    if (code === undefined || number === undefined) continue;
    if (!KNOWN_AIRLINES.has(code) && !flightWord) continue;
    // "Q3 2026", "H1 2027": quarters and halves next to a year are not flights.
    if (/^[QH][1-4]$/.test(code) && /^20\d\d$/.test(number)) continue;
    found.add(`${code}${Number(number)}`);
  }
  return [...found];
}
