/**
 * Time-zone and date helpers for the calendar module (no dependencies, usable inside the parse
 * worker). Conversions between wall-clock times and instants use `Intl` (full ICU in Node), so
 * any IANA zone works without VTIMEZONE data.
 *
 * Conventions (§5): timed values are ISO-8601 UTC (`…Z`, as produced by `toISOString`);
 * all-day values are `YYYY-MM-DD` with an exclusive end.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Sync window (§9): `[today-30d, today+365d]` in the server's local zone. */
export const SYNC_PAST_DAYS = 30;
export const SYNC_FUTURE_DAYS = 365;

/** The server's own IANA zone (used for floating times and the sync window). */
export function serverTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const zoneValidity = new Map<string, boolean>();

/** True when the runtime knows `tz` as an IANA zone (or alias). */
export function isKnownTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  const cached = zoneValidity.get(tz);
  if (cached !== undefined) return cached;
  let ok: boolean;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  if (zoneValidity.size > 500) zoneValidity.clear();
  zoneValidity.set(tz, ok);
  return ok;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (partFormatters.size > 200) partFormatters.clear();
    partFormatters.set(tz, formatter);
  }
  return formatter;
}

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock fields of the instant `ms` in `tz`. */
export function wallTimeAt(ms: number, tz: string): WallTime {
  const parts = partsFormatter(tz).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get('hour');
  return { year: get('year'), month: get('month'), day: get('day'), hour: hour === 24 ? 0 : hour, minute: get('minute'), second: get('second') };
}

function wallAsUtcMs(w: WallTime): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/** Offset of `tz` from UTC at the instant `ms` (local − UTC), in ms. */
export function zoneOffsetMs(ms: number, tz: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return wallAsUtcMs(wallTimeAt(whole, tz)) - whole;
}

/**
 * Instant (epoch ms) of a wall-clock time in `tz`. Times in a DST gap move forward by the gap
 * (RFC 5545: read with the offset from before the gap), in zones east and west of UTC alike;
 * ambiguous times (fall back) resolve to one of the two valid instants.
 */
export function wallToUtcMs(wall: WallTime, tz: string): number {
  const local = wallAsUtcMs(wall);
  const guess = local - zoneOffsetMs(local, tz);
  const offset = zoneOffsetMs(guess, tz);
  const result = local - offset;
  if (result === guess) return result;
  if (zoneOffsetMs(result, tz) === offset) return result;
  // In a gap neither candidate round-trips; the later one used the pre-gap offset.
  return Math.max(result, guess);
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** `YYYY-MM-DD` → its fields, or null. */
export function parseDate(date: string): { year: number; month: number; day: number } | null {
  const m = ISO_DATE_REGEX.exec(date);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && parseDate(value) !== null;
}

/** Calendar date of the instant `ms` in `tz`. */
export function localDateOf(ms: number, tz: string): string {
  const w = wallTimeAt(ms, tz);
  return formatDate(w.year, w.month, w.day);
}

/** `YYYY-MM-DD` ± `days`. */
export function addDays(date: string, days: number): string {
  const d = parseDate(date);
  if (!d) throw new RangeError(`Invalid date "${date}"`);
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day) + days * DAY_MS);
  return formatDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole days from `a` to `b` (both `YYYY-MM-DD`). */
export function daysBetween(a: string, b: string): number {
  const da = parseDate(a);
  const db = parseDate(b);
  if (!da || !db) throw new RangeError('Invalid date');
  return Math.round((Date.UTC(db.year, db.month - 1, db.day) - Date.UTC(da.year, da.month - 1, da.day)) / DAY_MS);
}

/** Instant of local midnight at the start of `date` in `tz`. */
export function startOfDayMs(date: string, tz: string): number {
  const d = parseDate(date);
  if (!d) throw new RangeError(`Invalid date "${date}"`);
  return wallToUtcMs({ ...d, hour: 0, minute: 0, second: 0 }, tz);
}

export function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

/** Normalizes an ISO date-time (any offset) to `toISOString()` form, or null. */
export function normalizeInstant(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? isoUtc(ms) : null;
}

export interface SyncWindow {
  /** First day covered (inclusive). */
  fromDate: string;
  /** Day after the last covered day (exclusive). */
  toDate: string;
  fromMs: number;
  toMs: number;
  /** Zone the window dates are expressed in (the server's). */
  tz: string;
}

/** The synced window `[today-30d, today+365d)` (§9) for the instant `nowMs`. */
export function syncWindow(nowMs: number, tz: string = serverTimeZone()): SyncWindow {
  const today = localDateOf(nowMs, tz);
  const fromDate = addDays(today, -SYNC_PAST_DAYS);
  const toDate = addDays(today, SYNC_FUTURE_DAYS);
  return { fromDate, toDate, fromMs: startOfDayMs(fromDate, tz), toMs: startOfDayMs(toDate, tz), tz };
}
