import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { setLoginReloadForTests } from './client.ts';
import { getClientEvents } from '../diagnostics/clientLog.ts';
import { qk, ACCOUNT_DEPENDENT_KEYS } from './keys.ts';
import { ServerModeEndedError } from '../localServer/controller.ts';
import {
  ApiError,
  CLIENT_EVENT_REPEAT_WINDOW_MS,
  SLOW_REQUEST_MS,
  api,
  apiDelete,
  apiGet,
  apiPatch,
  apiPath,
  apiPost,
  apiResponse,
  apiRouteOf,
  isApiError,
} from './client.ts';

type FetchArgs = [RequestInfo | URL, RequestInit | undefined];

function stubFetch(response: Response | (() => Promise<Response>)) {
  const mock = vi.fn(async (..._args: FetchArgs) => (typeof response === 'function' ? response() : response.clone()));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends X-Portly and Accept on every request and parses JSON', async () => {
    const fetchMock = stubFetch(new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }));
    expect(await apiGet('/api/health')).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/health');
    const headers = new Headers(init?.headers);
    expect(headers.get('X-Portly')).toBe('1');
    expect(headers.get('Accept')).toBe('application/json');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('same-origin');
  });

  it('JSON-encodes bodies with a JSON content type', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    expect(await apiPatch('/api/settings', { general: { userName: 'A' } })).toBeUndefined();
    const [, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe('{"general":{"userName":"A"}}');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  });

  it('sends FormData as-is (multipart boundary set by the browser)', async () => {
    const fetchMock = stubFetch(new Response('{"id":"x","url":"/api/uploads/x"}', { headers: { 'Content-Type': 'application/json' } }));
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.png');
    await apiPost('/api/uploads', form);
    const [, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(init?.body).toBe(form);
    expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
  });

  it('throws ApiError with the server error body', async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { code: 'reauth_required', message: 'Reconnect', accountId: 'a1', details: { x: 1 } } }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const err = await apiGet('/api/mail/summary').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'reauth_required', message: 'Reconnect', accountId: 'a1', details: { x: 1 } });
    expect(isApiError(err, 'reauth_required')).toBe(true);
    expect(isApiError(err, 'not_found')).toBe(false);
  });

  it('maps non-JSON errors by status and network failures to network_error', async () => {
    stubFetch(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(apiGet('/api/x')).rejects.toMatchObject({ status: 502, code: 'provider_error' });
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(apiDelete('/api/x')).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('a request a switching page can no longer serve is a network_error (hybrid mode)', async () => {
    stubFetch(async () => {
      throw new ServerModeEndedError();
    });
    await expect(apiGet('/api/settings')).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('propagates aborts unchanged', async () => {
    stubFetch(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(api('/api/x')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('apiPath encodes interpolated ids', () => {
    expect(apiPath`/api/profiles/${'a/b?c'}/widgets/${'w 1'}`).toBe('/api/profiles/a%2Fb%3Fc/widgets/w%201');
  });
});

describe('request ids', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ApiError carries the X-Request-Id the server answered with (only a well-formed one)', async () => {
    const body = JSON.stringify({ error: { code: 'not_found', message: 'Gone' } });
    stubFetch(new Response(body, { status: 404, headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'abc123def4' } }));
    await expect(apiGet('/api/x')).rejects.toMatchObject({ status: 404, code: 'not_found', requestId: 'abc123def4' });
    stubFetch(new Response('<html>', { status: 502, headers: { 'X-Request-Id': 'abc123def4' } }));
    await expect(apiGet('/api/x')).rejects.toMatchObject({ status: 502, code: 'provider_error', requestId: 'abc123def4' });
    stubFetch(new Response(body, { status: 404, headers: { 'Content-Type': 'application/json', 'X-Request-Id': '<script>' } }));
    const err = await apiGet('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).requestId).toBeUndefined();
  });

  it('apiResponse sends the same request and returns a 2xx response unread', async () => {
    const fetchMock = stubFetch(new Response('{"a":1}', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment' } }));
    const res = await apiResponse('/api/report?x=1', { headers: { Accept: 'application/octet-stream' } });
    expect(res.bodyUsed).toBe(false);
    expect(res.headers.get('Content-Disposition')).toBe('attachment');
    const [url, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/report?x=1');
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(new Headers(init?.headers).get('X-Portly')).toBe('1');
    expect(new Headers(init?.headers).get('Accept')).toBe('application/octet-stream');
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(apiResponse('/api/report')).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });
});

describe('diagnostic events of API requests', () => {
  const events = () => getClientEvents().map((entry) => entry.event);
  const jsonError = (status: number, code: string, message = code, rid?: string) =>
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { 'Content-Type': 'application/json', ...(rid === undefined ? {} : { 'X-Request-Id': rid }) },
    });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('no answer → warn with the error, no rid, the path without its query', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await apiGet('/api/feeds/items?url=https%3A%2F%2Fsecret.example%2Ffeed').catch(() => undefined);
    expect(events()).toEqual([
      expect.objectContaining({
        level: 'warn',
        cat: 'api',
        msg: 'API request got no answer',
        fields: {
          method: 'GET',
          route: '/api/feeds/items',
          path: '/api/feeds/items',
          ms: expect.any(Number),
          transport: 'server',
          status: 0,
          code: 'network_error',
          errName: 'TypeError',
          errMessage: 'Failed to fetch',
        },
      }),
    ]);
    expect(JSON.stringify(events())).not.toContain('secret');
  });

  it('5xx → warn with the rid and the message; 4xx → info with the rid, without the message', async () => {
    stubFetch(jsonError(502, 'provider_error', 'Google is down', 'aaaaaaaaa1'));
    await apiGet('/api/calendar/events').catch(() => undefined);
    stubFetch(jsonError(409, 'reauth_required', 'Reconnect a@example.com', 'bbbbbbbbb2'));
    await apiPost('/api/accounts/acc-1/test').catch(() => undefined);
    const [failed, refused] = events();
    expect(failed).toMatchObject({ level: 'warn', msg: 'API request failed', fields: { status: 502, code: 'provider_error', rid: 'aaaaaaaaa1', errMessage: 'Google is down' } });
    expect(refused).toMatchObject({ level: 'info', msg: 'API request refused', fields: { method: 'POST', route: '/api/accounts/:id/test', status: 409, code: 'reauth_required', rid: 'bbbbbbbbb2' } });
    expect(refused?.fields).not.toHaveProperty('errMessage');
  });

  it('collapses the same refusal within a minute into one event, then one with `repeats`', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonError(401, 'pairing_required')),
    );
    for (let i = 0; i < 4; i++) await apiGet(`/api/settings?i=${i}`).catch(() => undefined);
    expect(events()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CLIENT_EVENT_REPEAT_WINDOW_MS);
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({ level: 'info', msg: 'API request refused', fields: { status: 401, code: 'pairing_required', repeats: 3 } });
    // A new window: recorded at once again.
    await apiGet('/api/settings').catch(() => undefined);
    expect(events()).toHaveLength(3);
    // Another status is another event.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonError(404, 'not_found')),
    );
    await apiGet('/api/settings').catch(() => undefined);
    expect(events()).toHaveLength(4);
  });

  it('a slow answer (> 5 s) → info', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const answer = () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'ccccccccc3' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(answer()), SLOW_REQUEST_MS + 1_000);
          }),
      ),
    );
    const pending = apiGet('/api/mail/summary');
    await vi.advanceTimersByTimeAsync(SLOW_REQUEST_MS + 1_000);
    await pending;
    expect(events()).toEqual([
      expect.objectContaining({ level: 'info', msg: 'API request slow', fields: expect.objectContaining({ status: 200, rid: 'ccccccccc3', ms: SLOW_REQUEST_MS + 1_000 }) }),
    ]);
  });

  it('records nothing for the diagnostics routes, a cancelled request, a page switching backend or a quick success', async () => {
    stubFetch(jsonError(403, 'local_only'));
    await apiGet('/api/diagnostics/summary').catch(() => undefined);
    await apiPost('/api/diagnostics/client-events', {}).catch(() => undefined);
    stubFetch(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    await apiGet('/api/x').catch(() => undefined);
    const abort = new AbortController();
    abort.abort();
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await apiGet('/api/x', { signal: abort.signal }).catch(() => undefined);
    // Hybrid mode: the page is switching to the browser (its `hybrid` events say so).
    stubFetch(async () => {
      throw new ServerModeEndedError();
    });
    await expect(apiGet('/api/x')).rejects.toMatchObject({ status: 0, code: 'network_error' });
    stubFetch(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
    await apiGet('/api/x');
    expect(events()).toEqual([]);
  });

  it('names the transport of a Pages page load', async () => {
    for (const [backend, transport] of [
      ['browser', 'pages-browser'],
      ['server', 'pages-server'],
    ] as const) {
      setCapabilitiesForTests(capabilitiesFor(true, backend));
      stubFetch(jsonError(500, 'internal'));
      await apiGet(`/api/${backend}`).catch(() => undefined);
      expect(events().at(-1)?.fields.transport).toBe(transport);
    }
  });

  it('groups repeats by a route with ids masked', () => {
    expect(apiRouteOf('/api/bookmarks/3f2a9c1e-77aa/move?x=1')).toBe('/api/bookmarks/:id/move');
    expect(apiRouteOf('/api/calendar/calendars/me%40example.com/events')).toBe('/api/calendar/calendars/:id/events');
    expect(apiRouteOf('/api/oauth-clients/microsoft')).toBe('/api/oauth-clients/microsoft');
    expect(apiRouteOf('/api/settings#x')).toBe('/api/settings');
  });
});

