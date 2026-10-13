/**
 * Static backend: Outlook.com calendars synced from Microsoft Graph by the browser. Ports the
 * Microsoft parts of server/src/modules/calendar/calendar.test.ts (sync, events query, calendar
 * settings, write-through writes, failures and backoff) onto the request-driven sync: due accounts
 * sync on the calendar and events requests, which wait for it; tabs take turns; a sync that
 * outlives the wait tells the app when it is done.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type Account, type Calendar, type CalendarEvent, type EventsResponse } from '@portly/shared';
import { createFakeFetch, type FakeFetch, type FakeFetchRoute, type FakeRequest } from '../providers/__fixtures__/fakeFetch.ts';
import { graphCalendarViewPage1, graphCalendarViewPage2, graphCalendars } from '../providers/__fixtures__/graph.ts';
import { MICROSOFT_CLIENT_ID, tokenOk } from '../providers/__fixtures__/microsoft.ts';
import { MICROSOFT_TOKEN_ENDPOINT } from '../providers/microsoftAuth.ts';
import type { SanitizedEvent } from '../lib/calendarRecords.ts';
import { STORAGE_LIMIT_ERROR, getCalendarRow, replaceCalendarEvents, upsertEvent } from '../lib/calendarStore.ts';
import { getCalendarEvents, getCalendars, getCalendarSync, type StoredAccount } from '../slices.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import * as accounts from './accounts.ts';
import { MESSAGES } from './accounts.ts';
import * as calendar from './calendar.ts';
import {
  CALENDAR_LIST_ERROR_PREFIX,
  MAX_EVENTS_PER_RESPONSE,
  MAX_EVENTS_RESPONSE_CHARS,
  NO_CALENDARS_MESSAGE,
  SYNC_BACKOFF_BASE_MS,
  SYNC_WAIT_MS,
} from './calendar.ts';
import * as settings from './settings.ts';

type ErrorBody = { error: { code: string; message: string; accountId?: string } };

const T0 = Date.parse('2026-09-28T12:00:00.000Z');
const MINUTE = 60_000;
const ACCOUNT_ID = 'acc-outlook';
const [DEFAULT_REMOTE, BIRTHDAYS_REMOTE, SHARED_REMOTE] = graphCalendars.value.map((c) => c.id) as [string, string, string];
const GRAPH = 'https://graph.microsoft.com/v1.0';
const WEEK = '/api/calendar/events?from=2026-09-28&to=2026-10-06&tz=UTC';

const ACCOUNT: StoredAccount = {
  id: ACCOUNT_ID,
  kind: 'microsoft',
  label: 'me@outlook.com',
  email: 'me@outlook.com',
  externalId: 'subject-1',
  color: null,
  capabilities: ['calendar'],
  enabledCapabilities: ['calendar'],
  grantedScopes: ['calendars.readwrite'],
  status: 'ok',
  statusMessage: null,
  sort: 0,
  createdAt: T0 - 1000,
  updatedAt: T0 - 1000,
};

let t: TestBackend;
let fake: FakeFetch;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  t?.close();
});

function viewOf(remote: string): RegExp {
  return new RegExp(`/me/calendars/${remote}/calendarView\\?`);
}

/** Graph answering the fixtures: three calendars, two pages for the default one, the others empty. */
function graphRoutes(): FakeFetchRoute[] {
  return [
    { match: `${GRAPH}/me/calendars?`, method: 'GET', respond: { json: graphCalendars } },
    { match: /calendarView\?.*%24skip=500/, method: 'GET', respond: { json: graphCalendarViewPage2 } },
    { match: viewOf(DEFAULT_REMOTE), method: 'GET', respond: { json: graphCalendarViewPage1 } },
    { match: /calendarView\?/, method: 'GET', respond: { json: { value: [] } } },
  ];
}

