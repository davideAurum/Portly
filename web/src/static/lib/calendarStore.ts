/**
 * Calendar storage of the static backend (port of server/src/modules/calendar/store.ts over the
 * `calendars` / `calendar-events` slices instead of SQLite): the calendars in use, calendar upserts
 * per account, the per-calendar "replace window" step of a sync, write-through upserts and the
 * events query. Every function here is synchronous and mutates the live slices: callers read them
 * after their last `await` and commit right after (a reload from another tab replaces the slice
 * objects, so a reference kept across an `await` may be stale).
 *
 * Event rows carry the server's `updated_at` rule: a row written through the API after a listing
 * was requested is never overwritten or deleted by that listing, and unchanged rows keep their
 * `updated_at` (nothing is rewritten when a sync finds no change).
 */
import { CALENDAR_WARNING_PREFIX, normalizeHexColor, type CalendarSource } from '@portly/shared';
import type { StaticContext } from '../context.ts';
import { getCalendarEvents, getCalendars, getCalendarSync, getSettings, setSettings, type StoredAccount } from '../slices.ts';
import { MAX_CALENDAR_NAME, MAX_LAST_ERROR, MAX_REMOTE_ID, toEventRow, type CalendarRow, type EventRow, type RemoteCalendar, type SanitizedEvent } from './calendarRecords.ts';
import { singleLine } from './calendarText.ts';

/**
 * Limits on what the browser's events cache holds across every calendar (§4.1(d)), lower than the
 * server's: it lives in the browser's storage and is read whole when the page starts.
 */
export const MAX_STORED_EVENTS = 25_000;
export const MAX_STORED_EVENT_CHARS = 16 * 1024 * 1024;
export const STORAGE_LIMIT_ERROR =
  'This calendar was not updated: Portly already stores as many calendar events as it keeps in this browser. Hide or remove a very large calendar to make room.';

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

export function getCalendarRow(ctx: StaticContext, id: string): CalendarRow | null {
  return getCalendars(ctx).find((row) => row.id === id) ?? null;
}

function byRowOrder(a: CalendarRow, b: CalendarRow): number {
  return a.sort - b.sort || a.name.localeCompare(b.name);
}

/** The server's event order: start, all-day first, then title (binary comparison, like SQLite). */
function byEventOrder(a: EventRow, b: EventRow): number {
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  return b.all_day - a.all_day || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
}

export function accountCalendarRows(ctx: StaticContext, accountId: string): CalendarRow[] {
  return getCalendars(ctx)
    .filter((row) => row.account_id === accountId)
    .sort(byRowOrder);
}

/**
 * Calendars that are currently in use: those of accounts that exist and have the calendar
 * capability enabled (rows of switched-off accounts are kept so their settings survive). Ordered
 * like the settings page: by account order, primary first.
 */
export function activeCalendarRows(ctx: StaticContext, calendarAccounts: readonly Pick<StoredAccount, 'id'>[]): CalendarRow[] {
  const order = new Map(calendarAccounts.map((a, i) => [a.id, i] as const));
  return getCalendars(ctx)
    .filter((row) => row.account_id !== null && order.has(row.account_id))
    .sort((a, b) => (order.get(a.account_id!) ?? 0) - (order.get(b.account_id!) ?? 0) || b.is_primary - a.is_primary || byRowOrder(a, b));
}

/**
 * Removes calendars and their events, and the default calendar setting when it named one. Returns
 * true when the settings changed (the caller commits them too).
 */
function dropCalendars(ctx: StaticContext, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  const rows = getCalendars(ctx);
  for (let i = rows.length - 1; i >= 0; i--) if (ids.has(rows[i]!.id)) rows.splice(i, 1);
  const events = getCalendarEvents(ctx);
  for (const id of ids) delete events[id];
  const settings = getSettings(ctx);
  const preferred = settings.calendar.defaultCalendarId;
  if (preferred === null || !ids.has(preferred)) return false;
  setSettings(ctx, { ...settings, calendar: { ...settings.calendar, defaultCalendarId: null } });
  return true;
}

/** A remote calendar's stored id (`remote_id` is capped like the stored one). */
export function remoteKey(remote: Pick<RemoteCalendar, 'remoteId'>): string {
  return remote.remoteId.slice(0, MAX_REMOTE_ID);
}

/**
 * The id each listed calendar has, or will get when {@link upsertAccountCalendars} stores it: event
 * ids are derived from it, so a sync computes them before it stores anything.
 */
export function calendarIdsFor(ctx: StaticContext, accountId: string, remotes: readonly RemoteCalendar[]): Map<string, string> {
  const existing = new Map(accountCalendarRows(ctx, accountId).map((row) => [row.remote_id, row.id] as const));
  const ids = new Map<string, string>();
  for (const remote of remotes) {
    const key = remoteKey(remote);
    if (key !== '' && !ids.has(key)) ids.set(key, existing.get(key) ?? ctx.newId());
  }
  return ids;
}

