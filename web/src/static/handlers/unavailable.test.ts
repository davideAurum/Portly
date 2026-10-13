/**
 * Server-only routes in the static build answer `409 not_configured` ("Not set up yet"), with the
 * feature named in the message, for every method + path the web app's app-password account,
 * vault, calendar, mail, feeds and diagnostics API calls use; unknown routes still 404 and wrong methods still
 * 400. (Outlook.com accounts and OAuth are answered by handlers/accounts.ts.)
 */
import { ApiErrorBodySchema, ERROR_STATUS } from '@portly/shared';
import { describe, expect, it } from 'vitest';
import { createTestBackend } from '../test/harness.ts';
import * as core from './core.ts';
import * as unavailable from './unavailable.ts';
import { UNAVAILABLE_ROUTES, type UnavailableFeature } from './unavailable.ts';

/** One concrete call per route the web app can make (params filled in, query strings as the client sends them). */
const CALLS: readonly [method: string, path: string, feature: UnavailableFeature, body?: unknown][] = [
  ['POST', '/api/accounts/yahoo', 'Accounts', { label: 'Yahoo', email: 'me@yahoo.com', appPassword: 'secret' }],
  ['POST', '/api/accounts/caldav', 'Accounts', {}],
  ['POST', '/api/accounts/imap', 'Accounts', {}],
  ['POST', '/api/vault/reset', 'The credential vault'],
  ['GET', '/api/calendar/calendars', 'Calendars'],
  ['PATCH', '/api/calendar/calendars/cal-1', 'Calendars', { visible: false }],
  ['DELETE', '/api/calendar/calendars/cal-1', 'Calendars'],
  ['POST', '/api/calendar/ics', 'Calendars', { url: 'https://example.com/a.ics', name: 'Holidays' }],
  ['PATCH', '/api/calendar/ics/cal-1', 'Calendars', { name: 'Renamed' }],
  ['GET', '/api/calendar/events?from=2026-10-05&to=2026-10-12&tz=Europe%2FLondon&calendarIds=a%2Cb', 'Calendars'],
  ['POST', '/api/calendar/events', 'Calendars', { calendarId: 'cal-1', title: 'x' }],
  ['PATCH', '/api/calendar/events/ev-1', 'Calendars', { title: 'y' }],
  ['DELETE', '/api/calendar/events/ev-1', 'Calendars'],
  ['POST', '/api/calendar/sync', 'Calendars'],
  ['GET', '/api/mail/summary?maxMessages=10&unreadOnly=false&accountIds=acc-1%2Cacc-2', 'Mail'],
  ['POST', '/api/mail/acc-1/messages/msg%2F1/read', 'Mail', { read: true }],
  ['POST', '/api/mail/acc-1/messages/msg-1/archive', 'Mail'],
  ['POST', '/api/mail/acc-1/messages/msg-1/trash', 'Mail'],
  ['GET', '/api/feeds?url=https%3A%2F%2Fexample.com%2Ffeed.xml', 'Feeds'],
  ['GET', '/api/diagnostics/summary', 'Diagnostics'],
  ['GET', '/api/diagnostics/logs?scope=memory&level=warn&key=account%3Aacc-1&limit=500', 'Diagnostics'],
  ['GET', '/api/diagnostics/health/calendar%3Acal%2F1/history?limit=100', 'Diagnostics'],
  ['PUT', '/api/diagnostics/level', 'Diagnostics', { verbose: true, minutes: 30, areas: null }],
  ['POST', '/api/diagnostics/jobs/calendar%3Async/run', 'Diagnostics'],
  ['GET', '/api/diagnostics/report?redact=1', 'Diagnostics'],
  ['POST', '/api/diagnostics/client-events', 'Diagnostics', { sentAt: '2026-10-11T12:00:00.000Z', events: [] }],
];

