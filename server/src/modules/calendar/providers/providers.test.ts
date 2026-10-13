import { describe, expect, it } from 'vitest';
import { outcomeFromError } from '../../../lib/health.ts';
import type { SafeFetch, SafeFetchOptions } from '../../../security/safe-fetch.ts';
import {
  googleApiDisabled,
  googleCalendarList,
  googleEventsPage1,
  googleEventsPage2,
  googleForbidden,
  googleScopeInsufficient,
  graphCalendarViewPage1,
  graphCalendarViewPage2,
  graphCalendars,
} from '../__fixtures__/providers.ts';
import { eventId, sanitizeEvent } from '../store.ts';
import { htmlToText } from '../text.ts';
import { addDays, startOfDayMs, syncWindow, wallToUtcMs } from '../time.ts';
import { WINDOWS_ZONE_COUNT, ianaToWindows, resolveTimeZoneName, windowsToIana } from '../windows-zones.ts';
import { googleEventBody, googleZoneSent, mapGoogleCalendar, mapGoogleEvent } from './google.ts';
import { ProviderHttpError, classifyDenial, incompleteListing, listItems, providerCall, providerErrorReasons } from './http.ts';
import { graphEventBody, graphInstant, graphZoneSent, mapGraphCalendar, mapGraphEvent } from './microsoft.ts';

describe('Google mappers', () => {
  it('maps calendarList entries (writable from owner|writer, summaryOverride, selected → visible)', () => {
    const cals = googleCalendarList.items.map(mapGoogleCalendar);
    expect(cals).toEqual([
      { remoteId: 'alice@gmail.com', name: 'alice@gmail.com', color: '#9FE1E7', writable: true, primary: true, visible: true },
      { remoteId: 'en.german#holiday@group.v.calendar.google.com', name: 'Feiertage', color: '#16a765', writable: false, primary: false, visible: false },
      { remoteId: 'family0123@group.calendar.google.com', name: 'Family', color: 'rgb(1,2,3)', writable: true, primary: false, visible: true },
    ]);
  });

  it('maps a timed event: UTC instant, HTML description → text, organizer-editable', () => {
    const e = mapGoogleEvent(googleEventsPage1.items[0], { writable: true, defaultTimeZone: 'Europe/Berlin' });
    expect(e).toMatchObject({
      remoteId: 'abc123timed',
      title: 'Dentist',
      start: '2026-09-28T07:30:00.000Z',
      end: '2026-09-28T08:15:00.000Z',
      allDay: false,
      timezone: 'Europe/Berlin',
      status: 'confirmed',
      recurring: false,
      seriesId: null,
      htmlUrl: 'https://www.google.com/calendar/event?eid=YWJjMTIzdGltZWQ',
      meetingUrl: null,
      editable: true,
      location: 'Hauptstraße 1, Berlin',
    });
    expect(e?.description).toBe('Bring the insurance card.\nDetails: https://example.com/dentist\nTom & Jerry');
  });

  it('maps all-day events with start.date/end.date (end exclusive)', () => {
    const e = mapGoogleEvent(googleEventsPage1.items[1], { writable: true, defaultTimeZone: 'Europe/Berlin' });
    expect(e).toMatchObject({ allDay: true, start: '2026-10-01', end: '2026-10-04', timezone: 'Europe/Berlin' });
  });

  it('maps recurring instances (recurringEventId), meeting links and non-organizer editability', () => {
    const e = mapGoogleEvent(googleEventsPage1.items[2], { writable: true, defaultTimeZone: null });
    expect(e).toMatchObject({
      remoteId: 'weekly789_20260929T070000Z',
      recurring: true,
      seriesId: 'weekly789',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      editable: false, // organizer is someone else
    });
    const declined = mapGoogleEvent(googleEventsPage2.items[0], { writable: true, defaultTimeZone: null });
    expect(declined).toMatchObject({ status: 'declined', meetingUrl: 'https://zoom.us/j/123456789' });
  });

  it('drops working-location entries; unsafe links are stripped at ingest', () => {
    expect(mapGoogleEvent(googleEventsPage2.items[1], { writable: true, defaultTimeZone: null })).toBeNull();
    const evil = mapGoogleEvent(googleEventsPage2.items[2], { writable: true, defaultTimeZone: null })!;
    const clean = sanitizeEvent('cal-1', evil)!;
    expect(clean.htmlUrl).toBeNull();
    expect(clean.meetingUrl).toBeNull();
    expect(clean.title).toBe('Evil <script>alert(1)</script>'); // plain text; the UI renders it as text
  });

  it('builds insert/patch bodies (patch clears the other time field)', () => {
    expect(googleEventBody({ title: 'A', allDay: true, start: '2026-10-01', end: '2026-10-02' }, false)).toEqual({
      summary: 'A',
      start: { date: '2026-10-01' },
      end: { date: '2026-10-02' },
    });
    expect(
      googleEventBody({ allDay: false, start: '2026-10-01T10:00:00+02:00', end: '2026-10-01T11:00:00+02:00', timezone: 'Europe/Berlin', location: null }, true),
    ).toEqual({
      location: '',
      start: { dateTime: '2026-10-01T10:00:00+02:00', timeZone: 'Europe/Berlin', date: null },
      end: { dateTime: '2026-10-01T11:00:00+02:00', timeZone: 'Europe/Berlin', date: null },
    });
  });
});

