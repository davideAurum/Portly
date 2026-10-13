/**
 * Calendar module of the static backend: the calendars of Outlook.com accounts, synced from
 * Microsoft Graph by the browser itself (providers/graphClient.ts, with the account's token from
 * handlers/accounts.ts) into the `calendars` / `calendar-events` slices. A port of
 * server/src/modules/calendar (routes.ts, and the sync and write parts of service.ts) without ICS
 * feeds, Google or CalDAV, which need the server (their routes stay in handlers/unavailable.ts).
 *
 * Routes (same shapes and errors as the server):
 * - `GET /api/calendar/calendars` → `Calendar[]` (calendars of accounts with the calendar
 *   capability enabled; color = override > provider > account > palette)
 * - `PATCH /api/calendar/calendars/:id {visible?, colorOverride?, userReadOnly?, sort?}` → `Calendar`
 * - `DELETE /api/calendar/calendars/:id` → `409 conflict` (account calendars go with their account)
 * - `GET /api/calendar/events?from&to&tz[&calendarIds]` → `{events, window, truncated?}` (409
 *   `not_configured` without calendars), clipped to the synced window
 * - `POST /api/calendar/events` → 201 `CalendarEvent` · `PATCH|DELETE /api/calendar/events/:id`
 *   (single instance, written through to Graph, then cached)
 * - `POST /api/calendar/sync` → `Calendar[]` after a full sync
 *
 * Sync: there is no background job in a web page, so the calendar and events requests sync what
 * is due — accounts not tried for `settings.calendar.syncIntervalMin` minutes (the UI asks every
 * few minutes while a calendar is on screen) — and wait for it, at most {@link SYNC_WAIT_MS}: the
 * answer then carries the new data. A sync that takes longer goes on, and tells the app when it is
 * done (`ctx.notify`). Per account: list the calendars (upsert, remove the ones gone upstream),
 * fetch each calendar's window `[today-30d, today+365d)`, replace its events, all stored in one
 * commit. Tabs of the site take turns with a Web Lock per account and re-read the stored sync
 * time first, so one tab's sync serves the others (its commit reaches them like any change).
 *
 * Failures keep the cached events and say why on the calendar (`last_error`): a calendar list
 * that cannot be read marks every calendar of the account, or the account itself when it has
 * none yet (`Calendars could not be loaded: …`). Access refused or a calendar gone waits 15
 * minutes, doubling up to 6 hours; a rate limit makes the whole account wait for Graph's
 * `Retry-After` (else the next interval); an account that must be reconnected stops its sync. A
 * sync that cannot be stored (the browser's storage is full) makes this page wait at least
 * {@link SYNC_BACKOFF_BASE_MS} before fetching the account again. "Sync now"
 * (`POST /api/calendar/sync`) ignores every wait.
 */
import {
  CalendarUpdateSchema,
  EntityId,
  EventInputSchema,
  EventUpdateSchema,
  EventsQuerySchema,
  normalizeHexColor,
  type Calendar,
  type CalendarEvent,
  type EventsResponse,
} from '@portly/shared';
import { recordClientEvent } from '../../diagnostics/clientLog.ts';
import type { StaticContext } from '../context.ts';
import { MAX_LAST_ERROR, isWritableRow, sanitizeEvent, toCalendar, toCalendarEvent, type CalendarRow, type EventRecord, type RemoteCalendar, type SanitizedEvent } from '../lib/calendarRecords.ts';
import {
  accountCalendarRows,
  activeCalendarRows,
  calendarIdsFor,
  deleteEventRow,
  getCalendarRow,
  getEventRow,
  queryEventRows,
  remoteKey,
  replaceCalendarEvents,
  setCalendarError,
  upsertAccountCalendars,
  upsertEvent,
} from '../lib/calendarStore.ts';
import { isoUtc, startOfDayMs, syncWindow } from '../lib/calendarTime.ts';
import { parseJsonBody, parseQuery } from '../lib/validate.ts';
import { errorName } from '../providers/diagnostics.ts';
import { GraphHttpError, createGraphEvent, deleteGraphEvent, listGraphCalendars, listGraphEvents, updateGraphEvent } from '../providers/graphClient.ts';
import { StaticApiError, json, noContent } from '../respond.ts';
import type { StaticRouter } from '../router.ts';
import {
  SLICE,
  getAccounts,
  getCalendarEvents,
  getCalendars,
  getCalendarSync,
  getSettings,
  type CalendarSyncState,
  type StoredAccount,
  type SyncFailureState,
} from '../slices.ts';
import { calendarAccounts, withAccountLock } from './accounts.ts';

