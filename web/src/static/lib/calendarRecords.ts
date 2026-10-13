/**
 * Calendar records of the static backend (port of the pure parts of
 * server/src/modules/calendar/types.ts and store.ts): what providers produce, the stored calendar
 * and event rows, ingest sanitization, deterministic event ids and the mapping to the API's
 * `Calendar` / `CalendarEvent`.
 *
 * Stored rows keep the server's column names and 0/1 flags (`CalendarRow`, `EventRow`) so the
 * ported sync and mapping code stays line-for-line comparable with the server's; they live in
 * IndexedDB as plain JSON instead of SQLite rows. Event ids are the server's
 * `${calendarId}:${sha1(remoteId|instanceKey)}`, computed with Web Crypto (hence async).
 */
import {
  EVENT_STATUSES,
  EVENT_TEXT_LIMITS,
  normalizeHexColor,
  toSafeHttpUrl,
  type Calendar,
  type CalendarEvent,
  type CalendarSource,
  type EventStatus,
} from '@portly/shared';
import { addDays, isIsoDate, isKnownTimeZone, isoUtc, normalizeInstant } from './calendarTime.ts';
import { descriptionText, singleLine } from './calendarText.ts';

export const MAX_CALENDAR_NAME = 200;
export const MAX_LAST_ERROR = 500;
export const MAX_REMOTE_ID = 1024;
export const UNTITLED_EVENT = '(No title)';

// ---------------------------------------------------------------------------
// Records (server/src/modules/calendar/types.ts)
// ---------------------------------------------------------------------------

/** One event instance as produced by a provider (unsanitized: see `sanitizeEvent`). */
export interface EventRecord {
  /** Provider id: Graph event (or occurrence) id. */
  remoteId: string;
  /** Expanded recurrence instance key (ICS/CalDAV only), else null. */
  instanceKey: string | null;
  etag: string | null;
  title: string;
  location: string | null;
  description: string | null;
  /** Timed: ISO instant; all-day: `YYYY-MM-DD`. */
  start: string;
  /** Timed: ISO instant; all-day: `YYYY-MM-DD` (exclusive). */
  end: string;
  allDay: boolean;
  timezone: string | null;
  status: EventStatus;
  recurring: boolean;
  seriesId: string | null;
  htmlUrl: string | null;
  meetingUrl: string | null;
  editable: boolean;
}

/** A calendar as listed by an account's provider. */
export interface RemoteCalendar {
  remoteId: string;
  name: string;
  color: string | null;
  writable: boolean;
  primary: boolean;
  /** Initial visibility for newly discovered calendars. */
  visible?: boolean;
}

/** A stored calendar (the server's `calendars` row). */
export interface CalendarRow {
  id: string;
  account_id: string | null;
  source: CalendarSource;
  remote_id: string;
  name: string;
  color: string | null;
  color_override: string | null;
  provider_writable: number;
  user_read_only: number;
  visible: number;
  is_primary: number;
  sort: number;
  display_url: string | null;
  collection_url: string | null;
  sync_state: string | null;
  last_synced_at: number | null;
  last_error: string | null;
}

/** A stored event (the server's `events` row). */
export interface EventRow {
  id: string;
  calendar_id: string;
  remote_id: string;
  instance_key: string | null;
  etag: string | null;
  title: string;
  location: string | null;
  description: string | null;
  start: string;
  end: string;
  all_day: number;
  timezone: string | null;
  status: string | null;
  recurring: number;
  series_id: string | null;
  html_url: string | null;
  meeting_url: string | null;
  editable: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Ids and colors
// ---------------------------------------------------------------------------

/** Calm fallback palette for calendars without a provider color (matches the web swatches). */
const FALLBACK_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#14b8a6', '#ef4444', '#f59e0b', '#06b6d4', '#d946ef', '#6366f1', '#84cc16', '#64748b'] as const;

export function fallbackColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length]!;
}

async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Deterministic event id (§5): `${calendarId}:${sha1(remoteId + '|' + (instanceKey ?? ''))}`. */
export async function eventId(calendarId: string, remoteId: string, instanceKey: string | null): Promise<string> {
  return `${calendarId}:${await sha1Hex(`${remoteId}|${instanceKey ?? ''}`)}`;
}

// ---------------------------------------------------------------------------
// Ingest sanitization (§4.4, §4.5)
// ---------------------------------------------------------------------------

export interface SanitizedEvent extends EventRecord {
  id: string;
}

function isStatus(value: unknown): value is EventStatus {
  return typeof value === 'string' && (EVENT_STATUSES as readonly string[]).includes(value);
}

