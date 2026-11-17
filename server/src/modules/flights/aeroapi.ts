/**
 * FlightAware AeroAPI v4 client and mapping (§8 FlightAware): `x-apikey: <key>`, base
 * `https://aeroapi.flightaware.com/aeroapi`, fixed vendor endpoint → safe-fetch policy `provider`.
 *
 * - `GET /flights/{ident}?ident_type=designator&start&end&max_pages=1`: the flights of one flight
 *   number in a window. `start`/`end` compare to `scheduled_out` and must lie within 10 days back
 *   and 2 days ahead, so a date further off is answered `too_early`/`too_old` without a call.
 *   $0.005 per page of 15 (Personal tier: $5 free a month, 10 pages a minute).
 * - `GET /account/usage`: free; checks a new key.
 *
 * Failures map to the §7a error codes:
 * - 401/403 → 409 `not_configured` `{reason: 'token_rejected'}` (or 422 while checking a new key)
 * - 429 → 429 `rate_limited` `{retryAfterSeconds}` and a cooldown during which nothing is sent
 * - 400 → 422 `validation_failed`; 404 → the flight is `not_found`
 * - 5xx and others → 502 `provider_error`; timeouts → 504 (safe-fetch)
 * FlightAware's error text is never reflected to the client, and neither the key nor the flight
 * number is logged.
 */
import {
  FLIGHT_LOOKAHEAD_DAYS,
  FLIGHT_LOOKBACK_DAYS,
  type ErrorCode,
  type FlightAirport,
  type FlightEnd,
  type FlightInfo,
  type FlightPhase,
  type FlightStatus,
} from '@portly/shared';
import { HttpError } from '../../lib/errors.ts';
import type { Logger } from '../../lib/logger.ts';
import { SIZE_CAPS, type SafeFetch } from '../../security/safe-fetch.ts';

export const AEROAPI_BASE = 'https://aeroapi.flightaware.com/aeroapi';
export const REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRY_AFTER_S = 60;
export const MAX_RETRY_AFTER_S = 15 * 60;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export type UpstreamPurpose = 'validate' | 'status';

export class FlightsRateLimitError extends HttpError {
  override name = 'FlightsRateLimitError';
  readonly retryAfterSeconds: number;
  /** 429 when FlightAware answered it; null when our cooldown refused the request. */
  readonly httpStatus: number | null;
  constructor(retryAfterSeconds: number, httpStatus: number | null = null) {
    super(429, 'rate_limited', `FlightAware is limiting requests. Try again in ${retryAfterSeconds} s.`, { retryAfterSeconds });
    this.retryAfterSeconds = retryAfterSeconds;
    this.httpStatus = httpStatus;
  }
}

export class FlightsUpstreamError extends HttpError {
  override name = 'FlightsUpstreamError';
  /** FlightAware's HTTP status (logged as `upstreamStatus`); 2xx = an answer we could not read. */
  readonly httpStatus: number;
  constructor(httpStatus: number, status: number, code: ErrorCode, message: string, details?: unknown) {
    super(status, code, message, details);
    this.httpStatus = httpStatus;
  }
}

export function notConnected(): HttpError {
  return new HttpError(409, 'not_configured', 'FlightAware is not connected. Add your AeroAPI key in Settings → Accounts.', { reason: 'no_token' });
}

function failureFor(status: number, purpose: UpstreamPurpose): FlightsUpstreamError {
  if (status === 401 || status === 403) {
    if (purpose === 'validate') {
      return new FlightsUpstreamError(status, 422, 'validation_failed', 'FlightAware refused this key. Check that you copied all of it.', { reason: 'token_rejected' });
    }
    return new FlightsUpstreamError(status, 409, 'not_configured', 'FlightAware refused the saved key. Paste a new one under FlightAware in Settings → Accounts.', {
      reason: 'token_rejected',
    });
  }
  if (status === 400) return new FlightsUpstreamError(status, 422, 'validation_failed', 'FlightAware did not accept this flight number.');
  if (status >= 500) return new FlightsUpstreamError(status, 502, 'provider_error', `FlightAware is having problems (HTTP ${status}). Try again shortly.`);
  return new FlightsUpstreamError(status, 502, 'provider_error', `FlightAware returned an unexpected response (HTTP ${status}).`);
}

export function parseRetryAfter(header: string | null, now: number): number {
  let seconds: number | null = null;
  const value = header?.trim();
  if (value) {
    if (/^\d+$/.test(value)) seconds = Number(value);
    else {
      const at = Date.parse(value);
      if (!Number.isNaN(at)) seconds = Math.ceil((at - now) / 1000);
    }
  }
  if (seconds === null || !Number.isFinite(seconds)) seconds = DEFAULT_RETRY_AFTER_S;
  return Math.min(MAX_RETRY_AFTER_S, Math.max(1, seconds));
}

