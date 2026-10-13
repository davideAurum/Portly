/**
 * Static backend: Todoist routes over api.todoist.com/api/v1 called from the browser. Port of
 * server/src/modules/todoist/todoist.test.ts (token validation, paging/cursor loop, error mapping
 * incl. invalid_filter / token_rejected details, close/reopen 204, generation-keyed projects cache,
 * cooldown) with the browser twists: no vault (never `reauth_required`), no User-Agent, the 429
 * cooldown read from the body's `error_extra.retry_after` when the header is not exposed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '@portly/shared';
import { createFakeFetch, failingFetch, hangingFetch, type FakeFetchRoute, type FakeRequest } from '../providers/__fixtures__/fakeFetch.ts';
import { API, OTHER_TOKEN, TOKEN, page, upstreamDue, upstreamProject, upstreamTask } from '../providers/__fixtures__/todoist.ts';
import { DEFAULT_RETRY_AFTER_S, MAX_RETRY_AFTER_S, REQUEST_TIMEOUT_MS, parseRetryAfter } from '../providers/todoistClient.ts';
import { SLICE, getSettings, getTodoistToken } from '../slices.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import * as todoist from './todoist.ts';
import { MAX_TASKS, PROJECTS_TTL_MS } from './todoist.ts';

type ErrorBody = { error: { code: string; message: string; details?: unknown; accountId?: unknown } };

let t: TestBackend;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  t?.close();
});

interface SetupOptions {
  token?: string | null;
}

async function setup(routes: FakeFetchRoute[] = [], options: SetupOptions = {}) {
  const fake = createFakeFetch(routes);
  vi.stubGlobal('fetch', fake.fetch);
  t = await createTestBackend([todoist]);
  if (options.token) {
    getTodoistToken(t.ctx).token = options.token;
    await t.ctx.state.commit(SLICE.todoistToken);
  }
  return fake;
}

const withToken = (routes: FakeFetchRoute[] = []) => setup(routes, { token: TOKEN });

function query(req: FakeRequest): URLSearchParams {
  return new URL(req.url).searchParams;
}

/** Status, parsed body and raw text of a route call (the server testbed's `json`). */
async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; res: Response; text: string }> {
  const res = await t.call(method, path, body);
  const text = res.status === 204 ? '' : await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, res, text };
}

