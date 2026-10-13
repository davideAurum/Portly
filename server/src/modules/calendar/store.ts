/**
 * Calendar storage (§5 `calendars`, `events`): row mapping, ingest sanitization, deterministic
 * event ids, calendar upserts per account and the per-calendar "replace window" transaction.
 * SQL uses prepared statements only; PATCH fields map to columns through static allowlists.
 */
import {
  CALENDAR_WARNING_PREFIX,
  EVENT_STATUSES,
  EVENT_TEXT_LIMITS,
  normalizeHexColor,
  toSafeHttpUrl,
  type Account,
  type Calendar,
  type CalendarEvent,
  type CalendarSource,
  type EventStatus,
} from '@homebase/shared';
import type { Db } from '../../db/open.ts';
import { newId, sha1Hex } from '../../lib/ids.ts';
import { descriptionText, singleLine } from './text.ts';
import { isIsoDate, isKnownTimeZone, isoUtc, normalizeInstant, addDays } from './time.ts';
import type { CalendarRow, EventRecord, EventRow, RemoteCalendar } from './types.ts';

export const MAX_CALENDAR_NAME = 200;
export const MAX_LAST_ERROR = 500;
export const MAX_REMOTE_ID = 1024;
export const UNTITLED_EVENT = '(No title)';

/** Calm fallback palette for calendars without a provider color (matches the web swatches). */
const FALLBACK_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#14b8a6', '#ef4444', '#f59e0b', '#06b6d4', '#d946ef', '#6366f1', '#84cc16', '#64748b'] as const;

export function fallbackColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length]!;
}