describe('unavailable routes', () => {
  it('registers exactly the server-only routes the web app knows, in order', async () => {
    const backend = await createTestBackend([unavailable]);
    expect(backend.router.list()).toEqual(UNAVAILABLE_ROUTES.map((r) => `${r.method} ${r.pattern}`));
    expect(backend.router.list()).toEqual([
      'POST /api/accounts/:kind',
      'POST /api/vault/reset',
      'GET /api/calendar/calendars',
      'PATCH /api/calendar/calendars/:id',
      'DELETE /api/calendar/calendars/:id',
      'POST /api/calendar/ics',
      'PATCH /api/calendar/ics/:id',
      'GET /api/calendar/events',
      'POST /api/calendar/events',
      'PATCH /api/calendar/events/:id',
      'DELETE /api/calendar/events/:id',
      'POST /api/calendar/sync',
      'GET /api/mail/summary',
      'POST /api/mail/:accountId/messages/:id/read',
      'POST /api/mail/:accountId/messages/:id/archive',
      'POST /api/mail/:accountId/messages/:id/trash',
      'GET /api/feeds',
      'GET /api/diagnostics/summary',
      'GET /api/diagnostics/logs',
      'GET /api/diagnostics/health/:key/history',
      'PUT /api/diagnostics/level',
      'POST /api/diagnostics/jobs/:name/run',
      'GET /api/diagnostics/report',
      'POST /api/diagnostics/client-events',
    ]);
    backend.close();
  });

  it.each(CALLS)('%s %s answers 409 not_configured naming %s', async (method, path, feature, body) => {
    const backend = await createTestBackend([unavailable]);
    const res = await backend.call(method, path, body);
    expect(res.status).toBe(409);
    expect(ERROR_STATUS.not_configured).toBe(409);
    expect(res.headers.get('content-type')).toContain('application/json');
    const parsed = ApiErrorBodySchema.parse(await res.json());
    expect(parsed).toEqual({ error: { code: 'not_configured', message: `${feature} is not available in the browser-only build.` } });
    // Never an accountId (ErrorState would fetch GET /api/accounts) and never reauth_required.
    expect(parsed.error.accountId).toBeUndefined();
    expect(parsed.error.details).toBeUndefined();
    backend.close();
  });

  it('covers every registered pattern with the calls above (no untested route)', async () => {
    const backend = await createTestBackend([unavailable]);
    const hit = new Set<string>();
    for (const [method, path] of CALLS) {
      const pathname = new URL(path, 'http://portly.static').pathname;
      const match = backend.router.match(method, pathname);
      expect(match, `${method} ${path}`).toBeDefined();
      hit.add(`${method} ${match?.pattern}`);
    }
    expect([...hit].sort()).toEqual(backend.router.list().sort());
    backend.close();
  });

  it('ignores the request body and content type (the answer is the same for any input)', async () => {
    const backend = await createTestBackend([unavailable]);
    const text = await backend.fetch('/api/accounts/yahoo', { method: 'POST', body: 'not json', headers: { 'content-type': 'text/plain' } });
    expect(text.status).toBe(409);
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.txt');
    const multipart = await backend.fetch('/api/calendar/ics', { method: 'POST', body: form });
    expect(multipart.status).toBe(409);
    const empty = await backend.fetch('/api/vault/reset', { method: 'POST' });
    expect(empty.status).toBe(409);
    backend.close();
  });

  it('treats HEAD like GET and keeps the 404 / wrong-method behaviour for everything else', async () => {
    const backend = await createTestBackend([unavailable]);
    expect((await backend.fetch('/api/calendar/calendars', { method: 'HEAD' })).status).toBe(409);

    const unknown = await backend.json<{ error: { code: string } }>('GET', '/api/accounts/acc-1/nothing');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');
    expect((await backend.json('GET', '/api/oauth/google/callback')).status).toBe(404);
    expect((await backend.json('GET', '/api/mail')).status).toBe(404);

    const wrongMethod = await backend.json<{ error: { code: string } }>('GET', '/api/vault/reset');
    expect(wrongMethod.status).toBe(400);
    expect(wrongMethod.body.error.code).toBe('bad_request');
    expect((await backend.json('DELETE', '/api/calendar/sync')).status).toBe(400);
    backend.close();
  });

  it('collapses a trailing slash (same path, so a wrong method is 400) and never matches a missing segment (404)', async () => {
    const backend = await createTestBackend([unavailable]);
    expect((await backend.json('GET', '/api/calendar/calendars/')).status).toBe(409);
    expect((await backend.json('PATCH', '/api/calendar/calendars/')).status).toBe(400);
    expect((await backend.json('POST', '/api/mail//messages/m1/read')).status).toBe(404);
    backend.close();
  });

  it('does not read or write any state', async () => {
    const backend = await createTestBackend([unavailable]);
    for (const [method, path, , body] of CALLS) await backend.call(method, path, body);
    expect(backend.ctx.state.sliceNames()).toEqual([]);
    expect(await backend.storage.listJsonKeys()).toEqual([]);
    expect(backend.objectUrls).toEqual([]);
    backend.close();
  });

  it('coexists with the core module (health stays 200, calendars stay 409)', async () => {
    const backend = await createTestBackend([core, unavailable]);
    expect((await backend.fetch('/api/health')).status).toBe(200);
    expect((await backend.fetch('/api/about')).status).toBe(200);
    expect((await backend.fetch('/api/calendar/calendars')).status).toBe(409);
    backend.close();
  });
});