describe('provider error mapping (403 classification)', () => {
  const answering = (status: number, data: unknown): SafeFetch => (async () => ({ status, data, headers: new Headers(), url: 'https://www.googleapis.com/' })) as SafeFetch;
  const call = (status: number, data: unknown, method = 'GET') =>
    providerCall(answering(status, data), 'https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      method,
      token: 'tok',
      provider: 'Google Calendar',
      accountId: 'g1',
    });

  it('tells an API disabled for the OAuth client and a missing scope apart from a refused calendar', async () => {
    await expect(call(403, googleApiDisabled)).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      denial: 'api_disabled',
      providerReason: 'PERMISSION_DENIED accessNotConfigured SERVICE_DISABLED',
      message:
        'The Google Calendar API is not enabled for the Google Cloud project of your OAuth client; enable it in the Google Cloud console, then sync again',
    });
    await expect(call(403, googleScopeInsufficient)).rejects.toMatchObject({
      denial: 'insufficient_scope',
      message: 'Google Calendar access was not granted to Homebase; reconnect the account and allow calendar access',
    });
    await expect(call(403, googleForbidden)).rejects.toMatchObject({ denial: 'denied', providerReason: 'forbidden' });
    await expect(call(403, 'not json')).rejects.toMatchObject({ denial: 'denied', providerReason: null });
  });

  it('only writes are "not allowed changes"; reads say access was denied', async () => {
    await expect(call(403, googleForbidden, 'GET')).rejects.toMatchObject({ message: 'Google Calendar denied Homebase access to this calendar' });
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      await expect(call(403, googleForbidden, method)).rejects.toMatchObject({ message: 'Google Calendar does not allow this change' });
    }
  });

  it('keeps 403 rate limits as 429 and other statuses unchanged', async () => {
    await expect(call(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } })).rejects.toMatchObject({ status: 429, code: 'rate_limited', denial: null });
    await expect(call(404, { error: { errors: [{ reason: 'notFound' }] } })).rejects.toMatchObject({ code: 'not_found', providerReason: 'notFound' });
    await expect(call(503, {})).rejects.toMatchObject({ code: 'provider_error', message: 'Google Calendar returned an error (503)', providerReason: null });
  });

  it('keeps only identifier-like reason codes, and never sends them to the client', async () => {
    expect(
      providerErrorReasons({
        error: {
          status: 'PERMISSION_DENIED',
          code: 403,
          errors: [{ reason: 'accessNotConfigured' }, { reason: 'see https://console.cloud.google.com <b>now</b>' }, { reason: 42 }],
          details: [{ reason: 'SERVICE_DISABLED' }, { reason: 'accessNotConfigured' }, 'junk'],
        },
      }),
    ).toEqual(['PERMISSION_DENIED', 'accessNotConfigured', 'SERVICE_DISABLED']);
    expect(providerErrorReasons({ error: 'nope' })).toEqual([]);
    expect(classifyDenial(['ErrorAccessDenied'])).toBe('denied');

    const err = await call(403, googleApiDisabled).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(JSON.stringify((err as ProviderHttpError).toBody())).not.toMatch(/accessNotConfigured|SERVICE_DISABLED|123456789012/);
  });
});

