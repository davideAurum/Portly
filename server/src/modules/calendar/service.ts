/**
 * Calendar service: sync engine (§9), ICS feed management and write-through event writes.
 *
 * Sync: per account with the calendar capability enabled, list calendars (upsert by
 * `(account_id, remote_id)`, remove the ones gone upstream), then per calendar fetch the whole
 * window `[today-30d, today+365d]` and, in one transaction, upsert by deterministic id and delete
 * ids no longer returned; `last_synced_at` / `last_error` record the outcome (a failure keeps the
 * cached rows). ICS feeds sync on their own job with conditional GET. Runs for the same key never
 * overlap (a request during a run schedules exactly one follow-up run). Each unit of work runs in
 * `withLogContext({area: 'calendar', accountId | calendarId, op})` (inside the shared run body;
 * `op` is `sync` or the write), so token refreshes and outbound lines carry it.
 *
 * Health (ARCHITECTURE §17): every check is recorded with the health tracker, which logs the
 * failure, recovery and reminder lines; this module logs debug detail only, plus the event-write
 * lines below. Subjects: `calendar-list:<accountId>`, `calendar:<calendarId>` (detail `{mode,
 * fetched, upserted, deleted}`) and `ics:<calendarId>` (detail `{host, finalHost?, blockedHost?,
 * status, bytes?, notModified, redirects?}` and the counts), each expected within 3 intervals of
 * its job. Failures go through `outcomeFromError`; a subject that fails because its account must
 * be reconnected (or its Google/Microsoft OAuth client is not configured) records
 * `account_unavailable` caused by `account:<id>` (the account's own subject says why), and so do
 * the account's calendars that wait for it — missing CalDAV settings are the list's own
 * `not_configured` failure; a partial listing (shortened
 * repeating events) or the storage limit is `degraded`; skipped work (backoff, locked vault,
 * missing feed address) is `touch`ed, including the calendars of a list that is backing off.
 * Subjects are forgotten with their calendar or account, and an outcome that arrives after that
 * (a fetch that was in flight) is dropped.
 *
 * Backoff: failures that retrying soon cannot fix (403 forbidden, 404 not found) wait
 * {@link syncBackoffMs} (15 min doubling up to 6 h) instead of every interval, longer when the
 * provider's Retry-After asks for it; after a rate limit the whole account waits for the
 * provider's Retry-After (without one, for the next run): one failure per throttle.
 * `clearSyncBackoff` (manual sync, account changes) retries right away.
 *
 * Writes (Google/Microsoft only): provider call → upsert the cache row from the provider response
 * → return it, logged as `info 'calendar event written'` (warn on failure). Written ids are watched
 * for {@link WRITTEN_WATCH_MS}: a listing of the sync window that deletes one is reported (`event
 * written by Homebase is missing from the provider listing`); events outside the window are not
 * listed, so not watched. Deletes remove the row and remember its id briefly so a listing fetched
 * before the delete cannot resurrect it.
 */
import {
  normalizeHexColor,
  type Account,
  type AccountKind,
  type Calendar,
  type CalendarEvent,
  type EventInput,
  type EventUpdate,
  type IcsCreate,
  type IcsUpdate,
} from '@homebase/shared';
import type { AppContext } from '../../context.ts';
import { HttpError } from '../../lib/errors.ts';
import { outcomeFromError, type HealthSubject, type Outcome } from '../../lib/health.ts';
import { newId, sha1Hex } from '../../lib/ids.ts';
import { withLogContext } from '../../lib/log-context.ts';
import { errorFields, type Logger } from '../../lib/logger.ts';
import type { ExpandRunner } from './ical/run.ts';
import { ProviderHttpError } from './providers/http.ts';
import { blockedHost, feedHost, feedTransportError, icsSecretId, loadIcsFeed, parseIcsSyncState, type IcsFetchInfo } from './providers/ics.ts';
import { isEventListing, type AccountProvider, type WriteInfo, type WriteProvider } from './providers/types.ts';
import {
  accountCalendarRows,
  activeCalendarRows,
  deleteEventRow,
  getCalendarRow,
  getEventRow,
  icsCalendarRows,
  isWritableRow,
  replaceCalendarEvents,
  setCalendarError,
  setCalendarUnchanged,
  toCalendar,
  toCalendarEvent,
  upsertAccountCalendars,
  upsertEvent,
  MAX_LAST_ERROR,
  STORAGE_LIMIT_ERROR,
  type ReplaceResult,
} from './store.ts';
import { addDays, DAY_MS, serverTimeZone, syncWindow, type SyncWindow } from './time.ts';
import type { CalendarRow, EventRow } from './types.ts';

/** Prefix of the account status message set when an account's calendar list cannot be read. */
export const CALENDAR_LIST_ERROR_PREFIX = 'Calendars could not be loaded: ';

/** Interval of the ICS feeds job (`calendar:ics`). */
export const ICS_SYNC_INTERVAL_MS = 30 * 60 * 1000;