// ---------------------------------------------------------------------------
// The search window
// ---------------------------------------------------------------------------

/** AeroAPI's own time format: ISO-8601 without milliseconds. */
function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export type FlightWindow =
  | { kind: 'ok'; start: string; end: string }
  | { kind: 'too_early'; availableFrom: string }
  | { kind: 'too_old' };

/**
 * The `start`/`end` that cover departures on local date `date` anywhere on Earth (UTC−12 to
 * UTC+14), clipped to what AeroAPI accepts around `now`.
 */
export function flightWindow(date: string, now: number): FlightWindow {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  const from = midnight - 14 * HOUR;
  const to = midnight + DAY + 12 * HOUR;
  const latest = now + FLIGHT_LOOKAHEAD_DAYS * DAY - 60_000;
  const earliest = now - (FLIGHT_LOOKBACK_DAYS + 1) * DAY + HOUR;
  if (from > latest) return { kind: 'too_early', availableFrom: iso(from - FLIGHT_LOOKAHEAD_DAYS * DAY) };
  if (to < earliest) return { kind: 'too_old' };
  return { kind: 'ok', start: iso(Math.max(from, earliest)), end: iso(Math.min(to, latest)) };
}

// ---------------------------------------------------------------------------
// Mapping (hostile input: plain text only, lengths capped, unknown fields dropped)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Trimmed text without control characters, at most `max` long; null when empty or not a string. */
export function text(value: unknown, max = 80): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean === '') return null;
  return clean.length > max ? clean.slice(0, max) : clean;
}

