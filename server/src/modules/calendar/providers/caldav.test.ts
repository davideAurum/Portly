import { afterEach, describe, expect, it } from 'vitest';
import type { AccountDraft } from '@homebase/shared';
import { HttpError } from '../../../lib/errors.ts';
import { outcomeFromError } from '../../../lib/health.ts';
import { withLogContext } from '../../../lib/log-context.ts';
import { createTestLogger } from '../../../lib/logger.ts';
import type { ResponseKind, SafeFetch, SafeFetchOptions } from '../../../security/safe-fetch.ts';
import { createTestContext, type TestContext } from '../../../testing/test-context.ts';
import type { FakeAccountService } from '../../../testing/fake-accounts.ts';
import { calendarsResponse, homeResponse, multistatus, principalResponse, reportResponse } from '../__fixtures__/caldav.ts';
import { WINDOW } from '../__fixtures__/ics.ts';
import { expandCalendar } from '../ical/expand.ts';
import type { ExpandRunner } from '../ical/run.ts';
import type { CalendarRow } from '../types.ts';
import {
  createCaldavProbe,
  createCaldavProvider,
  createDavFetch,
  findPrincipal,
  isUnderCollection,
  PROPFIND_MAX_BYTES,
  queryDavEvents,
  resolveHref,
} from './caldav.ts';
import { createDavXmlParser, DavParseError } from './dav-xml.ts';
import { xmlNestingDepth } from './dav-xml-scan.ts';
import { isEventListing, type EventListing } from './types.ts';

const YAHOO = 'https://caldav.calendar.yahoo.com';
const inProcess: ExpandRunner = async (job) => expandCalendar(job);
const BASIC = `Basic ${Buffer.from('me@yahoo.com:app-pass', 'utf8').toString('base64')}`;

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.close();
  ctx = null;
});

function yahooDraft(): AccountDraft {
  return {
    kind: 'yahoo',
    label: 'me@yahoo.com',
    email: 'me@yahoo.com',
    config: { username: 'me@yahoo.com', caldav: { serverUrl: YAHOO, credentialOrigins: [YAHOO], insecureLan: false } },
    secret: { password: 'app-pass' },
  };
}

describe('href handling', () => {
  it('resolves hrefs against the request URL and drops foreign origins', () => {
    const origins = ['https://dav.example.com'];
    expect(resolveHref('/cal/a.ics', 'https://dav.example.com/cal/', origins)?.href).toBe('https://dav.example.com/cal/a.ics');
    expect(resolveHref('a.ics', 'https://dav.example.com/cal/', origins)?.href).toBe('https://dav.example.com/cal/a.ics');
    expect(resolveHref('https://evil.example.net/a.ics', 'https://dav.example.com/cal/', origins)).toBeNull();
    expect(resolveHref('//evil.example.net/a.ics', 'https://dav.example.com/cal/', origins)).toBeNull();
    expect(resolveHref('http://dav.example.com/a.ics', 'https://dav.example.com/cal/', origins)).toBeNull();
    expect(resolveHref('javascript:alert(1)', 'https://dav.example.com/cal/', origins)).toBeNull();
    expect(resolveHref('https://u:p@dav.example.com/a', 'https://dav.example.com/cal/', origins)).toBeNull();
  });

  it('accepts only resources strictly under the collection path', () => {
    const col = new URL('https://dav.example.com/cal/personal/');
    expect(isUnderCollection(new URL('https://dav.example.com/cal/personal/x.ics'), col)).toBe(true);
    expect(isUnderCollection(new URL('https://dav.example.com/cal/personal/'), col)).toBe(false);
    expect(isUnderCollection(new URL('https://dav.example.com/cal/personalx/x.ics'), col)).toBe(false);
    expect(isUnderCollection(new URL('https://dav.example.com/cal/personal/%2e%2e/other/x.ics'), col)).toBe(false);
    expect(isUnderCollection(new URL('https://other.example.com/cal/personal/x.ics'), col)).toBe(false);
  });
});