describe('todoist: token', () => {
  it('reports configured without ever returning the token, validating a new one upstream first', async () => {
    const fake = await setup();
    expect((await call('GET', '/api/todoist/token')).body).toEqual({ configured: false });

    fake.add({ match: `${API}/projects`, method: 'GET', respond: { json: page([upstreamProject()]) } });
    const saved = await call('PUT', '/api/todoist/token', { token: `  ${TOKEN}\n` });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ configured: true });
    expect(saved.text).not.toContain(TOKEN);

    // Validated with a cheap upstream call, Bearer auth, before storing.
    expect(fake.calls).toHaveLength(1);
    const validate = fake.calls[0]!;
    expect(validate.method).toBe('GET');
    expect(new URL(validate.url).pathname).toBe('/api/v1/projects');
    expect(validate.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(validate.headers.get('accept')).toBe('application/json');
    expect(validate.headers.has('user-agent')).toBe(false);
    expect(query(validate).get('limit')).toBe('1');
    expect(validate.init.redirect).toBe('error');
    expect(validate.init.credentials).toBe('omit');
    expect(getTodoistToken(t.ctx)).toEqual({ token: TOKEN, generation: 1 });

    const status = await call('GET', '/api/todoist/token');
    expect(status.body).toEqual({ configured: true });
    expect(status.text).not.toContain(TOKEN);
    expect(status.res.headers.get('cache-control')).toBe('no-store');
    expect(status.res.headers.get('content-type')).toContain('application/json');
  });

  it('persists the token in its own slice (the one export never reads)', async () => {
    await setup([{ match: `${API}/projects`, respond: { json: page([]) } }]);
    await call('PUT', '/api/todoist/token', { token: TOKEN });
    expect(await t.storage.getJson(`slice:${SLICE.todoistToken}`)).toEqual({ token: TOKEN, generation: 1 });
    expect(t.ctx.state.sliceNames()).toContain(SLICE.todoistToken);
  });

  it('accepts a pasted "Bearer " prefix', async () => {
    await setup([{ match: `${API}/projects`, respond: { json: page([]) } }]);
    expect((await call('PUT', '/api/todoist/token', { token: `Bearer ${TOKEN}` })).status).toBe(200);
    expect(getTodoistToken(t.ctx).token).toBe(TOKEN);
  });

  it("rejects malformed tokens without calling Todoist, with the server's message and details", async () => {
    const fake = await setup();
    for (const token of ['short', 'has spaces in the middle of it 0123456789', 'https://todoist.com/app/settings', '"0123456789abcdef0123456789abcdef01234567"']) {
      const res = await call<ErrorBody>('PUT', '/api/todoist/token', { token });
      expect(res.status, token).toBe(422);
      expect(res.body.error).toEqual({
        code: 'validation_failed',
        message: "That doesn't look like a Todoist API token. It is a long string of letters and digits (40 characters) without spaces.",
        details: [{ path: 'token', message: 'Invalid token format', code: 'invalid_format' }],
      });
    }
    const empty = await call<ErrorBody>('PUT', '/api/todoist/token', {});
    expect(empty.status).toBe(422);
    expect(empty.body.error.message).toBe('Invalid request body');
    expect((await call('PUT', '/api/todoist/token', { token: TOKEN, extra: 1 })).status).toBe(422);
    const malformed = await t.call('PUT', '/api/todoist/token', undefined, { 'Content-Type': 'application/json' });
    expect(malformed.status).toBe(422); // an empty body is `{}` → missing token
    const notJson = await t.fetch('/api/todoist/token', { method: 'PUT', body: '{nope', headers: { 'Content-Type': 'application/json' } });
    expect(notJson.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
    expect(getTodoistToken(t.ctx).token).toBeNull();
  });

  it('answers 422 with a clear message when Todoist rejects the token, and keeps the old one', async () => {
    await withToken([{ match: `${API}/projects`, respond: { status: 401, json: { error: 'Unauthorized', http_code: 401 } } }]);
    const res = await call<ErrorBody>('PUT', '/api/todoist/token', { token: OTHER_TOKEN });
    expect(res.status).toBe(422);
    expect(res.body.error).toEqual({
      code: 'validation_failed',
      message: 'Todoist rejected this token. Copy the API token again from Todoist → Settings → Integrations → Developer.',
      details: { reason: 'token_rejected' },
    });
    expect(res.text).not.toContain(OTHER_TOKEN);
    expect(getTodoistToken(t.ctx).token).toBe(TOKEN);
  });

  it('maps upstream outages while validating', async () => {
    await setup([{ match: `${API}/projects`, respond: { status: 503, text: 'down' } }]);
    const res = await call<ErrorBody>('PUT', '/api/todoist/token', { token: TOKEN });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('provider_error');
    expect(getTodoistToken(t.ctx).token).toBeNull();
  });

  it('DELETE removes the token and bumps the generation', async () => {
    await withToken();
    expect((await call('DELETE', '/api/todoist/token')).body).toEqual({ configured: false });
    expect(getTodoistToken(t.ctx)).toEqual({ token: null, generation: 1 });
    expect((await call('GET', '/api/todoist/token')).body).toEqual({ configured: false });
    expect(await t.storage.getJson(`slice:${SLICE.todoistToken}`)).toEqual({ token: null, generation: 1 });
  });

  /** Makes this browser's storage refuse writes of the token slice (quota, blocked or evicted IndexedDB). */
  const failTokenWrites = () => {
    const setJson = t.storage.setJson.bind(t.storage);
    vi.spyOn(t.storage, 'setJson').mockImplementation(async (key, value) => {
      if (key === `slice:${SLICE.todoistToken}`) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return setJson(key, value);
    });
  };

  it('keeps the previous token when the new one cannot be stored (PUT fails instead of pretending)', async () => {
    const fake = await withToken([{ match: `${API}/projects`, respond: { json: page([upstreamProject({ id: 'p1' })]) } }]);
    failTokenWrites();
    const res = await call<ErrorBody>('PUT', '/api/todoist/token', { token: OTHER_TOKEN });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.text).not.toContain(OTHER_TOKEN);
    // Memory agrees with what a reload would load: the old token, still configured and in use.
    expect(await t.storage.getJson(`slice:${SLICE.todoistToken}`)).toEqual({ token: TOKEN, generation: 0 });
    expect(getTodoistToken(t.ctx).token).toBe(TOKEN);
    expect((await call('GET', '/api/todoist/token')).body).toEqual({ configured: true });
    await call('GET', '/api/todoist/projects');
    expect(fake.calls.at(-1)!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    // The generation never goes back, so nothing cached under the uncommitted token is reused.
    expect(getTodoistToken(t.ctx).generation).toBe(2);
  });

  it('keeps the token when removing it cannot be stored (DELETE fails instead of pretending)', async () => {
    await withToken();
    failTokenWrites();
    expect((await call('DELETE', '/api/todoist/token')).status).toBeGreaterThanOrEqual(500);
    expect(getTodoistToken(t.ctx)).toEqual({ token: TOKEN, generation: 2 });
    expect((await call('GET', '/api/todoist/token')).body).toEqual({ configured: true });
    expect(await t.storage.getJson(`slice:${SLICE.todoistToken}`)).toEqual({ token: TOKEN, generation: 0 });
  });
});