/** How long a calendar or events request waits for the sync it started (or found running). */
export const SYNC_WAIT_MS = 15_000;
/** One events response carries at most this many events… */
export const MAX_EVENTS_PER_RESPONSE = 5_000;
/** …and this much event text (title, location, description, links; chars). */
export const MAX_EVENTS_RESPONSE_CHARS = 4 * 1024 * 1024;
export const SYNC_BACKOFF_BASE_MS = 15 * 60 * 1000;
export const SYNC_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
/** An event deleted through the API is not brought back by a listing fetched before the delete. */
const TOMBSTONE_MS = 10 * 60 * 1000;

/** Prefix of the account status message set when an account's calendar list cannot be read. */
export const CALENDAR_LIST_ERROR_PREFIX = 'Calendars could not be loaded: ';
export const NO_CALENDARS_MESSAGE = 'No calendars yet. Connect an Outlook.com account in Settings → Accounts.';

/** Wait before the next scheduled attempt after `failures` consecutive persistent failures. */
export function syncBackoffMs(failures: number): number {
  return Math.min(SYNC_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), SYNC_BACKOFF_MAX_MS);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Our own error messages are safe to store and show; anything else becomes a generic message. */
export function errorText(err: unknown, fallback = 'Sync failed'): string {
  if (err instanceof StaticApiError) return err.message.slice(0, MAX_LAST_ERROR);
  return fallback;
}

/** The account cannot be used (reconnect, or no OAuth client): its own status says why, and its calendars wait for it. */
function isAccountUnusable(err: unknown): boolean {
  return err instanceof StaticApiError && (err.code === 'reauth_required' || err.code === 'not_configured');
}

function isRateLimited(err: unknown): boolean {
  return err instanceof StaticApiError && err.code === 'rate_limited';
}

/** Failures that retrying every interval cannot fix (access refused, calendar gone). */
function isPersistentFailure(err: unknown): boolean {
  return err instanceof StaticApiError && (err.code === 'forbidden' || err.code === 'not_found');
}

/** The next failure state of a subject: persistent failures and `Retry-After` wait, others retry next interval. */
function failureState(previous: SyncFailureState | undefined | null, err: unknown, now: number): SyncFailureState {
  const code = err instanceof StaticApiError ? err.code : '';
  const signature = `${code}|${errorText(err)}`;
  const failures = previous?.signature === signature ? previous.failures + 1 : 1;
  const backoffMs = isPersistentFailure(err) ? syncBackoffMs(failures) : 0;
  const retryAfterMs = err instanceof GraphHttpError && err.retryAfterSeconds !== null ? err.retryAfterSeconds * 1000 : 0;
  const waitMs = Math.max(backoffMs, retryAfterMs);
  return { retryAt: waitMs > 0 ? now + waitMs : 0, failures, signature };
}