describe('provider errors for health and logs', () => {
  function recording(status: number, data: unknown, headers: Record<string, string> = {}) {
    const seen: SafeFetchOptions[] = [];
    const fetch = (async (_url: string, options: SafeFetchOptions) => {
      seen.push(options);
      return { status, data, headers: new Headers(headers), url: 'https://www.googleapis.com/' };
    }) as SafeFetch;
    return { fetch, seen };
  }
  const call = (fetch: SafeFetch, purpose?: string) =>
    providerCall(fetch, 'https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      token: 'tok',
      provider: 'Google Calendar',
      accountId: 'g1',
      ...(purpose === undefined ? {} : { purpose }),
    });
  const failure = (fetch: SafeFetch) => call(fetch).catch((e: unknown) => e);

  it('passes the purpose to safe-fetch', async () => {
    const { fetch, seen } = recording(200, { items: [] });
    await call(fetch, 'gcal.calendarList');
    expect(seen[0]).toMatchObject({ purpose: 'gcal.calendarList', policy: 'provider' });
    await call(fetch);
    expect(seen[1]).not.toHaveProperty('purpose');
  });

  it('keeps the provider status and Retry-After (seconds or HTTP date): health gets the code, status and next attempt', async () => {
    const throttled = await failure(recording(429, { error: { status: 'RESOURCE_EXHAUSTED' } }, { 'Retry-After': '120' }).fetch);
    expect(throttled).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 120, httpStatus: 429 });
    const before = Date.now();
    const outcome = outcomeFromError(throttled);
    expect(outcome).toMatchObject({ ok: false, code: 'rate_limited', status: 429, detail: expect.objectContaining({ retryAfterSeconds: 120 }) });
    expect(outcome.nextAttemptAt).toBeGreaterThanOrEqual(before + 120_000);

    const date = new Date(Date.now() + 90_000).toUTCString();
    const dated = await failure(recording(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, { 'retry-after': date }).fetch);
    expect((dated as ProviderHttpError).retryAfterSeconds).toBeGreaterThan(80);
    expect(dated).toMatchObject({ status: 429, httpStatus: 403 });

    const noHint = await failure(recording(503, {}).fetch);
    expect(noHint).toMatchObject({ retryAfterSeconds: null, httpStatus: 503 });
    expect(outcomeFromError(noHint)).toMatchObject({ code: 'http_5xx', status: 503 });
    expect(outcomeFromError(noHint)).not.toHaveProperty('nextAttemptAt');
    expect(outcomeFromError(await failure(recording(400, {}).fetch))).toMatchObject({ code: 'http_4xx', status: 400 });
    expect(outcomeFromError(await failure(recording(410, {}).fetch))).toMatchObject({ code: 'not_found', status: 410 });
    expect(outcomeFromError(await failure(recording(403, googleScopeInsufficient).fetch))).toMatchObject({ code: 'insufficient_scope', status: 403 });
  });

  it('names malformed and over-long listings for health', () => {
    let malformed: unknown = null;
    try {
      listItems({ kind: 'calendar#events' }, 'items', { id: 'g1' });
    } catch (err) {
      malformed = err;
    }
    expect(outcomeFromError(malformed)).toMatchObject({ code: 'parse_error', message: 'The provider returned an unexpected response' });
    expect(outcomeFromError(incompleteListing({ id: 'g1' }))).toMatchObject({ code: 'too_large' });
  });
});

describe('write info (zones sent)', () => {
  it('Google: a timed write sends the requested zone, UTC only as a fallback; all-day writes send none', () => {
    const timed = { allDay: false, start: '2026-10-01T10:00:00+02:00', end: '2026-10-01T11:00:00+02:00' };
    expect(googleZoneSent(googleEventBody({ ...timed, timezone: 'Europe/Berlin' }, false), 'Europe/Berlin')).toEqual({ tzSent: 'Europe/Berlin', tzFallback: false });
    expect(googleZoneSent(googleEventBody(timed, true), undefined)).toEqual({ tzSent: 'UTC', tzFallback: true });
    expect(googleZoneSent(googleEventBody({ allDay: true, start: '2026-10-01', end: '2026-10-02' }, false), 'Europe/Berlin')).toEqual({ tzSent: null, tzFallback: false });
    expect(googleZoneSent(googleEventBody({ title: 'Renamed' }, true), 'Europe/Berlin')).toEqual({ tzSent: null, tzFallback: false });
  });

  it('Graph: the Windows zone of the requested IANA zone, else UTC as a fallback', () => {
    const timed = { allDay: false, start: '2026-10-01T08:00:00Z', end: '2026-10-01T09:00:00Z' };
    expect(graphZoneSent(graphEventBody({ ...timed, timezone: 'Europe/Berlin' }), 'Europe/Berlin')).toEqual({ tzSent: 'W. Europe Standard Time', tzFallback: false });
    expect(graphZoneSent(graphEventBody({ ...timed, timezone: 'UTC' }), 'UTC')).toEqual({ tzSent: 'UTC', tzFallback: false });
    expect(graphZoneSent(graphEventBody({ ...timed, timezone: 'Mars/Nowhere' }), 'Mars/Nowhere')).toEqual({ tzSent: 'UTC', tzFallback: true });
    expect(graphZoneSent(graphEventBody({ title: 'x' }), null)).toEqual({ tzSent: null, tzFallback: false });
  });
});

