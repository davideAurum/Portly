import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCalendarWarning, type Calendar, type CalendarEvent, type EventsResponse } from '@portly/shared';
import { HttpError } from '../../lib/errors.ts';
import { sha1Hex } from '../../lib/ids.ts';
import { createMemoryLogger, createTestLogger } from '../../lib/logger.ts';
import type { FakeAccountSeed } from '../../testing/fake-accounts.ts';
import type { FakeFetchRoute, FakeRequest, FakeResponseSpec } from '../../testing/fake-fetch.ts';
import { SIMPLE_FEED, ics, manyVevents } from './__fixtures__/ics.ts';
import {
  googleApiDisabled,
  googleCalendarList,
  googleEventsPage1,
  googleEventsPage2,
  googleForbidden,
  googleScopeInsufficient,
  graphCalendars,
  graphCalendarViewPage1,
} from './__fixtures__/providers.ts';
import { T0, calendarTestbed, type CalendarTestbed } from './__fixtures__/setup.ts';
import { ACCOUNT_SYNC_JOB, ICS_SYNC_JOB, INITIAL_SYNC_DELAY_MS, ICS_SYNC_INTERVAL_MS } from './index.ts';
import { eventId, getCalendarRow, replaceCalendarEvents, STORAGE_LIMIT_ERROR } from './store.ts';
import type { EventRecord } from './types.ts';

const GOOGLE: FakeAccountSeed = { id: 'g1', kind: 'google', label: 'Gmail', email: 'alice@gmail.com', color: '#123456', capabilities: ['calendar', 'mail'], token: 'tok-1' };
const MS: FakeAccountSeed = { id: 'm1', kind: 'microsoft', label: 'Outlook', email: 'bob@outlook.com', capabilities: ['calendar'], token: 'ms-tok' };
const G_API = 'https://www.googleapis.com/calendar/v3';
const PRIMARY_EVENTS = `${G_API}/calendars/alice%40gmail.com/events`;

let tb: CalendarTestbed;
afterEach(() => tb?.close());

function googleRoutes(pages: { first?: unknown; second?: unknown } = {}): FakeFetchRoute[] {
  return [
    { match: `${G_API}/users/me/calendarList`, respond: { json: googleCalendarList } },
    {
      match: PRIMARY_EVENTS,
      method: 'GET',
      respond: (req) => ({ json: new URL(req.url).searchParams.get('pageToken') === 'page-2' ? (pages.second ?? googleEventsPage2) : (pages.first ?? googleEventsPage1) }),
    },
    { match: /calendars\/(en\.german|family0123)/, method: 'GET', respond: { json: { items: [] } } },
  ];
}

const json = <T>(res: { body: unknown }) => res.body as T;

async function events(from: string, to: string, tz = 'UTC'): Promise<EventsResponse> {
  const res = await tb.json<EventsResponse>('GET', `/api/calendar/events?from=${from}&to=${to}&tz=${encodeURIComponent(tz)}`);
  expect(res.status).toBe(200);
  return res.body;
}