describe('DAV transport', () => {
  it('rejects XML with a DOCTYPE and maps 401', async () => {
    ctx = createTestContext({
      fetchRoutes: [
        { match: `${YAHOO}/doctype`, respond: { status: 207, text: '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "a">]><d:multistatus xmlns:d="DAV:"/>' } },
        { match: `${YAHOO}/auth`, respond: { status: 401, text: 'nope' } },
      ],
    });
    const davFetch = createDavFetch(ctx.fetch, [YAHOO], { username: 'me@yahoo.com', password: 'app-pass' });
    await expect(davFetch(`${YAHOO}/doctype`, { method: 'PROPFIND' })).rejects.toMatchObject({ code: 'provider_error', message: expect.stringMatching(/DOCTYPE/) });
    await expect(davFetch(`${YAHOO}/auth`, { method: 'PROPFIND' })).rejects.toMatchObject({ httpStatus: 401 });
    expect(ctx.fakeFetch!.calls[0]!.headers.get('authorization')).toBe(BASIC);
  });

  it('never sends credentials outside the credential origins', async () => {
    ctx = createTestContext({ fetchRoutes: [] });
    const davFetch = createDavFetch(ctx.fetch, [YAHOO], { username: 'me@yahoo.com', password: 'app-pass' });
    await expect(davFetch('https://evil.example.net/', { method: 'PROPFIND' })).rejects.toBeInstanceOf(HttpError);
    expect(ctx.fakeFetch!.calls).toHaveLength(0);
  });
});

describe('CalDAV probe', () => {
  it('discovers principal and home for Yahoo (fixed origin) with Basic auth', async () => {
    ctx = createTestContext({
      fetchRoutes: [
        { match: `${YAHOO}/`, method: 'PROPFIND', respond: (req) => (req.body?.includes('current-user-principal') && req.url === `${YAHOO}/` ? principalResponse('/', '/dav/me/principal/') : { status: 404 }) , times: 1 },
        { match: `${YAHOO}/dav/me/principal/`, method: 'PROPFIND', respond: homeResponse('/dav/me/principal/', '/dav/me/Calendar/') },
        { match: `${YAHOO}/dav/me/Calendar/`, method: 'PROPFIND', respond: calendarsResponse('/dav/me/Calendar/') },
      ],
    });
    const probe = createCaldavProbe(ctx);
    const result = await probe(yahooDraft());
    expect(result.configPatch).toEqual({
      caldav: {
        credentialOrigins: [YAHOO],
        principalUrl: `${YAHOO}/dav/me/principal/`,
        calendarHomeUrl: `${YAHOO}/dav/me/Calendar/`,
      },
    });
    for (const call of ctx.fakeFetch!.calls) expect(call.headers.get('authorization')).toBe(BASIC);
    expect(ctx.fakeFetch!.calls.every((c) => c.url.startsWith(YAHOO))).toBe(true);
  });

  it('follows /.well-known/caldav to a same-site origin for generic servers and records it', async () => {
    ctx = createTestContext({
      fetchRoutes: [
        { match: /^https:\/\/example\.com\/$/, method: 'PROPFIND', respond: { status: 404, text: '' } },
        { match: 'https://example.com/.well-known/caldav', method: 'PROPFIND', respond: { status: 301, headers: { location: 'https://dav.example.com/caldav/' } } },
        { match: /^https:\/\/dav\.example\.com\/caldav\/$/, method: 'PROPFIND', respond: principalResponse('/caldav/', '/caldav/principals/me/') },
        { match: 'https://dav.example.com/caldav/principals/me/', method: 'PROPFIND', respond: homeResponse('/caldav/principals/me/', '/caldav/calendars/me/') },
        { match: 'https://dav.example.com/caldav/calendars/me/', method: 'PROPFIND', respond: calendarsResponse('/caldav/calendars/me/') },
      ],
    });
    const result = await createCaldavProbe(ctx)({
      kind: 'caldav',
      label: 'Home server',
      email: null,
      config: { username: 'me', caldav: { serverUrl: 'https://example.com/', credentialOrigins: ['https://example.com'], insecureLan: false } },
      secret: { password: 'pw' },
    });
    expect(result.configPatch).toEqual({
      caldav: {
        credentialOrigins: ['https://example.com', 'https://dav.example.com'],
        principalUrl: 'https://dav.example.com/caldav/principals/me/',
        calendarHomeUrl: 'https://dav.example.com/caldav/calendars/me/',
      },
    });
  });

  it('refuses a cross-site redirect (credentials never follow it) and a Yahoo redirect off its origin', async () => {
    ctx = createTestContext({
      fetchRoutes: [
        { match: /^https:\/\/example\.com\/$/, method: 'PROPFIND', respond: { status: 404 } },
        { match: 'https://example.com/.well-known/caldav', method: 'PROPFIND', respond: { status: 302, headers: { location: 'https://attacker.example.net/dav/' } } },
      ],
    });
    await expect(
      createCaldavProbe(ctx)({
        kind: 'caldav',
        label: 'x',
        email: null,
        config: { username: 'me', caldav: { serverUrl: 'https://example.com/', credentialOrigins: ['https://example.com'], insecureLan: false } },
        secret: { password: 'pw' },
      }),
    ).rejects.toMatchObject({ code: 'provider_error', message: expect.stringMatching(/different site/) });
    expect(ctx.fakeFetch!.calls.some((c) => c.url.includes('attacker'))).toBe(false);
  });

  it('reports a wrong password as an auth failure', async () => {
    ctx = createTestContext({ fetchRoutes: [{ match: YAHOO, respond: { status: 401, text: 'Unauthorized' } }] });
    await expect(createCaldavProbe(ctx)(yahooDraft())).rejects.toMatchObject({ code: 'forbidden', message: 'The server rejected the username or password' });
  });

  it('never leaks raw server text from parser errors', async () => {
    ctx = createTestContext({
      fetchRoutes: [
        { match: `${YAHOO}/`, method: 'PROPFIND', respond: principalResponse('/', '/dav/me/principal/') },
        { match: `${YAHOO}/dav/me/principal/`, method: 'PROPFIND', respond: { status: 500, text: 'SECRET STACK TRACE' } },
      ],
    });
    const err = await createCaldavProbe(ctx)(yahooDraft()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as Error).message).not.toMatch(/SECRET/);
  });
});