function time(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

const TZ_RE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

export function validTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64 || !TZ_RE.test(value)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

const CODE_RE = /^[A-Z0-9]{2,5}$/;

function airport(value: unknown): FlightAirport | null {
  if (!isObject(value)) return null;
  const code = [value.code_iata, value.code_icao, value.code_lid, value.code].map((c) => (typeof c === 'string' && CODE_RE.test(c) ? c : null)).find((c) => c !== null);
  if (code === undefined || code === null) return null;
  return { code, name: text(value.name), city: text(value.city), timezone: validTimeZone(value.timezone) };
}

const SHORT = 12;

function end(raw: Json, side: 'out' | 'in'): FlightEnd {
  const runway = side === 'out' ? 'off' : 'on';
  const where = side === 'out' ? 'origin' : 'destination';
  return {
    scheduled: time(raw[`scheduled_${side}`]) ?? time(raw[`scheduled_${runway}`]),
    estimated: time(raw[`estimated_${side}`]) ?? time(raw[`estimated_${runway}`]),
    actual: time(raw[`actual_${side}`]),
    runway: time(raw[`actual_${runway}`]),
    gate: text(raw[`gate_${where}`], SHORT),
    terminal: text(raw[`terminal_${where}`], SHORT),
  };
}

export function phaseOf(raw: Json): FlightPhase {
  if (raw.cancelled === true) return 'cancelled';
  if (raw.diverted === true) return 'diverted';
  if (time(raw.actual_in) !== null) return 'arrived';
  if (time(raw.actual_on) !== null) return 'landed';
  if (time(raw.actual_off) !== null) return 'airborne';
  if (time(raw.actual_out) !== null) return 'taxiing';
  return 'scheduled';
}

const FA_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const IDENT_RE = /^[A-Z0-9]{2,8}$/;

function minutes(seconds: number | null): number | null {
  return seconds === null ? null : Math.round(seconds / 60);
}

/** One AeroAPI flight object → {@link FlightInfo}; null when it lacks what every row needs. */
export function mapFlight(raw: unknown, fallbackIdent: string): FlightInfo | null {
  if (!isObject(raw)) return null;
  const ident = [raw.ident_iata, raw.ident, raw.ident_icao].find((v): v is string => typeof v === 'string' && IDENT_RE.test(v)) ?? fallbackIdent;
  const progress = int(raw.progress_percent);
  const faId = typeof raw.fa_flight_id === 'string' && FA_ID_RE.test(raw.fa_flight_id) ? raw.fa_flight_id : null;
  const operator = [raw.operator_iata, raw.operator].find((v): v is string => typeof v === 'string' && CODE_RE.test(v)) ?? null;
  return {
    ident,
    operator,
    origin: airport(raw.origin),
    destination: airport(raw.destination),
    departure: end(raw, 'out'),
    arrival: end(raw, 'in'),
    phase: phaseOf(raw),
    statusText: text(raw.status) ?? '',
    progressPercent: progress === null ? null : Math.min(100, Math.max(0, progress)),
    departureDelayMin: minutes(int(raw.departure_delay)),
    arrivalDelayMin: minutes(int(raw.arrival_delay)),
    baggageClaim: text(raw.baggage_claim, SHORT),
    aircraftType: text(raw.aircraft_type, SHORT),
    url: faId === null ? null : `https://www.flightaware.com/live/flight/id/${faId}`,
  };
}

/** `YYYY-MM-DD` of `iso` in `tz` (UTC when the zone is unknown). */
export function localDate(isoTime: string, tz: string | null): string {
  const date = new Date(isoTime);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * The flight of `ident` departing on local date `date` from an AeroAPI `/flights/{ident}` answer:
 * the one whose scheduled departure, in the origin's zone, is on that date (the first if a
 * diversion made two). Throws a `provider_error` when the answer has no `flights` list.
 */
export function pickFlight(answer: unknown, ident: string, date: string): FlightInfo | null {
  if (!isObject(answer) || !Array.isArray(answer.flights)) throw new FlightsUpstreamError(200, 502, 'provider_error', 'FlightAware returned an unexpected response.');
  const candidates: { flight: FlightInfo; at: number }[] = [];
  for (const raw of answer.flights.slice(0, 50)) {
    const flight = mapFlight(raw, ident);
    const scheduled = flight?.departure.scheduled ?? null;
    if (flight === null || scheduled === null) continue;
    if (localDate(scheduled, flight.origin?.timezone ?? null) !== date) continue;
    candidates.push({ flight, at: Date.parse(scheduled) });
  }
  candidates.sort((a, b) => a.at - b.at);
  return candidates[0]?.flight ?? null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface FlightsClientDeps {
  fetch: SafeFetch;
  log: Logger;
  now?: () => number;
}

export interface FlightsClient {
  /** The status of `ident` departing on `date` (no call when the date is out of AeroAPI's range). */
  status(key: string, ident: string, date: string): Promise<FlightStatus>;
  /** Asks the free usage endpoint, so a key FlightAware refuses is not stored. */
  checkKey(key: string): Promise<void>;
  resetCooldown(): void;
  cooldownUntil(): number;
}

export function createFlightsClient(deps: FlightsClientDeps): FlightsClient {
  const now = deps.now ?? Date.now;
  let blockedUntil = 0;

  const get = async (key: string, path: string, query: Record<string, string>, purpose: UpstreamPurpose): Promise<{ status: number; data: unknown }> => {
    const remainingMs = blockedUntil - now();
    if (remainingMs > 0) throw new FlightsRateLimitError(Math.ceil(remainingMs / 1000));
    const url = new URL(`${AEROAPI_BASE}${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const res = await deps.fetch(url.toString(), {
      headers: { 'x-apikey': key, Accept: 'application/json; charset=UTF-8' },
      policy: 'provider',
      as: 'text',
      maxBytes: SIZE_CAPS.json,
      timeoutMs: REQUEST_TIMEOUT_MS,
      redirect: 'error',
      purpose: `flightaware.${purpose}`,
    });
    if (res.status === 429) {
      const seconds = parseRetryAfter(res.headers.get('retry-after'), now());
      blockedUntil = now() + seconds * 1000;
      deps.log.debug('flightaware rate limited', { retryAfterSeconds: seconds });
      throw new FlightsRateLimitError(seconds, 429);
    }
    if (res.status === 404 && purpose === 'status') return { status: 404, data: null };
    if (res.status < 200 || res.status >= 300) throw failureFor(res.status, purpose);
    try {
      return { status: res.status, data: res.data.trim() === '' ? null : (JSON.parse(res.data) as unknown) };
    } catch {
      throw new FlightsUpstreamError(res.status, 502, 'provider_error', 'FlightAware returned an unexpected response.');
    }
  };

  return {
    async status(key, ident, date) {
      const window = flightWindow(date, now());
      const base = { ident, date, flight: null, availableFrom: null };
      if (window.kind === 'too_early') return { ...base, state: 'too_early', availableFrom: window.availableFrom, fetchedAt: new Date(now()).toISOString() };
      if (window.kind === 'too_old') return { ...base, state: 'too_old', fetchedAt: new Date(now()).toISOString() };
      const res = await get(key, `/flights/${encodeURIComponent(ident)}`, { ident_type: 'designator', start: window.start, end: window.end, max_pages: '1' }, 'status');
      const flight = res.status === 404 ? null : pickFlight(res.data, ident, date);
      return { ...base, state: flight === null ? 'not_found' : 'found', flight, fetchedAt: new Date(now()).toISOString() };
    },
    async checkKey(key) {
      await get(key, '/account/usage', {}, 'validate');
    },
    resetCooldown: () => {
      blockedUntil = 0;
    },
    cooldownUntil: () => blockedUntil,
  };
}