export interface CalendarProviders {
  google: AccountProvider & WriteProvider;
  microsoft: AccountProvider & WriteProvider;
  caldav: AccountProvider;
}

export interface CalendarServiceDeps {
  ctx: AppContext;
  providers: CalendarProviders;
  runExpand: ExpandRunner;
  now?: () => number;
  /** The server's zone (sync window, floating times). */
  timeZone?: () => string;
}

export interface CalendarService {
  window(): SyncWindow;
  /** Calendars in use (ICS + enabled calendar accounts), resolved for the API. */
  listCalendars(): Calendar[];
  calendarAccounts(): Account[];
  syncAccount(accountId: string): Promise<void>;
  syncAccounts(): Promise<void>;
  /** Lets the next sync retry calendars (and calendar lists) that are backing off: one account's, or all. */
  clearSyncBackoff(accountId?: string): void;
  /** Drops the health and backoff of an account's calendar list and calendars (account deleted, calendars switched off). */
  forgetAccount(accountId: string): void;
  syncIcs(calendarId: string): Promise<void>;
  syncIcsAll(): Promise<void>;
  addIcs(input: IcsCreate): Promise<Calendar>;
  updateIcs(calendarId: string, input: IcsUpdate): Promise<Calendar>;
  removeCalendar(calendarId: string): void;
  createEvent(input: EventInput): Promise<CalendarEvent>;
  updateEvent(eventId: string, patch: EventUpdate): Promise<CalendarEvent>;
  deleteEvent(eventId: string): Promise<void>;
}

const TOMBSTONE_MS = 10 * 60 * 1000;

/** Events written through Homebase are watched this long for a listing that drops them. */
export const WRITTEN_WATCH_MS = 30 * 60 * 1000;

/** A health subject is stale after this many intervals of its job without a check (§17). */
const EXPECTED_WITHIN_INTERVALS = 3;

export const SYNC_BACKOFF_BASE_MS = 15 * 60 * 1000;
export const SYNC_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

/** Wait before the next scheduled attempt after `failures` consecutive persistent failures. */
export function syncBackoffMs(failures: number): number {
  return Math.min(SYNC_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), SYNC_BACKOFF_MAX_MS);
}

/** Failures that retrying every interval cannot fix (access refused, calendar gone). */
function isPersistentFailure(err: unknown): boolean {
  return err instanceof HttpError && (err.code === 'forbidden' || err.code === 'not_found');
}

/**
 * The account cannot be used, and its own subject (`account:<id>`) reports why: it must be
 * reconnected (rejected token or password, locked vault — any kind), or it is a Google/Microsoft
 * account whose OAuth client is not configured (the accounts module records that refusal on the
 * account). Its calendars wait for it. Any other `not_configured` (no CalDAV settings) is the
 * failure of the subject itself.
 */
function isAccountUnusable(err: unknown, kind: AccountKind): boolean {
  if (!(err instanceof HttpError)) return false;
  return err.code === 'reauth_required' || (err.code === 'not_configured' && (kind === 'google' || kind === 'microsoft'));
}

function isRateLimited(err: unknown): boolean {
  return err instanceof HttpError && err.code === 'rate_limited';
}

/** The account's calendars are synced: it offers the capability and the user switched it on. */
function syncsCalendars(account: Account | null): account is Account {
  return account !== null && account.enabledCapabilities.includes('calendar') && account.capabilities.includes('calendar');
}

/**
 * Whether a listing of the sync window must return this event: it overlaps the window, a day
 * inside each end (providers may read all-day dates in the calendar's zone, the window is in the
 * server's).
 */
function listedIn(event: { start: string; end: string; allDay: boolean }, win: SyncWindow): boolean {
  if (event.allDay) return event.start < addDays(win.toDate, -1) && event.end > addDays(win.fromDate, 1);
  return Date.parse(event.start) < win.toMs - DAY_MS && Date.parse(event.end) > win.fromMs + DAY_MS;
}

/** Our own error messages are safe to store/show; anything else becomes a generic message. */
export function errorText(err: unknown, fallback = 'Sync failed'): string {
  if (err instanceof HttpError) return err.message.slice(0, MAX_LAST_ERROR);
  return fallback;
}

/** Outcome extra of a subject that fails because its account cannot be used (the account's own subject says why). */
function dependentOn(accountId: string | null): Partial<Outcome> {
  return { code: 'account_unavailable', causeKey: accountId === null ? null : `account:${accountId}`, severity: 'info' };
}

/** Outcome of a stored listing: ok, or degraded when only part of it is shown (storage limit, shortened events). */
function listingOutcome(result: ReplaceResult, warning: string | null | undefined, ms: number, detail: Record<string, number | boolean | string>): Outcome {
  if (result.limited) return { ok: true, degraded: true, code: 'storage_limit', message: STORAGE_LIMIT_ERROR, ms, detail };
  if (warning) return { ok: true, degraded: true, code: 'truncated', message: warning, ms, detail };
  return { ok: true, ms, detail };
}