describe('CalDAV provider (read-only)', () => {
  const home = `${YAHOO}/dav/me/Calendar/`;
  function setup(extraRoutes: Parameters<typeof createTestContext>[0] = {}) {
    ctx = createTestContext({
      accounts: [
        {
          id: 'y1',
          kind: 'yahoo',
          email: 'me@yahoo.com',
          capabilities: ['calendar'],
          password: 'app-pass',
          config: { username: 'me@yahoo.com', caldav: { serverUrl: YAHOO, credentialOrigins: [YAHOO], insecureLan: false, calendarHomeUrl: home } },
        },
      ],
      ...extraRoutes,
    });
    return createCaldavProvider(ctx, inProcess);
  }

  it('lists VEVENT calendars with names and colors; foreign hrefs and task lists are dropped', async () => {
    const provider = setup({ fetchRoutes: [{ match: home, method: 'PROPFIND', respond: calendarsResponse('/dav/me/Calendar/') }] });
    const cals = await provider.listCalendars(ctx!.accounts.get('y1')!);
    expect(cals).toEqual([
      { remoteId: `${home}personal/`, name: 'Personal', color: '#ff2968ff', writable: false, primary: true, collectionUrl: `${home}personal/`, ctag: 'ctag-Personal' },
      { remoteId: `${home}work/`, name: 'Work', color: null, writable: false, primary: false, collectionUrl: `${home}work/`, ctag: 'ctag-Work' },
    ]);
  });

  it('REPORTs the time range and keeps only objects under the collection', async () => {
    const provider = setup({ fetchRoutes: [{ match: `${home}personal/`, method: 'REPORT', respond: reportResponse('/dav/me/Calendar/personal/') }] });
    const row = { id: 'c1', remote_id: `${home}personal/`, collection_url: `${home}personal/` } as CalendarRow;
    const listing = await provider.listEvents(ctx!.accounts.get('y1')!, row, { ...WINDOW, tz: 'UTC' });
    expect(isEventListing(listing)).toBe(true);
    const { events, warning } = listing as EventListing;
    expect(events.map((e) => [e.remoteId, e.title, e.start])).toEqual([['dav-1', 'Dentist & checkup', '2026-10-05T09:00:00.000Z']]);
    expect(warning).toBeNull();
    const report = ctx!.fakeFetch!.calls[0]!;
    expect(report.headers.get('depth')).toBe('1');
    expect(report.body).toMatch(/time-range start="20260826T000000Z" end="20270925T000000Z"/);
  });

  it('passes shortened repeating events on as a warning (the listing still succeeds)', async () => {
    ctx = createTestContext({
      accounts: [
        {
          id: 'y1',
          kind: 'yahoo',
          email: 'me@yahoo.com',
          capabilities: ['calendar'],
          password: 'app-pass',
          config: { username: 'me@yahoo.com', caldav: { serverUrl: YAHOO, credentialOrigins: [YAHOO], insecureLan: false, calendarHomeUrl: home } },
        },
      ],
      fetchRoutes: [{ match: `${home}personal/`, method: 'REPORT', respond: reportResponse('/dav/me/Calendar/personal/') }],
    });
    const truncating: ExpandRunner = async (job) => {
      const result = expandCalendar(job);
      return result.ok ? { ...result, truncated: 2 } : result;
    };
    const provider = createCaldavProvider(ctx, truncating);
    const row = { id: 'c1', remote_id: `${home}personal/`, collection_url: `${home}personal/` } as CalendarRow;
    const listing = (await provider.listEvents(ctx.accounts.get('y1')!, row, { ...WINDOW, tz: 'UTC' })) as EventListing;
    expect(listing.events).toHaveLength(1);
    expect(listing.warning).toBe('Some repeating events were shortened: 2 events repeat too often, so only the first occurrences are shown.');
  });

  it('marks the account for reauth when the server rejects the password (reason caldav_password_rejected)', async () => {
    const provider = setup({ fetchRoutes: [{ match: home, respond: { status: 401 } }] });
    await expect(provider.listCalendars(ctx!.accounts.get('y1')!)).rejects.toMatchObject({ code: 'reauth_required', accountId: 'y1' });
    expect((ctx!.accounts as FakeAccountService).statusChanges).toContainEqual({
      id: 'y1',
      status: 'reauth',
      message: 'The CalDAV server rejected the password',
      meta: { reason: 'caldav_password_rejected', source: 'calendar' },
    });
  });

  it('refuses collection URLs outside the credential origins', async () => {
    const provider = setup();
    const row = { id: 'c1', remote_id: 'https://evil.example.net/cal/', collection_url: 'https://evil.example.net/cal/' } as CalendarRow;
    await expect(provider.listEvents(ctx!.accounts.get('y1')!, row, { ...WINDOW, tz: 'UTC' })).rejects.toMatchObject({ code: 'provider_error' });
    expect(ctx!.fakeFetch!.calls).toHaveLength(0);
  });

  it('names its requests for the logs (purpose) and gives an unreadable answer a health code', async () => {
    setup({
      fetchRoutes: [
        { match: home, method: 'PROPFIND', respond: calendarsResponse('/dav/me/Calendar/') },
        { match: `${home}personal/`, method: 'REPORT', respond: multistatus('<d:x>'.repeat(300)) },
      ],
    });
    const purposes: unknown[] = [];
    const spied = (<A extends ResponseKind>(url: string | URL, options: SafeFetchOptions<A>) => {
      purposes.push(options.purpose);
      return ctx!.fetch(url, options);
    }) as SafeFetch;
    const provider = createCaldavProvider({ ...ctx!, fetch: spied }, inProcess);
    const account = ctx!.accounts.get('y1')!;
    await provider.listCalendars(account);
    const row = { id: 'c1', remote_id: `${home}personal/`, collection_url: `${home}personal/` } as CalendarRow;
    const err = await provider.listEvents(account, row, { ...WINDOW, tz: 'UTC' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'provider_error', message: 'The CalDAV server sent an unexpected response', details: { reason: 'too_large' } });
    expect(outcomeFromError(err)).toMatchObject({ code: 'too_large' });
    expect(purposes).toEqual(['caldav.propfind', 'caldav.report']);
  });

  it('rejects DOCTYPE in REPORT responses', async () => {
    const provider = setup({
      fetchRoutes: [
        { match: `${home}personal/`, method: 'REPORT', respond: multistatus('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><d:response><d:href>&e;</d:href></d:response>') },
      ],
    });
    const row = { id: 'c1', remote_id: `${home}personal/`, collection_url: `${home}personal/` } as CalendarRow;
    await expect(provider.listEvents(ctx!.accounts.get('y1')!, row, { ...WINDOW, tz: 'UTC' })).rejects.toMatchObject({ message: expect.stringMatching(/DOCTYPE/) });
  });
});