/**
 * Validates and normalizes a provider record for storage: text cleaned and capped, URLs must be
 * SafeHttpUrl (else null), times normalized (timed → ISO UTC; all-day → `YYYY-MM-DD`, end
 * exclusive and after start), timezone must be a known IANA zone. Returns null when the record
 * has no usable id or times.
 */
export async function sanitizeEvent(calendarId: string, record: EventRecord): Promise<SanitizedEvent | null> {
  if (typeof record.remoteId !== 'string' || record.remoteId === '' || record.remoteId.length > MAX_REMOTE_ID) return null;
  const instanceKey = typeof record.instanceKey === 'string' && record.instanceKey !== '' ? record.instanceKey.slice(0, 100) : null;

  let start: string;
  let end: string;
  if (record.allDay) {
    if (!isIsoDate(record.start)) return null;
    start = record.start;
    end = isIsoDate(record.end) && record.end > start ? record.end : addDays(start, 1);
  } else {
    const s = normalizeInstant(record.start);
    if (s === null) return null;
    start = s;
    const e = normalizeInstant(record.end);
    end = e !== null && Date.parse(e) >= Date.parse(s) ? e : s;
  }

  return {
    id: await eventId(calendarId, record.remoteId, instanceKey),
    remoteId: record.remoteId,
    instanceKey,
    etag: typeof record.etag === 'string' && record.etag !== '' ? record.etag.slice(0, 500) : null,
    title: singleLine(record.title, EVENT_TEXT_LIMITS.title) ?? UNTITLED_EVENT,
    location: singleLine(record.location, EVENT_TEXT_LIMITS.location),
    description: descriptionText(record.description, EVENT_TEXT_LIMITS.description, 'text'),
    start,
    end,
    allDay: record.allDay,
    timezone: isKnownTimeZone(record.timezone) ? record.timezone : null,
    status: isStatus(record.status) ? record.status : 'confirmed',
    recurring: record.recurring === true,
    seriesId: typeof record.seriesId === 'string' && record.seriesId !== '' ? record.seriesId.slice(0, MAX_REMOTE_ID) : null,
    htmlUrl: toSafeHttpUrl(record.htmlUrl),
    meetingUrl: toSafeHttpUrl(record.meetingUrl),
    editable: record.editable === true,
  };
}

/** The stored row of a sanitized event. */
export function toEventRow(calendarId: string, e: SanitizedEvent, now: number): EventRow {
  return {
    id: e.id,
    calendar_id: calendarId,
    remote_id: e.remoteId,
    instance_key: e.instanceKey,
    etag: e.etag,
    title: e.title,
    location: e.location,
    description: e.description,
    start: e.start,
    end: e.end,
    all_day: e.allDay ? 1 : 0,
    timezone: e.timezone,
    status: e.status,
    recurring: e.recurring ? 1 : 0,
    series_id: e.seriesId,
    html_url: e.htmlUrl,
    meeting_url: e.meetingUrl,
    editable: e.editable ? 1 : 0,
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------
// API mapping
// ---------------------------------------------------------------------------

export function isWritableRow(row: CalendarRow): boolean {
  return row.provider_writable === 1 && row.user_read_only === 0 && (row.source === 'google' || row.source === 'microsoft');
}

export function toCalendar(row: CalendarRow, accountColor: string | null = null): Calendar {
  return {
    id: row.id,
    accountId: row.account_id,
    source: row.source,
    name: row.name,
    color: normalizeHexColor(row.color_override) ?? normalizeHexColor(row.color) ?? normalizeHexColor(accountColor) ?? fallbackColor(row.id),
    colorOverride: normalizeHexColor(row.color_override),
    writable: isWritableRow(row),
    providerWritable: row.provider_writable === 1,
    userReadOnly: row.user_read_only === 1,
    visible: row.visible === 1,
    isPrimary: row.is_primary === 1,
    sort: row.sort,
    displayUrl: row.display_url,
    lastSyncedAt: row.last_synced_at === null ? null : isoUtc(row.last_synced_at),
    lastError: row.last_error,
  };
}

export function toCalendarEvent(row: EventRow, calendar: CalendarRow): CalendarEvent {
  const status = isStatus(row.status) ? row.status : 'confirmed';
  return {
    id: row.id,
    calendarId: row.calendar_id,
    title: row.title,
    location: row.location,
    description: row.description,
    start: row.start,
    end: row.end,
    allDay: row.all_day === 1,
    timezone: row.timezone,
    status,
    recurring: row.recurring === 1,
    seriesId: row.series_id,
    htmlUrl: row.html_url,
    meetingUrl: row.meeting_url,
    editable: row.editable === 1 && isWritableRow(calendar),
  };
}