describe('Microsoft Graph mappers', () => {
  it('maps calendars: canEdit → writable, hexColor or preset color', () => {
    expect(graphCalendars.value.map(mapGraphCalendar)).toEqual([
      { remoteId: 'AQMkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgBGAAAD', name: 'Calendar', color: null, writable: true, primary: true },
      { remoteId: 'AQMkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgBGAAAE', name: 'Birthdays', color: '#5fb86b', writable: false, primary: false },
      { remoteId: 'AQMkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgBGAAAF', name: 'Shared', color: '#e3008c', writable: true, primary: false },
    ]);
  });

  it('maps a timed event in UTC with an HTML body, location, joinUrl and the Windows zone → IANA', () => {
    const e = mapGraphEvent(graphCalendarViewPage1.value[0], { writable: true });
    expect(e).toMatchObject({
      remoteId: 'AAMkAGI2TGuLAAA=',
      title: 'Quarterly review',
      start: '2026-09-30T13:00:00.000Z',
      end: '2026-09-30T14:30:00.000Z',
      allDay: false,
      location: 'Room 4.12',
      meetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
      htmlUrl: 'https://outlook.live.com/owa/?itemid=AAMkAGI2TGuLAAA%3D&exvsurl=1&path=/calendar/item',
      timezone: 'Europe/Berlin',
      editable: true,
      recurring: false,
    });
    expect(e?.description).toBe('Agenda:\n• Numbers\n• Plans\nJoin: Click here (https://teams.microsoft.com/l/meetup-join/abc)');
  });

  it('takes the date parts of all-day events verbatim', () => {
    const e = mapGraphEvent(graphCalendarViewPage1.value[1], { writable: true });
    expect(e).toMatchObject({ allDay: true, start: '2026-10-03', end: '2026-10-04', location: null, description: null });
  });

  it('maps occurrences, tentative/declined/cancelled and skips series masters', () => {
    const [occ, cancelled, master] = graphCalendarViewPage2.value.map((v) => mapGraphEvent(v, { writable: true }));
    expect(occ).toMatchObject({
      recurring: true,
      seriesId: 'AAMkAGI2master=',
      status: 'tentative',
      editable: false,
      meetingUrl: 'https://teams.microsoft.com/l/meetup-join/standup',
      timezone: 'America/Los_Angeles',
      description: 'Daily standup\nBe on time',
    });
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(master).toBeNull();
  });

  it('converts non-UTC dateTimeTimeZone values and builds write bodies with Windows zones', () => {
    expect(graphInstant({ dateTime: '2026-07-01T09:00:00.0000000', timeZone: 'Pacific Standard Time' })).toBe('2026-07-01T16:00:00.000Z');
    expect(graphInstant({ dateTime: '2026-07-01T09:00:00', timeZone: 'UTC' })).toBe('2026-07-01T09:00:00.000Z');
    expect(
      graphEventBody({ title: 'T', allDay: false, start: '2026-10-01T08:00:00Z', end: '2026-10-01T09:00:00Z', timezone: 'Europe/Berlin', description: 'x' }),
    ).toEqual({
      subject: 'T',
      body: { contentType: 'text', content: 'x' },
      isAllDay: false,
      start: { dateTime: '2026-10-01T10:00:00', timeZone: 'W. Europe Standard Time' },
      end: { dateTime: '2026-10-01T11:00:00', timeZone: 'W. Europe Standard Time' },
    });
    expect(graphEventBody({ allDay: true, start: '2026-10-01', end: '2026-10-02', timezone: 'Mars/Nowhere' })).toEqual({
      isAllDay: true,
      start: { dateTime: '2026-10-01T00:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-10-02T00:00:00', timeZone: 'UTC' },
    });
  });
});

