/**
 * Small pure helpers of Settings → Diagnostics (ARCHITECTURE §17): durations, sizes, the local
 * time with its UTC offset, the supervisor's last exit, area names, when the server has no
 * diagnostics, the link to the diagnostics page on this PC, the hybrid hint "Homebase answers,
 * but not to this site" with this site's address, and whether the server takes debug events.
 */
import type { DiagnosticArea, LogLevelState } from '@homebase/shared';
import { isApiError } from '../../api/client.ts';
import { LOCAL_SERVER_ORIGIN } from '../../localServer/config.ts';
import { DEFAULT_LOCAL_SERVER_ORIGIN } from '../../localServer/origin.ts';
import type { LocalServerState } from '../../localServer/types.ts';

/** DEL and C1 controls, line/paragraph separators and bidi controls: `JSON.stringify` leaves them raw. */
const UNSAFE_JSON_CHARS = /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * JSON text with {@link UNSAFE_JSON_CHARS} written as `\uXXXX` — the same JSON, but a field value
 * cannot reorder or hide what is shown or saved around it (this browser's events are not escaped
 * by the server).
 */
export function escapeUnsafeJson(json: string): string {
  return json.replace(UNSAFE_JSON_CHARS, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** `3 h 12 min`, `45 s`, `2 d 4 h` (the two largest units). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return ms < 1000 ? `${Math.round(ms)} ms` : `${seconds} s`;
  const units: [string, number][] = [
    ['d', 86_400],
    ['h', 3_600],
    ['min', 60],
    ['s', 1],
  ];
  const parts: string[] = [];
  let rest = seconds;
  for (const [unit, size] of units) {
    const value = Math.floor(rest / size);
    rest -= value * size;
    if (value > 0 || parts.length > 0) parts.push(`${value} ${unit}`);
    if (parts.length === 2) break;
  }
  return parts.filter((part) => !part.startsWith('0 ')).join(' ');
}

/** `512 B`, `12.3 KB`, `120 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function pad(value: number, length = 2): string {
  return String(Math.abs(Math.trunc(value))).padStart(length, '0');
}

/** Local time with its offset, e.g. `2026-10-11 14:32:05 UTC+02:00` (the Copy summary's first line). */
export function localTimeWithOffset(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day} ${time} UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** `HH:MM:SS.mmm` in local time: the log list's time column (the full date is the row's tooltip). */
export function logTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

const AREA_LABELS: Readonly<Record<DiagnosticArea, string>> = Object.freeze({
  server: 'Server',
  core: 'Core',
  accounts: 'Accounts',
  calendar: 'Calendar',
  mail: 'Mail',
  todoist: 'Todoist',
  feeds: 'Feeds',
  weather: 'Weather',
  sports: 'Sports',
  search: 'Search',
  bookmarks: 'Bookmarks',
  pairing: 'Pairing',
  diagnostics: 'Diagnostics',
  fetch: 'Outbound requests',
  scheduler: 'Scheduler',
  health: 'Health',
  vault: 'Credential vault',
  settings: 'Settings',
  console: 'Console',
  client: 'Browser events',
});

/** A readable name for a log area (a newer server's unknown area: the id itself). */
export function areaLabel(area: string): string {
  return Object.hasOwn(AREA_LABELS, area) ? AREA_LABELS[area as DiagnosticArea] : area;
}

/**
 * A summary request the server cannot answer because it predates diagnostics: it answers the
 * Pages site `403 local_only` (an untagged route) and its own page `404`. Only for the summary:
 * other diagnostics routes may answer 404 for a missing item.
 */
export function diagnosticsUnavailable(error: unknown): boolean {
  return isApiError(error) && (error.code === 'local_only' || error.status === 404);
}

/** The diagnostics page of Homebase on this PC, which always stays there (see `app/pagesForward.ts`). */
export function localDiagnosticsUrl(origin: string = LOCAL_SERVER_ORIGIN): string {
  return `${origin === '' ? DEFAULT_LOCAL_SERVER_ORIGIN : origin.replace(/\/+$/, '')}/#/settings/diagnostics`;
}

/**
 * True when the last probe found something answering on the local server's port, but not to this
 * site's CORS requests (`unreachableReason`, set by the local server controller): Homebase on this
 * PC runs, but its `HOMEBASE_PAGES_URL` is not this site (or it is too old for hybrid mode).
 */
export function answersWithoutCors(state: Pick<LocalServerState, 'status' | 'unreachableReason'>): boolean {
  return state.unreachableReason === 'answers-without-cors' && state.status !== 'connected';
}

/**
 * This site's address, origin plus base path (`https://<user>.github.io/<repo>/`): the value
 * `HOMEBASE_PAGES_URL` must have for Homebase on this PC to answer it (its origin alone names
 * another site when the site has a path).
 */
export function thisSiteAddress(origin: string = window.location.origin, base: string = import.meta.env.BASE_URL): string {
  return new URL(base, origin).href;
}

/** The server keeps uploaded debug events: verbose logging covers browser events (`client`). */
export function takesDebugEvents(state: Pick<LogLevelState, 'verbose' | 'areas'>): boolean {
  return state.verbose && (state.areas === null || state.areas.includes('client'));
}

interface LastExit {
  code?: unknown;
  signal?: unknown;
  failure?: unknown;
}

function text(value: unknown, max = 120): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * The supervisor's last exit of the server (`HOMEBASE_SUPERVISOR_LAST_EXIT`: JSON `{code, signal,
 * failure?}`, `failure` being the server's `startup-failed` message), as one line: `exit code 1,
 * start-up failed (db): SqliteError [SQLITE_BUSY]: database is locked`. Text that is not that
 * JSON is shown as it is (shortened).
 */
export function describeLastExit(raw: string | null): string | null {
  if (raw === null || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return text(raw, 200);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return text(raw, 200);
  const exit = parsed as LastExit;
  const parts: string[] = [];
  const code = text(exit.code);
  const signal = text(exit.signal);
  if (code !== null) parts.push(`exit code ${code}`);
  if (signal !== null) parts.push(`signal ${signal}`);
  if (exit.failure !== null && typeof exit.failure === 'object' && !Array.isArray(exit.failure)) {
    const failure = exit.failure as Record<string, unknown>;
    const phase = text(failure.phase, 32);
    const name = text(failure.errName, 64);
    const errCode = text(failure.errCode, 64) ?? text(failure.sqliteCode, 64);
    const message = text(failure.message, 200);
    let line = phase === null ? 'start-up failed' : `start-up failed (${phase})`;
    if (name !== null) line += `: ${name}${errCode === null ? '' : ` [${errCode}]`}`;
    if (message !== null) line += `: ${message}`;
    parts.push(line);
  }
  return parts.length > 0 ? parts.join(', ') : text(raw, 200);
}