describe('DAV XML is parsed off the main thread (DOS-2)', () => {
  /** Longest gap between ticks of a 10 ms interval while `fn` runs. */
  async function maxLag<T>(fn: () => Promise<T>): Promise<{ lag: number; outcome: PromiseSettledResult<T> }> {
    let last = performance.now();
    let lag = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      lag = Math.max(lag, now - last - 10);
      last = now;
    }, 10);
    const [outcome] = await Promise.allSettled([fn()]);
    clearInterval(timer);
    return { lag, outcome: outcome as PromiseSettledResult<T> };
  }

  const hostile = (body: string) => ({
    status: 207,
    text: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${body}`,
    headers: { 'content-type': 'application/xml' },
  });

  it('a REPORT of unclosed nested elements neither stalls the event loop nor parses for seconds', async () => {
    ctx = createTestContext({ fetchRoutes: [{ match: `${YAHOO}/cal/`, respond: hostile('<d:x>'.repeat(450_000)) }] });
    const session = { fetch: createDavFetch(ctx.fetch, [YAHOO], { username: 'u', password: 'p' }), origins: [YAHOO] };
    const started = performance.now();
    const { lag, outcome } = await maxLag(() => queryDavEvents(session, `${YAHOO}/cal/`, { fromMs: 0, toMs: 1 }));
    expect(outcome.status).toBe('rejected');
    expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(DavParseError);
    expect(lag).toBeLessThan(400);
    expect(performance.now() - started).toBeLessThan(4_000);
  });

  it('PROPFIND discovery answers get the same treatment and a 1 MB cap; REPORT keeps 10 MB', async () => {
    const principal = (href: string) =>
      `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
    const padding = `<!-- ${'x'.repeat(1_100_000)} -->`;
    ctx = createTestContext({
      fetchRoutes: [
        { match: `${YAHOO}/deep`, respond: hostile('<d:x>'.repeat(300)) },
        { match: `${YAHOO}/ok`, respond: principalResponse('/ok', '/principals/me/') },
        { match: `${YAHOO}/big-propfind`, respond: multistatus(padding + principal('/big-propfind')) },
        { match: `${YAHOO}/big-report/`, respond: multistatus(padding) },
      ],
    });
    const session = { fetch: createDavFetch(ctx.fetch, [YAHOO], { username: 'u', password: 'p' }), origins: [YAHOO] };
    await expect(findPrincipal(session, `${YAHOO}/deep`)).rejects.toMatchObject({ reason: 'limit' });
    await expect(findPrincipal(session, `${YAHOO}/ok`)).resolves.toBe(`${YAHOO}/principals/me/`);
    await expect(findPrincipal(session, `${YAHOO}/big-propfind`)).rejects.toBeDefined();
    await expect(queryDavEvents(session, `${YAHOO}/big-report/`, { fromMs: 0, toMs: 1 })).resolves.toEqual([]);
    expect(PROPFIND_MAX_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });

  it('a parse that runs past its time budget is abandoned, and the parent logs it in the caller’s context', async () => {
    const log = createTestLogger();
    const slow = createDavXmlParser({ timeoutMs: 1, log });
    const job = { url: `${YAHOO}/`, text: principalResponse('/', '/p/').text as string, status: 207, contentType: 'application/xml' };
    await expect(withLogContext({ accountId: 'y1', calendarId: 'c1' }, () => slow(job))).resolves.toMatchObject({ ok: false, reason: 'timeout' });
    expect(log.lines().filter((r) => r.msg === 'calendar worker failed')).toEqual([
      expect.objectContaining({
        level: 'info',
        fields: expect.objectContaining({ worker: 'dav-xml', reason: 'timeout', bytes: Buffer.byteLength(job.text), accountId: 'y1', calendarId: 'c1' }),
      }),
    ]);
  });

  it('measures nesting depth in one linear pass', () => {
    expect(xmlNestingDepth('<a><b/><c x="/>"><d></d></c></a>')).toBe(3);
    expect(xmlNestingDepth('<a><!-- <b><c> --><![CDATA[<x><y>]]></a>')).toBe(1);
    expect(xmlNestingDepth('<x>'.repeat(1_000_000), 256)).toBe(257);
  });
});