describe('todoist: tasks', () => {
  it('answers 409 not_configured without a token (no_token), without an upstream call', async () => {
    const fake = await setup();
    const res = await call<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'not_configured',
      message: 'Todoist is not connected. Add your API token in Settings → Todoist.',
      details: { reason: 'no_token' },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('follows next_cursor, maps tasks and uses the default filter from settings', async () => {
    const first = [
      upstreamTask({ id: 't1', content: 'Pay rent', priority: 4, due: upstreamDue('2026-09-24'), labels: ['home'], project_id: 'p1' }),
      upstreamTask({ id: 't2', content: 'Standup', due: upstreamDue('2026-09-25T09:30:00', { string: 'every weekday 9:30', is_recurring: true }) }),
    ];
    const second = [upstreamTask({ id: 't3', content: 'Call mum', due: null }), upstreamTask({ id: 't4', checked: true })];
    const fake = await withToken([
      { match: /\/tasks\/filter\?.*cursor=c2/, respond: { json: page(second, null) } },
      { match: `${API}/tasks/filter`, respond: { json: page(first, 'c2') } },
    ]);
    const res = await call<Task[]>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(200);
    expect(res.body.map((task) => task.id)).toEqual(['t1', 't2', 't3']);
    expect(res.body[0]).toEqual({
      id: 't1',
      content: 'Pay rent',
      description: '',
      projectId: 'p1',
      due: { date: '2026-09-24', datetime: null, string: '2026-09-24', isRecurring: false },
      priority: 4,
      labels: ['home'],
      url: 'https://app.todoist.com/app/task/t1',
    });
    expect(res.body[1]!.due).toEqual({ date: '2026-09-25', datetime: '2026-09-25T09:30:00', string: 'every weekday 9:30', isRecurring: true });

    expect(fake.calls).toHaveLength(2);
    const [a, b] = fake.calls.map(query);
    expect(a!.get('query')).toBe('today | overdue');
    expect(a!.get('limit')).toBe('200');
    expect(a!.has('cursor')).toBe(false);
    expect(b!.get('cursor')).toBe('c2');
    expect(fake.calls[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(fake.calls[0]!.headers.get('accept')).toBe('application/json');
    expect(fake.calls[0]!.headers.has('content-type')).toBe(false);
    expect(new URL(fake.calls[0]!.url).pathname).toBe('/api/v1/tasks/filter');
  });

  it('uses the filter parameter, or the configured default when it is empty', async () => {
    const fake = await withToken([{ match: `${API}/tasks/filter`, respond: { json: page([]) } }]);
    getSettings(t.ctx).todoist.defaultFilter = '#Work & p1';
    await call('GET', `/api/todoist/tasks?filter=${encodeURIComponent('7 days & @home')}`);
    await call('GET', '/api/todoist/tasks?filter=%20');
    await call('GET', '/api/todoist/tasks');
    expect(fake.calls.map((c) => query(c).get('query'))).toEqual(['7 days & @home', '#Work & p1', '#Work & p1']);
    const tooLong = await call<ErrorBody>('GET', `/api/todoist/tasks?filter=${'x'.repeat(1100)}`);
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error.message).toBe('Invalid filter');
    expect(fake.calls).toHaveLength(3);
  });

  it(`caps the list at ${MAX_TASKS} tasks`, async () => {
    const batch = (n: number) => Array.from({ length: 200 }, (_, i) => upstreamTask({ id: `b${n}i${i}` }));
    const fake = await withToken([
      { match: /cursor=p3/, respond: { json: page(batch(3), 'p4') } },
      { match: /cursor=p2/, respond: { json: page(batch(2), 'p3') } },
      { match: `${API}/tasks/filter`, respond: { json: page(batch(1), 'p2') } },
    ]);
    const res = await call<Task[]>('GET', '/api/todoist/tasks');
    expect(res.body).toHaveLength(MAX_TASKS);
    expect(fake.calls).toHaveLength(3);
  });

  it('stops when a cursor repeats', async () => {
    const fake = await withToken([{ match: `${API}/tasks/filter`, respond: { json: page([upstreamTask({ id: 'loop' })], 'same') } }]);
    const res = await call<Task[]>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(2);
  });

  it('gives up after 4 pages even when cursors keep changing', async () => {
    let n = 0;
    const fake = await withToken([{ match: `${API}/tasks/filter`, respond: () => ({ json: page([upstreamTask()], `c${++n}`) }) }]);
    const res = await call<Task[]>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    expect(fake.calls).toHaveLength(4);
  });

  it('rejects an unexpected page shape as provider_error', async () => {
    await withToken([{ match: `${API}/tasks/filter`, respond: { json: [upstreamTask()] } }]);
    const res = await call<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(502);
    expect(res.body.error).toEqual({ code: 'provider_error', message: 'Todoist returned an unexpected response.' });
  });
});

describe('todoist: upstream error mapping', () => {
  it.each([401, 403])('%i → 409 not_configured with token_rejected details', async (status) => {
    await withToken([{ match: `${API}/tasks/filter`, respond: { status, json: { error: 'Forbidden' } } }]);
    const res = await call<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'not_configured',
      message: 'Todoist rejected the saved API token. Paste a new one in Settings → Todoist.',
      details: { reason: 'token_rejected' },
    });
    expect(res.text).not.toContain(TOKEN);
  });

  it('429 → rate_limited with Retry-After from the body (the header is not readable cross-origin), then a local cooldown', async () => {
    const fake = await withToken([
      { match: `${API}/tasks/filter`, respond: { status: 429, json: { error: 'Too many requests', error_extra: { retry_after: 17 } } } },
    ]);
    const res = await call<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(429);
    expect(res.body.error).toEqual({ code: 'rate_limited', message: 'Todoist is rate limiting requests. Try again in 17 s.', details: { retryAfterSeconds: 17 } });
    expect(res.res.headers.get('retry-after')).toBe('17');
    expect(res.res.headers.get('content-type')).toContain('application/json');
    expect(todoist.todoistState(t.ctx).client.cooldownUntil()).toBe(t.ctx.now() + 17_000);

    const again = await call<ErrorBody>('POST', '/api/todoist/tasks/abc/close');
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('rate_limited');
    expect(Number(again.res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(fake.calls).toHaveLength(1);

    // The cooldown is over: requests go upstream again.
    t.tick(17_001);
    fake.add({ match: `${API}/tasks/abc/close`, respond: { json: {} } });
    expect((await t.call('POST', '/api/todoist/tasks/abc/close')).status).toBe(204);
    expect(fake.calls).toHaveLength(2);
  });

  it('429 with a readable Retry-After header prefers the header', async () => {
    await withToken([{ match: `${API}/tasks/filter`, respond: { status: 429, headers: { 'Retry-After': '42' }, json: { error: 'Too many', error_extra: { retry_after: 7 } } } }]);
    const res = await call<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.res.headers.get('retry-after')).toBe('42');
    expect(res.body.error.details).toEqual({ retryAfterSeconds: 42 });
  });

  it('429 without any hint falls back to 60 s; values are clamped to 1..900 s', async () => {
    await withToken([
      { match: /query=none/, respond: { status: 429, text: '' } },
      { match: /query=huge/, respond: { status: 429, json: { error_extra: { retry_after: 5000 } } } },
      { match: /query=zero/, respond: { status: 429, json: { error_extra: { retry_after: 0 } } } },
    ]);
    const { client } = todoist.todoistState(t.ctx);
    expect((await call<ErrorBody>('GET', '/api/todoist/tasks?filter=none')).body.error.details).toEqual({ retryAfterSeconds: DEFAULT_RETRY_AFTER_S });
    client.resetCooldown();
    expect((await call<ErrorBody>('GET', '/api/todoist/tasks?filter=huge')).body.error.details).toEqual({ retryAfterSeconds: MAX_RETRY_AFTER_S });
    client.resetCooldown();
    expect((await call<ErrorBody>('GET', '/api/todoist/tasks?filter=zero')).body.error.details).toEqual({ retryAfterSeconds: 1 });
  });

  it('parseRetryAfter reads delta-seconds, HTTP-dates and error_extra.retry_after', () => {
    const now = Date.UTC(2026, 8, 26, 12, 0, 0);
    expect(parseRetryAfter('30', null, now)).toBe(30);
    expect(parseRetryAfter(new Date(now + 90_000).toUTCString(), null, now)).toBe(90);
    expect(parseRetryAfter(null, { error_extra: { retry_after: 2.2 } }, now)).toBe(3);
    expect(parseRetryAfter(null, { error_extra: { retry_after: 'soon' } }, now)).toBe(DEFAULT_RETRY_AFTER_S);
    expect(parseRetryAfter('garbage', null, now)).toBe(DEFAULT_RETRY_AFTER_S);
    // A date in the past (Date.parse reads "-5" as a year) clamps to the 1 s floor, like the server.
    expect(parseRetryAfter('-5', null, now)).toBe(1);
    expect(parseRetryAfter(new Date(now - 60_000).toUTCString(), null, now)).toBe(1);
    expect(parseRetryAfter('99999', null, now)).toBe(MAX_RETRY_AFTER_S);
  });

  it('a new token clears the cooldown', async () => {
    await withToken([
      { match: `${API}/tasks/filter`, times: 1, respond: { status: 429, json: { error_extra: { retry_after: 600 } } } },
      { match: `${API}/projects`, respond: { json: page([]) } },
      { match: `${API}/tasks/filter`, respond: { json: page([]) } },
    ]);
    expect((await call('GET', '/api/todoist/tasks')).status).toBe(429);
    expect((await call('PUT', '/api/todoist/token', { token: OTHER_TOKEN })).status).toBe(200);
    expect(todoist.todoistState(t.ctx).client.cooldownUntil()).toBe(0);
    expect((await call('GET', '/api/todoist/tasks')).status).toBe(200);
  });

  it('removing the token also clears the cooldown', async () => {
    await withToken([{ match: `${API}/tasks/filter`, respond: { status: 429, json: { error_extra: { retry_after: 600 } } } }]);
    expect((await call('GET', '/api/todoist/tasks')).status).toBe(429);
    await call('DELETE', '/api/todoist/token');
    expect(todoist.todoistState(t.ctx).client.cooldownUntil()).toBe(0);
  });

  it('maps non-JSON error pages by their status (plain-text 401, HTML 403, CDN 429 page)', async () => {
    await withToken([
      { match: `${API}/tasks/filter`, times: 1, respond: { status: 401, text: 'Unauthorized' } },
      { match: `${API}/tasks/filter`, times: 1, respond: { status: 403, headers: { 'content-type': 'text/html' }, text: '<html>Forbidden</html>' } },
      { match: `${API}/tasks/filter`, respond: { status: 429, headers: { 'content-type': 'text/html' }, text: '<html>Error 1015: rate limited</html>' } },
    ]);
    let res = await call<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ reason: 'token_rejected' });
    res = await call<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_configured');
    res = await call<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(res.res.headers.get('retry-after')).toBe(String(DEFAULT_RETRY_AFTER_S));
    expect(res.text).not.toContain('1015');
  });

  it('a plain-text 401 while validating a new token is still a clear 422', async () => {
    await setup([{ match: `${API}/projects`, respond: { status: 401, text: 'Unauthorized' } }]);
    const res = await call<ErrorBody>('PUT', '/api/todoist/token', { token: TOKEN });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Todoist rejected this token/);
    expect(getTodoistToken(t.ctx).token).toBeNull();
  });

  it('a 2xx answer that is not JSON is a provider_error (and asks for JSON)', async () => {
    const fake = await withToken([{ match: `${API}/tasks/filter`, respond: { status: 200, text: '<html>captive portal</html>' } }]);
    const res = await call<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(502);
    expect(res.body.error).toEqual({ code: 'provider_error', message: 'Todoist returned an unexpected response.' });
    expect(res.text).not.toContain('captive');
    expect(fake.calls[0]!.headers.get('accept')).toBe('application/json');
  });

  it.each([500, 502, 503])('%i → 502 provider_error', async (status) => {
    await withToken([{ match: `${API}/tasks/filter`, respond: { status, text: '<html>oops</html>' } }]);
    const res = await call<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(502);
    expect(res.body.error).toEqual({ code: 'provider_error', message: `Todoist is having problems (HTTP ${status}). Try again shortly.` });
    expect(res.text).not.toContain('oops');
  });

  it('an unexpected status (e.g. 418) → 502 provider_error naming the status', async () => {
    await withToken([{ match: `${API}/tasks/filter`, respond: { status: 418, text: 'teapot' } }]);
    const res = await call<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(502);
    expect(res.body.error.message).toBe('Todoist returned an unexpected response (HTTP 418).');
  });

  it('400 on a filter → 422 validation_failed with invalid_filter details (upstream text not reflected)', async () => {
    await withToken([{ match: `${API}/tasks/filter`, respond: { status: 400, json: { error: 'SECRET-UPSTREAM-TEXT' } } }]);
    const res = await call<ErrorBody>('GET', '/api/todoist/tasks?filter=%28%28');
    expect(res.status).toBe(422);
    expect(res.body.error).toEqual({ code: 'validation_failed', message: 'Todoist could not understand this filter. Check its syntax.', details: { reason: 'invalid_filter' } });
    expect(res.text).not.toContain('SECRET-UPSTREAM-TEXT');
  });

  it('400 on quick add / a task action → 422 with purpose-specific messages', async () => {
    await withToken([
      { match: `${API}/tasks/quick`, respond: { status: 400, json: { error: 'bad' } } },
      { match: `${API}/tasks/abc/close`, respond: { status: 400, json: { error: 'bad' } } },
    ]);
    const quick = await call<ErrorBody>('POST', '/api/todoist/tasks', { text: 'x' });
    expect(quick.status).toBe(422);
    expect(quick.body.error).toEqual({ code: 'validation_failed', message: 'Todoist could not add this task.' });
    const close = await call<ErrorBody>('POST', '/api/todoist/tasks/abc/close');
    expect(close.status).toBe(422);
    expect(close.body.error).toEqual({ code: 'validation_failed', message: 'Todoist rejected the request.' });
  });

  it('a transport timeout (10 s) → 504 upstream_timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch);
    t = await createTestBackend([todoist]);
    getTodoistToken(t.ctx).token = TOKEN;
    const pending = call<ErrorBody>('GET', '/api/todoist/tasks');
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    const res = await pending;
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('upstream_timeout');
  });

  it('a network/CORS failure → 502 provider_error (never a thrown TypeError)', async () => {
    vi.stubGlobal('fetch', failingFetch);
    t = await createTestBackend([todoist]);
    getTodoistToken(t.ctx).token = TOKEN;
    const res = await call<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('provider_error');
  });

  it("rethrows the API client's own abort", async () => {
    vi.stubGlobal('fetch', hangingFetch);
    t = await createTestBackend([todoist]);
    getTodoistToken(t.ctx).token = TOKEN;
    const controller = new AbortController();
    const pending = t.fetch('/api/todoist/tasks', { method: 'GET', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('never emits reauth_required or an accountId, and never echoes the token', async () => {
    await withToken([
      { match: `${API}/tasks/filter`, times: 1, respond: { status: 401, text: 'Unauthorized' } },
      { match: `${API}/tasks/filter`, times: 1, respond: { status: 429, text: '' } },
      { match: `${API}/tasks/filter`, respond: { status: 500, text: '' } },
    ]);
    for (let i = 0; i < 3; i++) {
      todoist.todoistState(t.ctx).client.resetCooldown();
      const res = await call<ErrorBody>('GET', '/api/todoist/tasks');
      expect(res.body.error.code).not.toBe('reauth_required');
      expect('accountId' in res.body.error).toBe(false);
      expect(res.text).not.toContain(TOKEN);
    }
  });
});

describe('todoist: quick add, close, reopen', () => {
  it('quick add posts {text} and returns the mapped task with 201', async () => {
    const fake = await withToken([
      {
        match: `${API}/tasks/quick`,
        method: 'POST',
        respond: { json: upstreamTask({ id: 'new1', content: 'Buy milk', due: upstreamDue('2026-09-26', { string: 'tomorrow' }), labels: ['shop'] }) },
      },
    ]);
    const res = await call<Task>('POST', '/api/todoist/tasks', { text: '  Buy milk tomorrow @shop  ' });
    expect(res.status).toBe(201);
    expect(res.res.headers.get('content-type')).toContain('application/json');
    expect(res.body).toMatchObject({ id: 'new1', content: 'Buy milk', labels: ['shop'], due: { date: '2026-09-26', string: 'tomorrow' } });
    expect(JSON.parse(fake.calls[0]!.body!)).toEqual({ text: 'Buy milk tomorrow @shop' });
    expect(fake.calls[0]!.headers.get('content-type')).toBe('application/json');
    expect(fake.calls[0]!.method).toBe('POST');
  });

  it('quick add validates the text', async () => {
    const fake = await withToken();
    expect((await call('POST', '/api/todoist/tasks', { text: '   ' })).status).toBe(422);
    expect((await call('POST', '/api/todoist/tasks', { text: 'x'.repeat(1001) })).status).toBe(422);
    expect((await call('POST', '/api/todoist/tasks', { text: 'ok', extra: true })).status).toBe(422);
    expect(fake.calls).toHaveLength(0);
  });

  it('quick add returns JSON null when the answer cannot be mapped (the task was still created)', async () => {
    await withToken([{ match: `${API}/tasks/quick`, respond: { json: { weird: true } } }]);
    const res = await call('POST', '/api/todoist/tasks', { text: 'Something' });
    expect(res.status).toBe(201);
    expect(res.text).toBe('null');
    expect(res.body).toBeNull();
    expect(res.res.headers.get('content-type')).toContain('application/json');
  });

  it('quick add without a token is 409 not_configured before any upstream call', async () => {
    const fake = await setup();
    const res = await call<ErrorBody>('POST', '/api/todoist/tasks', { text: 'Something' });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ reason: 'no_token' });
    expect(fake.calls).toHaveLength(0);
  });

  it('close and reopen call the v1 endpoints and answer 204 (Todoist v1 answers 200 {})', async () => {
    const fake = await withToken([
      { match: `${API}/tasks/abc123/close`, method: 'POST', respond: { status: 200, json: {} } },
      { match: `${API}/tasks/abc123/reopen`, method: 'POST', respond: { status: 204 } },
    ]);
    const closed = await t.call('POST', '/api/todoist/tasks/abc123/close');
    expect(closed.status).toBe(204);
    expect(await closed.text()).toBe('');
    expect((await t.call('POST', '/api/todoist/tasks/abc123/reopen')).status).toBe(204);
    expect(fake.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['POST /api/v1/tasks/abc123/close', 'POST /api/v1/tasks/abc123/reopen']);
    expect(fake.calls[0]!.body).toBeNull();
    expect(fake.calls[0]!.headers.has('content-type')).toBe(false);
  });

  it('rejects odd task ids without calling Todoist and maps upstream 404', async () => {
    const fake = await withToken([{ match: `${API}/tasks/gone/close`, respond: { status: 404, json: { error: 'Task not found' } } }]);
    const odd = await call<ErrorBody>('POST', `/api/todoist/tasks/${encodeURIComponent('a b')}/close`);
    expect(odd.status).toBe(404);
    expect(odd.body.error).toEqual({ code: 'not_found', message: 'Task not found' });
    expect((await t.call('POST', `/api/todoist/tasks/${'x'.repeat(65)}/reopen`)).status).toBe(404);
    expect((await t.call('POST', `/api/todoist/tasks/${encodeURIComponent('../x')}/close`)).status).toBe(404);
    expect(fake.calls).toHaveLength(0);
    const res = await call<ErrorBody>('POST', '/api/todoist/tasks/gone/close');
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'not_found', message: 'This task no longer exists in Todoist.' });
  });
});