/** Health detail of a feed request (hosts, status, size, redirects; never the URL). */
function icsDetail(host: string, info: IcsFetchInfo): Record<string, number | boolean | string> {
  return {
    host,
    ...(info.finalHost === null ? {} : { finalHost: info.finalHost }),
    status: info.status,
    ...(info.bytes === null ? {} : { bytes: info.bytes }),
    notModified: info.status === 304,
    ...(info.redirects === 0 ? {} : { redirects: info.redirects }),
  };
}

interface SyncFailure {
  accountId: string | null;
  /** Code and message of the failure: the same one again is a repeat. */
  signature: string;
  /** Consecutive failures with this signature. */
  count: number;
  /** Scheduled syncs skip this key until then (0: no backoff). */
  retryAt: number;
}

type WriteOp = 'create' | 'update' | 'delete';

function createKeyedRunner() {
  const running = new Map<string, { again: boolean; promise: Promise<void> }>();
  return (key: string, fn: () => Promise<void>): Promise<void> => {
    const current = running.get(key);
    if (current) {
      current.again = true;
      return current.promise;
    }
    const entry: { again: boolean; promise: Promise<void> } = { again: false, promise: Promise.resolve() };
    entry.promise = (async () => {
      try {
        do {
          entry.again = false;
          await fn();
        } while (entry.again);
      } finally {
        running.delete(key);
      }
    })();
    running.set(key, entry);
    return entry.promise;
  };
}