async function setup(routes: FakeFetchRoute[] = graphRoutes(), seed: (storage: MemoryStorage) => Promise<void> = async () => {}) {
  fake = createFakeFetch(routes);
  vi.stubGlobal('fetch', fake.fetch);
  const storage = new MemoryStorage();
  await storage.setJson('slice:oauth-clients', { microsoft: { clientId: MICROSOFT_CLIENT_ID, updatedAt: T0 } });
  await storage.setJson('slice:accounts', [ACCOUNT]);
  await storage.setJson('slice:account-tokens', {
    [ACCOUNT_ID]: { refreshToken: 'RT1', accessToken: 'AT1', accessRefreshAt: T0 + 60 * MINUTE, sessionExpiresAt: T0 + 24 * 60 * MINUTE, silentAttemptAt: null },
  });
  await seed(storage);
  t = await createTestBackend([settings, accounts, calendar], { storage, startAt: T0 });
  return t;
}

function graphCalls(pattern: string | RegExp = 'graph.microsoft.com'): FakeRequest[] {
  return fake.calls.filter((c) => (typeof pattern === 'string' ? c.url.includes(pattern) : pattern.test(c.url)));
}

async function calendars(): Promise<Calendar[]> {
  const res = await t.json<Calendar[]>('GET', '/api/calendar/calendars');
  expect(res.status).toBe(200);
  return res.body;
}

async function events(path = WEEK): Promise<CalendarEvent[]> {
  const res = await t.json<EventsResponse>('GET', path);
  expect(res.status).toBe(200);
  return res.body.events;
}

function byName(list: Calendar[], name: string): Calendar {
  const found = list.find((c) => c.name === name);
  if (!found) throw new Error(`no calendar ${name}`);
  return found;
}