describe('todoist: PATCH', () => {
  it('maps allowlisted fields onto an upstream POST /tasks/{id}', async () => {
    const fake = await withToken([
      {
        match: `${API}/tasks/abc`,
        method: 'POST',
        respond: { json: upstreamTask({ id: 'abc', content: 'Renamed', priority: 3, labels: ['a', 'b'], description: 'Notes' }) },
      },
    ]);
    const res = await call<Task>('PATCH', '/api/todoist/tasks/abc', {
      content: 'Renamed',
      description: 'Notes',
      priority: 3,
      dueString: null,
      labels: ['a', 'b', 'a'],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'abc', content: 'Renamed', priority: 3, labels: ['a', 'b'], due: null });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.method).toBe('POST');
    expect(new URL(fake.calls[0]!.url).pathname).toBe('/api/v1/tasks/abc');
    expect(JSON.parse(fake.calls[0]!.body!)).toEqual({ content: 'Renamed', description: 'Notes', priority: 3, due_string: 'no date', labels: ['a', 'b'] });
  });

  it('passes a natural-language due string through and clears with an empty one', async () => {
    const fake = await withToken([{ match: `${API}/tasks/abc`, respond: { json: upstreamTask({ id: 'abc' }) } }]);
    await call('PATCH', '/api/todoist/tasks/abc', { dueString: 'next monday 9am' });
    expect(JSON.parse(fake.calls[0]!.body!)).toEqual({ due_string: 'next monday 9am' });
    await call('PATCH', '/api/todoist/tasks/abc', { dueString: '' });
    expect(JSON.parse(fake.calls[1]!.body!)).toEqual({ due_string: 'no date' });
  });

  it('refuses fields outside the allowlist and empty updates, without calling Todoist', async () => {
    const fake = await withToken();
    for (const body of [{ projectId: 'p2' }, { project_id: 'p2' }, { content: 'x', checked: true }, { due_date: '2026-10-01' }, { priority: 5 }, { labels: 'a' }]) {
      const res = await call<ErrorBody>('PATCH', '/api/todoist/tasks/abc', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.message).toBe('Invalid request body');
    }
    const empty = await call<ErrorBody>('PATCH', '/api/todoist/tasks/abc', {});
    expect(empty.status).toBe(422);
    expect(empty.body.error).toEqual({ code: 'validation_failed', message: 'Nothing to update' });
    expect((await t.call('PATCH', `/api/todoist/tasks/${encodeURIComponent('a b')}`, { content: 'x' })).status).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });

  it('answers 502 when Todoist returns something that is not a task', async () => {
    await withToken([{ match: `${API}/tasks/abc`, respond: { json: { ok: true } } }]);
    const res = await call<ErrorBody>('PATCH', '/api/todoist/tasks/abc', { content: 'x' });
    expect(res.status).toBe(502);
    expect(res.body.error).toEqual({ code: 'provider_error', message: 'Todoist returned an unexpected response.' });
  });
});