function calendarIdByName(name: string): string {
  const row = tb.ctx.db.get<{ id: string }>('SELECT id FROM calendars WHERE name = ?', [name]);
  if (!row) throw new Error(`no calendar ${name}`);
  return row.id;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

/** A promise the test settles: holds a provider call while the test changes what is around it. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// ---------------------------------------------------------------------------

describe('sync (Google)', () => {
  it('upserts calendars and events per calendar with deterministic ids, paging through events.list', async () => {
    tb = calendarTestbed({ accounts: [GOOGLE], fetchRoutes: googleRoutes() });
    await tb.module.service.syncAccounts();

    const cals = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'));
    expect(cals.map((c) => [c.name, c.color, c.writable, c.visible, c.isPrimary, c.source, c.accountId])).toEqual([
      ['alice@gmail.com', '#9fe1e7', true, true, true, 'google', 'g1'],
      ['Feiertage', '#16a765', false, false, false, 'google', 'g1'],
      ['Family', '#123456', true, true, false, 'google', 'g1'], // invalid provider color → account color
    ]);
    expect(cals[0]!.lastSyncedAt).toBe(new Date(T0).toISOString());

    const primaryId = cals[0]!.id;
    const rows = tb.ctx.db.all<{ id: string; remote_id: string }>('SELECT id, remote_id FROM events WHERE calendar_id = ? ORDER BY remote_id', [primaryId]);
    expect(rows.map((r) => r.remote_id)).toEqual(['abc123timed', 'allday456', 'declined1', 'evil1', 'weekly789_20260929T070000Z']);
    for (const r of rows) expect(r.id).toBe(eventId(primaryId, r.remote_id, null));

    const listCalls = tb.ctx.fakeFetch!.calls.filter((c) => c.url.startsWith(PRIMARY_EVENTS));
    expect(listCalls).toHaveLength(2);
    const params = new URL(listCalls[0]!.url).searchParams;
    expect(Object.fromEntries(params)).toMatchObject({
      singleEvents: 'true',
      maxResults: '1000',
      prettyPrint: 'false',
      fields: expect.stringContaining('nextPageToken,timeZone,items(id,etag,status,summary,description,location,start,end,'),
      timeMin: '2026-08-26T00:00:00.000Z',
      timeMax: '2027-09-25T00:00:00.000Z',
    });
    expect(listCalls[0]!.headers.get('authorization')).toBe('Bearer tok-1');
  });

  it('deletes events no longer returned and calendars that disappeared, keeping user settings', async () => {
    let listing = googleEventsPage1;
    let calendarList = googleCalendarList;
    tb = calendarTestbed({
      accounts: [GOOGLE],
      fetchRoutes: [
        { match: `${G_API}/users/me/calendarList`, respond: () => ({ json: calendarList }) },
        { match: PRIMARY_EVENTS, respond: () => ({ json: { ...listing, nextPageToken: undefined } }) },
        { match: /calendars\/(en\.german|family0123)/, respond: { json: { items: [googleEventsPage2.items[0]] } } },
      ],
    });
    await tb.module.service.syncAccounts();
    const familyId = calendarIdByName('Family');
    await tb.req('PATCH', `/api/calendar/calendars/${familyId}`, { body: { colorOverride: '#AA00BB', visible: false } });
    const primaryId = calendarIdByName('alice@gmail.com');
    expect(tb.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?', [primaryId])?.n).toBe(3);

    tb.clock.now += 60_000;
    listing = { ...googleEventsPage1, items: googleEventsPage1.items.filter((i) => i.id !== 'allday456') };
    calendarList = { ...googleCalendarList, items: googleCalendarList.items.filter((i) => i.id !== 'en.german#holiday@group.v.calendar.google.com') };
    await tb.module.service.syncAccounts();

    const remaining = tb.ctx.db.all<{ remote_id: string }>('SELECT remote_id FROM events WHERE calendar_id = ? ORDER BY remote_id', [primaryId]);
    expect(remaining.map((r) => r.remote_id)).toEqual(['abc123timed', 'weekly789_20260929T070000Z']);
    const cals = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'));
    expect(cals.map((c) => c.name)).toEqual(['alice@gmail.com', 'Family']);
    expect(cals[1]).toMatchObject({ color: '#aa00bb', colorOverride: '#aa00bb', visible: false });
    expect(cals[0]!.colorOverride).toBeNull(); // provider color in use
    expect(tb.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE calendar_id NOT IN (SELECT id FROM calendars)")?.n).toBe(0);
  });

  it('keeps cached rows and records last_error when a calendar fails; reauth stops the account', async () => {
    let fail = false;
    tb = calendarTestbed({
      accounts: [GOOGLE],
      fetchRoutes: [
        { match: `${G_API}/users/me/calendarList`, respond: { json: googleCalendarList } },
        { match: PRIMARY_EVENTS, respond: () => (fail ? { status: 503, json: { error: { code: 503, message: 'Backend Error with secrets' } } } : { json: { items: googleEventsPage1.items } }) },
        { match: /calendars\/(en\.german|family0123)/, respond: { json: { items: [] } } },
      ],
    });
    await tb.module.service.syncAccounts();
    fail = true;
    tb.clock.now += 60_000;
    await tb.module.service.syncAccounts();
    const cal = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'))[0]!;
    expect(cal.lastError).toBe('Google Calendar returned an error (503)');
    expect(cal.lastSyncedAt).toBe(new Date(T0).toISOString());
    expect((await events('2026-09-01', '2026-11-01')).events).toHaveLength(3);

    // Missing token → reauth_required: every calendar of the account gets the message.
    tb.accounts.add({ ...GOOGLE, token: undefined });
    await tb.module.service.syncAccounts();
    const after = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'));
    expect(after.every((c) => c.lastError === 'Reconnect required')).toBe(true);
  });

  it('a calendar list that fails before any calendar exists is reported on the account, and cleared by a later success (WEB-2)', async () => {
    let fail = true;
    tb = calendarTestbed({
      accounts: [GOOGLE],
      fetchRoutes: [
        { match: `${G_API}/users/me/calendarList`, respond: () => (fail ? { status: 503, json: {} } : { json: googleCalendarList }) },
        { match: PRIMARY_EVENTS, respond: { json: { items: [] } } },
        { match: /calendars\/(en\.german|family0123)/, respond: { json: { items: [] } } },
      ],
    });
    await tb.module.service.syncAccounts();
    expect(tb.accounts.get('g1')).toMatchObject({ status: 'error', statusMessage: expect.stringContaining('Calendars could not be loaded') });
    fail = false;
    await tb.module.service.syncAccounts();
    expect(tb.accounts.get('g1')).toMatchObject({ status: 'ok' });
    // With calendars cached, a later list failure stays on the calendars (the account is fine).
    fail = true;
    await tb.module.service.syncAccounts();
    expect(tb.accounts.get('g1')?.status).toBe('ok');
  });

  it('never treats a malformed or partial listing as "everything was deleted"', async () => {
    let mode: 'ok' | 'no-items' | 'list-403-page-2' = 'ok';
    tb = calendarTestbed({
      accounts: [GOOGLE],
      fetchRoutes: [
        {
          match: `${G_API}/users/me/calendarList`,
          respond: (req: FakeRequest) => {
            if (mode !== 'list-403-page-2') return { json: googleCalendarList };
            if (new URL(req.url).searchParams.get('pageToken') === 'cl-2') return { status: 403, json: { error: { code: 403, errors: [{ reason: 'forbidden' }] } } };
            return { json: { ...googleCalendarList, nextPageToken: 'cl-2' } };
          },
        },
        { match: PRIMARY_EVENTS, respond: () => ({ json: mode === 'no-items' ? { kind: 'calendar#events' } : { items: googleEventsPage1.items } }) },
        { match: /calendars\/(en\.german|family0123)/, respond: { json: { items: [] } } },
      ],
    });
    await tb.module.service.syncAccounts();
    const primaryId = calendarIdByName('alice@gmail.com');
    const count = () => tb.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?', [primaryId])?.n;
    expect(count()).toBe(3);

    // 200 without `items`: an error, not an empty calendar.
    mode = 'no-items';
    tb.clock.now += 60_000;
    await tb.module.service.syncAccounts();
    expect(count()).toBe(3);
    expect(tb.ctx.db.get<{ last_error: string | null }>('SELECT last_error FROM calendars WHERE id = ?', [primaryId])?.last_error).toMatch(/unexpected response/);

    // calendarList refused on a later page: no "primary only" fallback that would drop the rest.
    mode = 'list-403-page-2';
    tb.clock.now += 60_000;
    await tb.module.service.syncAccounts();
    expect(json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars')).map((c) => c.name)).toEqual(['alice@gmail.com', 'Feiertage', 'Family']);
    expect(count()).toBe(3);
  });

  it('refreshes once on a provider 401 (withToken) and marks reauth when it persists', async () => {
    tb = calendarTestbed({
      accounts: [{ ...GOOGLE, refreshedTokens: [] }],
      fetchRoutes: [{ match: `${G_API}/users/me/calendarList`, respond: { status: 401, json: { error: { code: 401 } } } }],
    });
    await tb.module.service.syncAccounts();
    expect(tb.accounts.refreshes.get('g1')).toBe(1);
    expect(tb.accounts.get('g1')?.status).toBe('reauth');
  });
});

describe('sync failures: 403 classification, one health line per failure, back off', () => {
  const API_DISABLED =
    'The Google Calendar API is not enabled for the Google Cloud project of your OAuth client; enable it in the Google Cloud console, then sync again';

  it('a Calendar API disabled for the OAuth client fails the list with an actionable message — no stand-in primary calendar', async () => {
    const log = createMemoryLogger();
    tb = calendarTestbed({
      accounts: [GOOGLE],
      log,
      fetchRoutes: [
        { match: `${G_API}/users/me/calendarList`, respond: { status: 403, json: googleApiDisabled } },
        { match: `${G_API}/calendars/`, respond: { status: 403, json: googleApiDisabled } },
      ],
    });
    await tb.module.service.syncAccounts();

    expect(json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'))).toEqual([]);
    expect(tb.accounts.get('g1')).toMatchObject({ status: 'error', statusMessage: `Calendars could not be loaded: ${API_DISABLED}` });
    expect(tb.ctx.fakeFetch!.calls.filter((c) => c.url.includes('/events'))).toHaveLength(0);
    expect(tb.accounts.statusChanges).toContainEqual({
      id: 'g1',
      status: 'error',
      message: `Calendars could not be loaded: ${API_DISABLED}`,
      meta: { reason: 'calendar_list_failed', source: 'calendar' },
    });
    // The health tracker logs the failure (once); the module itself only logs debug detail.
    const warned = log.lines.filter((l) => l.level === 'warn');
    expect(warned).toEqual([
      expect.objectContaining({
        message: 'calendar failing',
        fields: expect.objectContaining({
          key: 'calendar-list:g1',
          accountId: 'g1',
          code: 'api_disabled',
          status: 403,
          message: API_DISABLED,
          providerReason: 'PERMISSION_DENIED:accessNotConfigured:SERVICE_DISABLED',
          nextAttemptAt: new Date(T0 + 15 * 60_000).toISOString(),
        }),
      }),
    ]);
    expect(tb.ctx.health.get('calendar-list:g1')).toMatchObject({ status: 'failing', lastCode: 'api_disabled', lastStatus: 403, nextAttemptAt: T0 + 15 * 60_000 });
    expect(JSON.stringify(log.lines)).not.toContain('has not been used in project'); // provider text stays out of the log
  });

  it('falls back to the primary calendar only when the calendar-list scope is missing; a stand-in row then shows later failures', async () => {
    let refusal: unknown = googleScopeInsufficient;
    tb = calendarTestbed({
      accounts: [GOOGLE],
      fetchRoutes: [
        { match: `${G_API}/users/me/calendarList`, respond: () => ({ status: 403, json: refusal }) },
        {
          match: `${G_API}/calendars/primary/events`,
          respond: () => (refusal === googleApiDisabled ? { status: 403, json: googleApiDisabled } : { json: { items: googleEventsPage1.items } }),
        },
      ],
    });
    await tb.module.service.syncAccounts();
    const cals = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'));
    expect(cals.map((c) => [c.name, c.isPrimary, c.writable, c.lastError])).toEqual([['alice@gmail.com', true, true, null]]);
    const count = () => tb.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?', [cals[0]!.id])?.n;
    expect(count()).toBe(3);

    // The Calendar API is then disabled: the cached stand-in keeps its events and shows why.
    refusal = googleApiDisabled;
    tb.clock.now += 60_000;
    await tb.module.service.syncAccounts();
    expect(json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'))[0]!.lastError).toBe(API_DISABLED);
    expect(tb.accounts.get('g1')?.status).toBe('ok'); // calendars are cached: the error stays on them
    expect(count()).toBe(3);
  });

  it('a calendar refused on read says so, is reported once and backs off; account changes and "Sync now" retry right away', async () => {
    const log = createMemoryLogger();
    let refused = true;
    tb = calendarTestbed({
      accounts: [GOOGLE],
      log,
      fetchRoutes: [
        { match: `${G_API}/users/me/calendarList`, respond: { json: googleCalendarList } },
        { match: PRIMARY_EVENTS, respond: { json: { items: [] } } },
        { match: /calendars\/en\.german/, respond: { json: { items: [] } } },
        { match: /calendars\/family0123/, respond: () => (refused ? { status: 403, json: googleForbidden } : { json: { items: [] } }) },
      ],
    });
    const calls = (part: string) => tb.ctx.fakeFetch!.calls.filter((c) => c.url.includes(part)).length;

    await tb.module.service.syncAccounts();
    const familyId = calendarIdByName('Family');
    const key = `calendar:${familyId}`;
    const lines = (message: string, level: string) => log.lines.filter((l) => l.message === message && l.level === level && l.fields?.key === key);
    expect(getCalendarRow(tb.ctx.db, familyId)?.last_error).toBe('Google Calendar denied Portly access to this calendar');
    expect(lines('calendar failing', 'warn')).toHaveLength(1);
    expect(lines('calendar failing', 'warn')[0]!.fields).toMatchObject({
      accountId: 'g1',
      code: 'denied',
      status: 403,
      providerReason: 'forbidden',
      nextAttemptAt: new Date(T0 + 15 * 60_000).toISOString(),
    });
    expect(calls('family0123')).toBe(1);

    // Runs inside the backoff skip the refused calendar (recorded as skipped); the others still sync.
    tb.clock.now += 5 * 60_000;
    await tb.module.service.syncAccounts();
    expect([calls('family0123'), calls('alice%40gmail.com')]).toEqual([1, 2]);
    expect(tb.ctx.health.get(key)).toMatchObject({ status: 'failing', detail: expect.objectContaining({ skipped: 'backoff' }), nextAttemptAt: T0 + 15 * 60_000 });

    // After it, the calendar is retried: the same failure is only logged at debug level and the wait doubles.
    tb.clock.now += 10 * 60_000;
    await tb.module.service.syncAccounts();
    expect(calls('family0123')).toBe(2);
    expect(lines('calendar failing', 'warn')).toHaveLength(1);
    expect(lines('calendar still failing', 'debug').at(-1)!.fields).toMatchObject({ code: 'denied', consecutive: 2 });
    expect(tb.ctx.health.get(key)).toMatchObject({ consecutiveFailures: 2, nextAttemptAt: tb.clock.now + 30 * 60_000 });
    tb.clock.now += 15 * 60_000;
    await tb.module.service.syncAccounts();
    expect(calls('family0123')).toBe(2);

    // An account change (e.g. a reconnect) retries right away.
    tb.accounts.emit({ type: 'updated', accountId: 'g1' });
    await tb.module.service.syncAccount('g1'); // joins the run started by the event
    expect(calls('family0123')).toBe(3);
    expect(lines('calendar failing', 'warn')).toHaveLength(1);
    expect(tb.ctx.health.get(key)).toMatchObject({ consecutiveFailures: 3, nextAttemptAt: tb.clock.now + 60 * 60_000 });

    // "Sync now" retries right away too; the recovery is logged and the error cleared.
    refused = false;
    expect((await tb.json('POST', '/api/calendar/sync')).status).toBe(200);
    expect(calls('family0123')).toBe(4);
    expect(getCalendarRow(tb.ctx.db, familyId)?.last_error).toBeNull();
    expect(log.lines.filter((l) => l.message === 'calendar recovered')).toEqual([
      expect.objectContaining({ level: 'info', fields: expect.objectContaining({ key, failures: 3 }) }),
    ]);
    expect(tb.ctx.health.get(key)).toMatchObject({ status: 'ok', nextAttemptAt: null });

    // A new failure after the recovery is a warning again.
    refused = true;
    tb.clock.now += 5 * 60_000;
    await tb.module.service.syncAccounts();
    expect(lines('calendar failing', 'warn')).toHaveLength(2);
  });

  it('retries transient failures every run, but reports a repeated failure only once', async () => {
    const log = createMemoryLogger();
    tb = calendarTestbed({
      accounts: [GOOGLE],
      log,
      fetchRoutes: [{ match: `${G_API}/users/me/calendarList`, respond: { status: 503, json: { error: { code: 503, status: 'UNAVAILABLE' } } } }],
    });
    for (let i = 0; i < 3; i++) {
      await tb.module.service.syncAccounts();
      tb.clock.now += 5 * 60_000;
    }
    expect(tb.ctx.fakeFetch!.calls).toHaveLength(3);
    const lines = log.lines.filter((l) => l.fields?.key === 'calendar-list:g1' && /^calendar (still )?failing$/.test(l.message));
    expect(lines.map((l) => [l.message, l.level])).toEqual([
      ['calendar failing', 'warn'],
      ['calendar still failing', 'debug'],
      ['calendar still failing', 'debug'],
    ]);
    expect(lines[0]!.fields).not.toHaveProperty('nextAttemptAt');
    expect(lines[0]!.fields).toMatchObject({ code: 'http_5xx', status: 503, providerReason: 'UNAVAILABLE', message: 'Google Calendar returned an error (503)' });
  });
});

describe('sync (Microsoft, CalDAV) and scheduling', () => {
  it('syncs Graph calendars with calendarView paging and the UTC Prefer header', async () => {
    const page1 = { ...graphCalendarViewPage1 };
    tb = calendarTestbed({
      accounts: [MS],
      fetchRoutes: [
        { match: 'https://graph.microsoft.com/v1.0/me/calendars?', respond: { json: graphCalendars } },
        { match: /calendarView\?.*%24skip=500/, respond: { json: { value: [] } } },
        { match: /AAAD\/calendarView/, respond: { json: page1 } },
        { match: /calendarView/, respond: { json: { value: [] } } },
      ],
    });
    await tb.module.service.syncAccounts();
    const view = tb.ctx.fakeFetch!.calls.find((c) => c.url.includes('AAAD/calendarView'))!;
    expect(view.headers.get('prefer')).toContain('outlook.timezone="UTC"');
    const params = new URL(view.url).searchParams;
    expect(params.get('startDateTime')).toBe('2026-08-26T00:00:00.000Z');
    expect(params.get('$top')).toBe('500');
    const res = await events('2026-09-30', '2026-10-05', 'Europe/Berlin');
    expect(res.events.map((e) => [e.title, e.start, e.allDay])).toEqual([
      ['Quarterly review', '2026-09-30T13:00:00.000Z', false],
      ['Public holiday', '2026-10-03', true],
    ]);
  });

  it('registers the jobs (initial run after 5 s), reschedules on settings change and syncs on POST /sync', async () => {
    tb = calendarTestbed({ accounts: [GOOGLE], fetchRoutes: googleRoutes() });
    const jobs = tb.ctx.scheduler.jobs();
    expect(jobs.find((j) => j.name === ACCOUNT_SYNC_JOB)).toMatchObject({ intervalMs: 5 * 60_000, dueAt: INITIAL_SYNC_DELAY_MS });
    expect(jobs.find((j) => j.name === ICS_SYNC_JOB)).toMatchObject({ intervalMs: ICS_SYNC_INTERVAL_MS, dueAt: INITIAL_SYNC_DELAY_MS });

    tb.ctx.settings.patch({ calendar: { syncIntervalMin: 15 } });
    expect(tb.ctx.scheduler.jobs().find((j) => j.name === ACCOUNT_SYNC_JOB)?.intervalMs).toBe(15 * 60_000);

    const res = await tb.json<Calendar[]>('POST', '/api/calendar/sync');
    expect(res.status).toBe(200);
    expect(res.body.map((c) => c.name)).toEqual(['alice@gmail.com', 'Feiertage', 'Family']);
    await tb.ctx.scheduler.advance(INITIAL_SYNC_DELAY_MS);
  });

  it('syncs a newly created account right away and resets a dangling default calendar on delete', async () => {
    tb = calendarTestbed({ fetchRoutes: googleRoutes() });
    tb.addAccount(GOOGLE);
    tb.accounts.emit({ type: 'created', accountId: 'g1' });
    await tb.module.service.syncAccount('g1'); // joins the run started by the event
    const primaryId = calendarIdByName('alice@gmail.com');
    tb.ctx.settings.patch({ calendar: { defaultCalendarId: primaryId } });

    tb.ctx.db.run('DELETE FROM accounts WHERE id = ?', ['g1']); // calendars and events cascade
    tb.accounts.remove('g1');
    tb.accounts.emit({ type: 'deleted', accountId: 'g1' });
    expect(tb.ctx.settings.get('calendar').defaultCalendarId).toBeNull();
  });

  it('records a CalDAV listing warning without marking the calendar as failed', async () => {
    let warning: string | null = 'Some repeating events were shortened: 1 event repeats too often, so only the first occurrences are shown.';
    tb = calendarTestbed({
      accounts: [{ id: 'y1', kind: 'yahoo', label: 'Yahoo', capabilities: ['calendar'], password: 'pw' }],
      module: {
        providers: {
          caldav: {
            source: 'caldav',
            listCalendars: async () => [{ remoteId: 'https://caldav.example.com/cal/', name: 'Personal', color: null, writable: false, primary: true }],
            listEvents: async () => ({ events: [record({ remoteId: 'e1', title: 'Yoga' })], warning }),
          },
        },
      },
    });
    await tb.module.service.syncAccounts();
    let cal = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'))[0]!;
    expect(cal.lastError).toBe(`Warning: ${warning}`);
    expect(isCalendarWarning(cal.lastError)).toBe(true);
    expect(cal.lastSyncedAt).toBe(new Date(T0).toISOString());
    expect((await events('2026-10-01', '2026-10-02')).events.map((e) => e.title)).toEqual(['Yoga']);
    // Partial data: the calendar's health is degraded (not failing), with the warning as its message.
    expect(tb.ctx.health.get(`calendar:${cal.id}`)).toMatchObject({ status: 'degraded', lastCode: 'truncated', lastMessage: warning, detail: { mode: 'full', fetched: 1 } });

    warning = null;
    tb.clock.now += 60_000;
    await tb.module.service.syncAccounts();
    cal = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'))[0]!;
    expect(cal.lastError).toBeNull();
    expect(tb.ctx.health.get(`calendar:${cal.id}`)?.status).toBe('ok');
  });

  it('hides calendars of accounts whose calendar capability is switched off', async () => {
    tb = calendarTestbed({ accounts: [GOOGLE], fetchRoutes: googleRoutes() });
    await tb.module.service.syncAccounts();
    tb.accounts.add({ ...GOOGLE, enabledCapabilities: ['mail'] });
    expect(json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'))).toEqual([]);
    expect((await tb.json('GET', '/api/calendar/events?from=2026-09-01&to=2026-10-01&tz=UTC')).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------

function record(overrides: Partial<EventRecord>): EventRecord {
  return {
    remoteId: 'r',
    instanceKey: null,
    etag: null,
    title: 'x',
    location: null,
    description: null,
    start: '2026-10-01T10:00:00Z',
    end: '2026-10-01T11:00:00Z',
    allDay: false,
    timezone: null,
    status: 'confirmed',
    recurring: false,
    seriesId: null,
    htmlUrl: null,
    meetingUrl: null,
    editable: false,
    ...overrides,
  };
}

describe('GET /api/calendar/events (§7 window semantics)', () => {
  async function seedIcs(records: EventRecord[]): Promise<string> {
    tb = calendarTestbed({ fetchRoutes: [{ match: 'https://feeds.example.com/', respond: { text: SIMPLE_FEED } }] });
    const created = json<Calendar>(await tb.json('POST', '/api/calendar/ics', { body: { url: 'https://feeds.example.com/cal.ics', name: 'Feed' } }));
    tb.clock.now += 1000;
    replaceCalendarEvents(tb.ctx.db, created.id, records, { now: tb.clock.now, startedAt: tb.clock.now });
    return created.id;
  }

  it('answers 409 not_configured when there are no calendars; validates the query', async () => {
    tb = calendarTestbed();
    const res = await tb.json<{ error: { code: string } }>('GET', '/api/calendar/events?from=2026-09-01&to=2026-10-01&tz=UTC');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_configured');
    await seedIcs([]);
    expect((await tb.json('GET', '/api/calendar/events?from=2026-10-02&to=2026-10-01&tz=UTC')).status).toBe(422);
    expect((await tb.json('GET', '/api/calendar/events?from=2026-10-01&to=2026-10-02&tz=Mars%2FBase')).status).toBe(422);
    expect((await tb.json('GET', '/api/calendar/events?from=2026-10-01&tz=UTC')).status).toBe(422);
  });

  it('interprets timed boundaries in the requested zone and all-day dates as dates', async () => {
    await seedIcs([
      record({ remoteId: 'late', title: 'Late UTC', start: '2026-10-01T23:30:00Z', end: '2026-10-02T00:30:00Z' }),
      record({ remoteId: 'day', title: 'All day Oct 2', allDay: true, start: '2026-10-02', end: '2026-10-03' }),
      record({ remoteId: 'span', title: 'Trip', allDay: true, start: '2026-09-30', end: '2026-10-05' }),
      record({ remoteId: 'endsAtFrom', title: 'Ends at midnight', start: '2026-10-01T23:00:00Z', end: '2026-10-02T00:00:00Z' }),
      record({ remoteId: 'startsAtTo', title: 'Starts at midnight', start: '2026-10-03T00:00:00Z', end: '2026-10-03T01:00:00Z' }),
    ]);

    const utc = await events('2026-10-02', '2026-10-03', 'UTC');
    expect(utc.window).toEqual({ from: '2026-10-02', to: '2026-10-03' });
    expect(utc.events.map((e) => e.title).sort()).toEqual(['All day Oct 2', 'Late UTC', 'Trip']);

    // Tokyo (UTC+9): Oct 2 is 2026-10-01T15:00Z … 2026-10-02T15:00Z.
    const tokyo = await events('2026-10-02', '2026-10-03', 'Asia/Tokyo');
    expect(tokyo.events.map((e) => e.title).sort()).toEqual(['All day Oct 2', 'Ends at midnight', 'Late UTC', 'Trip']);

    // Los Angeles (UTC-7): Oct 2 is 2026-10-02T07:00Z … 2026-10-03T07:00Z.
    const la = await events('2026-10-02', '2026-10-03', 'America/Los_Angeles');
    expect(la.events.map((e) => e.title).sort()).toEqual(['All day Oct 2', 'Starts at midnight', 'Trip']);

    const next = await events('2026-10-03', '2026-10-04', 'UTC');
    expect(next.events.map((e) => e.title).sort()).toEqual(['Starts at midnight', 'Trip']);
  });

  it('clips the window to the synced range and maps rows to CalendarEvent', async () => {
    const calId = await seedIcs([record({ remoteId: 'a', title: 'A', htmlUrl: 'https://example.com/a', description: 'see https://example.com' })]);
    const res = await events('2026-01-01', '2030-01-01', 'UTC');
    expect(res.window).toEqual({ from: '2026-08-26', to: '2027-09-25' });
    const [event] = res.events as [CalendarEvent];
    expect(event).toEqual({
      id: eventId(calId, 'a', null),
      calendarId: calId,
      title: 'A',
      location: null,
      description: 'see https://example.com',
      start: '2026-10-01T10:00:00.000Z',
      end: '2026-10-01T11:00:00.000Z',
      allDay: false,
      timezone: null,
      status: 'confirmed',
      recurring: false,
      seriesId: null,
      htmlUrl: 'https://example.com/a',
      meetingUrl: null,
      editable: false,
    });
    const outside = await events('2028-01-01', '2028-02-01', 'UTC');
    expect(outside).toEqual({ events: [], window: { from: '2028-01-01', to: '2028-01-01' } });
  });
});

// ---------------------------------------------------------------------------

describe('event writes (write-through)', () => {
  const createdGoogle = {
    id: 'newevt1',
    status: 'confirmed',
    htmlLink: 'https://www.google.com/calendar/event?eid=bmV3',
    summary: 'Lunch',
    organizer: { email: 'alice@gmail.com', self: true },
    start: { dateTime: '2026-10-07T12:00:00+02:00', timeZone: 'Europe/Berlin' },
    end: { dateTime: '2026-10-07T13:00:00+02:00', timeZone: 'Europe/Berlin' },
  };

  async function googleBed(extra: FakeFetchRoute[] = []) {
    tb = calendarTestbed({ accounts: [GOOGLE], fetchRoutes: [...extra, ...googleRoutes()] });
    await tb.module.service.syncAccounts();
    return calendarIdByName('alice@gmail.com');
  }

  it('creates an event (201) and upserts the cache row from the provider response', async () => {
    const bodies: unknown[] = [];
    const calId = await googleBed([
      {
        match: PRIMARY_EVENTS,
        method: 'POST',
        respond: (req: FakeRequest) => {
          bodies.push(JSON.parse(req.body!));
          return { json: createdGoogle };
        },
      },
    ]);
    const res = await tb.json<CalendarEvent>('POST', '/api/calendar/events', {
      body: { calendarId: calId, title: 'Lunch', allDay: false, start: '2026-10-07T12:00:00+02:00', end: '2026-10-07T13:00:00+02:00', timezone: 'Europe/Berlin', location: '' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: eventId(calId, 'newevt1', null), title: 'Lunch', start: '2026-10-07T10:00:00.000Z', editable: true });
    expect(bodies[0]).toEqual({
      summary: 'Lunch',
      location: '',
      start: { dateTime: '2026-10-07T12:00:00+02:00', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-10-07T13:00:00+02:00', timeZone: 'Europe/Berlin' },
    });
    expect((await events('2026-10-07', '2026-10-08', 'Europe/Berlin')).events.map((e) => e.title)).toContain('Lunch');
  });

  it('patches a single instance and deletes; a stale listing cannot resurrect a deleted event', async () => {
    const calId = await googleBed([
      { match: `${PRIMARY_EVENTS}/abc123timed`, method: 'PATCH', respond: { json: { ...googleEventsPage1.items[0], summary: 'Dentist (moved)', start: { dateTime: '2026-09-28T11:00:00+02:00' }, end: { dateTime: '2026-09-28T12:00:00+02:00' } } } },
      { match: `${PRIMARY_EVENTS}/abc123timed`, method: 'DELETE', respond: { status: 204 } },
    ]);
    const id = eventId(calId, 'abc123timed', null);
    const patched = await tb.json<CalendarEvent>('PATCH', `/api/calendar/events/${encodeURIComponent(id)}`, {
      body: { title: 'Dentist (moved)', allDay: false, start: '2026-09-28T11:00:00+02:00', end: '2026-09-28T12:00:00+02:00', timezone: 'Europe/Berlin' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ id, title: 'Dentist (moved)', start: '2026-09-28T09:00:00.000Z' });
    const patchCall = tb.ctx.fakeFetch!.calls.find((c) => c.method === 'PATCH')!;
    expect(JSON.parse(patchCall.body!)).toMatchObject({ summary: 'Dentist (moved)', start: { dateTime: '2026-09-28T11:00:00+02:00', timeZone: 'Europe/Berlin', date: null } });

    const del = await tb.req('DELETE', `/api/calendar/events/${encodeURIComponent(id)}`);
    expect(del.status).toBe(204);
    expect(tb.ctx.db.get('SELECT 1 AS x FROM events WHERE id = ?', [id])).toBeUndefined();
    // The next sync still sees the event (listing fetched before the delete propagated).
    tb.clock.now += 1000;
    await tb.module.service.syncAccounts();
    expect(tb.ctx.db.get('SELECT 1 AS x FROM events WHERE id = ?', [id])).toBeUndefined();
  });

  it('a listing requested before a write-through edit neither overwrites nor deletes the edit', async () => {
    let hold = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    const calId = await googleBed([
      {
        match: `${PRIMARY_EVENTS}/abc123timed`,
        method: 'PATCH',
        respond: { json: { ...googleEventsPage1.items[0], summary: 'Dentist (moved)' } },
      },
      {
        match: PRIMARY_EVENTS,
        method: 'GET',
        respond: async (req: FakeRequest) => {
          if (hold) {
            hold = false;
            signalStarted();
            await gate; // the listing is "in flight" while the user edits
          }
          return { json: new URL(req.url).searchParams.get('pageToken') === 'page-2' ? googleEventsPage2 : googleEventsPage1 };
        },
      },
    ]);
    const id = eventId(calId, 'abc123timed', null);
    hold = true;
    tb.clock.now += 1000;
    const sync = tb.module.service.syncAccounts();
    await started;
    tb.clock.now += 1000;
    const patched = await tb.json<CalendarEvent>('PATCH', `/api/calendar/events/${encodeURIComponent(id)}`, { body: { title: 'Dentist (moved)' } });
    expect(patched.status).toBe(200);
    tb.clock.now += 1000;
    release();
    await sync;
    expect(tb.ctx.db.get<{ title: string }>('SELECT title FROM events WHERE id = ?', [id])?.title).toBe('Dentist (moved)');
    // The next sync (listing requested after the edit) applies the provider's data again.
    tb.clock.now += 1000;
    await tb.module.service.syncAccounts();
    expect(tb.ctx.db.get<{ title: string }>('SELECT title FROM events WHERE id = ?', [id])?.title).not.toBe('Dentist (moved)');
  });

  it('refuses writes to read-only calendars (403), read-only sources (409) and events the user does not organize (403)', async () => {
    const calId = await googleBed();
    const holidays = calendarIdByName('Feiertage');
    const input = { title: 'X', allDay: true, start: '2026-10-07', end: '2026-10-08', timezone: 'UTC' };
    const forbidden = await tb.json<{ error: { code: string } }>('POST', '/api/calendar/events', { body: { ...input, calendarId: holidays } });
    expect([forbidden.status, forbidden.body.error.code]).toEqual([403, 'forbidden']);

    await tb.req('PATCH', `/api/calendar/calendars/${calId}`, { body: { userReadOnly: true } });
    expect((await tb.json('POST', '/api/calendar/events', { body: { ...input, calendarId: calId } })).status).toBe(403);
    const cal = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars')).find((c) => c.id === calId)!;
    expect(cal).toMatchObject({ writable: false, providerWritable: true, userReadOnly: true });
    await tb.req('PATCH', `/api/calendar/calendars/${calId}`, { body: { userReadOnly: false } });

    const notMine = eventId(calId, 'weekly789_20260929T070000Z', null);
    const refused = await tb.json<{ error: { code: string } }>('PATCH', `/api/calendar/events/${encodeURIComponent(notMine)}`, { body: { title: 'x' } });
    expect([refused.status, refused.body.error.code]).toEqual([403, 'forbidden']);

    // ICS is read-only in v1.
    tb.ctx.fakeFetch!.add({ match: 'https://feeds.example.com/', respond: { text: SIMPLE_FEED } });
    const feed = json<Calendar>(await tb.json('POST', '/api/calendar/ics', { body: { url: 'https://feeds.example.com/h.ics', name: 'Holidays' } }));
    const conflict = await tb.json<{ error: { code: string } }>('POST', '/api/calendar/events', { body: { ...input, calendarId: feed.id } });
    expect([conflict.status, conflict.body.error.code]).toEqual([409, 'conflict']);
    const icsEvent = tb.ctx.db.get<{ id: string }>('SELECT id FROM events WHERE calendar_id = ?', [feed.id])!;
    expect((await tb.json('DELETE', `/api/calendar/events/${encodeURIComponent(icsEvent.id)}`)).status).toBe(409);
    expect((await tb.json('PATCH', '/api/calendar/events/nope', { body: { title: 'x' } })).status).toBe(404);
  });

  it('validates event input (end after start, all-day dates, fields sent together)', async () => {
    const calId = await googleBed();
    const bad = [
      { calendarId: calId, title: 'X', allDay: false, start: '2026-10-07T12:00:00Z', end: '2026-10-07T11:00:00Z', timezone: 'UTC' },
      { calendarId: calId, title: 'X', allDay: true, start: '2026-10-07T00:00:00Z', end: '2026-10-08', timezone: 'UTC' },
      { calendarId: calId, title: '', allDay: true, start: '2026-10-07', end: '2026-10-08', timezone: 'UTC' },
    ];
    for (const body of bad) expect((await tb.json('POST', '/api/calendar/events', { body })).status).toBe(422);
    const id = eventId(calId, 'abc123timed', null);
    expect((await tb.json('PATCH', `/api/calendar/events/${encodeURIComponent(id)}`, { body: { start: '2026-10-07T10:00:00Z' } })).status).toBe(422);
  });

  it('creates Outlook events with Windows zone names and surfaces reauth for write calls', async () => {
    const posts: unknown[] = [];
    tb = calendarTestbed({
      accounts: [MS],
      fetchRoutes: [
        { match: 'https://graph.microsoft.com/v1.0/me/calendars?', respond: { json: graphCalendars } },
        {
          match: /\/me\/calendars\/[^/]+\/events$/,
          method: 'POST',
          respond: (req) => {
            posts.push(JSON.parse(req.body!));
            return { status: 201, json: { ...graphCalendarViewPage1.value[0], id: 'AAMkNEW=', subject: 'Call' } };
          },
        },
        { match: /calendarView/, respond: { json: { value: [] } } },
      ],
    });
    await tb.module.service.syncAccounts();
    const calId = calendarIdByName('Calendar');
    const res = await tb.json<CalendarEvent>('POST', '/api/calendar/events', {
      body: { calendarId: calId, title: 'Call', allDay: false, start: '2026-09-30T15:00:00+02:00', end: '2026-09-30T16:30:00+02:00', timezone: 'Europe/Berlin' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: 'Call', meetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc' });
    expect(posts[0]).toMatchObject({ subject: 'Call', isAllDay: false, start: { dateTime: '2026-09-30T15:00:00', timeZone: 'W. Europe Standard Time' } });

    tb.accounts.add({ ...MS, token: undefined });
    const reauth = await tb.json<{ error: { code: string; accountId: string } }>('POST', '/api/calendar/events', {
      body: { calendarId: calId, title: 'Call', allDay: true, start: '2026-09-30', end: '2026-10-01', timezone: 'Europe/Berlin' },
    });
    expect(reauth.status).toBe(409);
    expect(reauth.body.error).toMatchObject({ code: 'reauth_required', accountId: 'm1' });
  });
});

// ---------------------------------------------------------------------------

describe('ICS subscriptions', () => {
  it('adds a webcal feed: https fetch, URL in the vault, host-only display, events cached', async () => {
    tb = calendarTestbed({
      fetchRoutes: [{ match: 'https://calendar.example.org/', respond: { text: SIMPLE_FEED, headers: { etag: '"v1"', 'last-modified': 'Wed, 23 Sep 2026 10:00:00 GMT' } } }],
    });
    const res = await tb.json<Calendar>('POST', '/api/calendar/ics', {
      body: { url: 'webcal://calendar.example.org/private/abc123token/basic.ics', name: 'Proton', color: '#22C55E' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ source: 'ics', name: 'Proton', displayUrl: 'calendar.example.org', color: '#22c55e', writable: false, accountId: null, lastError: null });
    expect(JSON.stringify(res.body)).not.toContain('abc123token');
    expect(tb.ctx.fakeFetch!.calls[0]!.url).toBe('https://calendar.example.org/private/abc123token/basic.ics');
    expect(tb.ctx.vault.get(`ics:${res.body.id}`)).toBe('https://calendar.example.org/private/abc123token/basic.ics');
    expect((await events('2026-10-01', '2026-10-15')).events.map((e) => e.title)).toEqual(['Unity Day', 'Parade']);
    const listed = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'));
    expect(JSON.stringify(listed)).not.toContain('abc123token');
  });

  it('validates that the first fetch returns a calendar (422 on url) and refuses private addresses', async () => {
    tb = calendarTestbed({ fetchRoutes: [{ match: 'https://example.org/page', respond: { text: '<html><body>Hello</body></html>' } }] });
    const notCal = await tb.json<{ error: { code: string; details: { path: string }[] } }>('POST', '/api/calendar/ics', { body: { url: 'https://example.org/page', name: 'X' } });
    expect(notCal.status).toBe(422);
    expect(notCal.body.error.details[0]?.path).toBe('url');
    const priv = await tb.json('POST', '/api/calendar/ics', { body: { url: 'http://127.0.0.1:8080/cal.ics', name: 'X' } });
    expect(priv.status).toBe(422);
    const bad = await tb.json('POST', '/api/calendar/ics', { body: { url: 'javascript:alert(1)', name: 'X' } });
    expect(bad.status).toBe(422);
    expect(tb.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM calendars')?.n).toBe(0);
    expect(tb.ctx.vault.list('ics:')).toEqual([]);
  });

  it('uses conditional GET within the same window; a new day refetches the body; failures keep rows', async () => {
    const requests: FakeRequest[] = [];
    let mode: 'body' | '304' | '500' = 'body';
    tb = calendarTestbed({
      fetchRoutes: [
        {
          match: 'https://feeds.example.com/',
          respond: (req) => {
            requests.push(req);
            if (mode === '304') return { status: 304 };
            if (mode === '500') return { status: 500, text: 'oops' };
            return { text: SIMPLE_FEED, headers: { etag: '"v1"', 'last-modified': 'Wed, 23 Sep 2026 10:00:00 GMT' } };
          },
        },
      ],
    });
    const cal = json<Calendar>(await tb.json('POST', '/api/calendar/ics', { body: { url: 'https://feeds.example.com/a.ics', name: 'A' } }));
    expect(requests[0]!.headers.get('if-none-match')).toBeNull();

    mode = '304';
    tb.clock.now += 30 * 60_000;
    await tb.module.service.syncIcs(cal.id);
    expect(requests[1]!.headers.get('if-none-match')).toBe('"v1"');
    expect(requests[1]!.headers.get('if-modified-since')).toBe('Wed, 23 Sep 2026 10:00:00 GMT');
    let listed = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'))[0]!;
    expect(listed.lastSyncedAt).toBe(new Date(tb.clock.now).toISOString());
    expect((await events('2026-10-01', '2026-10-15')).events).toHaveLength(2);

    mode = 'body';
    tb.clock.now += 24 * 3600_000;
    await tb.module.service.syncIcs(cal.id);
    expect(requests[2]!.headers.get('if-none-match')).toBeNull();

    mode = '500';
    tb.clock.now += 60_000;
    await tb.module.service.syncIcs(cal.id);
    listed = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'))[0]!;
    expect(listed.lastError).toBe('feeds.example.com answered 500');
    expect((await events('2026-10-01', '2026-10-15')).events).toHaveLength(2);
  });

  it('records feed limits as last_error and keeps previous rows', async () => {
    let body = SIMPLE_FEED;
    tb = calendarTestbed({ fetchRoutes: [{ match: 'https://feeds.example.com/', respond: () => ({ text: body }) }] });
    const cal = json<Calendar>(await tb.json('POST', '/api/calendar/ics', { body: { url: 'https://feeds.example.com/a.ics', name: 'A' } }));
    body = manyVevents(5_001);
    tb.clock.now += 24 * 3600_000;
    await tb.module.service.syncIcs(cal.id);
    const listed = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'))[0]!;
    expect(listed.lastError).toMatch(/more than 5,000 events/);
    expect(isCalendarWarning(listed.lastError)).toBe(false);
    expect((await events('2026-10-01', '2026-10-15')).events).toHaveLength(2);
  });

  it('shortens an endlessly repeating event with a warning instead of failing the feed (kept through 304s)', async () => {
    let body = SIMPLE_FEED;
    let status = 200;
    tb = calendarTestbed({
      fetchRoutes: [{ match: 'https://feeds.example.com/', respond: () => (status === 304 ? { status: 304 } : { text: body, headers: { etag: '"v2"' } }) }],
    });
    const cal = json<Calendar>(await tb.json('POST', '/api/calendar/ics', { body: { url: 'https://feeds.example.com/a.ics', name: 'A' } }));
    body = SIMPLE_FEED.replace('END:VCALENDAR', ['BEGIN:VEVENT', 'UID:s', 'DTSTART:20261001T000000Z', 'DTEND:20261001T001500Z', 'RRULE:FREQ=HOURLY', 'SUMMARY:Ping', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    tb.clock.now += 24 * 3600_000;
    await tb.module.service.syncIcs(cal.id);

    let listed = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'))[0]!;
    expect(listed.lastError).toBe('Warning: Some repeating events were shortened: 1 event repeats too often, so only the first occurrences are shown.');
    expect(isCalendarWarning(listed.lastError)).toBe(true);
    expect(listed.lastSyncedAt).toBe(new Date(tb.clock.now).toISOString());
    const shown = (await events('2026-10-01', '2026-10-15')).events;
    expect(shown.filter((e) => e.title === 'Ping')).toHaveLength(14 * 24);
    expect(shown.filter((e) => e.title !== 'Ping').map((e) => e.title)).toEqual(['Unity Day', 'Parade']);
    expect(tb.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?', [cal.id])?.n).toBe(1_002);

    // Unchanged (304): the warning about the unchanged data stays.
    status = 304;
    tb.clock.now += 30 * 60_000;
    await tb.module.service.syncIcs(cal.id);
    listed = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'))[0]!;
    expect(isCalendarWarning(listed.lastError)).toBe(true);

    // A clean feed clears it.
    status = 200;
    body = SIMPLE_FEED;
    tb.clock.now += 24 * 3600_000;
    await tb.module.service.syncIcs(cal.id);
    listed = json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'))[0]!;
    expect(listed.lastError).toBeNull();
  });

  it('edits name and URL, deletes feeds (secret removed, default reset) and refuses deleting account calendars', async () => {
    tb = calendarTestbed({
      accounts: [GOOGLE],
      fetchRoutes: [
        { match: 'https://feeds.example.com/', respond: { text: SIMPLE_FEED } },
        { match: 'https://other.example.com/', respond: { text: ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//y//EN', 'END:VCALENDAR']) } },
        ...googleRoutes(),
      ],
    });
    const cal = json<Calendar>(await tb.json('POST', '/api/calendar/ics', { body: { url: 'https://feeds.example.com/a.ics', name: 'A' } }));
    tb.clock.now += 1000;
    const renamed = await tb.json<Calendar>('PATCH', `/api/calendar/ics/${cal.id}`, { body: { name: 'Renamed', url: 'webcal://other.example.com/b.ics' } });
    expect(renamed.body).toMatchObject({ name: 'Renamed', displayUrl: 'other.example.com' });
    expect(tb.ctx.vault.get(`ics:${cal.id}`)).toBe('https://other.example.com/b.ics');
    expect(tb.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?', [cal.id])?.n).toBe(0);

    tb.ctx.settings.patch({ calendar: { defaultCalendarId: cal.id } });
    expect((await tb.req('DELETE', `/api/calendar/calendars/${cal.id}`)).status).toBe(204);
    expect(tb.ctx.vault.get(`ics:${cal.id}`)).toBeNull();
    expect(tb.ctx.settings.get('calendar').defaultCalendarId).toBeNull();

    await tb.module.service.syncAccounts();
    const google = calendarIdByName('alice@gmail.com');
    const refused = await tb.json<{ error: { code: string } }>('DELETE', `/api/calendar/calendars/${google}`);
    expect([refused.status, refused.body.error.code]).toEqual([409, 'conflict']);
    expect((await tb.json('PATCH', `/api/calendar/ics/${google}`, { body: { name: 'x' } })).status).toBe(409);
  });
});

describe('PATCH /api/calendar/calendars/:id', () => {
  it('updates allowlisted fields and rejects anything else', async () => {
    tb = calendarTestbed({ fetchRoutes: [{ match: 'https://feeds.example.com/', respond: { text: SIMPLE_FEED } }] });
    const cal = json<Calendar>(await tb.json('POST', '/api/calendar/ics', { body: { url: 'https://feeds.example.com/a.ics', name: 'A' } }));
    const res = await tb.json<Calendar>('PATCH', `/api/calendar/calendars/${cal.id}`, { body: { visible: false, colorOverride: '#ABCDEF', sort: 7 } });
    expect(res.body).toMatchObject({ visible: false, color: '#abcdef', colorOverride: '#abcdef', sort: 7 });
    expect(json<Calendar[]>(await tb.json('GET', '/api/calendar/calendars'))[0]).toMatchObject({ color: '#abcdef', colorOverride: '#abcdef' });
    const reset = await tb.json<Calendar>('PATCH', `/api/calendar/calendars/${cal.id}`, { body: { colorOverride: null } });
    expect(reset.body.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(reset.body.color).not.toBe('#abcdef');
    expect(reset.body.colorOverride).toBeNull();
    for (const body of [{ colorOverride: 'red' }, { name: 'x' }, { visible: 'yes' }, { 'color_override); DROP TABLE calendars;--': 1 }]) {
      expect((await tb.json('PATCH', `/api/calendar/calendars/${cal.id}`, { body })).status, JSON.stringify(body)).toBe(422);
    }
    expect((await tb.json('PATCH', '/api/calendar/calendars/missing', { body: { visible: true } })).status).toBe(404);
  });
});

describe('GET /api/calendar/events — selection, limits and edges (CAL-4, CAL-5, DOS-3)', () => {
  async function seedTwoFeeds(): Promise<{ shown: string; hidden: string }> {
    tb = calendarTestbed({ fetchRoutes: [{ match: 'https://feeds.example.com/', respond: { text: SIMPLE_FEED } }] });
    const shown = json<Calendar>(await tb.json('POST', '/api/calendar/ics', { body: { url: 'https://feeds.example.com/a.ics', name: 'Shown' } })).id;
    const hidden = json<Calendar>(await tb.json('POST', '/api/calendar/ics', { body: { url: 'https://feeds.example.com/b.ics', name: 'Hidden' } })).id;
    tb.clock.now += 1000;
    replaceCalendarEvents(tb.ctx.db, shown, [record({ remoteId: 's', title: 'From shown' })], { now: tb.clock.now, startedAt: tb.clock.now });
    replaceCalendarEvents(tb.ctx.db, hidden, [record({ remoteId: 'h', title: 'From hidden' })], { now: tb.clock.now, startedAt: tb.clock.now });
    expect((await tb.json('PATCH', `/api/calendar/calendars/${hidden}`, { body: { visible: false } })).status).toBe(200);
    return { shown, hidden };
  }

  it('returns only visible calendars unless the widget names calendars explicitly (hidden ones included)', async () => {
    const { shown, hidden } = await seedTwoFeeds();
    expect((await events('2026-10-01', '2026-10-02')).events.map((e) => e.title)).toEqual(['From shown']);
    const named = await tb.json<EventsResponse>('GET', `/api/calendar/events?from=2026-10-01&to=2026-10-02&tz=UTC&calendarIds=${hidden}`);
    expect(named.body.events.map((e) => e.title)).toEqual(['From hidden']);
    const both = await tb.json<EventsResponse>('GET', `/api/calendar/events?from=2026-10-01&to=2026-10-02&tz=UTC&calendarIds=${shown},${hidden}`);
    expect(both.body.events.map((e) => e.title).sort()).toEqual(['From hidden', 'From shown']);
    const tooMany = Array.from({ length: 201 }, (_, i) => `c${i}`).join(',');
    expect((await tb.json('GET', `/api/calendar/events?from=2026-10-01&to=2026-10-02&tz=UTC&calendarIds=${tooMany}`)).status).toBe(422);
  });

  it('a zero-length event exactly at the start of the range belongs to that range (and not the previous one)', async () => {
    await seedTwoFeeds();
    const shown = calendarIdByName('Shown');
    tb.clock.now += 1000;
    replaceCalendarEvents(
      tb.ctx.db,
      shown,
      [
        // 00:00 America/Chicago on Sep 27.
        record({ remoteId: 'zero', title: 'Zero at midnight', start: '2026-09-27T05:00:00Z', end: '2026-09-27T05:00:00Z' }),
        record({ remoteId: 'zero-end', title: 'Zero at next midnight', start: '2026-09-28T05:00:00Z', end: '2026-09-28T05:00:00Z' }),
      ],
      { now: tb.clock.now, startedAt: tb.clock.now },
    );
    const titles = async (from: string, to: string) => (await events(from, to, 'America/Chicago')).events.map((e) => e.title);
    expect(await titles('2026-09-27', '2026-09-28')).toEqual(['Zero at midnight']);
    expect(await titles('2026-09-26', '2026-09-27')).toEqual([]);
  });

  it('caps one response by event count and text, earliest events first, flagged truncated', async () => {
    await seedTwoFeeds();
    const shown = calendarIdByName('Shown');
    const big = 'd'.repeat(8_000);
    const many = Array.from({ length: 1_200 }, (_, i) =>
      record({ remoteId: `e${i}`, title: `E${String(i).padStart(4, '0')}`, description: big, start: `2026-10-01T${String(Math.floor(i / 60) % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`, end: '2026-10-02T00:00:00Z' }),
    );
    tb.clock.now += 1000;
    replaceCalendarEvents(tb.ctx.db, shown, many, { now: tb.clock.now, startedAt: tb.clock.now });
    const res = await events('2026-10-01', '2026-10-02');
    expect(res.truncated).toBe(true);
    const text = res.events.reduce((sum, e) => sum + e.title.length + (e.description?.length ?? 0), 0);
    expect(text).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(res.events.length).toBeGreaterThan(400);
    expect(res.events[0]!.title).toBe('E0000');
    const small = await events('2026-10-03', '2026-10-04');
    expect(small.truncated).toBeUndefined();
  });
});

describe('events storage (CAL-1, DOS-3)', () => {
  it('a sync does not rewrite unchanged rows', async () => {
    tb = calendarTestbed({ fetchRoutes: [{ match: 'https://feeds.example.com/', respond: { text: SIMPLE_FEED } }] });
    const id = json<Calendar>(await tb.json('POST', '/api/calendar/ics', { body: { url: 'https://feeds.example.com/a.ics', name: 'Feed' } })).id;
    const records = [record({ remoteId: 'same', title: 'Same' }), record({ remoteId: 'edited', title: 'Before' })];
    tb.clock.now += 1000;
    replaceCalendarEvents(tb.ctx.db, id, records, { now: tb.clock.now, startedAt: tb.clock.now });
    const firstWrite = tb.clock.now;
    tb.clock.now += 1000;
    const result = replaceCalendarEvents(tb.ctx.db, id, [records[0]!, record({ remoteId: 'edited', title: 'After' })], { now: tb.clock.now, startedAt: tb.clock.now });
    expect(result).toMatchObject({ upserted: 2, deleted: 0 });
    const rows = tb.ctx.db.all<{ remote_id: string; title: string; updated_at: number }>('SELECT remote_id, title, updated_at FROM events WHERE calendar_id = ? ORDER BY remote_id', [id]);
    expect(rows).toEqual([
      { remote_id: 'edited', title: 'After', updated_at: tb.clock.now },
      { remote_id: 'same', title: 'Same', updated_at: firstWrite },
    ]);
  });

  it('refuses a listing that would push the whole cache past the global limits, keeping the old rows', async () => {
    tb = calendarTestbed({ fetchRoutes: [{ match: 'https://feeds.example.com/', respond: { text: SIMPLE_FEED } }] });
    const a = json<Calendar>(await tb.json('POST', '/api/calendar/ics', { body: { url: 'https://feeds.example.com/a.ics', name: 'A' } })).id;
    const b = json<Calendar>(await tb.json('POST', '/api/calendar/ics', { body: { url: 'https://feeds.example.com/b.ics', name: 'B' } })).id;
    const storageLimits = { events: 1_000, chars: 80_000 };
    const batch = (prefix: string, n: number, description: string | null = null) =>
      Array.from({ length: n }, (_, i) => record({ remoteId: `${prefix}${i}`, description }));
    const replace = (id: string, records: EventRecord[]) => {
      tb.clock.now += 1000;
      return replaceCalendarEvents(tb.ctx.db, id, records, { now: tb.clock.now, startedAt: tb.clock.now, storageLimits });
    };
    const count = (id: string) => tb.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?', [id])!.n;

    expect(replace(a, batch('a', 9, 'x'.repeat(10_000))).limited).toBeUndefined();
    expect(replace(b, batch('b', 5)).limited).toBeUndefined();
    // Text (descriptions are capped at 8 KiB): A's ~73,700 chars + B's 2 × ~8,200 would pass 80,000.
    expect(replace(b, batch('b', 2, 'y'.repeat(10_000)))).toMatchObject({ limited: true, upserted: 0 });
    expect(count(b)).toBe(5);
    expect(getCalendarRow(tb.ctx.db, b)?.last_error).toBe(STORAGE_LIMIT_ERROR);
    // Rows: 9 + 992 > 1,000.
    expect(replace(b, batch('b', 992)).limited).toBe(true);
    // A calendar may always shrink or stay the same; removing the big feed makes room again.
    expect(replace(a, batch('a', 9, 'x'.repeat(10_000))).limited).toBeUndefined();
    expect((await tb.req('DELETE', `/api/calendar/calendars/${a}`)).status).toBe(204);
    expect(replace(b, batch('b', 992))).toMatchObject({ upserted: 992 });
  });
});

describe('Google listing size (CAL-3)', () => {
  it('asks for compact, projected pages and accepts a busy page over the 5 MB JSON default', async () => {
    const busy = {
      timeZone: 'Europe/Berlin',
      items: Array.from({ length: 700 }, (_, i) => ({
        id: `busy${i}`,
        status: 'confirmed',
        summary: `Meeting ${i}`,
        description: 'agenda '.repeat(1_300),
        start: { dateTime: '2026-10-01T09:00:00+02:00' },
        end: { dateTime: '2026-10-01T10:00:00+02:00' },
      })),
    };
    tb = calendarTestbed({ accounts: [GOOGLE], fetchRoutes: googleRoutes({ first: busy }) });
    await tb.module.service.syncAccounts();
    const primary = calendarIdByName('alice@gmail.com');
    expect(getCalendarRow(tb.ctx.db, primary)?.last_error).toBeNull();
    expect(tb.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?', [primary])!.n).toBe(700);
    const listCall = tb.ctx.fakeFetch!.calls.find((c) => c.url.includes('/users/me/calendarList'))!;
    expect(Object.fromEntries(new URL(listCall.url).searchParams)).toMatchObject({ prettyPrint: 'false', fields: expect.stringContaining('items(id,') });
  });
});

// ---------------------------------------------------------------------------

describe('health and diagnostics', () => {
  it('records the calendar list and every calendar with their detail, inside the unit of work’s log context', async () => {
    const log = createTestLogger();
    tb = calendarTestbed({ accounts: [GOOGLE], fetchRoutes: googleRoutes(), log });
    await tb.module.service.syncAccounts();
    const primaryId = calendarIdByName('alice@gmail.com');
    const expectEveryMs = 3 * 5 * 60_000; // 3 × the default sync interval

    expect(tb.ctx.health.get('calendar-list:g1')).toMatchObject({ area: 'calendar', accountId: 'g1', status: 'ok', expectEveryMs, detail: { calendars: 3 } });
    expect(tb.ctx.health.get(`calendar:${primaryId}`)).toMatchObject({
      area: 'calendar',
      accountId: 'g1',
      status: 'ok',
      expectEveryMs,
      detail: { mode: 'full', fetched: 5, upserted: 5, deleted: 0 },
    });
    // The tracker's line for a calendar carries the calendar from the log context.
    const ok = log.lines().find((r) => r.msg === 'calendar ok' && r.fields.key === `calendar:${primaryId}`);
    expect(ok).toMatchObject({ level: 'debug', area: 'calendar', fields: expect.objectContaining({ accountId: 'g1', calendarId: primaryId }) });
    // Content never reaches the log: no event titles, no calendar names.
    expect(JSON.stringify(log.lines())).not.toMatch(/Dentist|Feiertage|insurance/);
  });

  it('forgets the health of calendars gone upstream, of a deleted account and of calendars switched off', async () => {
    let calendarList = googleCalendarList;
    tb = calendarTestbed({
      accounts: [GOOGLE],
      fetchRoutes: [
        { match: `${G_API}/users/me/calendarList`, respond: () => ({ json: calendarList }) },
        { match: `${G_API}/calendars/`, respond: { json: { items: [] } } },
      ],
    });
    await tb.module.service.syncAccounts();
    const keys = () => tb.ctx.health.list({ accountId: 'g1' }).map((h) => h.key);
    expect(keys()).toHaveLength(4);
    const familyKey = `calendar:${calendarIdByName('Family')}`;

    calendarList = { ...googleCalendarList, items: googleCalendarList.items.filter((i) => i.id !== 'family0123@group.calendar.google.com') };
    tb.clock.now += 60_000;
    await tb.module.service.syncAccounts();
    expect(keys()).toHaveLength(3);
    expect(tb.ctx.health.get(familyKey)).toBeNull();

    tb.accounts.add({ ...GOOGLE, enabledCapabilities: ['mail'] });
    tb.accounts.emit({ type: 'updated', accountId: 'g1' });
    expect(keys()).toEqual([]);

    tb.accounts.add(GOOGLE);
    tb.accounts.emit({ type: 'updated', accountId: 'g1' });
    await tb.module.service.syncAccount('g1'); // joins the run started by the event
    expect(keys()).toHaveLength(3);
    tb.ctx.db.run('DELETE FROM accounts WHERE id = ?', ['g1']);
    tb.accounts.remove('g1');
    tb.accounts.emit({ type: 'deleted', accountId: 'g1' });
    expect(keys()).toEqual([]);
  });

  it('an account that needs reconnecting: its calendar list and calendars wait for it (account_unavailable, info)', async () => {
    const log = createMemoryLogger();
    tb = calendarTestbed({ accounts: [GOOGLE], fetchRoutes: googleRoutes(), log });
    await tb.module.service.syncAccounts();
    const ids = ['alice@gmail.com', 'Feiertage', 'Family'].map(calendarIdByName);

    tb.accounts.add({ ...GOOGLE, token: undefined });
    tb.clock.now += 60_000;
    await tb.module.service.syncAccounts();
    for (const key of ['calendar-list:g1', ...ids.map((id) => `calendar:${id}`)]) {
      expect(tb.ctx.health.get(key), key).toMatchObject({ status: 'failing', lastCode: 'account_unavailable', causeKey: 'account:g1', lastMessage: 'Reconnect required' });
    }
    // The account's own subject reports the problem: the dependents' lines are info, never warnings.
    expect(log.lines.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
    expect(log.lines.filter((l) => l.message === 'calendar failing').map((l) => l.level)).toEqual(['info', 'info', 'info', 'info']);
  });

  it('a Google account whose OAuth client is not configured: its calendar list waits for it (the account records the refusal)', async () => {
    const log = createMemoryLogger();
    tb = calendarTestbed({ accounts: [GOOGLE], fetchRoutes: googleRoutes(), log });
    vi.spyOn(tb.accounts, 'getAccessToken').mockRejectedValue(
      new HttpError(409, 'not_configured', { message: 'The Google OAuth client is not configured', accountId: 'g1' }),
    );
    await tb.module.service.syncAccounts();
    expect(tb.ctx.health.get('calendar-list:g1')).toMatchObject({
      status: 'failing',
      lastCode: 'account_unavailable',
      causeKey: 'account:g1',
      lastMessage: 'The Google OAuth client is not configured',
    });
    // The account's own subject says why: no `calendar_list_failed` status written over it, no warning here.
    expect(tb.accounts.statusChanges).toEqual([]);
    expect(log.lines.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
  });

  it('a CalDAV account without server settings: the calendar list’s own not_configured (warn, no cause)', async () => {
    const log = createMemoryLogger();
    tb = calendarTestbed({ accounts: [{ id: 'c1', kind: 'caldav', label: 'CalDAV', capabilities: ['calendar'], password: 'pw', config: {} }], log });
    await tb.module.service.syncAccounts();
    expect(tb.ctx.health.get('calendar-list:c1')).toMatchObject({
      status: 'failing',
      lastCode: 'not_configured',
      causeKey: null,
      lastMessage: 'This account has no CalDAV settings',
    });
    expect(log.lines.filter((l) => l.message === 'calendar failing')).toEqual([
      expect.objectContaining({ level: 'warn', fields: expect.objectContaining({ key: 'calendar-list:c1', code: 'not_configured' }) }),
    ]);
  });

  it('a calendar whose events listing needs a reconnect stops the account; the rest wait for it too', async () => {
    const listed: string[] = [];
    tb = calendarTestbed({
      accounts: [{ id: 'y1', kind: 'yahoo', label: 'Yahoo', capabilities: ['calendar'], password: 'pw' }],
      module: {
        providers: {
          caldav: {
            source: 'caldav',
            listCalendars: async () => ['a', 'b', 'c'].map((n, i) => ({ remoteId: `https://caldav.example.com/${n}/`, name: n.toUpperCase(), color: null, writable: false, primary: i === 0 })),
            listEvents: async (_account, row) => {
              listed.push(row.name);
              throw new HttpError(409, 'reauth_required', { message: 'The CalDAV server rejected the password', accountId: 'y1' });
            },
          },
        },
      },
    });
    await tb.module.service.syncAccounts();
    expect(listed).toEqual(['A']);
    for (const name of ['A', 'B', 'C']) {
      const id = calendarIdByName(name);
      expect(getCalendarRow(tb.ctx.db, id)?.last_error).toBe('The CalDAV server rejected the password');
      expect(tb.ctx.health.get(`calendar:${id}`), name).toMatchObject({ status: 'failing', lastCode: 'account_unavailable', causeKey: 'account:y1' });
    }
  });

  it('a rate limit is one failure: the whole account waits for the provider’s Retry-After; "Sync now" does not', async () => {
    const log = createMemoryLogger();
    let throttle = true;
    tb = calendarTestbed({
      accounts: [GOOGLE],
      log,
      fetchRoutes: [
        { match: `${G_API}/users/me/calendarList`, respond: { json: googleCalendarList } },
        {
          match: PRIMARY_EVENTS,
          respond: () => (throttle ? { status: 429, json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, headers: { 'Retry-After': '600' } } : { json: { items: [] } }),
        },
        { match: /calendars\/(en\.german|family0123)/, respond: { json: { items: [] } } },
      ],
    });
    const calls = (part: string) => tb.ctx.fakeFetch!.calls.filter((c) => c.url.includes(part)).length;
    const warned = () => log.lines.filter((l) => l.level === 'warn');
    await tb.module.service.syncAccounts();
    const primary = `calendar:${calendarIdByName('alice@gmail.com')}`;
    const family = `calendar:${calendarIdByName('Family')}`;
    expect([calls('alice%40gmail.com'), calls('family0123'), calls('en.german')]).toEqual([1, 0, 0]);
    expect(warned()).toEqual([
      expect.objectContaining({
        message: 'calendar failing',
        fields: expect.objectContaining({ key: primary, code: 'rate_limited', status: 429, retryAfterSeconds: 600, nextAttemptAt: new Date(T0 + 600_000).toISOString() }),
      }),
    ]);
    expect(tb.ctx.health.get(family)).toMatchObject({ status: 'unknown', detail: { skipped: 'backoff' }, nextAttemptAt: T0 + 600_000 });

    // The provider keeps throttling: a run before Retry-After asks it nothing (not even the
    // calendar list), so the throttle stays one warning; every subject shows when it is retried.
    tb.clock.now += 5 * 60_000;
    await tb.module.service.syncAccounts();
    expect([calls('calendarList'), calls('alice%40gmail.com'), calls('family0123'), calls('en.german')]).toEqual([1, 1, 0, 0]);
    expect(warned()).toHaveLength(1);
    for (const key of ['calendar-list:g1', primary, family]) {
      expect(tb.ctx.health.get(key), key).toMatchObject({ detail: expect.objectContaining({ skipped: 'backoff' }), nextAttemptAt: T0 + 600_000 });
    }

    // Once Retry-After has passed, every calendar syncs again.
    throttle = false;
    tb.clock.now += 5 * 60_000;
    await tb.module.service.syncAccounts();
    expect([calls('alice%40gmail.com'), calls('family0123'), calls('en.german')]).toEqual([2, 1, 1]);
    expect([primary, family].map((key) => tb.ctx.health.get(key)?.status)).toEqual(['ok', 'ok']);

    // "Sync now" retries a throttled account right away.
    throttle = true;
    tb.clock.now += 5 * 60_000;
    await tb.module.service.syncAccounts();
    expect([calls('alice%40gmail.com'), calls('family0123')]).toEqual([3, 1]);
    throttle = false;
    expect((await tb.json('POST', '/api/calendar/sync')).status).toBe(200);
    expect([calls('alice%40gmail.com'), calls('family0123')]).toEqual([4, 2]);
  });

  it('calendars of a calendar list that is backing off are recorded as skipped, not left to go stale', async () => {
    let refused = false;
    tb = calendarTestbed({
      accounts: [GOOGLE],
      fetchRoutes: [
        { match: `${G_API}/users/me/calendarList`, respond: () => (refused ? { status: 403, json: googleApiDisabled } : { json: googleCalendarList }) },
        { match: `${G_API}/calendars/`, respond: { json: { items: [] } } },
      ],
    });
    await tb.module.service.syncAccounts();
    const keys = ['alice@gmail.com', 'Feiertage', 'Family'].map((name) => `calendar:${calendarIdByName(name)}`);

    refused = true;
    tb.clock.now += 5 * 60_000;
    await tb.module.service.syncAccounts();
    const retryAt = tb.clock.now + 15 * 60_000;
    expect(tb.ctx.health.get('calendar-list:g1')).toMatchObject({ status: 'failing', lastCode: 'api_disabled', nextAttemptAt: retryAt });

    tb.clock.now += 5 * 60_000;
    await tb.module.service.syncAccounts();
    expect(tb.ctx.fakeFetch!.calls.filter((c) => c.url.includes('calendarList'))).toHaveLength(2);
    for (const key of keys) {
      expect(tb.ctx.health.get(key), key).toMatchObject({ status: 'ok', detail: expect.objectContaining({ skipped: 'backoff' }), nextAttemptAt: retryAt });
    }
  });

  it('drops the outcome of a feed fetch that was in flight when the feed was removed (no ghost subject)', async () => {
    const log = createMemoryLogger();
    let held: Deferred<FakeResponseSpec> | null = null;
    tb = calendarTestbed({ log, fetchRoutes: [{ match: 'https://feeds.example.com/', respond: () => held?.promise ?? { text: SIMPLE_FEED } }] });
    const answers: FakeResponseSpec[] = [{ status: 500, text: 'oops' }, { status: 304 }, { text: SIMPLE_FEED }];
    for (const answer of answers) {
      held = null;
      const cal = json<Calendar>(await tb.json('POST', '/api/calendar/ics', { body: { url: 'https://feeds.example.com/a.ics', name: 'A' } }));
      held = deferred<FakeResponseSpec>();
      const requests = tb.ctx.fakeFetch!.calls.length;
      const syncing = tb.module.service.syncIcs(cal.id);
      await vi.waitFor(() => expect(tb.ctx.fakeFetch!.calls).toHaveLength(requests + 1));
      expect((await tb.req('DELETE', `/api/calendar/calendars/${cal.id}`)).status).toBe(204);
      held.resolve(answer);
      await syncing;
      expect(tb.ctx.health.get(`ics:${cal.id}`), `answer ${answer.status ?? 200}`).toBeNull();
    }
    expect(log.lines.filter((l) => l.level === 'warn' || l.message === 'calendar failing')).toEqual([]);
  });

  it('drops the outcomes of an account sync in flight when its calendars are switched off or the account is deleted', async () => {
    const log = createMemoryLogger();
    const YAHOO: FakeAccountSeed = { id: 'y1', kind: 'yahoo', label: 'Yahoo', capabilities: ['calendar'], password: 'pw' };
    const hold: { list: Deferred<void> | null; events: Deferred<void> | null } = { list: null, events: null };
    let listCalls = 0;
    const listed: string[] = [];
    // A held call fails once the test lets it go on.
    const answerOrFail = async (gate: Deferred<void> | null): Promise<void> => {
      if (!gate) return;
      await gate.promise;
      throw new HttpError(502, 'provider_error', 'The CalDAV server answered 500');
    };
    tb = calendarTestbed({
      accounts: [YAHOO],
      log,
      module: {
        providers: {
          caldav: {
            source: 'caldav',
            listCalendars: async () => {
              listCalls++;
              await answerOrFail(hold.list);
              return ['a', 'b', 'c'].map((n, i) => ({ remoteId: `https://caldav.example.com/${n}/`, name: n.toUpperCase(), color: null, writable: false, primary: i === 0 }));
            },
            listEvents: async (_account, row) => {
              listed.push(row.name);
              await answerOrFail(hold.events);
              return [];
            },
          },
        },
      },
    });
    const keys = () => tb.ctx.health.list({ accountId: 'y1' }).map((h) => h.key);

    // The calendars are switched off while the first calendar's events are being fetched: that
    // failure is not reported and the other calendars are not asked for.
    hold.events = deferred<void>();
    const first = tb.module.service.syncAccounts();
    await vi.waitFor(() => expect(listed).toEqual(['A']));
    tb.accounts.add({ ...YAHOO, enabledCapabilities: [] });
    tb.accounts.emit({ type: 'updated', accountId: 'y1' });
    hold.events.resolve();
    await first;
    expect(listed).toEqual(['A']);
    expect(keys()).toEqual([]);

    // Switched on again, the account syncs; then it is deleted while its calendar list is fetched.
    hold.events = null;
    tb.accounts.add(YAHOO);
    tb.accounts.emit({ type: 'updated', accountId: 'y1' });
    await tb.module.service.syncAccount('y1'); // joins the run started by the event
    expect(keys()).toHaveLength(4);
    hold.list = deferred<void>();
    const before = listCalls;
    tb.clock.now += 5 * 60_000;
    const second = tb.module.service.syncAccounts();
    await vi.waitFor(() => expect(listCalls).toBe(before + 1));
    tb.ctx.db.run('DELETE FROM accounts WHERE id = ?', ['y1']);
    tb.accounts.remove('y1');
    tb.accounts.emit({ type: 'deleted', accountId: 'y1' });
    hold.list.resolve();
    await second;
    expect(keys()).toEqual([]);
    expect(tb.ctx.health.get('calendar-list:y1')).toBeNull();
    expect(log.lines.filter((l) => l.level === 'warn' || l.message === 'calendar failing')).toEqual([]);
  });

  it('a listing kept back by the storage limit is degraded (storage_limit), not failing', async () => {
    tb = calendarTestbed({ accounts: [GOOGLE], fetchRoutes: googleRoutes() });
    // Another calendar already holds as many events as the cache keeps.
    tb.ctx.db.run(`INSERT INTO calendars (id, account_id, source, remote_id, name) VALUES ('big', NULL, 'ics', 'big', 'Big')`);
    tb.ctx.db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
       INSERT INTO events (id, calendar_id, remote_id, title, start, "end", all_day, updated_at)
       SELECT 'big:' || i, 'big', 'r' || i, 'x', '2026-10-01T10:00:00.000Z', '2026-10-01T11:00:00.000Z', 0, 0 FROM n`,
    );
    await tb.module.service.syncAccounts();
    const primaryId = calendarIdByName('alice@gmail.com');
    expect(getCalendarRow(tb.ctx.db, primaryId)?.last_error).toBe(STORAGE_LIMIT_ERROR);
    expect(tb.ctx.health.get(`calendar:${primaryId}`)).toMatchObject({ status: 'degraded', lastCode: 'storage_limit', lastMessage: STORAGE_LIMIT_ERROR });
  });

  it('ICS feeds: request detail (host, status, size, 304, redirects), failures by code, a redirect to a private address names the hop', async () => {
    const log = createTestLogger();
    let mode: 'body' | '304' | 'moved' | '500' | 'private-hop' = 'body';
    tb = calendarTestbed({
      log,
      fetchRoutes: [
        {
          match: 'https://feeds.example.com/',
          respond: (req): FakeResponseSpec => {
            if (mode === '304') return { status: 304 };
            if (mode === 'moved' && !req.url.endsWith('/moved.ics')) return { status: 302, headers: { location: 'https://feeds.example.com/moved.ics' } };
            if (mode === '500') return { status: 500, text: 'oops' };
            if (mode === 'private-hop') return { status: 302, headers: { location: 'http://192.168.1.10/cal.ics' } };
            return { text: SIMPLE_FEED, headers: { etag: '"v1"' } };
          },
        },
      ],
    });
    const cal = json<Calendar>(await tb.json('POST', '/api/calendar/ics', { body: { url: 'https://feeds.example.com/private/tok3n/a.ics', name: 'A' } }));
    const key = `ics:${cal.id}`;
    expect(tb.ctx.health.get(key)).toMatchObject({
      area: 'calendar',
      accountId: null,
      label: 'feeds.example.com',
      status: 'ok',
      expectEveryMs: 3 * 30 * 60_000,
      detail: { host: 'feeds.example.com', status: 200, bytes: Buffer.byteLength(SIMPLE_FEED), notModified: false, fetched: 2, upserted: 2, deleted: 0 },
    });
    expect(tb.ctx.health.get(key)?.detail).not.toHaveProperty('redirects');
    // The tracker's line for the feed's first check carries the feed from the log context.
    const lineFor = (msg: string) => log.lines().filter((r) => r.msg === msg && r.fields.key === key).at(-1);
    expect(lineFor('calendar ok')?.fields).toMatchObject({ calendarId: cal.id });

    mode = '304';
    tb.clock.now += 30 * 60_000;
    await tb.module.service.syncIcs(cal.id);
    expect(tb.ctx.health.get(key)).toMatchObject({ status: 'ok', detail: { host: 'feeds.example.com', status: 304, notModified: true } });
    expect(tb.ctx.health.get(key)?.detail).not.toHaveProperty('bytes');

    mode = 'moved';
    tb.clock.now += 30 * 60_000;
    await tb.module.service.syncIcs(cal.id);
    expect(tb.ctx.health.get(key)).toMatchObject({ status: 'ok', detail: { host: 'feeds.example.com', status: 200, notModified: false, redirects: 1 } });
    expect(tb.ctx.health.get(key)?.detail).not.toHaveProperty('finalHost'); // same host

    mode = '500';
    tb.clock.now += 30 * 60_000;
    await tb.module.service.syncIcs(cal.id);
    expect(tb.ctx.health.get(key)).toMatchObject({ status: 'failing', lastCode: 'http_5xx', lastStatus: 500, lastMessage: 'feeds.example.com answered 500' });

    mode = 'private-hop';
    tb.clock.now += 30 * 60_000;
    await tb.module.service.syncIcs(cal.id);
    const hop = 'feeds.example.com redirected to 192.168.1.10, a private or reserved address';
    expect(getCalendarRow(tb.ctx.db, cal.id)?.last_error).toBe(hop);
    expect(tb.ctx.health.get(key)).toMatchObject({
      status: 'failing',
      lastCode: 'blocked',
      lastMessage: hop,
      detail: expect.objectContaining({ host: 'feeds.example.com', blockedHost: '192.168.1.10' }),
    });
    expect(JSON.stringify(tb.ctx.health.history(key))).not.toContain('tok3n');

    // A new address that works: the recovery line carries the feed too.
    mode = 'body';
    expect((await tb.json('PATCH', `/api/calendar/ics/${cal.id}`, { body: { url: 'https://feeds.example.com/private/tok3n/b.ics' } })).status).toBe(200);
    expect(tb.ctx.health.get(key)?.status).toBe('ok');
    expect(lineFor('calendar recovered')?.fields).toMatchObject({ calendarId: cal.id });

    // Skipped work is recorded as such; removing the feed forgets it.
    tb.ctx.vault.setState('locked');
    await tb.module.service.syncIcs(cal.id);
    expect(tb.ctx.health.get(key)?.detail).toMatchObject({ skipped: 'vault_locked' });
    tb.ctx.vault.setState('ready');
    expect((await tb.req('DELETE', `/api/calendar/calendars/${cal.id}`)).status).toBe(204);
    expect(tb.ctx.health.get(key)).toBeNull();
  });

  it('logs event writes (no content), write failures, and an event written by Portly that a later listing drops', async () => {
    const log = createMemoryLogger();
    let refuse = false;
    let listing: unknown[] = googleEventsPage1.items;
    tb = calendarTestbed({
      accounts: [GOOGLE],
      log,
      fetchRoutes: [
        {
          match: PRIMARY_EVENTS,
          method: 'POST',
          respond: () =>
            refuse
              ? { status: 403, json: googleForbidden }
              : {
                  json: {
                    id: 'newevt1',
                    status: 'confirmed',
                    summary: 'Lunch with Carol',
                    organizer: { self: true },
                    start: { dateTime: '2026-10-07T12:00:00+02:00', timeZone: 'Europe/Berlin' },
                    end: { dateTime: '2026-10-07T13:00:00+02:00', timeZone: 'Europe/Berlin' },
                  },
                },
        },
        { match: `${G_API}/users/me/calendarList`, respond: { json: googleCalendarList } },
        { match: PRIMARY_EVENTS, method: 'GET', respond: () => ({ json: { items: listing } }) },
        { match: /calendars\/(en\.german|family0123)/, respond: { json: { items: [] } } },
      ],
    });
    await tb.module.service.syncAccounts();
    const calId = calendarIdByName('alice@gmail.com');
    const body = { calendarId: calId, title: 'Lunch with Carol', allDay: false, start: '2026-10-07T12:00:00+02:00', end: '2026-10-07T13:00:00+02:00', timezone: 'Europe/Berlin' };
    const created = await tb.json<CalendarEvent>('POST', '/api/calendar/events', { body });
    expect(created.status).toBe(201);
    const written = log.lines.filter((l) => l.message === 'calendar event written');
    expect(written).toEqual([
      expect.objectContaining({
        level: 'info',
        fields: expect.objectContaining({
          op: 'create',
          source: 'google',
          accountId: 'g1',
          calendarId: calId,
          status: 200,
          allDay: false,
          tzSent: 'Europe/Berlin',
          tzFallback: false,
          remoteIdTag: sha1Hex('newevt1').slice(0, 8),
        }),
      }),
    ]);
    expect(JSON.stringify(written)).not.toMatch(/Lunch|Carol|newevt1/);

    refuse = true;
    expect((await tb.json('POST', '/api/calendar/events', { body })).status).toBe(403);
    expect(log.lines.filter((l) => l.message === 'calendar event write failed')).toEqual([
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({ op: 'create', calendarId: calId, errName: 'ProviderHttpError', errStatus: 403, upstreamStatus: 403 }),
      }),
    ]);

    // A listing requested after the write that no longer has the event deletes it: reported once.
    listing = googleEventsPage1.items.filter((i) => i.id !== 'allday456');
    tb.clock.now += 2_000;
    await tb.module.service.syncAccounts();
    const missing = log.lines.filter((l) => l.message === 'event written by Portly is missing from the provider listing');
    expect(missing).toEqual([
      expect.objectContaining({ level: 'warn', fields: { calendarId: calId, eventId: created.body.id, op: 'create', agoMs: 2_000, module: 'calendar' } }),
    ]);
    tb.clock.now += 2_000;
    await tb.module.service.syncAccounts();
    expect(log.lines.filter((l) => l.message === 'event written by Portly is missing from the provider listing')).toHaveLength(1);
  });

  it('does not report an event written outside the synced window as missing (listings never return it)', async () => {
    const log = createMemoryLogger();
    const far = { start: '2027-10-30T12:00:00+02:00', end: '2027-10-30T13:00:00+02:00' }; // 400 days after T0
    tb = calendarTestbed({
      accounts: [GOOGLE],
      log,
      fetchRoutes: [
        {
          match: PRIMARY_EVENTS,
          method: 'POST',
          respond: {
            json: {
              id: 'farevt1',
              status: 'confirmed',
              summary: 'Far ahead',
              organizer: { self: true },
              start: { dateTime: far.start, timeZone: 'Europe/Berlin' },
              end: { dateTime: far.end, timeZone: 'Europe/Berlin' },
            },
          },
        },
        ...googleRoutes(),
      ],
    });
    await tb.module.service.syncAccounts();
    const calendarId = calendarIdByName('alice@gmail.com');
    const created = await tb.json<CalendarEvent>('POST', '/api/calendar/events', { body: { calendarId, title: 'Far ahead', allDay: false, ...far, timezone: 'Europe/Berlin' } });
    expect(created.status).toBe(201);

    tb.clock.now += 2_000;
    await tb.module.service.syncAccounts();
    expect(log.lines.filter((l) => l.message === 'event written by Portly is missing from the provider listing')).toEqual([]);
    expect(tb.ctx.health.get(`calendar:${calendarId}`)?.status).toBe('ok');
  });
});