describe('query keys', () => {
  it('nests calendar/mail keys under their account-dependent prefixes', () => {
    expect(qk.calendar.events('2026-09-01', '2026-10-01', 'UTC').slice(0, 1)).toEqual(qk.calendar.all());
    expect(qk.mail.summary().slice(0, 1)).toEqual(qk.mail.all());
    expect(ACCOUNT_DEPENDENT_KEYS).toEqual([['accounts'], ['calendar'], ['mail']]);
    expect(qk.weather(52.51704, 13.38886)).toEqual(['weather', 'report', 52.52, 13.39]);
    expect(qk.geocode('Berlin').slice(0, 1)).toEqual(['weather']);
    expect(qk.todoist.tasks('today').slice(0, 1)).toEqual(qk.todoist.all());
    expect(qk.search.suggest('google', 'x')).toEqual(['search', 'suggest', 'google', 'x']);
  });
});

describe('login_required on another PC’s page load', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setLoginReloadForTests(null);
  });

  it('reloads once into the connect screen, and only on another PC', async () => {
    const reload = vi.fn();
    setLoginReloadForTests(reload);
    const refused = () => new Response('{"error":{"code":"login_required","message":"not connected"}}', { status: 401, headers: { 'Content-Type': 'application/json' } });
    setCapabilitiesForTests(capabilitiesFor(false, 'server'));
    stubFetch(refused());
    await expect(apiGet('/api/settings')).rejects.toMatchObject({ code: 'login_required' });
    expect(reload).not.toHaveBeenCalled();

    setCapabilitiesForTests(capabilitiesFor(false, 'server', true));
    stubFetch(refused());
    await expect(apiGet('/api/settings')).rejects.toMatchObject({ code: 'login_required', status: 401 });
    expect(reload).toHaveBeenCalledTimes(1);
    stubFetch(refused());
    await expect(apiGet('/api/profiles')).rejects.toMatchObject({ code: 'login_required' });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