describe('todoist: projects', () => {
  it('pages projects, maps colors and caches them for 5 minutes', async () => {
    const fake = await withToken([
      { match: /\/projects\?.*cursor=n2/, respond: { json: page([upstreamProject({ id: 'p2', name: 'Work', color: 'sky_blue' })]) } },
      { match: `${API}/projects`, respond: { json: page([upstreamProject({ id: 'p1', name: 'Inbox', color: 'grey' })], 'n2') } },
    ]);
    const first = await call<Project[]>('GET', '/api/todoist/projects');
    expect(first.body).toEqual([
      { id: 'p1', name: 'Inbox', color: '#b8b8b8' },
      { id: 'p2', name: 'Work', color: '#14aaf5' },
    ]);
    expect(query(fake.calls[0]!).get('limit')).toBe('200');
    expect(new URL(fake.calls[0]!.url).pathname).toBe('/api/v1/projects');
    const second = await call<Project[]>('GET', '/api/todoist/projects');
    expect(second.body).toEqual(first.body);
    expect(fake.calls).toHaveLength(2);
    expect(todoist.todoistState(t.ctx).cache.get('todoist:projects:0')).toEqual(first.body);
    t.tick(PROJECTS_TTL_MS + 1);
    await call('GET', '/api/todoist/projects');
    expect(fake.calls).toHaveLength(4);
  });

  it('forgets cached projects when the token changes', async () => {
    const fake = await withToken([{ match: `${API}/projects`, respond: { json: page([upstreamProject({ id: 'p1' })]) } }]);
    await call('GET', '/api/todoist/projects');
    await call('PUT', '/api/todoist/token', { token: OTHER_TOKEN });
    await call('GET', '/api/todoist/projects');
    // list, validate, list again
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]!.headers.get('authorization')).toBe(`Bearer ${OTHER_TOKEN}`);
    expect(todoist.todoistState(t.ctx).cache.get('todoist:projects:0')).toBeUndefined();
    expect(todoist.todoistState(t.ctx).cache.get('todoist:projects:1')).toHaveLength(1);
  });

  it('a project list requested before a token change is never served for the new token', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await withToken([
      {
        match: `${API}/projects`,
        respond: async (req) => {
          if (req.headers.get('authorization') === `Bearer ${TOKEN}`) {
            await gate;
            return { json: page([upstreamProject({ id: 'old', name: 'Old account' })]) };
          }
          return { json: page([upstreamProject({ id: 'new', name: 'New account' })]) };
        },
      },
    ]);
    // A slow list with the old token is still in flight when the token is replaced.
    const slow = call<Project[]>('GET', '/api/todoist/projects');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await call('PUT', '/api/todoist/token', { token: OTHER_TOKEN })).status).toBe(200);
    const fresh = call<Project[]>('GET', '/api/todoist/projects');
    release();
    expect((await slow).body.map((p) => p.id)).toEqual(['old']);
    expect((await fresh).body.map((p) => p.id)).toEqual(['new']);
    // …and the old answer did not end up in the cache either.
    expect((await call<Project[]>('GET', '/api/todoist/projects')).body.map((p) => p.id)).toEqual(['new']);
  });

  /** A project list answered only when released and, like fetch, honouring its signal meanwhile. */
  const gatedProjects = async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = await withToken([
      {
        match: `${API}/projects`,
        respond: (req) =>
          new Promise((resolve, reject) => {
            const signal = req.init.signal;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            void gate.then(() => resolve({ json: page([upstreamProject({ id: 'p1' })]) }));
          }),
      },
    ]);
    return { fake, release };
  };

  it("one caller's abort never fails the others sharing the project list (server parity)", async () => {
    const { fake, release } = await gatedProjects();
    const first = new AbortController();
    const abandoned = t.fetch('/api/todoist/projects', { method: 'GET', signal: first.signal });
    const waiting = t.fetch('/api/todoist/projects', { method: 'GET', signal: new AbortController().signal });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    first.abort();
    release();
    const res = await waiting;
    expect(res.status).toBe(200);
    expect(((await res.json()) as Project[]).map((p) => p.id)).toEqual(['p1']);
    expect((await abandoned).status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(todoist.todoistState(t.ctx).cache.get('todoist:projects:0')).toHaveLength(1);
  });

  it('a project list requested right after an aborted one gets the list', async () => {
    const { fake, release } = await gatedProjects();
    const cancelled = new AbortController();
    const abandoned = t.fetch('/api/todoist/projects', { method: 'GET', signal: cancelled.signal });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    cancelled.abort();
    const retry = t.fetch('/api/todoist/projects', { method: 'GET', signal: new AbortController().signal });
    release();
    expect((await retry).status).toBe(200);
    expect((await abandoned).status).toBe(200);
    expect(fake.calls).toHaveLength(1);
  });

  it('answers not_configured without a token and maps an upstream 404', async () => {
    await setup();
    expect((await call<ErrorBody>('GET', '/api/todoist/projects')).body.error.code).toBe('not_configured');
    t.close();
    await withToken([{ match: `${API}/projects`, respond: { status: 404, text: '' } }]);
    const res = await call<ErrorBody>('GET', '/api/todoist/projects');
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'not_found', message: 'Not found in Todoist.' });
  });
});