/**
 * Upserts an account's calendars by `(account_id, remote_id)` and removes the ones that disappeared
 * upstream (with their events). Provider fields (name, color, writability, primary) are refreshed;
 * user fields (visible, color override, read-only, sort) are kept. New calendars take their id from
 * `ids` (see {@link calendarIdsFor}). Returns the account's rows, and whether the settings changed
 * (a removed calendar was the default one).
 */
export function upsertAccountCalendars(
  ctx: StaticContext,
  accountId: string,
  source: CalendarSource,
  remotes: readonly RemoteCalendar[],
  ids: ReadonlyMap<string, string> = new Map(),
): { rows: CalendarRow[]; settingsChanged: boolean } {
  const rows = getCalendars(ctx);
  const existing = new Map(rows.filter((row) => row.account_id === accountId).map((row) => [row.remote_id, row] as const));
  const seen = new Set<string>();
  remotes.forEach((remote, index) => {
    const remoteId = remoteKey(remote);
    if (remoteId === '' || seen.has(remoteId)) return;
    seen.add(remoteId);
    const name = singleLine(remote.name, MAX_CALENDAR_NAME) ?? 'Calendar';
    const color = normalizeHexColor(remote.color);
    const row = existing.get(remoteId);
    if (row) {
      row.name = name;
      row.color = color;
      row.provider_writable = remote.writable ? 1 : 0;
      row.is_primary = remote.primary ? 1 : 0;
    } else {
      rows.push({
        id: ids.get(remoteId) ?? ctx.newId(),
        account_id: accountId,
        source,
        remote_id: remoteId,
        name,
        color,
        color_override: null,
        provider_writable: remote.writable ? 1 : 0,
        user_read_only: 0,
        visible: remote.visible === false ? 0 : 1,
        is_primary: remote.primary ? 1 : 0,
        sort: index,
        display_url: null,
        collection_url: null,
        sync_state: null,
        last_synced_at: null,
        last_error: null,
      });
    }
  });
  const settingsChanged = dropCalendars(ctx, new Set([...existing.values()].filter((row) => !seen.has(row.remote_id)).map((row) => row.id)));
  return { rows: accountCalendarRows(ctx, accountId), settingsChanged };
}

/**
 * Removes an account's calendars, their events and its sync state (the account was deleted).
 * Returns whether anything was removed, and whether the settings changed.
 */
export function removeAccountCalendars(ctx: StaticContext, accountId: string): { removed: boolean; settingsChanged: boolean } {
  const ids = new Set(accountCalendarRows(ctx, accountId).map((row) => row.id));
  const sync = getCalendarSync(ctx);
  const hadSync = accountId in sync;
  delete sync[accountId];
  const settingsChanged = dropCalendars(ctx, ids);
  return { removed: ids.size > 0 || hadSync, settingsChanged };
}

export function setCalendarError(row: CalendarRow, message: string): void {
  row.last_error = message.slice(0, MAX_LAST_ERROR);
}