describe('calendar: sync on request', () => {
  it('syncs the account on the first calendar request and answers with its calendars', async () => {
    await setup();
    const list = await calendars();
    expect(list.map((c) => [c.name, c.color, c.writable, c.isPrimary, c.visible, c.source, c.accountId])).toEqual([
      ['Calendar', expect.stringMatching(/^#[0-9a-f]{6}$/), true, true, true, 'microsoft', ACCOUNT_ID],
      ['Birthdays', '#5fb86b', false, false, true, 'microsoft', ACCOUNT_ID],
      ['Shared', '#e3008c', true, false, true, 'microsoft', ACCOUNT_ID],
    ]);
    expect(list.every((c) => c.lastSyncedAt === new Date(T0).toISOString() && c.lastError === null)).toBe(true);

    // Straight to Graph with the account's token and the UTC / plain-text preference.
    const listing = graphCalls(`${GRAPH}/me/calendars?`)[0]!;
    expect(listing.headers.get('authorization')).toBe('Bearer AT1');
    expect(listing.headers.get('prefer')).toBe('outlook.timezone="UTC", outlook.body-content-type="text"');
    expect(listing.init.credentials).toBe('omit');
    expect(listing.init.redirect).toBe('error');
    const view = new URL(graphCalls(viewOf(DEFAULT_REMOTE))[0]!.url);
    expect(view.searchParams.get('$top')).toBe('500');
    expect(Date.parse(view.searchParams.get('startDateTime')!)).toBeLessThan(T0 - 29 * 24 * 60 * MINUTE);
    expect(Date.parse(view.searchParams.get('endDateTime')!)).toBeGreaterThan(T0 + 364 * 24 * 60 * MINUTE);
    // Both pages of the default calendar were read.
    expect(graphCalls(/%24skip=500/)).toHaveLength(1);
    // Stored for the next page load (and other tabs).
    expect(await t.storage.getJson('slice:calendars')).toHaveLength(3);
  });

  it('answers the events of the visible calendars in the window, in order, without series masters', async () => {
    await setup();
    const list = await events();
    expect(list.map((e) => [e.title, e.start, e.allDay, e.status, e.editable])).toEqual([
      ['Standup', '2026-09-29T07:00:00.000Z', false, 'tentative', false],
      ['Quarterly review', '2026-09-30T13:00:00.000Z', false, 'confirmed', true],
      ['Public holiday', '2026-10-03', true, 'confirmed', true],
      ['Canceled: Lunch', '2026-10-05T11:00:00.000Z', false, 'cancelled', false],
    ]);
    const defaultId = byName(await calendars(), 'Calendar').id;
    expect(list.every((e) => e.calendarId === defaultId && e.id.startsWith(`${defaultId}:`) && /:[0-9a-f]{40}$/.test(e.id))).toBe(true);
    expect(list[1]).toMatchObject({ location: 'Room 4.12', meetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc', timezone: 'Europe/Berlin' });
    expect(list[0]).toMatchObject({ recurring: true, seriesId: 'AAMkAGI2master=' });
  });

  it('does not ask Graph again within the sync interval, and does once it has passed', async () => {
    await setup();
    await calendars();
    const after = fake.calls.length;
    await events();
    await calendars();
    expect(fake.calls.length).toBe(after);
    t.tick(5 * MINUTE);
    await calendars();
    expect(graphCalls(`${GRAPH}/me/calendars?`)).toHaveLength(2);
  });

  it('lets concurrent requests share one sync', async () => {
    await setup();
    const [list, week] = await Promise.all([t.json<Calendar[]>('GET', '/api/calendar/calendars'), t.json<EventsResponse>('GET', WEEK)]);
    expect(list.body).toHaveLength(3);
    expect(week.body.events).toHaveLength(4);
    expect(graphCalls(`${GRAPH}/me/calendars?`)).toHaveLength(1);
  });

  it('skips the sync when another tab has just synced the account (the stored sync time decides)', async () => {
    await setup();
    // Another tab of the site synced a moment ago and stored it.
    await t.storage.setJson('slice:calendar-sync', { [ACCOUNT_ID]: { attemptedAt: T0, failure: null, calendars: {} } });
    expect(await calendars()).toEqual([]);
    expect(graphCalls()).toHaveLength(0);
  });

  it('answers with what it has when the sync takes longer than the wait, and tells the app when it is done', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const routes = graphRoutes();
    routes[0] = { match: `${GRAPH}/me/calendars?`, method: 'GET', respond: async () => (await gate, { json: graphCalendars }) };
    await setup(routes);
    const notify = vi.fn();
    t.ctx.notify = notify;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const pending = t.json<Calendar[]>('GET', '/api/calendar/calendars');
    await vi.advanceTimersByTimeAsync(SYNC_WAIT_MS);
    expect((await pending).body).toEqual([]);
    expect(notify).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(['calendars', 'calendar-events', 'accounts']));
    expect(getCalendars(t.ctx)).toHaveLength(3);
  });

  it('"Sync now" syncs right away, inside the interval', async () => {
    await setup();
    await calendars();
    const res = await t.json<Calendar[]>('POST', '/api/calendar/sync');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(graphCalls(`${GRAPH}/me/calendars?`)).toHaveLength(2);
  });

  it('answers 409 not_configured without calendars, and 422 for a bad query', async () => {
    await setup([], async (storage) => storage.setJson('slice:accounts', []));
    const none = await t.json<ErrorBody>('GET', WEEK);
    expect(none.status).toBe(409);
    expect(none.body.error).toEqual({ code: 'not_configured', message: NO_CALENDARS_MESSAGE });
    expect((await t.json('GET', '/api/calendar/events?from=2026-10-06&to=2026-10-01&tz=UTC')).status).toBe(422);
    expect((await t.json('GET', '/api/calendar/events?from=2026-10-01&to=2026-10-06&tz=Not/AZone')).status).toBe(422);
    expect(graphCalls()).toHaveLength(0);
  });

  it('clips the answer to the synced window', async () => {
    await setup();
    await calendars();
    const res = await t.json<EventsResponse>('GET', '/api/calendar/events?from=2020-01-01&to=2030-01-01&tz=UTC');
    expect(res.body.window.from).toBe('2026-08-29');
    expect(res.body.window.to > '2027-09-27').toBe(true);
    expect(res.body.events).toHaveLength(4);
  });
});

describe('calendar: settings of a calendar', () => {
  it('hides a calendar (named calendars still read it) and overrides its color', async () => {
    await setup();
    const id = byName(await calendars(), 'Calendar').id;
    const patched = await t.json<Calendar>('PATCH', `/api/calendar/calendars/${id}`, { visible: false, colorOverride: '#ABCDEF', userReadOnly: true });
    expect(patched.body).toMatchObject({ visible: false, color: '#abcdef', colorOverride: '#abcdef', userReadOnly: true, writable: false });
    expect(await events()).toEqual([]);
    expect(await events(`${WEEK}&calendarIds=${id}`)).toHaveLength(4);
    // Read-only in Portly: nothing is editable, and writes are refused.
    expect((await events(`${WEEK}&calendarIds=${id}`)).every((e) => !e.editable)).toBe(true);
    // The user's choices survive the next sync.
    t.tick(5 * MINUTE);
    expect(byName(await calendars(), 'Calendar')).toMatchObject({ visible: false, colorOverride: '#abcdef', userReadOnly: true });
  });

  it('keeps account calendars: delete is a conflict, an unknown id 404', async () => {
    await setup();
    const id = byName(await calendars(), 'Shared').id;
    const conflict = await t.json<ErrorBody>('DELETE', `/api/calendar/calendars/${id}`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('conflict');
    expect((await t.json('DELETE', '/api/calendar/calendars/nope')).status).toBe(404);
    expect((await t.json('PATCH', '/api/calendar/calendars/nope', { visible: false })).status).toBe(404);
  });

  it('drops calendars removed upstream with their events and the default-calendar setting', async () => {
    await setup();
    const shared = byName(await calendars(), 'Shared').id;
    expect((await t.json('PATCH', '/api/settings', { calendar: { defaultCalendarId: shared } })).status).toBe(200);
    // Graph no longer lists the shared calendar.
    const routes = graphRoutes();
    routes[0] = { match: `${GRAPH}/me/calendars?`, method: 'GET', respond: { json: { value: graphCalendars.value.slice(0, 2) } } };
    fake = createFakeFetch(routes);
    vi.stubGlobal('fetch', fake.fetch);
    t.tick(5 * MINUTE);
    expect((await calendars()).map((c) => c.name)).toEqual(['Calendar', 'Birthdays']);
    expect(getCalendarEvents(t.ctx)[shared]).toBeUndefined();
    expect((await t.json<{ calendar: { defaultCalendarId: string | null } }>('GET', '/api/settings')).body.calendar.defaultCalendarId).toBeNull();
  });
});

describe('calendar: writes', () => {
  const created = {
    id: 'AAMkNEW=',
    subject: 'Dentist',
    body: { contentType: 'text', content: 'Bring card' },
    start: { dateTime: '2026-10-01T08:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-01T09:00:00.0000000', timeZone: 'UTC' },
    isAllDay: false,
    location: { displayName: 'Clinic' },
    type: 'singleInstance',
    isCancelled: false,
    isOrganizer: true,
    responseStatus: { response: 'organizer' },
    originalStartTimeZone: 'W. Europe Standard Time',
  };

  it('creates, updates and deletes an event through Graph and caches the answer', async () => {
    await setup([
      { match: `${GRAPH}/me/calendars/${DEFAULT_REMOTE}/events`, method: 'POST', respond: { status: 201, json: created } },
      { match: `${GRAPH}/me/events/AAMkNEW%3D`, method: 'PATCH', respond: { json: { ...created, subject: 'Dentist (moved)' } } },
      { match: `${GRAPH}/me/events/AAMkNEW%3D`, method: 'DELETE', respond: { status: 204 } },
      ...graphRoutes(),
    ]);
    const calendarId = byName(await calendars(), 'Calendar').id;

    const res = await t.json<CalendarEvent>('POST', '/api/calendar/events', {
      calendarId,
      title: 'Dentist',
      allDay: false,
      start: '2026-10-01T10:00:00+02:00',
      end: '2026-10-01T11:00:00+02:00',
      timezone: 'Europe/Berlin',
      location: 'Clinic',
      description: 'Bring card',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ calendarId, title: 'Dentist', start: '2026-10-01T08:00:00.000Z', editable: true, location: 'Clinic' });
    const sent = JSON.parse(graphCalls(/\/events$/)[0]!.body!) as Record<string, unknown>;
    expect(sent).toMatchObject({
      subject: 'Dentist',
      isAllDay: false,
      start: { dateTime: '2026-10-01T10:00:00', timeZone: 'W. Europe Standard Time' },
      end: { dateTime: '2026-10-01T11:00:00', timeZone: 'W. Europe Standard Time' },
      location: { displayName: 'Clinic' },
      body: { contentType: 'text', content: 'Bring card' },
    });
    expect((await events()).map((e) => e.title)).toContain('Dentist');

    const updated = await t.json<CalendarEvent>('PATCH', `/api/calendar/events/${encodeURIComponent(res.body.id)}`, { title: 'Dentist (moved)' });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe('Dentist (moved)');
    expect(JSON.parse(graphCalls(/\/me\/events\//)[0]!.body!)).toEqual({ subject: 'Dentist (moved)' });

    expect((await t.call('DELETE', `/api/calendar/events/${encodeURIComponent(res.body.id)}`)).status).toBe(204);
    expect((await events()).map((e) => e.title)).not.toContain('Dentist (moved)');
  });

  it('replaces the cached event when Graph answers an update with a new id', async () => {
    await setup([
      { match: `${GRAPH}/me/calendars/${DEFAULT_REMOTE}/events`, method: 'POST', respond: { status: 201, json: created } },
      { match: `${GRAPH}/me/events/AAMkNEW%3D`, method: 'PATCH', respond: { json: { ...created, id: 'AAMkMOVED=', subject: 'Dentist (moved)' } } },
      ...graphRoutes(),
    ]);
    const calendarId = byName(await calendars(), 'Calendar').id;
    const res = await t.json<CalendarEvent>('POST', '/api/calendar/events', {
      calendarId,
      title: 'Dentist',
      allDay: false,
      start: '2026-10-01T10:00:00Z',
      end: '2026-10-01T11:00:00Z',
      timezone: 'UTC',
    });
    const updated = await t.json<CalendarEvent>('PATCH', `/api/calendar/events/${encodeURIComponent(res.body.id)}`, { title: 'Dentist (moved)' });
    expect(updated.status).toBe(200);
    expect(updated.body.id).not.toBe(res.body.id);
    const titles = (await events()).map((e) => [e.id, e.title]);
    expect(titles).toContainEqual([updated.body.id, 'Dentist (moved)']);
    expect(titles.filter(([, title]) => title?.startsWith('Dentist'))).toHaveLength(1);
    expect(getCalendarEvents(t.ctx)[calendarId]!.some((row) => row.id === res.body.id)).toBe(false);
  });

  it('does not bring back an event deleted moments ago from an older listing', async () => {
    const standup = graphCalendarViewPage2.value[0]!;
    await setup([{ match: `${GRAPH}/me/events/`, method: 'DELETE', respond: { status: 204 } }, ...graphRoutes()]);
    const calendarId = byName(await calendars(), 'Calendar').id;
    // Make the standup editable for this test: the user organizes it.
    const rows = getCalendarEvents(t.ctx)[calendarId]!;
    const row = rows.find((r) => r.remote_id === standup.id)!;
    row.editable = 1;
    expect((await t.call('DELETE', `/api/calendar/events/${encodeURIComponent(row.id)}`)).status).toBe(204);
    // Graph still lists it (eventual consistency): the tombstone keeps it out.
    expect((await t.json('POST', '/api/calendar/sync')).status).toBe(200);
    expect((await events()).map((e) => e.title)).not.toContain('Standup');
  });

  it('refuses read-only calendars, events organized by someone else, and unknown ids', async () => {
    await setup();
    const list = await calendars();
    const birthdays = await t.json<ErrorBody>('POST', '/api/calendar/events', {
      calendarId: byName(list, 'Birthdays').id,
      title: 'Party',
      allDay: true,
      start: '2026-10-02',
      end: '2026-10-03',
      timezone: 'UTC',
    });
    expect(birthdays.status).toBe(403);
    expect(birthdays.body.error.message).toBe('You cannot add or change events in this calendar');
    const standup = (await events()).find((e) => e.title === 'Standup')!;
    const notMine = await t.json<ErrorBody>('PATCH', `/api/calendar/events/${encodeURIComponent(standup.id)}`, { title: 'Mine now' });
    expect(notMine.status).toBe(403);
    expect(notMine.body.error.message).toBe('Only the organizer can change this event');
    expect((await t.json('PATCH', '/api/calendar/events/nope:0', { title: 'x' })).status).toBe(404);
    expect((await t.json('POST', '/api/calendar/events', { calendarId: 'nope', title: 'x', allDay: true, start: '2026-10-02', end: '2026-10-03', timezone: 'UTC' })).status).toBe(404);
    expect(graphCalls(/\/events/).filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
});

describe('calendar: failures', () => {
  it('refreshes a refused token once and retries', async () => {
    await setup([
      { match: `${GRAPH}/me/calendars?`, method: 'GET', respond: { status: 401, json: { error: { code: 'InvalidAuthenticationToken' } } }, times: 1 },
      { match: MICROSOFT_TOKEN_ENDPOINT, method: 'POST', respond: tokenOk({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }) },
      ...graphRoutes(),
    ]);
    expect(await calendars()).toHaveLength(3);
    const listings = graphCalls(`${GRAPH}/me/calendars?`);
    expect(listings.map((c) => c.headers.get('authorization'))).toEqual(['Bearer AT1', 'Bearer AT2']);
  });

  it('asks for a reconnect when Graph refuses a freshly refreshed token', async () => {
    await setup([
      { match: `${GRAPH}/me/calendars?`, method: 'GET', respond: { status: 401, json: { error: { code: 'InvalidAuthenticationToken' } } } },
      { match: MICROSOFT_TOKEN_ENDPOINT, method: 'POST', respond: tokenOk({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }) },
    ]);
    expect(await calendars()).toEqual([]);
    const [account] = (await t.json<Account[]>('GET', '/api/accounts')).body;
    expect(account).toMatchObject({ status: 'reauth', statusMessage: MESSAGES.tokenRejected });
    // An account that must be reconnected is not asked again on the next interval (no request leaves).
    t.tick(5 * MINUTE);
    const before = graphCalls().length;
    expect(await calendars()).toEqual([]);
    expect(graphCalls().length).toBe(before);
  });

  it('says on the account why its calendars could not be loaded, until they can', async () => {
    const routes = graphRoutes();
    await setup([{ match: `${GRAPH}/me/calendars?`, method: 'GET', respond: { status: 500 }, times: 1 }, ...routes]);
    expect(await calendars()).toEqual([]);
    const failing = (await t.json<Account[]>('GET', '/api/accounts')).body[0]!;
    expect(failing).toMatchObject({ status: 'error', statusMessage: `${CALENDAR_LIST_ERROR_PREFIX}Outlook.com returned an error (500)` });
    t.tick(5 * MINUTE);
    expect(await calendars()).toHaveLength(3);
    expect((await t.json<Account[]>('GET', '/api/accounts')).body[0]).toMatchObject({ status: 'ok', statusMessage: null });
  });

  it('keeps a failing calendar’s events, says why, and waits before asking again when access is refused', async () => {
    await setup();
    const calendarId = byName(await calendars(), 'Calendar').id;
    // Access to the default calendar is now refused (routes are tried in order: the refusal first).
    fake = createFakeFetch([{ match: viewOf(DEFAULT_REMOTE), method: 'GET', respond: { status: 403, json: { error: { code: 'ErrorAccessDenied' } } } }, ...graphRoutes()]);
    vi.stubGlobal('fetch', fake.fetch);
    t.tick(5 * MINUTE);
    const list = await calendars();
    expect(byName(list, 'Calendar').lastError).toBe('Outlook.com denied Portly access to this calendar');
    expect(byName(list, 'Shared').lastError).toBeNull();
    expect(await events()).toHaveLength(4);
    expect(getCalendarSync(t.ctx)[ACCOUNT_ID]!.calendars[calendarId]).toMatchObject({ failures: 1, retryAt: T0 + 5 * MINUTE + 15 * MINUTE });

    // The next interval skips it (15 minutes of backoff) but syncs the others.
    t.tick(5 * MINUTE);
    const before = graphCalls(viewOf(DEFAULT_REMOTE)).length;
    await calendars();
    expect(graphCalls(viewOf(DEFAULT_REMOTE)).length).toBe(before);
    expect(graphCalls(viewOf(SHARED_REMOTE)).length).toBe(2);
    // "Sync now" asks again.
    await t.json('POST', '/api/calendar/sync');
    expect(graphCalls(viewOf(DEFAULT_REMOTE)).length).toBe(before + 1);
  });

  it('makes the whole account wait for Graph’s Retry-After after a rate limit', async () => {
    await setup([{ match: viewOf(DEFAULT_REMOTE), method: 'GET', respond: { status: 429, headers: { 'Retry-After': '900' } }, times: 1 }, ...graphRoutes()]);
    const list = await calendars();
    expect(byName(list, 'Calendar').lastError).toBe('Outlook.com is rate limiting requests; try again shortly');
    // The rest of the account was not asked during the throttle.
    expect(graphCalls(viewOf(BIRTHDAYS_REMOTE))).toHaveLength(0);
    t.tick(5 * MINUTE);
    const before = graphCalls().length;
    await calendars();
    expect(graphCalls().length).toBe(before);
    t.tick(10 * MINUTE);
    await calendars();
    expect(graphCalls(viewOf(BIRTHDAYS_REMOTE))).toHaveLength(1);
    expect(byName(await calendars(), 'Calendar').lastError).toBeNull();
  });
});

describe('calendar: limits', () => {
  /** A listing of `count` events for `calendarId`, each with `description` characters of text. */
  function listing(calendarId: string, count: number, description = 0): SanitizedEvent[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `${calendarId}:limit-${i}`,
      remoteId: `limit-${i}`,
      instanceKey: null,
      etag: null,
      title: `Event ${i}`,
      location: null,
      description: description > 0 ? 'x'.repeat(description) : null,
      start: '2026-09-30T08:00:00.000Z',
      end: '2026-09-30T09:00:00.000Z',
      allDay: false,
      timezone: null,
      status: 'confirmed',
      recurring: false,
      seriesId: null,
      htmlUrl: null,
      meetingUrl: null,
      editable: false,
    }));
  }

  it('keeps a calendar as it was when its listing would exceed what the browser stores', async () => {
    await setup();
    const calendarId = byName(await calendars(), 'Calendar').id;
    const before = getCalendarEvents(t.ctx)[calendarId]!.map((row) => row.id);
    // Every other calendar's events count too: here, none.
    const byCount = replaceCalendarEvents(t.ctx, calendarId, listing(calendarId, 3), { now: T0, startedAt: T0, storageLimits: { events: 2, chars: 1_000_000 } });
    expect(byCount).toMatchObject({ limited: true, changed: false, upserted: 0, deleted: 0 });
    const bySize = replaceCalendarEvents(t.ctx, calendarId, listing(calendarId, 2, 600), { now: T0, startedAt: T0, storageLimits: { events: 100, chars: 1_000 } });
    expect(bySize).toMatchObject({ limited: true, changed: false });
    expect(getCalendarEvents(t.ctx)[calendarId]!.map((row) => row.id)).toEqual(before);
    expect(byName(await calendars(), 'Calendar').lastError).toBe(STORAGE_LIMIT_ERROR);

    // Within the limits it is stored.
    const fits = replaceCalendarEvents(t.ctx, calendarId, listing(calendarId, 2), { now: T0, startedAt: T0 + 1, storageLimits: { events: 2, chars: 1_000_000 } });
    expect(fits).toMatchObject({ upserted: 2, changed: true });
    expect(getCalendarRow(t.ctx, calendarId)!.last_error).toBeNull();
  });

  it('cuts an events answer short, and says so, past the response limits', async () => {
    await setup();
    const calendarId = byName(await calendars(), 'Calendar').id;
    const rows = getCalendarEvents(t.ctx)[calendarId]!;
    // Text: three long descriptions that only fit two at a time.
    const long = Math.floor(MAX_EVENTS_RESPONSE_CHARS / 2.5);
    for (const [i, event] of listing(calendarId, 3, long).entries()) upsertEvent(t.ctx, calendarId, { ...event, id: `${calendarId}:long-${i}` }, T0);
    let res = await t.json<EventsResponse>('GET', WEEK);
    expect(res.body.truncated).toBe(true);
    expect(res.body.events.filter((e) => e.title.startsWith('Event'))).toHaveLength(2);

    // Count: more events than one answer carries.
    rows.splice(0, rows.length);
    for (const event of listing(calendarId, MAX_EVENTS_PER_RESPONSE + 1)) upsertEvent(t.ctx, calendarId, event, T0);
    res = await t.json<EventsResponse>('GET', WEEK);
    expect(res.body.truncated).toBe(true);
    expect(res.body.events).toHaveLength(MAX_EVENTS_PER_RESPONSE);
  });

  it('waits before fetching an account again when its sync could not be stored', async () => {
    await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.spyOn(t.storage, 'applyBatch').mockRejectedValue(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
    await calendars();
    const fetched = graphCalls().length;
    expect(fetched).toBeGreaterThan(0);
    expect(getCalendars(t.ctx)).toEqual([]);

    // Not on every request, nor at the next interval…
    await calendars();
    t.tick(5 * MINUTE);
    await calendars();
    expect(graphCalls().length).toBe(fetched);

    // …but once the wait is over, and then it is stored.
    write.mockRestore();
    t.tick(SYNC_BACKOFF_BASE_MS);
    expect(await calendars()).toHaveLength(3);
    expect(graphCalls().length).toBeGreaterThan(fetched);
  });
});

describe('calendar: accounts', () => {
  it('removes the calendars and events of a deleted account', async () => {
    await setup();
    await calendars();
    expect(getCalendarEvents(t.ctx)).not.toEqual({});
    expect((await t.call('DELETE', `/api/accounts/${ACCOUNT_ID}`)).status).toBe(204);
    expect(getCalendars(t.ctx)).toEqual([]);
    expect(getCalendarEvents(t.ctx)).toEqual({});
    expect(getCalendarSync(t.ctx)).toEqual({});
    expect(await t.storage.getJson('slice:calendars')).toEqual([]);
    expect((await t.json<ErrorBody>('GET', WEEK)).body.error.code).toBe('not_configured');
  });

  it('hides the calendars of an account whose calendar is switched off, and keeps their settings', async () => {
    await setup();
    const id = byName(await calendars(), 'Shared').id;
    await t.json('PATCH', `/api/calendar/calendars/${id}`, { visible: false });
    expect((await t.json('PATCH', `/api/accounts/${ACCOUNT_ID}`, { enabledCapabilities: [] })).status).toBe(200);
    expect(await calendars()).toEqual([]);
    expect((await t.json<ErrorBody>('GET', WEEK)).status).toBe(409);
    // Back on: synced again right away, the hidden calendar still hidden.
    const before = graphCalls(`${GRAPH}/me/calendars?`).length;
    expect((await t.json('PATCH', `/api/accounts/${ACCOUNT_ID}`, { enabledCapabilities: ['calendar'] })).status).toBe(200);
    expect(byName(await calendars(), 'Shared').visible).toBe(false);
    expect(graphCalls(`${GRAPH}/me/calendars?`).length).toBe(before + 1);
  });

  it('drops calendars of accounts that are gone when the backend starts', async () => {
    await setup(graphRoutes(), async (storage) => {
      await storage.setJson('slice:calendars', [
        {
          id: 'orphan',
          account_id: 'gone',
          source: 'microsoft',
          remote_id: 'r',
          name: 'Old',
          color: null,
          color_override: null,
          provider_writable: 1,
          user_read_only: 0,
          visible: 1,
          is_primary: 0,
          sort: 0,
          display_url: null,
          collection_url: null,
          sync_state: null,
          last_synced_at: null,
          last_error: null,
        },
      ]);
      await storage.setJson('slice:calendar-events', { orphan: [] });
      await storage.setJson('slice:settings', defaultSettings());
    });
    expect(getCalendars(t.ctx)).toEqual([]);
    expect(getCalendarEvents(t.ctx)).toEqual({});
    expect(await t.storage.getJson('slice:calendars')).toEqual([]);
  });
});