describe('ids, sanitization and text', () => {
  it('builds deterministic event ids `${calendarId}:${sha1(remoteId|instanceKey)}`', () => {
    expect(eventId('cal', 'uid-1', null)).toBe('cal:2ff2cfd576779f94dbc303644ce0cd6d295b079f');
    expect(eventId('cal', 'uid-1', '2026-10-01T10:00:00.000Z')).toBe('cal:2fa259518afe783e7b280e7d7fc1420b005de555');
    expect(eventId('other', 'uid-1', null)).toBe('other:2ff2cfd576779f94dbc303644ce0cd6d295b079f');
  });

  it('sanitizes records: caps, defaults, time normalization, invalid zones', () => {
    const clean = sanitizeEvent('cal', {
      remoteId: 'r',
      instanceKey: null,
      etag: null,
      title: `  ${'x'.repeat(600)}  `,
      location: '\u0000Somewhere\n   else',
      description: 'a\r\n\r\n\r\n\r\nb',
      start: '2026-10-01T10:00:00+02:00',
      end: '2026-10-01T09:00:00+02:00',
      allDay: false,
      timezone: 'Not/AZone',
      status: 'bogus' as never,
      recurring: false,
      seriesId: null,
      htmlUrl: 'https://user:pw@example.com/',
      meetingUrl: 'https://example.com/meet',
      editable: true,
    })!;
    expect(clean.title).toHaveLength(500);
    expect(clean.location).toBe('Somewhere else');
    expect(clean.description).toBe('a\n\nb');
    expect(clean.start).toBe('2026-10-01T08:00:00.000Z');
    expect(clean.end).toBe(clean.start);
    expect(clean.timezone).toBeNull();
    expect(clean.status).toBe('confirmed');
    expect(clean.htmlUrl).toBeNull();
    expect(clean.meetingUrl).toBe('https://example.com/meet');
    expect(sanitizeEvent('cal', { ...clean, allDay: true, start: '2026-10-01', end: '2026-10-01' })).toMatchObject({ end: '2026-10-02' });
    expect(sanitizeEvent('cal', { ...clean, title: '   ' })?.title).toBe('(No title)');
    expect(sanitizeEvent('cal', { ...clean, start: 'garbage' })).toBeNull();
  });

  it('converts HTML to text without a DOM (scripts dropped, entities decoded, links kept)', () => {
    expect(htmlToText('<p>Hello&nbsp;<b>world</b></p><script>alert(1)</script><div>2&lt;3</div>')).toBe('Hello world\n2<3');
    expect(htmlToText('<a href="javascript:alert(1)">x</a>')).toBe('x');
  });
});

describe('time and zones', () => {
  it('converts wall times across DST', () => {
    expect(new Date(wallToUtcMs({ year: 2026, month: 3, day: 29, hour: 12, minute: 0, second: 0 }, 'Europe/Berlin')).toISOString()).toBe('2026-03-29T10:00:00.000Z');
    expect(new Date(wallToUtcMs({ year: 2026, month: 3, day: 28, hour: 12, minute: 0, second: 0 }, 'Europe/Berlin')).toISOString()).toBe('2026-03-28T11:00:00.000Z');
    // A time in the spring-forward gap moves forward.
    expect(new Date(wallToUtcMs({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, 'America/New_York')).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(new Date(startOfDayMs('2026-10-01', 'Asia/Tokyo')).toISOString()).toBe('2026-09-30T15:00:00.000Z');
  });

  it('computes the synced window [today-30d, today+365d) in the server zone', () => {
    const w = syncWindow(Date.parse('2026-09-25T23:30:00Z'), 'Europe/Berlin'); // already Sep 26 in Berlin
    expect(w.fromDate).toBe('2026-08-27');
    expect(w.toDate).toBe('2027-09-26');
    expect(new Date(w.fromMs).toISOString()).toBe('2026-08-26T22:00:00.000Z');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('bundles the CLDR windowsZones table', () => {
    expect(WINDOWS_ZONE_COUNT).toBeGreaterThan(130);
    expect(windowsToIana('W. Europe Standard Time')).toBe('Europe/Berlin');
    expect(windowsToIana('eastern standard time')).toBe('America/New_York');
    expect(ianaToWindows('Europe/Amsterdam')).toBe('W. Europe Standard Time');
    // Browsers report current IANA names; CLDR lists the legacy ones.
    expect(ianaToWindows('Asia/Kolkata')).toBe('India Standard Time');
    expect(ianaToWindows('Europe/Kyiv')).toBe('FLE Standard Time');
    expect(ianaToWindows('Nowhere/Special')).toBeNull();
    expect(resolveTimeZoneName('/mozilla.org/20050126_1/Europe/Paris')).toBe('Europe/Paris');
    expect(resolveTimeZoneName('"Tokyo Standard Time"')).toBe('Asia/Tokyo');
    expect(resolveTimeZoneName('Nowhere/Special')).toBeNull();
  });
});