/** `last_error` text of a non-fatal sync warning (the UI shows it as a warning, not a failure). */
export function syncWarningText(warning: string): string {
  return `${CALENDAR_WARNING_PREFIX}${warning}`.slice(0, MAX_LAST_ERROR);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function getEventRow(ctx: StaticContext, id: string): EventRow | null {
  const calendarId = id.slice(0, id.lastIndexOf(':'));
  return getCalendarEvents(ctx)[calendarId]?.find((row) => row.id === id) ?? null;
}

/** True when the stored row already says what the listing says (`updated_at` aside). */
function sameContent(row: EventRow, next: EventRow): boolean {
  return (
    row.remote_id === next.remote_id &&
    row.instance_key === next.instance_key &&
    row.etag === next.etag &&
    row.title === next.title &&
    row.location === next.location &&
    row.description === next.description &&
    row.start === next.start &&
    row.end === next.end &&
    row.all_day === next.all_day &&
    row.timezone === next.timezone &&
    row.status === next.status &&
    row.recurring === next.recurring &&
    row.series_id === next.series_id &&
    row.html_url === next.html_url &&
    row.meeting_url === next.meeting_url &&
    row.editable === next.editable
  );
}

/** Upserts one sanitized event (write-through); returns the stored row. */
export function upsertEvent(ctx: StaticContext, calendarId: string, event: SanitizedEvent, now: number): EventRow {
  const events = getCalendarEvents(ctx);
  const list = (events[calendarId] ??= []);
  const row = toEventRow(calendarId, event, now);
  const index = list.findIndex((r) => r.id === row.id);
  if (index === -1) list.push(row);
  else list[index] = row;
  return row;
}

export function deleteEventRow(ctx: StaticContext, id: string): void {
  const calendarId = id.slice(0, id.lastIndexOf(':'));
  const list = getCalendarEvents(ctx)[calendarId];
  if (!list) return;
  const index = list.findIndex((row) => row.id === id);
  if (index !== -1) list.splice(index, 1);
}

export interface ReplaceOptions {
  now: number;
  /** When the provider fetch started: rows written after it (write-through) are never deleted or overwritten. */
  startedAt: number;
  /** Event ids deleted through the API moments ago (not re-inserted from an older listing). */
  skipIds?: ReadonlySet<string>;
  /** Non-fatal warning recorded as `last_error`; default none. */
  warning?: string | null;
  /** Global limits (tests); default {@link MAX_STORED_EVENTS} / {@link MAX_STORED_EVENT_CHARS}. */
  storageLimits?: { events: number; chars: number };
}

export interface ReplaceResult {
  upserted: number;
  deleted: number;
  /** The listing would have pushed the stored events past the limits: nothing changed. */
  limited?: boolean;
  /** The calendar no longer exists (removed while fetching): nothing changed. */
  removed?: boolean;
  /** The stored events changed (a row was added, changed or deleted). */
  changed: boolean;
}

function eventChars(e: { title: string; location: string | null; description: string | null }): number {
  return e.title.length + (e.location?.length ?? 0) + (e.description?.length ?? 0);
}

/**
 * The per-calendar step of a sync (§9): upsert every returned event by deterministic id, delete the
 * calendar's events that were not returned, and mark the calendar synced. A listing that would
 * exceed the storage limits (with every other calendar's rows) changes nothing and records
 * {@link STORAGE_LIMIT_ERROR}.
 */
export function replaceCalendarEvents(ctx: StaticContext, calendarId: string, sanitized: readonly SanitizedEvent[], options: ReplaceOptions): ReplaceResult {
  const row = getCalendarRow(ctx, calendarId);
  if (!row) return { upserted: 0, deleted: 0, removed: true, changed: false };

  const byId = new Map<string, SanitizedEvent>();
  let chars = 0;
  for (const event of sanitized) {
    if (byId.has(event.id) || options.skipIds?.has(event.id)) continue;
    byId.set(event.id, event);
    chars += eventChars(event);
  }

  const events = getCalendarEvents(ctx);
  let otherRows = 0;
  let otherChars = 0;
  for (const [id, list] of Object.entries(events)) {
    if (id === calendarId) continue;
    otherRows += list.length;
    for (const e of list) otherChars += eventChars(e);
  }
  const limits = options.storageLimits ?? { events: MAX_STORED_EVENTS, chars: MAX_STORED_EVENT_CHARS };
  if (otherRows + byId.size > limits.events || otherChars + chars > limits.chars) {
    setCalendarError(row, STORAGE_LIMIT_ERROR);
    return { upserted: 0, deleted: 0, limited: true, changed: false };
  }

  const current = new Map((events[calendarId] ?? []).map((r) => [r.id, r] as const));
  const next: EventRow[] = [];
  let changed = false;
  for (const event of byId.values()) {
    const stored = current.get(event.id);
    current.delete(event.id);
    const fresh = toEventRow(calendarId, event, options.now);
    // A write-through upsert during the fetch is newer than this listing: keep it.
    if (stored && (stored.updated_at >= options.startedAt || sameContent(stored, fresh))) next.push(stored);
    else {
      next.push(fresh);
      changed = true;
    }
  }
  let deleted = 0;
  for (const stored of current.values()) {
    if (stored.updated_at >= options.startedAt) next.push(stored);
    else deleted++;
  }
  if (deleted > 0) changed = true;
  next.sort(byEventOrder);
  if (changed || !(calendarId in events)) events[calendarId] = next;

  row.last_synced_at = options.now;
  row.last_error = options.warning ? syncWarningText(options.warning) : null;
  return { upserted: byId.size, deleted, changed };
}

export interface EventRange {
  fromInstant: string;
  toInstant: string;
  fromDate: string;
  toDate: string;
}

/**
 * §7 events query over the given calendars (to exclusive), ordered by start, all-day first, then
 * title. A zero-length timed event (start == end) belongs to the range it starts in, including
 * exactly at its first instant.
 */
export function queryEventRows(ctx: StaticContext, calendarIds: readonly string[], range: EventRange): EventRow[] {
  const events = getCalendarEvents(ctx);
  const out: EventRow[] = [];
  for (const id of calendarIds) {
    for (const row of events[id] ?? []) {
      const hit =
        row.all_day === 0
          ? row.start < range.toInstant && (row.end > range.fromInstant || row.start === range.fromInstant)
          : row.start < range.toDate && row.end > range.fromDate;
      if (hit) out.push(row);
    }
  }
  return out.sort(byEventOrder);
}