/** Deterministic event id (§5): `${calendarId}:${sha1(remoteId + '|' + (instanceKey ?? ''))}`. */
export function eventId(calendarId: string, remoteId: string, instanceKey: string | null): string {
  return `${calendarId}:${sha1Hex(`${remoteId}|${instanceKey ?? ''}`)}`;
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
export function sanitizeEvent(calendarId: string, record: EventRecord): SanitizedEvent | null {
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
    id: eventId(calendarId, record.remoteId, instanceKey),
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

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

const CALENDAR_COLUMNS =
  'id, account_id, source, remote_id, name, color, color_override, provider_writable, user_read_only, visible, is_primary, sort, display_url, collection_url, sync_state, last_synced_at, last_error';

export function getCalendarRow(db: Db, id: string): CalendarRow | null {
  return db.get<CalendarRow>(`SELECT ${CALENDAR_COLUMNS} FROM calendars WHERE id = ?`, [id]) ?? null;
}

export function listCalendarRows(db: Db): CalendarRow[] {
  return db.all<CalendarRow>(`SELECT ${CALENDAR_COLUMNS} FROM calendars ORDER BY sort, name`);
}

export function accountCalendarRows(db: Db, accountId: string): CalendarRow[] {
  return db.all<CalendarRow>(`SELECT ${CALENDAR_COLUMNS} FROM calendars WHERE account_id = ? ORDER BY sort, name`, [accountId]);
}

export function icsCalendarRows(db: Db): CalendarRow[] {
  return db.all<CalendarRow>(`SELECT ${CALENDAR_COLUMNS} FROM calendars WHERE source = 'ics' ORDER BY sort, name`);
}

/**
 * Calendars that are currently in use: ICS feeds, plus calendars of accounts that exist and have
 * the calendar capability enabled (rows of disabled accounts are kept so settings survive).
 * Ordered like the settings page: by account order, ICS feeds last.
 */
export function activeCalendarRows(db: Db, calendarAccounts: readonly Account[]): CalendarRow[] {
  const order = new Map(calendarAccounts.map((a, i) => [a.id, i] as const));
  return listCalendarRows(db)
    .filter((row) => row.account_id === null || order.has(row.account_id))
    .sort((a, b) => {
      const oa = a.account_id === null ? Number.MAX_SAFE_INTEGER : (order.get(a.account_id) ?? 0);
      const ob = b.account_id === null ? Number.MAX_SAFE_INTEGER : (order.get(b.account_id) ?? 0);
      return oa - ob || b.is_primary - a.is_primary || a.sort - b.sort || a.name.localeCompare(b.name);
    });
}

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

/**
 * Upserts an account's calendars by `(account_id, remote_id)` and removes the ones that
 * disappeared upstream (their events cascade). Provider fields (name, color, writability,
 * primary) are refreshed; user fields (visible, color override, read-only, sort) are kept.
 */
export function upsertAccountCalendars(db: Db, accountId: string, source: CalendarSource, remotes: readonly RemoteCalendar[]): CalendarRow[] {
  return db.tx(() => {
    const existing = new Map(accountCalendarRows(db, accountId).map((row) => [row.remote_id, row] as const));
    const seen = new Set<string>();
    remotes.forEach((remote, index) => {
      const remoteId = remote.remoteId.slice(0, MAX_REMOTE_ID);
      if (remoteId === '' || seen.has(remoteId)) return;
      seen.add(remoteId);
      const name = singleLine(remote.name, MAX_CALENDAR_NAME) ?? 'Calendar';
      const color = normalizeHexColor(remote.color);
      const collectionUrl = remote.collectionUrl ?? null;
      const row = existing.get(remoteId);
      if (row) {
        db.run(
          `UPDATE calendars SET name = ?, color = ?, provider_writable = ?, is_primary = ?, collection_url = ? WHERE id = ?`,
          [name, color, remote.writable ? 1 : 0, remote.primary ? 1 : 0, collectionUrl, row.id],
        );
      } else {
        db.run(
          `INSERT INTO calendars (id, account_id, source, remote_id, name, color, provider_writable, visible, is_primary, sort, collection_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId(), accountId, source, remoteId, name, color, remote.writable ? 1 : 0, remote.visible === false ? 0 : 1, remote.primary ? 1 : 0, index, collectionUrl],
        );
      }
    });
    for (const row of existing.values()) {
      if (!seen.has(row.remote_id)) db.run('DELETE FROM calendars WHERE id = ?', [row.id]);
    }
    return accountCalendarRows(db, accountId);
  });
}

export function setCalendarError(db: Db, id: string, message: string): void {
  db.run('UPDATE calendars SET last_error = ? WHERE id = ?', [message.slice(0, MAX_LAST_ERROR), id]);
}

/** `last_error` text of a non-fatal sync warning (the UI shows it as a warning, not a failure). */
export function syncWarningText(warning: string): string {
  return `${CALENDAR_WARNING_PREFIX}${warning}`.slice(0, MAX_LAST_ERROR);
}

/**
 * Warning for events shortened by the per-event recurrence limits (§4.9) and/or instances stored
 * without their description (text budget), or null. The sync itself succeeded: the calendar is
 * not marked as failed.
 */
export function truncationWarning(truncated: number, descriptionsDropped = 0): string | null {
  const parts: string[] = [];
  if (truncated > 0) {
    const which = truncated === 1 ? '1 event repeats' : `${truncated.toLocaleString('en-US')} events repeat`;
    parts.push(`Some repeating events were shortened: ${which} too often, so only the first occurrences are shown.`);
  }
  if (descriptionsDropped > 0) parts.push('Some event descriptions were left out because this calendar is very large.');
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Marks a calendar synced: `last_error` becomes the warning (see {@link syncWarningText}) or null;
 * `syncState` undefined keeps the stored one.
 */
export function setCalendarSynced(db: Db, id: string, now: number, syncState?: string | null, warning: string | null = null): void {
  const lastError = warning === null ? null : syncWarningText(warning);
  if (syncState === undefined) db.run('UPDATE calendars SET last_synced_at = ?, last_error = ? WHERE id = ?', [now, lastError, id]);
  else db.run('UPDATE calendars SET last_synced_at = ?, last_error = ?, sync_state = ? WHERE id = ?', [now, lastError, syncState, id]);
}

/**
 * The source reported no change since the last sync (ICS 304, …): errors are cleared, but a
 * warning about the unchanged data stays.
 */
export function setCalendarUnchanged(db: Db, id: string, now: number): void {
  db.run(
    `UPDATE calendars SET last_synced_at = ?, last_error = CASE WHEN substr(last_error, 1, ?) = ? THEN last_error ELSE NULL END WHERE id = ?`,
    [now, CALENDAR_WARNING_PREFIX.length, CALENDAR_WARNING_PREFIX, id],
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const EVENT_COLUMNS =
  'id, calendar_id, remote_id, instance_key, etag, title, location, description, start, "end", all_day, timezone, status, recurring, series_id, html_url, meeting_url, editable, updated_at';

const UPSERT_EVENT = `INSERT INTO events (${EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET remote_id = excluded.remote_id, instance_key = excluded.instance_key, etag = excluded.etag,
    title = excluded.title, location = excluded.location, description = excluded.description, start = excluded.start,
    "end" = excluded."end", all_day = excluded.all_day, timezone = excluded.timezone, status = excluded.status,
    recurring = excluded.recurring, series_id = excluded.series_id, html_url = excluded.html_url,
    meeting_url = excluded.meeting_url, editable = excluded.editable, updated_at = excluded.updated_at`;

/**
 * Sync upsert: never overwrites a row written (write-through) after the listing was requested,
 * and leaves unchanged rows alone (a big calendar is not rewritten on every sync).
 */
const UPSERT_EVENT_FROM_LISTING = `${UPSERT_EVENT} WHERE events.updated_at < ? AND (
    events.remote_id IS NOT excluded.remote_id OR events.instance_key IS NOT excluded.instance_key OR
    events.etag IS NOT excluded.etag OR events.title IS NOT excluded.title OR events.location IS NOT excluded.location OR
    events.description IS NOT excluded.description OR events.start IS NOT excluded.start OR events."end" IS NOT excluded."end" OR
    events.all_day IS NOT excluded.all_day OR events.timezone IS NOT excluded.timezone OR events.status IS NOT excluded.status OR
    events.recurring IS NOT excluded.recurring OR events.series_id IS NOT excluded.series_id OR
    events.html_url IS NOT excluded.html_url OR events.meeting_url IS NOT excluded.meeting_url OR events.editable IS NOT excluded.editable)`;

function writeEvent(db: Db, calendarId: string, e: SanitizedEvent, now: number, listingStartedAt?: number): void {
  const values = [
    e.id,
    calendarId,
    e.remoteId,
    e.instanceKey,
    e.etag,
    e.title,
    e.location,
    e.description,
    e.start,
    e.end,
    e.allDay ? 1 : 0,
    e.timezone,
    e.status,
    e.recurring ? 1 : 0,
    e.seriesId,
    e.htmlUrl,
    e.meetingUrl,
    e.editable ? 1 : 0,
    now,
  ];
  if (listingStartedAt === undefined) db.run(UPSERT_EVENT, values);
  else db.run(UPSERT_EVENT_FROM_LISTING, [...values, listingStartedAt]);
}

export function getEventRow(db: Db, id: string): EventRow | null {
  return db.get<EventRow>(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`, [id]) ?? null;
}

/** Sanitizes and upserts one event (write-through); returns the stored row, or null when invalid. */
export function upsertEvent(db: Db, calendarId: string, record: EventRecord, now: number): EventRow | null {
  const clean = sanitizeEvent(calendarId, record);
  if (!clean) return null;
  writeEvent(db, calendarId, clean, now);
  return getEventRow(db, clean.id);
}

export function deleteEventRow(db: Db, id: string): void {
  db.run('DELETE FROM events WHERE id = ?', [id]);
}

export interface ReplaceOptions {
  now: number;
  /** When the provider fetch started: rows written after it (write-through) are never deleted or overwritten. */
  startedAt: number;
  /** New `sync_state` (undefined keeps the stored one). */
  syncState?: string | null;
  /** Event ids deleted through the API moments ago (not re-inserted from an older listing). */
  skipIds?: ReadonlySet<string>;
  /** Non-fatal warning recorded as `last_error` (e.g. shortened repeating events); default none. */
  warning?: string | null;
  /** Event ids Homebase wrote recently: the result names the ones this listing deletes. */
  watchIds?: ReadonlySet<string>;
  /** Global limits (tests); default {@link MAX_STORED_EVENTS} / {@link MAX_STORED_EVENT_CHARS}. */
  storageLimits?: { events: number; chars: number };
}

export interface ReplaceResult {
  upserted: number;
  deleted: number;
  /** The listing would have pushed the stored events past the global limits: nothing changed. */
  limited?: boolean;
  /** The calendar no longer exists (removed while fetching): nothing changed. */
  removed?: boolean;
  /** Ids of {@link ReplaceOptions.watchIds} that this listing deleted (only when some were). */
  deletedWatched?: string[];
}

/**
 * Global limits on what the events cache holds across every calendar and feed (§4.1(d)): each
 * sync job is bounded on its own (§4.9 instances, text budget), but a hostile server with many
 * calendars, or many feeds, would otherwise multiply that.
 */
export const MAX_STORED_EVENTS = 100_000;
export const MAX_STORED_EVENT_CHARS = 64 * 1024 * 1024;
export const STORAGE_LIMIT_ERROR =
  'This calendar was not updated: Homebase already stores as many calendar events as it keeps. Remove a very large calendar or feed to make room.';

interface StoredTotals {
  rows: number;
  chars: number;
}

/** Rows and text stored per calendar, computed once per database and kept current by replaces. */
const storedTotalsByDb = new WeakMap<Db, Map<string, StoredTotals>>();

function storedTotals(db: Db): Map<string, StoredTotals> {
  let totals = storedTotalsByDb.get(db);
  if (!totals) {
    totals = new Map();
    const rows = db.all<{ calendar_id: string; rows: number; chars: number | null }>(
      `SELECT calendar_id, COUNT(*) AS rows, SUM(length(title) + IFNULL(length(location), 0) + IFNULL(length(description), 0)) AS chars
       FROM events GROUP BY calendar_id`,
    );
    for (const row of rows) totals.set(row.calendar_id, { rows: row.rows, chars: row.chars ?? 0 });
    storedTotalsByDb.set(db, totals);
  }
  return totals;
}

function eventChars(e: SanitizedEvent): number {
  return e.title.length + (e.location?.length ?? 0) + (e.description?.length ?? 0);
}

/**
 * One transaction per calendar (§9): upsert every returned event by deterministic id, delete
 * the calendar's events that were not returned, and mark the calendar synced. A listing that
 * would exceed {@link MAX_STORED_EVENTS} / {@link MAX_STORED_EVENT_CHARS} (with every other
 * calendar's rows) changes nothing and records {@link STORAGE_LIMIT_ERROR}. Deleted rows that the
 * caller watches (events Homebase wrote moments ago) are reported in `deletedWatched`.
 */
export function replaceCalendarEvents(db: Db, calendarId: string, records: readonly EventRecord[], options: ReplaceOptions): ReplaceResult {
  const byId = new Map<string, SanitizedEvent>();
  let chars = 0;
  for (const record of records) {
    const clean = sanitizeEvent(calendarId, record);
    if (clean && !byId.has(clean.id) && !options.skipIds?.has(clean.id)) {
      byId.set(clean.id, clean);
      chars += eventChars(clean);
    }
  }
  return db.tx(() => {
    // The calendar may have been removed (account deleted, feed removed) while fetching.
    if (!db.get('SELECT 1 AS ok FROM calendars WHERE id = ?', [calendarId])) return { upserted: 0, deleted: 0, removed: true };

    const totals = storedTotals(db);
    const live = new Set(db.all<{ id: string }>('SELECT id FROM calendars').map((r) => r.id));
    let otherRows = 0;
    let otherChars = 0;
    for (const [id, t] of totals) {
      if (!live.has(id)) totals.delete(id);
      else if (id !== calendarId) {
        otherRows += t.rows;
        otherChars += t.chars;
      }
    }
    const limits = options.storageLimits ?? { events: MAX_STORED_EVENTS, chars: MAX_STORED_EVENT_CHARS };
    if (otherRows + byId.size > limits.events || otherChars + chars > limits.chars) {
      setCalendarError(db, calendarId, STORAGE_LIMIT_ERROR);
      return { upserted: 0, deleted: 0, limited: true };
    }

    // A write-through upsert during the fetch is newer than this listing: keep it (and its row).
    for (const e of byId.values()) writeEvent(db, calendarId, e, options.now, options.startedAt);
    const kept = JSON.stringify([...byId.keys()]);
    const watched = options.watchIds && options.watchIds.size > 0 ? JSON.stringify([...options.watchIds]) : null;
    const deletedWatched =
      watched === null
        ? []
        : db
            .all<{ id: string }>(
              `SELECT id FROM events WHERE calendar_id = ? AND updated_at < ? AND id NOT IN (SELECT value FROM json_each(?))
                 AND id IN (SELECT value FROM json_each(?))`,
              [calendarId, options.startedAt, kept, watched],
            )
            .map((r) => r.id);
    const deleted = db.run(
      `DELETE FROM events WHERE calendar_id = ? AND updated_at < ? AND id NOT IN (SELECT value FROM json_each(?))`,
      [calendarId, options.startedAt, kept],
    ).changes;
    setCalendarSynced(db, calendarId, options.now, options.syncState, options.warning ?? null);
    totals.set(calendarId, { rows: byId.size, chars });
    return deletedWatched.length > 0 ? { upserted: byId.size, deleted, deletedWatched } : { upserted: byId.size, deleted };
  });
}

export interface EventRange {
  fromInstant: string;
  toInstant: string;
  fromDate: string;
  toDate: string;
}

/**
 * §7 events query over the given calendars (to exclusive). A zero-length timed event (start ==
 * end) belongs to the range it starts in, including exactly at its first instant (like the
 * expansion's and the web's overlap rules).
 */
export function queryEventRows(db: Db, calendarIds: readonly string[], range: EventRange): EventRow[] {
  if (calendarIds.length === 0) return [];
  return db.all<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events
     WHERE calendar_id IN (SELECT value FROM json_each(:ids))
       AND ((all_day = 0 AND start < :toInstant AND ("end" > :fromInstant OR start = :fromInstant))
         OR (all_day = 1 AND start < :toDate AND "end" > :fromDate))
     ORDER BY start, all_day DESC, title`,
    { ids: JSON.stringify(calendarIds), toInstant: range.toInstant, fromInstant: range.fromInstant, toDate: range.toDate, fromDate: range.fromDate },
  );
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