function idParam(value: string | undefined, what: string): string {
  const parsed = EntityId.safeParse(value);
  if (!parsed.success) throw new StaticApiError('not_found', `${what} not found`);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Per-page state
// ---------------------------------------------------------------------------

interface Runtime {
  /** The sync run in progress, if any. */
  running: Promise<void> | null;
  /** A request stopped waiting for the running sync: the app is told when it ends. */
  late: boolean;
  /** Event ids deleted through the API, until when a listing may not bring them back. */
  tombstones: Map<string, number>;
  /**
   * Accounts whose sync could not be stored (a failed commit, e.g. a full browser storage), until
   * when a scheduled sync waits. The failed commit also rolled back the stored sync time, so
   * without this every request would fetch the whole account from Graph again.
   */
  storeRetryAt: Map<string, number>;
}

const runtimes = new WeakMap<StaticContext, Runtime>();

function runtime(ctx: StaticContext): Runtime {
  let rt = runtimes.get(ctx);
  if (!rt) {
    rt = { running: null, late: false, tombstones: new Map(), storeRetryAt: new Map() };
    runtimes.set(ctx, rt);
  }
  return rt;
}

function liveTombstones(ctx: StaticContext): Set<string> {
  const { tombstones } = runtime(ctx);
  const now = ctx.now();
  for (const [id, expires] of tombstones) if (expires <= now) tombstones.delete(id);
  return new Set(tombstones.keys());
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function syncLockName(accountId: string): string {
  return `portly-static:${import.meta.env.BASE_URL}:calendar-sync:${accountId}`;
}

function intervalMs(ctx: StaticContext): number {
  return getSettings(ctx).calendar.syncIntervalMin * 60_000;
}

/**
 * Whether a scheduled sync of the account is due: not tried for an interval, not waiting out a
 * failure, and not waiting after its last sync could not be stored in this page.
 */
function isDue(ctx: StaticContext, accountId: string, state: CalendarSyncState | undefined, now: number, interval: number): boolean {
  if (now < (runtime(ctx).storeRetryAt.get(accountId) ?? 0)) return false;
  if (!state) return true;
  return now - state.attemptedAt >= interval && now >= (state.failure?.retryAt ?? 0);
}

/** One calendar's listing: the sanitized events, or why it failed (absent: not fetched). */
type Listing = { events: SanitizedEvent[] } | { error: unknown };

interface FetchedAccount {
  remotes: RemoteCalendar[];
  ids: Map<string, string>;
  listings: Map<string, Listing>;
  /** The failure that stopped the run early (account unusable, rate limited). */
  stoppedBy: unknown;
}

/** The network part of an account's sync (nothing is stored here). */
async function fetchAccount(ctx: StaticContext, accountId: string, state: CalendarSyncState | undefined, force: boolean, now: number): Promise<FetchedAccount> {
  const remotes = await listGraphCalendars(ctx, accountId);
  const ids = calendarIdsFor(ctx, accountId, remotes);
  const win = syncWindow(now);
  const listings = new Map<string, Listing>();
  let stoppedBy: unknown = null;
  for (const remote of remotes) {
    const key = remoteKey(remote);
    const calendarId = ids.get(key);
    if (calendarId === undefined || listings.has(key)) continue;
    // A calendar waiting out a failure is skipped (its last error still shows).
    if (!force && (state?.calendars[calendarId]?.retryAt ?? 0) > now) continue;
    let records: EventRecord[];
    try {
      records = await listGraphEvents(ctx, accountId, { remote_id: key, provider_writable: remote.writable ? 1 : 0 }, win);
    } catch (err) {
      listings.set(key, { error: err });
      // No point asking Graph again for this account's other calendars.
      if (isAccountUnusable(err) || isRateLimited(err)) {
        stoppedBy = err;
        break;
      }
      continue;
    }
    const events: SanitizedEvent[] = [];
    for (const record of records) {
      const clean = await sanitizeEvent(calendarId, record);
      if (clean) events.push(clean);
    }
    listings.set(key, { events });
  }
  return { remotes, ids, listings, stoppedBy };
}

/** Sets the account's status (and says whether it changed). */
function setAccountStatus(account: StoredAccount, status: StoredAccount['status'], message: string | null, now: number): boolean {
  if (account.status === status && account.statusMessage === message) return false;
  account.status = status;
  account.statusMessage = message;
  account.updatedAt = now;
  return true;
}

/** Stores a successful listing: calendars, their events, the per-calendar failures. */
async function storeListing(ctx: StaticContext, accountId: string, fetched: FetchedAccount, startedAt: number): Promise<void> {
  await ctx.state.settled();
  // Re-read after the awaits: the account may be gone, or its calendars switched off, meanwhile.
  const account = calendarAccounts(ctx).find((a) => a.id === accountId);
  if (!account) return;
  const now = ctx.now();
  const { rows, settingsChanged } = upsertAccountCalendars(ctx, accountId, 'microsoft', fetched.remotes, fetched.ids);
  const sync = getCalendarSync(ctx);
  const previous = sync[accountId];
  const failures: Record<string, SyncFailureState> = {};
  const skipIds = liveTombstones(ctx);
  let eventsChanged = false;
  for (const row of rows) {
    const listing = fetched.listings.get(row.remote_id);
    if (listing === undefined) {
      if (isAccountUnusable(fetched.stoppedBy)) setCalendarError(row, errorText(fetched.stoppedBy));
      // Skipped (waiting out a failure) or not reached (rate limited): its failure state stays.
      const kept = previous?.calendars[row.id];
      if (kept) failures[row.id] = kept;
      continue;
    }
    if ('error' in listing) {
      setCalendarError(row, errorText(listing.error));
      if (!isAccountUnusable(listing.error)) failures[row.id] = failureState(previous?.calendars[row.id], listing.error, now);
      continue;
    }
    const result = replaceCalendarEvents(ctx, row.id, listing.events, { now, startedAt, skipIds });
    if (result.changed) eventsChanged = true;
  }
  // A rate limit makes the whole account wait (one failure per throttle).
  const throttled = isRateLimited(fetched.stoppedBy) ? failureState(previous?.failure, fetched.stoppedBy, now) : null;
  sync[accountId] = { attemptedAt: now, failure: throttled, calendars: failures };
  const statusChanged =
    account.status === 'error' && account.statusMessage?.startsWith(CALENDAR_LIST_ERROR_PREFIX) === true && setAccountStatus(account, 'ok', null, now);
  await ctx.state.commit(
    SLICE.calendars,
    SLICE.calendarSync,
    // A new calendar gets its (possibly empty) event list too.
    ...(eventsChanged || rows.some((row) => !(row.id in getCalendarEvents(ctx))) ? [SLICE.calendarEvents] : []),
    ...(statusChanged ? [SLICE.accounts] : []),
    ...(settingsChanged ? [SLICE.settings] : []),
  );
}

/** Stores a failed calendar listing: every calendar of the account says why (or the account, when it has none). */
async function storeListFailure(ctx: StaticContext, accountId: string, err: unknown): Promise<void> {
  await ctx.state.settled();
  const account = calendarAccounts(ctx).find((a) => a.id === accountId);
  if (!account) return;
  const now = ctx.now();
  const message = errorText(err);
  const rows = accountCalendarRows(ctx, accountId);
  for (const row of rows) setCalendarError(row, message);
  const sync = getCalendarSync(ctx);
  const previous = sync[accountId];
  sync[accountId] = {
    attemptedAt: now,
    failure: isAccountUnusable(err) ? null : failureState(previous?.failure, err, now),
    calendars: previous?.calendars ?? {},
  };
  // With no calendars there is nowhere else to show it (and the widget would keep waiting for a
  // first sync) — unless the account must be reconnected, which its own status already says.
  const statusChanged =
    !isAccountUnusable(err) &&
    rows.length === 0 &&
    account.status === 'ok' &&
    setAccountStatus(account, 'error', `${CALENDAR_LIST_ERROR_PREFIX}${message}`.slice(0, MAX_LAST_ERROR), now);
  await ctx.state.commit(SLICE.calendarSync, ...(rows.length > 0 ? [SLICE.calendars] : []), ...(statusChanged ? [SLICE.accounts] : []));
}

/** Syncs one account's calendars (when due, or `force`), taking turns with the site's other tabs. */
async function syncAccount(ctx: StaticContext, accountId: string, force: boolean): Promise<void> {
  await withAccountLock(syncLockName(accountId), async () => {
    // Another tab may have synced, or changed the account, while this one waited.
    await ctx.state.reload([SLICE.accounts, SLICE.calendars, SLICE.calendarEvents, SLICE.calendarSync]);
    if (!calendarAccounts(ctx).some((a) => a.id === accountId)) return;
    const startedAt = ctx.now();
    const state = getCalendarSync(ctx)[accountId];
    if (!force && !isDue(ctx, accountId, state, startedAt, intervalMs(ctx))) return;
    let fetched: FetchedAccount | null = null;
    let listError: unknown = null;
    try {
      fetched = await fetchAccount(ctx, accountId, state, force, startedAt);
    } catch (err) {
      listError = err;
    }
    const { storeRetryAt } = runtime(ctx);
    try {
      if (fetched === null) await storeListFailure(ctx, accountId, listError);
      else await storeListing(ctx, accountId, fetched, startedAt);
      storeRetryAt.delete(accountId);
    } catch (err) {
      // Not stored: wait a while before fetching it all again ("Sync now" still tries at once).
      storeRetryAt.set(accountId, ctx.now() + Math.max(intervalMs(ctx), SYNC_BACKOFF_BASE_MS));
      throw err;
    }
  });
}

/** Runs the sync of these accounts one after the other; a crash of one is reported and does not stop the others. */
function startRun(ctx: StaticContext, accountIds: readonly string[], force: boolean): Promise<void> {
  const rt = runtime(ctx);
  const run = (async () => {
    for (const id of accountIds) {
      try {
        await syncAccount(ctx, id, force);
      } catch (err) {
        console.error('[Portly] The calendar sync failed', err);
        recordClientEvent('error', 'backend', 'calendar sync failed', { errName: errorName(err), op: 'calendar sync' });
      }
    }
  })();
  rt.running = run;
  void run.finally(() => {
    if (rt.running === run) rt.running = null;
    if (!rt.late) return;
    rt.late = false;
    ctx.notify?.([SLICE.calendars, SLICE.calendarEvents, SLICE.accounts]);
  });
  return run;
}

/** Resolves true when `promise` settles within `ms`, false otherwise. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.finally(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Syncs the accounts that are due (or joins the sync already running) and waits for it, at most
 * {@link SYNC_WAIT_MS}; past that the sync goes on and tells the app when it ends.
 */
export async function syncDueCalendars(ctx: StaticContext): Promise<void> {
  const rt = runtime(ctx);
  let run = rt.running;
  if (run === null) {
    const now = ctx.now();
    const interval = intervalMs(ctx);
    const sync = getCalendarSync(ctx);
    const due = calendarAccounts(ctx)
      .filter((a) => isDue(ctx, a.id, sync[a.id], now, interval))
      .map((a) => a.id);
    if (due.length === 0) return;
    run = startRun(ctx, due, false);
  }
  if (!(await settlesWithin(run, SYNC_WAIT_MS))) rt.late = true;
}

/** "Sync now": every calendar account, whatever its interval or backoff, waited for. */
export async function syncAllCalendars(ctx: StaticContext): Promise<void> {
  const rt = runtime(ctx);
  if (rt.running) await rt.running;
  const ids = calendarAccounts(ctx).map((a) => a.id);
  if (ids.length > 0) await startRun(ctx, ids, true);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function accountColor(ctx: StaticContext, accountId: string | null): string | null {
  return accountId === null ? null : (getAccounts(ctx).find((a) => a.id === accountId)?.color ?? null);
}

function listCalendars(ctx: StaticContext): Calendar[] {
  return activeCalendarRows(ctx, calendarAccounts(ctx)).map((row) => toCalendar(row, accountColor(ctx, row.account_id)));
}

function eventTextChars(e: CalendarEvent): number {
  return e.title.length + (e.location?.length ?? 0) + (e.description?.length ?? 0) + (e.htmlUrl?.length ?? 0) + (e.meetingUrl?.length ?? 0);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** The account of a calendar the user may write to, or the §7a refusal. */
function writeTarget(ctx: StaticContext, calendar: CalendarRow): StoredAccount {
  if (!isWritableRow(calendar)) {
    throw new StaticApiError('forbidden', calendar.user_read_only === 1 ? 'This calendar is marked read-only' : 'You cannot add or change events in this calendar');
  }
  const account = calendarAccounts(ctx).find((a) => a.id === calendar.account_id);
  if (!account) throw new StaticApiError('not_configured', 'The calendar’s account is not connected');
  return account;
}

async function sanitizeWritten(calendarId: string, record: EventRecord): Promise<SanitizedEvent> {
  const clean = await sanitizeEvent(calendarId, record);
  if (!clean) throw new StaticApiError('provider_error', 'The provider returned an event Portly cannot show');
  return clean;
}

/** The calendar again after the provider call (another tab may have removed it meanwhile). */
async function currentCalendar(ctx: StaticContext, id: string): Promise<CalendarRow> {
  await ctx.state.settled();
  const row = getCalendarRow(ctx, id);
  if (!row) throw new StaticApiError('not_found', 'Calendar not found');
  return row;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function register(router: StaticRouter): void {
  router.get('/api/calendar/calendars', async (ctx) => {
    await syncDueCalendars(ctx);
    return json(listCalendars(ctx));
  });

  router.patch('/api/calendar/calendars/:id', async (ctx, { req, params }) => {
    const id = idParam(params.id, 'Calendar');
    const patch = await parseJsonBody(req, CalendarUpdateSchema);
    const row = getCalendarRow(ctx, id);
    if (!row) throw new StaticApiError('not_found', 'Calendar not found');
    if (patch.visible !== undefined) row.visible = patch.visible ? 1 : 0;
    if (patch.colorOverride !== undefined) row.color_override = patch.colorOverride === null ? null : normalizeHexColor(patch.colorOverride);
    if (patch.userReadOnly !== undefined) row.user_read_only = patch.userReadOnly ? 1 : 0;
    if (patch.sort !== undefined) row.sort = patch.sort;
    await ctx.state.commit(SLICE.calendars);
    return json(toCalendar(row, accountColor(ctx, row.account_id)));
  });

  router.delete('/api/calendar/calendars/:id', (ctx, { params }) => {
    const id = idParam(params.id, 'Calendar');
    if (!getCalendarRow(ctx, id)) throw new StaticApiError('not_found', 'Calendar not found');
    throw new StaticApiError('conflict', 'Calendars of an account are removed with the account; hide this calendar instead');
  });

  router.get('/api/calendar/events', async (ctx, { url }) => {
    const q = parseQuery(url, EventsQuerySchema);
    await syncDueCalendars(ctx);
    const active = activeCalendarRows(ctx, calendarAccounts(ctx));
    if (active.length === 0) throw new StaticApiError('not_configured', NO_CALENDARS_MESSAGE);
    // Hidden calendars are only read when a widget names them explicitly.
    const wanted = q.calendarIds === undefined ? null : new Set(q.calendarIds);
    const calendars = active.filter((row) => (wanted === null ? row.visible === 1 : wanted.has(row.id)));
    // Clip to the synced window (§7): outside it the cache has nothing to say.
    const synced = syncWindow(ctx.now());
    const from = q.from > synced.fromDate ? q.from : synced.fromDate;
    let to = q.to < synced.toDate ? q.to : synced.toDate;
    if (to < from) to = from;
    const byId = new Map(calendars.map((row) => [row.id, row] as const));
    const rows =
      from < to
        ? queryEventRows(ctx, [...byId.keys()], {
            fromInstant: isoUtc(startOfDayMs(from, q.tz)),
            toInstant: isoUtc(startOfDayMs(to, q.tz)),
            fromDate: from,
            toDate: to,
          })
        : [];
    const events: CalendarEvent[] = [];
    let chars = 0;
    let truncated = false;
    for (const row of rows) {
      const event = toCalendarEvent(row, byId.get(row.calendar_id)!);
      chars += eventTextChars(event);
      if (events.length >= MAX_EVENTS_PER_RESPONSE || chars > MAX_EVENTS_RESPONSE_CHARS) {
        truncated = true;
        break;
      }
      events.push(event);
    }
    const body: EventsResponse = { events, window: { from, to } };
    if (truncated) body.truncated = true;
    return json(body);
  });

  router.post('/api/calendar/events', async (ctx, { req }) => {
    const input = await parseJsonBody(req, EventInputSchema);
    const calendar = getCalendarRow(ctx, input.calendarId);
    if (!calendar) throw new StaticApiError('not_found', 'Calendar not found');
    const account = writeTarget(ctx, calendar);
    const record = await createGraphEvent(ctx, account.id, calendar, input);
    const clean = await sanitizeWritten(calendar.id, record);
    const current = await currentCalendar(ctx, calendar.id);
    const row = upsertEvent(ctx, current.id, clean, ctx.now());
    await ctx.state.commit(SLICE.calendarEvents);
    return json(toCalendarEvent(row, current), 201);
  });

  router.patch('/api/calendar/events/:id', async (ctx, { req, params }) => {
    const id = idParam(params.id, 'Event');
    const patch = await parseJsonBody(req, EventUpdateSchema);
    const event = getEventRow(ctx, id);
    if (!event) throw new StaticApiError('not_found', 'Event not found');
    const calendar = getCalendarRow(ctx, event.calendar_id);
    if (!calendar) throw new StaticApiError('not_found', 'Calendar not found');
    const account = writeTarget(ctx, calendar);
    if (event.editable !== 1) throw new StaticApiError('forbidden', 'Only the organizer can change this event');
    const record = await updateGraphEvent(ctx, account.id, calendar, event, patch);
    const clean = await sanitizeWritten(calendar.id, record);
    const current = await currentCalendar(ctx, calendar.id);
    const row = upsertEvent(ctx, current.id, clean, ctx.now());
    if (row.id !== event.id) deleteEventRow(ctx, event.id);
    await ctx.state.commit(SLICE.calendarEvents);
    return json(toCalendarEvent(row, current));
  });

  router.delete('/api/calendar/events/:id', async (ctx, { params }) => {
    const id = idParam(params.id, 'Event');
    const event = getEventRow(ctx, id);
    if (!event) throw new StaticApiError('not_found', 'Event not found');
    const calendar = getCalendarRow(ctx, event.calendar_id);
    if (!calendar) throw new StaticApiError('not_found', 'Calendar not found');
    const account = writeTarget(ctx, calendar);
    if (event.editable !== 1) throw new StaticApiError('forbidden', 'Only the organizer can delete this event');
    await deleteGraphEvent(ctx, account.id, event);
    await ctx.state.settled();
    deleteEventRow(ctx, event.id);
    runtime(ctx).tombstones.set(event.id, ctx.now() + TOMBSTONE_MS);
    await ctx.state.commit(SLICE.calendarEvents);
    return noContent();
  });

  router.post('/api/calendar/sync', async (ctx) => {
    await syncAllCalendars(ctx);
    return json(listCalendars(ctx));
  });
}

/**
 * Drops what no longer belongs to anything: calendars of accounts that are gone, and events or
 * sync states of calendars and accounts that are gone (a repaired slice, an interrupted delete).
 */
export async function ready(ctx: StaticContext): Promise<void> {
  const accountIds = new Set(getAccounts(ctx).map((a) => a.id));
  const rows = getCalendars(ctx);
  const changed = new Set<string>();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.account_id === null || !accountIds.has(rows[i]!.account_id!)) {
      rows.splice(i, 1);
      changed.add(SLICE.calendars);
    }
  }
  const calendarIds = new Set(rows.map((row) => row.id));
  const events = getCalendarEvents(ctx);
  for (const id of Object.keys(events)) {
    if (!calendarIds.has(id)) {
      delete events[id];
      changed.add(SLICE.calendarEvents);
    }
  }
  const sync = getCalendarSync(ctx);
  for (const id of Object.keys(sync)) {
    if (!accountIds.has(id)) {
      delete sync[id];
      changed.add(SLICE.calendarSync);
    }
  }
  if (changed.size > 0) await ctx.state.commit(...changed);
}