export function createCalendarService(deps: CalendarServiceDeps): CalendarService {
  const { ctx, providers, runExpand } = deps;
  const { db } = ctx;
  const log: Logger = ctx.log.child({ module: 'calendar' });
  const now = deps.now ?? Date.now;
  const timeZone = deps.timeZone ?? serverTimeZone;
  const run = createKeyedRunner();
  const tombstones = new Map<string, number>();

  const window = (): SyncWindow => syncWindow(now(), timeZone());

  const calendarAccounts = (): Account[] => ctx.accounts.list({ capability: 'calendar' });

  const providerFor = (account: Account): AccountProvider | null => {
    if (account.kind === 'google') return providers.google;
    if (account.kind === 'microsoft') return providers.microsoft;
    if (account.kind === 'yahoo' || account.kind === 'caldav') return providers.caldav;
    return null;
  };

  const writerFor = (source: CalendarRow['source']): WriteProvider | null => {
    if (source === 'google') return providers.google;
    if (source === 'microsoft') return providers.microsoft;
    return null;
  };

  const liveTombstones = (): Set<string> => {
    const t = now();
    for (const [id, expires] of tombstones) if (expires <= t) tombstones.delete(id);
    return new Set(tombstones.keys());
  };

  const accountColor = (accountId: string | null): string | null => (accountId ? (ctx.accounts.get(accountId)?.color ?? null) : null);

  // ---------------------------------------------------------------------------
  // Health subjects, failures and backoff
  // ---------------------------------------------------------------------------

  const accountsExpectMs = (): number => EXPECTED_WITHIN_INTERVALS * ctx.settings.get('calendar').syncIntervalMin * 60_000;

  const listSubject = (accountId: string): HealthSubject => ({
    key: `calendar-list:${accountId}`,
    area: 'calendar',
    accountId,
    expectEveryMs: accountsExpectMs(),
  });

  const calendarSubject = (row: CalendarRow): HealthSubject => ({
    key: `calendar:${row.id}`,
    area: 'calendar',
    accountId: row.account_id,
    expectEveryMs: accountsExpectMs(),
  });

  const icsSubject = (row: CalendarRow): HealthSubject => ({
    key: `ics:${row.id}`,
    area: 'calendar',
    accountId: null,
    label: row.display_url,
    expectEveryMs: EXPECTED_WITHIN_INTERVALS * ICS_SYNC_INTERVAL_MS,
  });

  /** Keyed by health key (`calendar-list:<accountId>`, `calendar:<calendarId>`); scheduling only, the health tracker logs. */
  const failures = new Map<string, SyncFailure>();

  /** Accounts whose provider rate-limited a calendar, until its Retry-After: none of their calendars is asked meanwhile. */
  const throttledUntil = new Map<string, number>();

  const retryAtOf = (key: string): number => failures.get(key)?.retryAt ?? 0;
  const backedOff = (key: string): boolean => retryAtOf(key) > now();

  /**
   * Records a failed check with the health tracker (via `outcomeFromError`) and keeps the backoff:
   * persistent failures wait {@link syncBackoffMs}, a provider's Retry-After at least that long;
   * the time of the next attempt becomes the outcome's `nextAttemptAt`.
   */
  const recordFailure = (subject: HealthSubject, err: unknown, extra: Partial<Outcome>): void => {
    const code = err instanceof HttpError ? err.code : undefined;
    const signature = `${code ?? ''}|${errorText(err)}`;
    const previous = failures.get(subject.key);
    const count = previous?.signature === signature ? previous.count + 1 : 1;
    const backoffMs = isPersistentFailure(err) ? syncBackoffMs(count) : 0;
    const retryAfterMs = err instanceof ProviderHttpError && err.retryAfterSeconds !== null ? err.retryAfterSeconds * 1000 : 0;
    const waitMs = Math.max(backoffMs, retryAfterMs);
    const retryAt = waitMs > 0 ? now() + waitMs : 0;
    failures.set(subject.key, { accountId: subject.accountId ?? null, signature, count, retryAt });
    ctx.health.record(subject, outcomeFromError(err, { nextAttemptAt: retryAt > 0 ? retryAt : null, ...extra }));
  };

  const recordSuccess = (subject: HealthSubject, outcome: Outcome): void => {
    failures.delete(subject.key);
    ctx.health.record(subject, outcome);
  };

  /**
   * Outcome of a check that found the data unchanged: a subject degraded by its stored data
   * (shortened repeating events) stays degraded, since that data is still what is shown.
   */
  const unchangedOutcome = (key: string, ms: number, detail: Record<string, number | boolean | string>): Outcome => {
    const previous = ctx.health.get(key);
    if (previous?.status === 'degraded' && previous.lastCode === 'truncated') {
      return { ok: true, degraded: true, code: 'truncated', ...(previous.lastMessage === null ? {} : { message: previous.lastMessage }), ms, detail };
    }
    return { ok: true, ms, detail };
  };

  /** Runs `fn` in the calendar's log context: the tracker's lines are then among the calendar's related lines. */
  const forCalendar = (row: CalendarRow, fn: () => void): void => withLogContext({ calendarId: row.id }, fn);

  const forgetCalendarHealth = (calendarId: string): void => {
    for (const key of [`calendar:${calendarId}`, `ics:${calendarId}`]) {
      failures.delete(key);
      if (ctx.health.get(key) !== null) ctx.health.forget(key);
    }
  };

  /**
   * False when the calendar stopped being synced while its fetch was in flight (feed removed,
   * account deleted, its calendars switched off): its health was forgotten then, so the late
   * outcome is dropped (and the health forgotten again) instead of bringing the subject back.
   */
  const stillSynced = (row: CalendarRow): boolean => {
    if (getCalendarRow(db, row.id) !== null && (row.account_id === null || syncsCalendars(ctx.accounts.get(row.account_id)))) return true;
    forgetCalendarHealth(row.id);
    return false;
  };

  // ---------------------------------------------------------------------------
  // Events written through Homebase (watched for a listing that drops them)
  // ---------------------------------------------------------------------------

  /** By event id: the write, when, and when the event takes place (as stored). */
  const written = new Map<string, { op: WriteOp; at: number; start: string; end: string; allDay: boolean }>();

  const markWritten = (op: WriteOp, row: EventRow): void => {
    written.set(row.id, { op, at: now(), start: row.start, end: row.end, allDay: row.all_day === 1 });
  };

  /**
   * Ids of this calendar's events written within {@link WRITTEN_WATCH_MS} that a listing of `win`
   * must return (an event outside the window is not listed, and leaves the cache as usual).
   */
  const watchedIn = (calendarId: string, win: SyncWindow): Set<string> => {
    const cutoff = now() - WRITTEN_WATCH_MS;
    const ids = new Set<string>();
    for (const [id, mark] of written) {
      if (mark.at <= cutoff) written.delete(id);
      else if (id.startsWith(`${calendarId}:`) && listedIn(mark, win)) ids.add(id);
    }
    return ids;
  };

  const reportMissingWrites = (calendarId: string, deletedIds: readonly string[] | undefined): void => {
    for (const eventId of deletedIds ?? []) {
      const mark = written.get(eventId);
      if (!mark) continue;
      written.delete(eventId);
      log.warn('event written by Homebase is missing from the provider listing', { calendarId, eventId, op: mark.op, agoMs: Math.max(0, now() - mark.at) });
    }
  };

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /** Fetches and stores one calendar's events; returns the failure (null on success) so the caller can stop early. */
  const syncCalendarNow = async (account: Account, provider: AccountProvider, row: CalendarRow, win: SyncWindow): Promise<unknown> => {
    const subject = calendarSubject(row);
    const startedAt = now();
    const started = Date.now();
    try {
      const listed = await provider.listEvents(account, row, win);
      const ms = Date.now() - started;
      if (listed === null) {
        setCalendarUnchanged(db, row.id, now());
        if (!stillSynced(row)) return null;
        recordSuccess(subject, unchangedOutcome(subject.key, ms, { mode: 'delta', fetched: 0, upserted: 0, deleted: 0 }));
        return null;
      }
      const listing = isEventListing(listed) ? listed : { events: listed, syncState: undefined, warning: null };
      const result = replaceCalendarEvents(db, row.id, listing.events, {
        now: now(),
        startedAt,
        syncState: listing.syncState,
        skipIds: liveTombstones(),
        warning: listing.warning ?? null,
        watchIds: watchedIn(row.id, win),
      });
      if (!stillSynced(row)) return null; // also when the listing found the row removed (nothing stored)
      reportMissingWrites(row.id, result.deletedWatched);
      const detail = { mode: 'full', fetched: listing.events.length, upserted: result.upserted, deleted: result.deleted };
      recordSuccess(subject, listingOutcome(result, listing.warning, ms, detail));
      return null;
    } catch (err) {
      // Not a failure to report (or to stop the account's run for): the calendar is not synced any more.
      if (!stillSynced(row)) return null;
      setCalendarError(db, row.id, errorText(err));
      const ms = Date.now() - started;
      recordFailure(subject, err, isAccountUnusable(err, account.kind) ? { ...dependentOn(row.account_id), ms } : { ms });
      return err;
    }
  };

  const syncAccountNow = async (accountId: string): Promise<void> => {
    const account = ctx.accounts.get(accountId);
    if (!syncsCalendars(account)) return;
    const provider = providerFor(account);
    if (!provider) return;
    const win = window();
    const list = listSubject(accountId);
    const waitUntil = Math.max(retryAtOf(list.key), throttledUntil.get(accountId) ?? 0);
    if (waitUntil > now()) {
      // The list is backing off, or the provider asked to wait: none of the account's calendars is synced either.
      ctx.health.touch(list, { skipped: 'backoff', nextAttemptAt: waitUntil });
      for (const row of accountCalendarRows(db, accountId)) {
        const subject = calendarSubject(row);
        forCalendar(row, () => ctx.health.touch(subject, { skipped: 'backoff', nextAttemptAt: Math.max(waitUntil, retryAtOf(subject.key)) }));
      }
      return;
    }

    let rows: CalendarRow[];
    const started = Date.now();
    try {
      const remotes = await provider.listCalendars(account);
      const current = ctx.accounts.get(accountId);
      if (!syncsCalendars(current)) return; // deleted, or its calendars switched off, meanwhile
      const before = accountCalendarRows(db, accountId);
      rows = upsertAccountCalendars(db, accountId, provider.source, remotes);
      const kept = new Set(rows.map((r) => r.id));
      for (const gone of before) if (!kept.has(gone.id)) forgetCalendarHealth(gone.id);
      if (current.status === 'error' && current.statusMessage?.startsWith(CALENDAR_LIST_ERROR_PREFIX)) {
        ctx.accounts.setStatus(accountId, 'ok', undefined, { source: 'calendar' });
      }
      recordSuccess(list, { ok: true, ms: Date.now() - started, detail: { calendars: rows.length } });
    } catch (err) {
      // Deleted, or its calendars switched off, meanwhile: their health was forgotten then and stays so.
      if (!syncsCalendars(ctx.accounts.get(accountId))) return;
      const message = errorText(err);
      const ms = Date.now() - started;
      db.run('UPDATE calendars SET last_error = ? WHERE account_id = ?', [message, accountId]);
      if (isAccountUnusable(err, account.kind)) {
        recordFailure(list, err, { ...dependentOn(accountId), ms });
        for (const row of accountCalendarRows(db, accountId)) {
          forCalendar(row, () => ctx.health.record(calendarSubject(row), outcomeFromError(err, dependentOn(accountId))));
        }
      } else {
        recordFailure(list, err, { ms });
      }
      // With no calendar rows there is nowhere else to show the failure (and the widget would keep
      // waiting for a first sync): record it on the account — unless the account is unusable, which
      // its own subject already says (reauth, or the accounts module's OAuth-client refusal).
      if (!isAccountUnusable(err, account.kind) && accountCalendarRows(db, accountId).length === 0 && ctx.accounts.get(accountId)?.status === 'ok') {
        ctx.accounts.setStatus(accountId, 'error', `${CALENDAR_LIST_ERROR_PREFIX}${message}`.slice(0, MAX_LAST_ERROR), {
          reason: 'calendar_list_failed',
          source: 'calendar',
        });
      }
      return;
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (!stillSynced(row)) continue; // the account was deleted, or its calendars switched off, during an earlier fetch
      const subject = calendarSubject(row);
      if (backedOff(subject.key)) {
        // last_error still shows the failure.
        forCalendar(row, () => ctx.health.touch(subject, { skipped: 'backoff', nextAttemptAt: retryAtOf(subject.key) }));
        continue;
      }
      const failure = await withLogContext({ calendarId: row.id }, () => syncCalendarNow(account, provider, row, win));
      if (failure === null) continue;
      if (!syncsCalendars(ctx.accounts.get(accountId))) return; // deleted, or its calendars switched off, meanwhile
      const rest = rows.slice(i + 1);
      if (isAccountUnusable(failure, account.kind)) {
        // No point asking the provider again for the other calendars of this account.
        const message = errorText(failure);
        for (const other of rest) {
          setCalendarError(db, other.id, message);
          forCalendar(other, () => ctx.health.record(calendarSubject(other), outcomeFromError(failure, dependentOn(accountId))));
        }
        return;
      }
      if (isRateLimited(failure)) {
        // One failure per throttle: the whole account waits for the provider's Retry-After (the
        // throttle is usually per user or app), without one for the next run.
        const retryAt = retryAtOf(subject.key);
        if (retryAt > 0) throttledUntil.set(accountId, retryAt);
        for (const other of rest) forCalendar(other, () => ctx.health.touch(calendarSubject(other), { skipped: 'backoff', nextAttemptAt: retryAt || null }));
        return;
      }
    }
  };

  const syncIcsNow = async (calendarId: string): Promise<void> => {
    const row = getCalendarRow(db, calendarId);
    if (!row || row.source !== 'ics') return;
    const subject = icsSubject(row);
    let url: string | null;
    try {
      url = ctx.vault.get(icsSecretId(calendarId));
    } catch (err) {
      setCalendarError(db, calendarId, errorText(err, 'Saved credentials are locked'));
      ctx.health.touch(subject, { skipped: 'vault_locked' });
      return;
    }
    if (!url) {
      setCalendarError(db, calendarId, 'The feed address is missing; edit this calendar and enter it again');
      ctx.health.touch(subject, { skipped: 'missing_url' });
      return;
    }
    const host = feedHost(url);
    const startedAt = now();
    const started = Date.now();
    try {
      const loaded = await loadIcsFeed(ctx.fetch, runExpand, url, parseIcsSyncState(row.sync_state), window());
      const ms = Date.now() - started;
      if (loaded.kind === 'unchanged') {
        setCalendarUnchanged(db, calendarId, now());
        if (!stillSynced(row)) return; // feed removed while fetching
        ctx.health.record(subject, unchangedOutcome(subject.key, ms, icsDetail(host, loaded.info)));
        return;
      }
      const result = replaceCalendarEvents(db, calendarId, loaded.events, { now: now(), startedAt, syncState: loaded.syncState, warning: loaded.warning });
      if (!stillSynced(row)) return; // feed removed while fetching (nothing stored)
      const detail = { ...icsDetail(host, loaded.info), fetched: loaded.events.length, upserted: result.upserted, deleted: result.deleted };
      ctx.health.record(subject, listingOutcome(result, loaded.warning, ms, detail));
    } catch (err) {
      if (!stillSynced(row)) return; // feed removed while fetching: not a failure to report
      const message = errorText(err);
      setCalendarError(db, calendarId, message);
      const blocked = blockedHost(err);
      // A transport failure is classified by the safe-fetch error behind it (dns, refused, tls, blocked …).
      ctx.health.record(
        subject,
        outcomeFromError(feedTransportError(err) ?? err, {
          message,
          ms: Date.now() - started,
          detail: { host, ...(blocked === null ? {} : { blockedHost: blocked }) },
        }),
      );
    }
  };

  /** A feed just fetched while adding or editing it: the subject's first (or new) check, in the feed's log context. */
  const recordFeedSetup = (calendarId: string, url: string, info: IcsFetchInfo, result: ReplaceResult, events: number, warning: string | null, ms: number): void => {
    const row = getCalendarRow(db, calendarId);
    if (!row) return;
    const detail = { ...icsDetail(feedHost(url), info), fetched: events, upserted: result.upserted, deleted: result.deleted };
    forCalendar(row, () => ctx.health.record(icsSubject(row), listingOutcome(result, warning, ms, detail)));
  };

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Runs one provider write in its unit of work's log context and logs it: `info 'calendar event
   * written'` (op, source, provider status, ms, all-day, zone sent and whether UTC stood in for it,
   * `remoteIdTag` = first 8 hex of sha1(remote id), never the id itself), or `warn 'calendar event
   * write failed'` with the error's fields.
   */
  const logWrite = <T>(
    op: WriteOp,
    account: Account,
    calendar: CalendarRow,
    allDay: boolean,
    fn: () => Promise<{ result: T; info: WriteInfo; remoteId: string }>,
  ): Promise<T> =>
    withLogContext({ area: 'calendar', accountId: account.id, calendarId: calendar.id, op }, async () => {
      const started = Date.now();
      const base = { op, source: calendar.source, accountId: account.id, calendarId: calendar.id };
      try {
        const { result, info, remoteId } = await fn();
        log.info('calendar event written', {
          ...base,
          status: info.status,
          ms: Date.now() - started,
          allDay,
          ...(info.tzSent === null ? {} : { tzSent: info.tzSent }),
          tzFallback: info.tzFallback,
          remoteIdTag: sha1Hex(remoteId).slice(0, 8),
        });
        return result;
      } catch (err) {
        log.warn('calendar event write failed', { ...errorFields(err), ...base, ms: Date.now() - started });
        throw err;
      }
    });

  const service: CalendarService = {
    window,
    calendarAccounts,

    listCalendars() {
      return activeCalendarRows(db, calendarAccounts()).map((row) => toCalendar(row, accountColor(row.account_id)));
    },

    syncAccount(accountId) {
      // The keyed runner shares one run between callers: the context goes inside the shared body.
      return run(`account:${accountId}`, () => withLogContext({ area: 'calendar', accountId, op: 'sync' }, () => syncAccountNow(accountId)));
    },

    async syncAccounts() {
      for (const account of calendarAccounts()) {
        if (!providerFor(account)) continue;
        await service.syncAccount(account.id);
      }
    },

    clearSyncBackoff(accountId) {
      for (const failure of failures.values()) if (accountId === undefined || failure.accountId === accountId) failure.retryAt = 0;
      if (accountId === undefined) throttledUntil.clear();
      else throttledUntil.delete(accountId);
    },

    forgetAccount(accountId) {
      throttledUntil.delete(accountId);
      for (const [key, failure] of failures) if (failure.accountId === accountId) failures.delete(key);
      for (const state of ctx.health.list({ accountId })) {
        if (state.key.startsWith('calendar:') || state.key.startsWith('calendar-list:')) ctx.health.forget(state.key);
      }
    },

    syncIcs(calendarId) {
      return run(`ics:${calendarId}`, () => withLogContext({ area: 'calendar', calendarId, op: 'sync' }, () => syncIcsNow(calendarId)));
    },

    async syncIcsAll() {
      for (const row of icsCalendarRows(db)) await service.syncIcs(row.id);
    },

    // -------------------------------------------------------------------------
    // ICS feeds
    // -------------------------------------------------------------------------

    async addIcs(input) {
      const parsed = input;
      if (ctx.vault.state !== 'ready') {
        throw new HttpError(409, 'conflict', 'Saved credentials are locked; reset them in Settings → Accounts first');
      }
      const win = window();
      const started = Date.now();
      const loaded = await loadFeedForSetup(parsed.url, win);
      const ms = Date.now() - started;
      const id = newId();
      const sort = (db.get<{ m: number | null }>('SELECT MAX(sort) AS m FROM calendars')?.m ?? -1) + 1;
      db.tx(() => {
        db.run(
          `INSERT INTO calendars (id, account_id, source, remote_id, name, color, color_override, provider_writable, visible, sort, display_url)
           VALUES (?, NULL, 'ics', ?, ?, ?, ?, 0, 1, ?, ?)`,
          [id, id, parsed.name, normalizeHexColor(loaded.color), normalizeHexColor(parsed.color ?? null), sort, feedHost(parsed.url)],
        );
        ctx.vault.put(icsSecretId(id), parsed.url);
      });
      const result = replaceCalendarEvents(db, id, loaded.events, { now: now(), startedAt: now(), syncState: loaded.syncState, warning: loaded.warning });
      recordFeedSetup(id, parsed.url, loaded.info, result, loaded.events.length, loaded.warning, ms);
      log.info('ics feed added', { calendarId: id, host: feedHost(parsed.url), events: loaded.events.length });
      return toCalendar(getCalendarRow(db, id)!);
    },

    async updateIcs(calendarId, input) {
      const row = getCalendarRow(db, calendarId);
      if (!row) throw new HttpError(404, 'not_found', 'Calendar not found');
      if (row.source !== 'ics') throw new HttpError(409, 'conflict', 'Only ICS subscriptions can be edited here');
      if (input.url !== undefined) {
        if (ctx.vault.state !== 'ready') {
          throw new HttpError(409, 'conflict', 'Saved credentials are locked; reset them in Settings → Accounts first');
        }
        const url = input.url;
        const started = Date.now();
        const loaded = await withLogContext({ area: 'calendar', calendarId }, () => loadFeedForSetup(url, window()));
        const ms = Date.now() - started;
        db.tx(() => {
          ctx.vault.put(icsSecretId(calendarId), url);
          db.run('UPDATE calendars SET display_url = ?, sync_state = NULL WHERE id = ?', [feedHost(url), calendarId]);
        });
        const result = replaceCalendarEvents(db, calendarId, loaded.events, { now: now(), startedAt: now(), syncState: loaded.syncState, warning: loaded.warning });
        recordFeedSetup(calendarId, url, loaded.info, result, loaded.events.length, loaded.warning, ms);
      }
      if (input.name !== undefined) db.run('UPDATE calendars SET name = ? WHERE id = ?', [input.name, calendarId]);
      return toCalendar(getCalendarRow(db, calendarId)!);
    },

    removeCalendar(calendarId) {
      const row = getCalendarRow(db, calendarId);
      if (!row) throw new HttpError(404, 'not_found', 'Calendar not found');
      if (row.source !== 'ics') {
        throw new HttpError(409, 'conflict', 'Calendars of an account are removed with the account; hide this calendar instead');
      }
      db.tx(() => {
        db.run('DELETE FROM calendars WHERE id = ?', [calendarId]);
        try {
          ctx.vault.delete(icsSecretId(calendarId));
        } catch {
          // Locked vault: the orphaned secret is removed with the next vault reset.
        }
      });
      forgetCalendarHealth(calendarId);
      if (ctx.settings.get('calendar').defaultCalendarId === calendarId) {
        ctx.settings.patch({ calendar: { defaultCalendarId: null } });
      }
    },

    // -------------------------------------------------------------------------
    // Writes (single instances, Google/Microsoft)
    // -------------------------------------------------------------------------

    async createEvent(input) {
      const calendar = getCalendarRow(db, input.calendarId);
      if (!calendar) throw new HttpError(404, 'not_found', 'Calendar not found');
      const { account, writer } = writeTarget(calendar);
      const row = await logWrite('create', account, calendar, input.allDay, async () => {
        const write = await writer.createEvent(account, calendar, input);
        const stored = upsertEvent(db, calendar.id, write.record, now());
        if (!stored) throw new HttpError(502, 'provider_error', 'The provider returned an event Homebase cannot show');
        return { result: stored, info: write, remoteId: write.record.remoteId };
      });
      markWritten('create', row);
      return toCalendarEvent(row, getCalendarRow(db, calendar.id) ?? calendar);
    },

    async updateEvent(eventId, patch) {
      const event = getEventRow(db, eventId);
      if (!event) throw new HttpError(404, 'not_found', 'Event not found');
      const calendar = getCalendarRow(db, event.calendar_id);
      if (!calendar) throw new HttpError(404, 'not_found', 'Calendar not found');
      const { account, writer } = writeTarget(calendar);
      if (event.editable !== 1) throw new HttpError(403, 'forbidden', 'Only the organizer can change this event');
      const row = await logWrite('update', account, calendar, patch.allDay ?? event.all_day === 1, async () => {
        const write = await writer.updateEvent(account, calendar, event, patch);
        const stored = upsertEvent(db, calendar.id, write.record, now());
        if (!stored) throw new HttpError(502, 'provider_error', 'The provider returned an event Homebase cannot show');
        return { result: stored, info: write, remoteId: write.record.remoteId };
      });
      if (row.id !== event.id) {
        deleteEventRow(db, event.id);
        written.delete(event.id);
      }
      markWritten('update', row);
      return toCalendarEvent(row, calendar);
    },

    async deleteEvent(eventId) {
      const event = getEventRow(db, eventId);
      if (!event) throw new HttpError(404, 'not_found', 'Event not found');
      const calendar = getCalendarRow(db, event.calendar_id);
      if (!calendar) throw new HttpError(404, 'not_found', 'Calendar not found');
      const { account, writer } = writeTarget(calendar);
      if (event.editable !== 1) throw new HttpError(403, 'forbidden', 'Only the organizer can delete this event');
      await logWrite('delete', account, calendar, event.all_day === 1, async () => {
        const info = await writer.deleteEvent(account, calendar, event);
        return { result: undefined, info, remoteId: event.remote_id };
      });
      deleteEventRow(db, event.id);
      written.delete(event.id);
      tombstones.set(event.id, now() + TOMBSTONE_MS);
    },
  };

  /** Fetches + expands a feed while adding/editing it; failures are 422 on the `url` field. */
  async function loadFeedForSetup(url: string, win: SyncWindow) {
    try {
      const loaded = await loadIcsFeed(ctx.fetch, runExpand, url, null, win);
      if (loaded.kind !== 'events') throw new HttpError(502, 'provider_error', 'The feed did not return a calendar');
      return loaded;
    } catch (err) {
      const message = err instanceof HttpError ? err.message : 'The feed could not be loaded';
      const text = err instanceof HttpError && err.code === 'validation_failed' ? `This address did not return a calendar: ${message}` : message;
      throw new HttpError(422, 'validation_failed', text, [{ path: 'url', message: text, code: 'custom' }]);
    }
  }

  /** The account and writer for a calendar, or the §7a refusal. */
  function writeTarget(calendar: CalendarRow): { account: Account; writer: WriteProvider } {
    const writer = writerFor(calendar.source);
    if (!writer) throw new HttpError(409, 'conflict', 'This calendar is read-only in Homebase');
    if (!isWritableRow(calendar)) {
      throw new HttpError(403, 'forbidden', calendar.user_read_only === 1 ? 'This calendar is marked read-only' : 'You cannot add or change events in this calendar');
    }
    const account = calendar.account_id ? ctx.accounts.get(calendar.account_id) : null;
    if (!account || !account.enabledCapabilities.includes('calendar')) {
      throw new HttpError(409, 'not_configured', 'The calendar’s account is not connected');
    }
    return { account, writer };
  }

  return service;
}
