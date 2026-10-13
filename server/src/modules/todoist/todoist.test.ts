import { afterEach, describe, expect, it } from 'vitest';
import type { Project, Task } from '@portly/shared';
import { createTestLogger } from '../../lib/logger.ts';
import { createSafeFetch, SafeFetchError, type SafeFetch } from '../../security/safe-fetch.ts';
import type { FakeRequest } from '../../testing/fake-fetch.ts';
import { API, OTHER_TOKEN, TOKEN, page, todoistTestbed, upstreamDue, upstreamProject, upstreamTask, type TodoistTestbed } from './__fixtures__/todoist.ts';
import { MAX_TASKS, TOKEN_SECRET_ID } from './index.ts';

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

let t: TodoistTestbed;
afterEach(() => t?.close());

function withToken(extra: Parameters<typeof todoistTestbed>[0] = {}): TodoistTestbed {
  return todoistTestbed({ secrets: { [TOKEN_SECRET_ID]: TOKEN }, ...extra });
}

function calls(): FakeRequest[] {
  return t.ctx.fakeFetch?.calls ?? [];
}

function query(req: FakeRequest): URLSearchParams {
  return new URL(req.url).searchParams;
}

describe('todoist: token', () => {
  it('reports configured without ever returning the token', async () => {
    t = todoistTestbed();
    expect((await t.json('GET', '/api/todoist/token')).body).toEqual({ configured: false });

    t.ctx.fakeFetch!.add({ match: `${API}/projects`, method: 'GET', respond: { json: page([upstreamProject()]) } });
    const saved = await t.json('PUT', '/api/todoist/token', { body: { token: `  ${TOKEN}\n` } });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ configured: true });
    expect(saved.text).not.toContain(TOKEN);

    // Validated with a cheap upstream call, Bearer auth, before storing.
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(query(calls()[0]!).get('limit')).toBe('1');
    expect(t.ctx.vault.get(TOKEN_SECRET_ID)).toBe(TOKEN);

    const status = await t.json('GET', '/api/todoist/token');
    expect(status.body).toEqual({ configured: true });
    expect(status.text).not.toContain(TOKEN);
    expect(status.res.headers.get('cache-control')).toBe('no-store');
  });

  it('accepts a pasted "Bearer " prefix', async () => {
    t = todoistTestbed({ fetchRoutes: [{ match: `${API}/projects`, respond: { json: page([]) } }] });
    expect((await t.json('PUT', '/api/todoist/token', { body: { token: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect(t.ctx.vault.get(TOKEN_SECRET_ID)).toBe(TOKEN);
  });

  it('rejects malformed tokens without calling Todoist', async () => {
    t = todoistTestbed();
    for (const token of ['short', 'has spaces in the middle of it 0123456789', 'https://todoist.com/app/settings', '"0123456789abcdef0123456789abcdef01234567"']) {
      const res = await t.json<ErrorBody>('PUT', '/api/todoist/token', { body: { token } });
      expect(res.status, token).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
    }
    expect((await t.json('PUT', '/api/todoist/token', { body: {} })).status).toBe(422);
    expect((await t.json('PUT', '/api/todoist/token', { body: { token: TOKEN, extra: 1 } })).status).toBe(422);
    expect(calls()).toHaveLength(0);
    expect(t.ctx.vault.has(TOKEN_SECRET_ID)).toBe(false);
  });

  it('answers 422 with a clear message when Todoist rejects the token, and keeps the old one', async () => {
    t = withToken({ fetchRoutes: [{ match: `${API}/projects`, respond: { status: 401, json: { error: 'Unauthorized', http_code: 401 } } }] });
    const res = await t.json<ErrorBody>('PUT', '/api/todoist/token', { body: { token: OTHER_TOKEN } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.message).toMatch(/Todoist rejected this token/);
    expect(res.text).not.toContain(OTHER_TOKEN);
    expect(t.ctx.vault.get(TOKEN_SECRET_ID)).toBe(TOKEN);
  });

  it('maps upstream outages while validating', async () => {
    t = todoistTestbed({ fetchRoutes: [{ match: `${API}/projects`, respond: { status: 503, text: 'down' } }] });
    const res = await t.json<ErrorBody>('PUT', '/api/todoist/token', { body: { token: TOKEN } });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('provider_error');
    expect(t.ctx.vault.has(TOKEN_SECRET_ID)).toBe(false);
  });

  it('refuses to store while the vault is locked (reauth_required), without calling Todoist', async () => {
    t = todoistTestbed();
    t.ctx.vault.setState('locked');
    const res = await t.json<ErrorBody>('PUT', '/api/todoist/token', { body: { token: TOKEN } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('reauth_required');
    expect(calls()).toHaveLength(0);
  });

  it('DELETE removes the token (also while the vault is locked)', async () => {
    t = withToken();
    t.ctx.vault.setState('locked');
    expect((await t.json('DELETE', '/api/todoist/token')).body).toEqual({ configured: false });
    expect(t.ctx.vault.has(TOKEN_SECRET_ID)).toBe(false);
    expect((await t.json('GET', '/api/todoist/token')).body).toEqual({ configured: false });
  });

  it('requires the X-Portly header (gate)', async () => {
    t = todoistTestbed();
    expect((await t.req('GET', '/api/todoist/token', { headers: { 'X-Portly': null } })).status).toBe(403);
  });
});

describe('todoist: tasks', () => {
  it('answers 409 not_configured without a token', async () => {
    t = todoistTestbed();
    const res = await t.json<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_configured');
    expect(res.body.error.details).toEqual({ reason: 'no_token' });
  });

  it('answers 409 reauth_required when the token is stored but the vault is locked', async () => {
    t = withToken();
    t.ctx.vault.setState('locked');
    const res = await t.json<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('reauth_required');
    expect(calls()).toHaveLength(0);
  });

  it('follows next_cursor, maps tasks and uses the default filter from settings', async () => {
    const first = [
      upstreamTask({ id: 't1', content: 'Pay rent', priority: 4, due: upstreamDue('2026-09-24'), labels: ['home'], project_id: 'p1' }),
      upstreamTask({ id: 't2', content: 'Standup', due: upstreamDue('2026-09-25T09:30:00', { string: 'every weekday 9:30', is_recurring: true }) }),
    ];
    const second = [upstreamTask({ id: 't3', content: 'Call mum', due: null }), upstreamTask({ id: 't4', checked: true })];
    t = withToken({
      fetchRoutes: [
        { match: /\/tasks\/filter\?.*cursor=c2/, respond: { json: page(second, null) } },
        { match: `${API}/tasks/filter`, respond: { json: page(first, 'c2') } },
      ],
    });
    const res = await t.json<Task[]>('GET', '/api/todoist/tasks');
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

    expect(calls()).toHaveLength(2);
    const [a, b] = calls().map(query);
    expect(a!.get('query')).toBe('today | overdue');
    expect(a!.get('limit')).toBe('200');
    expect(a!.has('cursor')).toBe(false);
    expect(b!.get('cursor')).toBe('c2');
    expect(calls()[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(new URL(calls()[0]!.url).pathname).toBe('/api/v1/tasks/filter');
  });

  it('uses the filter parameter, or the configured default when it is empty', async () => {
    t = withToken({ fetchRoutes: [{ match: `${API}/tasks/filter`, respond: { json: page([]) } }] });
    t.ctx.settings.patch({ todoist: { defaultFilter: '#Work & p1' } });
    await t.json('GET', `/api/todoist/tasks?filter=${encodeURIComponent('7 days & @home')}`);
    await t.json('GET', '/api/todoist/tasks?filter=%20');
    await t.json('GET', '/api/todoist/tasks');
    expect(calls().map((c) => query(c).get('query'))).toEqual(['7 days & @home', '#Work & p1', '#Work & p1']);
    const tooLong = await t.json('GET', `/api/todoist/tasks?filter=${'x'.repeat(1100)}`);
    expect(tooLong.status).toBe(422);
  });

  it(`caps the list at ${MAX_TASKS} tasks`, async () => {
    const batch = (n: number) => Array.from({ length: 200 }, (_, i) => upstreamTask({ id: `b${n}i${i}` }));
    t = withToken({
      fetchRoutes: [
        { match: /cursor=p3/, respond: { json: page(batch(3), 'p4') } },
        { match: /cursor=p2/, respond: { json: page(batch(2), 'p3') } },
        { match: `${API}/tasks/filter`, respond: { json: page(batch(1), 'p2') } },
      ],
    });
    const res = await t.json<Task[]>('GET', '/api/todoist/tasks');
    expect(res.body).toHaveLength(MAX_TASKS);
    expect(calls()).toHaveLength(3);
  });

  it('stops when a cursor repeats', async () => {
    t = withToken({ fetchRoutes: [{ match: `${API}/tasks/filter`, respond: { json: page([upstreamTask({ id: 'loop' })], 'same') } }] });
    const res = await t.json<Task[]>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(200);
    expect(calls()).toHaveLength(2);
  });

  it('rejects an unexpected page shape as provider_error', async () => {
    t = withToken({ fetchRoutes: [{ match: `${API}/tasks/filter`, respond: { json: [upstreamTask()] } }] });
    const res = await t.json<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('provider_error');
  });
});

describe('todoist: upstream error mapping', () => {
  it.each([401, 403])('%i → 409 not_configured with token_rejected details', async (status) => {
    t = withToken({ fetchRoutes: [{ match: `${API}/tasks/filter`, respond: { status, json: { error: 'Forbidden' } } }] });
    const res = await t.json<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_configured');
    expect(res.body.error.details).toEqual({ reason: 'token_rejected' });
    expect(res.body.error.message).toMatch(/rejected/);
  });

  it('429 → rate_limited with Retry-After, then a local cooldown without upstream calls', async () => {
    t = withToken({
      fetchRoutes: [{ match: `${API}/tasks/filter`, respond: { status: 429, headers: { 'Retry-After': '17' }, json: { error: 'Too many requests' } } }],
    });
    const res = await t.json<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(res.body.error.details).toEqual({ retryAfterSeconds: 17 });
    expect(res.res.headers.get('retry-after')).toBe('17');

    const again = await t.json<ErrorBody>('POST', '/api/todoist/tasks/abc/close');
    expect(again.status).toBe(429);
    expect(Number(again.res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(calls()).toHaveLength(1);
  });

  it('429 without a header uses error_extra.retry_after', async () => {
    t = withToken({
      fetchRoutes: [{ match: `${API}/tasks/filter`, respond: { status: 429, json: { error: 'Too many', error_extra: { retry_after: 42 } } } }],
    });
    const res = await t.json<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.res.headers.get('retry-after')).toBe('42');
  });

  it('a new token clears the cooldown', async () => {
    t = withToken({
      fetchRoutes: [
        { match: `${API}/tasks/filter`, times: 1, respond: { status: 429, headers: { 'Retry-After': '600' } } },
        { match: `${API}/projects`, respond: { json: page([]) } },
        { match: `${API}/tasks/filter`, respond: { json: page([]) } },
      ],
    });
    expect((await t.json('GET', '/api/todoist/tasks')).status).toBe(429);
    expect((await t.json('PUT', '/api/todoist/token', { body: { token: OTHER_TOKEN } })).status).toBe(200);
    expect((await t.json('GET', '/api/todoist/tasks')).status).toBe(200);
  });

  it('maps non-JSON error pages by their status (plain-text 401, CDN 429 page)', async () => {
    t = withToken({
      fetchRoutes: [
        { match: `${API}/tasks/filter`, times: 1, respond: { status: 401, text: 'Unauthorized' } },
        { match: `${API}/tasks/filter`, times: 1, respond: { status: 403, headers: { 'content-type': 'text/html' }, text: '<html>Forbidden</html>' } },
        { match: `${API}/tasks/filter`, respond: { status: 429, headers: { 'Retry-After': '30', 'content-type': 'text/html' }, text: '<html>Error 1015: rate limited</html>' } },
      ],
    });
    let res = await t.json<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ reason: 'token_rejected' });
    res = await t.json<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_configured');
    res = await t.json<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(res.res.headers.get('retry-after')).toBe('30');
    expect(res.text).not.toContain('1015');
  });

  it('a plain-text 401 while validating a new token is still a clear 422', async () => {
    t = todoistTestbed({ fetchRoutes: [{ match: `${API}/projects`, respond: { status: 401, text: 'Unauthorized' } }] });
    const res = await t.json<ErrorBody>('PUT', '/api/todoist/token', { body: { token: TOKEN } });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Todoist rejected this token/);
    expect(t.ctx.vault.has(TOKEN_SECRET_ID)).toBe(false);
  });

  it('a 2xx answer that is not JSON is a provider_error (and asks for JSON)', async () => {
    t = withToken({ fetchRoutes: [{ match: `${API}/tasks/filter`, respond: { status: 200, text: '<html>captive portal</html>' } }] });
    const res = await t.json<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('provider_error');
    expect(res.text).not.toContain('captive');
    expect(calls()[0]!.headers.get('accept')).toBe('application/json');
  });

  it.each([500, 502, 503])('%i → 502 provider_error', async (status) => {
    t = withToken({ fetchRoutes: [{ match: `${API}/tasks/filter`, respond: { status, text: '<html>oops</html>' } }] });
    const res = await t.json<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('provider_error');
    expect(res.text).not.toContain('oops');
  });

  it('400 on a filter → 422 validation_failed (upstream text not reflected)', async () => {
    t = withToken({ fetchRoutes: [{ match: `${API}/tasks/filter`, respond: { status: 400, json: { error: 'SECRET-UPSTREAM-TEXT' } } }] });
    const res = await t.json<ErrorBody>('GET', '/api/todoist/tasks?filter=%28%28');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.text).not.toContain('SECRET-UPSTREAM-TEXT');
  });

  it('timeouts → 504 upstream_timeout; network errors → 502 provider_error', async () => {
    const failing =
      (reason: 'timeout' | 'network'): SafeFetch =>
      async () => {
        throw new SafeFetchError(reason, 'failed', 'api.todoist.com');
      };
    t = withToken({ fetch: failing('timeout') });
    let res = await t.json<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('upstream_timeout');
    t.close();

    t = withToken({ fetch: failing('network') });
    res = await t.json<ErrorBody>('GET', '/api/todoist/tasks');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('provider_error');
  });

  it('never logs the token', async () => {
    const { createMemoryLogger } = await import('../../lib/logger.ts');
    const log = createMemoryLogger();
    t = todoistTestbed({
      log,
      fetchRoutes: [
        { match: `${API}/projects`, respond: { json: page([]) } },
        { match: `${API}/tasks/filter`, respond: { status: 401 } },
      ],
    });
    await t.json('PUT', '/api/todoist/token', { body: { token: TOKEN } });
    await t.json('GET', '/api/todoist/tasks');
    expect(JSON.stringify(log.lines)).not.toContain(TOKEN);
  });

  it('safe-fetch sees the provider policy and never follows redirects', async () => {
    const seen: { policy: string; redirect?: string }[] = [];
    let inner: SafeFetch | null = null;
    const spy: SafeFetch = async (url, options) => {
      seen.push({ policy: options.policy, redirect: options.redirect });
      return inner!(url, options);
    };
    t = withToken({ fetch: spy });
    const { createFakeFetch } = await import('../../testing/fake-fetch.ts');
    inner = createSafeFetch({ version: 't', log: t.ctx.log, fetchImpl: createFakeFetch([{ match: `${API}/tasks/filter`, respond: { json: page([]) } }]) });
    await t.json('GET', '/api/todoist/tasks');
    expect(seen).toEqual([{ policy: 'provider', redirect: 'error' }]);
  });
});

describe('todoist: quick add, close, reopen', () => {
  it('quick add posts {text} and returns the mapped task', async () => {
    t = withToken({
      fetchRoutes: [
        {
          match: `${API}/tasks/quick`,
          method: 'POST',
          respond: { json: upstreamTask({ id: 'new1', content: 'Buy milk', due: upstreamDue('2026-09-26', { string: 'tomorrow' }), labels: ['shop'] }) },
        },
      ],
    });
    const res = await t.json<Task>('POST', '/api/todoist/tasks', { body: { text: '  Buy milk tomorrow @shop  ' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'new1', content: 'Buy milk', labels: ['shop'], due: { date: '2026-09-26', string: 'tomorrow' } });
    expect(JSON.parse(calls()[0]!.body!)).toEqual({ text: 'Buy milk tomorrow @shop' });
    expect(calls()[0]!.headers.get('content-type')).toBe('application/json');
  });

  it('quick add validates the text', async () => {
    t = withToken();
    expect((await t.json('POST', '/api/todoist/tasks', { body: { text: '   ' } })).status).toBe(422);
    expect((await t.json('POST', '/api/todoist/tasks', { body: { text: 'x'.repeat(1001) } })).status).toBe(422);
    expect(calls()).toHaveLength(0);
  });

  it('quick add returns null when the answer cannot be mapped (the task was still created)', async () => {
    t = withToken({ fetchRoutes: [{ match: `${API}/tasks/quick`, respond: { json: { weird: true } } }] });
    const res = await t.json('POST', '/api/todoist/tasks', { body: { text: 'Something' } });
    expect(res.status).toBe(201);
    expect(res.body).toBeNull();
  });

  it('close and reopen call the v1 endpoints and answer 204', async () => {
    t = withToken({
      fetchRoutes: [
        { match: `${API}/tasks/abc123/close`, method: 'POST', respond: { status: 204 } },
        { match: `${API}/tasks/abc123/reopen`, method: 'POST', respond: { status: 204 } },
      ],
    });
    expect((await t.req('POST', '/api/todoist/tasks/abc123/close')).status).toBe(204);
    expect((await t.req('POST', '/api/todoist/tasks/abc123/reopen')).status).toBe(204);
    expect(calls().map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /api/v1/tasks/abc123/close',
      'POST /api/v1/tasks/abc123/reopen',
    ]);
  });

  it('rejects odd task ids without calling Todoist and maps upstream 404', async () => {
    t = withToken({ fetchRoutes: [{ match: `${API}/tasks/gone/close`, respond: { status: 404, json: { error: 'Task not found' } } }] });
    expect((await t.req('POST', `/api/todoist/tasks/${encodeURIComponent('a b')}/close`)).status).toBe(404);
    expect((await t.req('POST', `/api/todoist/tasks/${'x'.repeat(65)}/reopen`)).status).toBe(404);
    expect(calls()).toHaveLength(0);
    const res = await t.json<ErrorBody>('POST', '/api/todoist/tasks/gone/close');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('todoist: PATCH', () => {
  it('maps allowlisted fields onto an upstream POST /tasks/{id}', async () => {
    t = withToken({
      fetchRoutes: [
        {
          match: `${API}/tasks/abc`,
          method: 'POST',
          respond: { json: upstreamTask({ id: 'abc', content: 'Renamed', priority: 3, labels: ['a', 'b'], description: 'Notes' }) },
        },
      ],
    });
    const res = await t.json<Task>('PATCH', '/api/todoist/tasks/abc', {
      body: { content: 'Renamed', description: 'Notes', priority: 3, dueString: null, labels: ['a', 'b', 'a'] },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'abc', content: 'Renamed', priority: 3, labels: ['a', 'b'], due: null });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.method).toBe('POST');
    expect(JSON.parse(calls()[0]!.body!)).toEqual({ content: 'Renamed', description: 'Notes', priority: 3, due_string: 'no date', labels: ['a', 'b'] });
  });

  it('passes a natural-language due string through', async () => {
    t = withToken({ fetchRoutes: [{ match: `${API}/tasks/abc`, respond: { json: upstreamTask({ id: 'abc' }) } }] });
    await t.json('PATCH', '/api/todoist/tasks/abc', { body: { dueString: 'next monday 9am' } });
    expect(JSON.parse(calls()[0]!.body!)).toEqual({ due_string: 'next monday 9am' });
  });

  it('refuses fields outside the allowlist and empty updates, without calling Todoist', async () => {
    t = withToken();
    for (const body of [
      { projectId: 'p2' },
      { project_id: 'p2' },
      { content: 'x', checked: true },
      { due_date: '2026-10-01' },
      { priority: 5 },
      { labels: 'a' },
      {},
    ]) {
      const res = await t.json<ErrorBody>('PATCH', '/api/todoist/tasks/abc', { body });
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(calls()).toHaveLength(0);
  });
});

describe('todoist: projects', () => {
  it('pages projects, maps colors and caches them for 5 minutes', async () => {
    t = withToken({
      fetchRoutes: [
        { match: /\/projects\?.*cursor=n2/, respond: { json: page([upstreamProject({ id: 'p2', name: 'Work', color: 'sky_blue' })]) } },
        { match: `${API}/projects`, respond: { json: page([upstreamProject({ id: 'p1', name: 'Inbox', color: 'grey' })], 'n2') } },
      ],
    });
    const first = await t.json<Project[]>('GET', '/api/todoist/projects');
    expect(first.body).toEqual([
      { id: 'p1', name: 'Inbox', color: '#b8b8b8' },
      { id: 'p2', name: 'Work', color: '#14aaf5' },
    ]);
    expect(query(calls()[0]!).get('limit')).toBe('200');
    const second = await t.json<Project[]>('GET', '/api/todoist/projects');
    expect(second.body).toEqual(first.body);
    expect(calls()).toHaveLength(2);
  });

  it('forgets cached projects when the token changes', async () => {
    t = withToken({ fetchRoutes: [{ match: `${API}/projects`, respond: { json: page([upstreamProject({ id: 'p1' })]) } }] });
    await t.json('GET', '/api/todoist/projects');
    await t.json('PUT', '/api/todoist/token', { body: { token: OTHER_TOKEN } });
    await t.json('GET', '/api/todoist/projects');
    // list, validate, list again
    expect(calls()).toHaveLength(3);
    expect(calls()[2]!.headers.get('authorization')).toBe(`Bearer ${OTHER_TOKEN}`);
  });

  it("a project list requested before a token change is never served for the new token", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    t = withToken({
      fetchRoutes: [
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
      ],
    });
    // A slow list with the old token is still in flight when the token is replaced.
    const slow = t.json<Project[]>('GET', '/api/todoist/projects');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await t.json('PUT', '/api/todoist/token', { body: { token: OTHER_TOKEN } })).status).toBe(200);
    const fresh = t.json<Project[]>('GET', '/api/todoist/projects');
    release();
    expect((await slow).body.map((p) => p.id)).toEqual(['old']);
    expect((await fresh).body.map((p) => p.id)).toEqual(['new']);
    // …and the old answer did not end up in the cache either.
    expect((await t.json<Project[]>('GET', '/api/todoist/projects')).body.map((p) => p.id)).toEqual(['new']);
  });

  it('answers not_configured without a token', async () => {
    t = todoistTestbed();
    expect((await t.json<ErrorBody>('GET', '/api/todoist/projects')).body.error.code).toBe('not_configured');
  });
});

describe('todoist: health (diagnostics)', () => {
  const health = () => t.ctx.health.get('todoist');

  it('records ok for a call made with the stored token (on demand: never stale)', async () => {
    t = withToken({ fetchRoutes: [{ match: `${API}/tasks/filter`, respond: { json: page([upstreamTask()]) } }] });
    expect(health()).toBeNull();
    expect((await t.json('GET', '/api/todoist/tasks')).status).toBe(200);
    expect(health()).toMatchObject({ key: 'todoist', area: 'todoist', label: 'Todoist', status: 'ok', expectEveryMs: null, consecutiveFailures: 0 });
  });

  it("a rejected token fails the subject with token_rejected, Todoist's status and error_tag", async () => {
    const logs = createTestLogger();
    t = withToken({
      logs,
      fetchRoutes: [
        {
          match: `${API}/tasks/filter`,
          respond: { status: 401, json: { error: 'Invalid token', error_code: 401, error_tag: 'AUTH_INVALID_TOKEN', http_code: 401 } },
        },
      ],
    });
    await t.json('GET', '/api/todoist/tasks');
    await t.json('GET', '/api/todoist/tasks');
    expect(health()).toMatchObject({
      status: 'failing',
      lastCode: 'token_rejected',
      lastStatus: 401,
      lastMessage: 'Todoist rejected the saved API token. Paste a new one in Settings → Todoist.',
      consecutiveFailures: 2,
      detail: { errorTag: 'AUTH_INVALID_TOKEN', upstreamStatus: 401, errReason: 'token_rejected' },
    });
    // One warning (the transition); the repeat is debug only. Both carry the unit of work.
    const failing = logs.lines().filter((r) => r.msg === 'todoist failing');
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({ level: 'warn', area: 'todoist', fields: { key: 'todoist', code: 'token_rejected', op: 'filter' } });
    expect(logs.lines().find((r) => r.msg === 'todoist still failing')?.level).toBe('debug');
    expect(JSON.stringify(logs.lines())).not.toContain(TOKEN);
  });

  it('an error_tag that is not a machine token is left out', async () => {
    t = withToken({ fetchRoutes: [{ match: `${API}/tasks/filter`, respond: { status: 403, json: { error_tag: 'not a <tag>' } } }] });
    await t.json('GET', '/api/todoist/tasks');
    expect(health()?.lastCode).toBe('token_rejected');
    expect(health()?.detail).not.toHaveProperty('errorTag');
  });

  it('429 → rate_limited until the cooldown ends; requests refused by the cooldown are skipped checks', async () => {
    t = withToken({ fetchRoutes: [{ match: `${API}/tasks/filter`, respond: { status: 429, headers: { 'Retry-After': '17' } } }] });
    const before = Date.now();
    await t.json('GET', '/api/todoist/tasks');
    const failed = health()!;
    expect(failed).toMatchObject({ status: 'failing', lastCode: 'rate_limited', lastStatus: 429, consecutiveFailures: 1 });
    expect(failed.nextAttemptAt).toBeGreaterThanOrEqual(before + 17_000);
    expect(failed.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 17_000);

    await t.json('POST', '/api/todoist/tasks/abc/close');
    expect(calls()).toHaveLength(1);
    expect(health()).toMatchObject({ status: 'failing', consecutiveFailures: 1, nextAttemptAt: failed.nextAttemptAt, detail: { skipped: 'backoff' } });
  });

  it('Todoist errors, unreadable answers and transport failures fail it; answers about one request do not', async () => {
    t = withToken({
      fetchRoutes: [
        { match: `${API}/tasks/filter`, times: 1, respond: { status: 400, json: { error: 'Invalid filter' } } },
        { match: `${API}/tasks/gone/close`, respond: { status: 404 } },
        { match: `${API}/tasks/filter`, times: 1, respond: { status: 503, text: 'down' } },
        { match: `${API}/tasks/filter`, times: 1, respond: { status: 200, text: '<html>captive portal</html>' } },
        { match: `${API}/tasks/filter`, times: 1, respond: { json: { results: 'nope' } } },
      ],
    });
    await t.json('GET', '/api/todoist/tasks?filter=%28%28');
    await t.json('POST', '/api/todoist/tasks/gone/close');
    expect(health()).toBeNull();

    await t.json('GET', '/api/todoist/tasks');
    expect(health()).toMatchObject({ status: 'failing', lastCode: 'http_5xx', lastStatus: 503 });
    await t.json('GET', '/api/todoist/tasks');
    expect(health()).toMatchObject({ lastCode: 'parse_error', lastStatus: 200 });
    await t.json('GET', '/api/todoist/tasks');
    expect(health()).toMatchObject({ lastCode: 'parse_error', consecutiveFailures: 3 });
  });

  it('a timeout is recorded with its transport code', async () => {
    t = withToken({
      fetch: async () => {
        throw new SafeFetchError('timeout', 'Request to api.todoist.com timed out', 'api.todoist.com');
      },
    });
    await t.json('GET', '/api/todoist/tasks');
    expect(health()).toMatchObject({ status: 'failing', lastCode: 'timeout', lastMessage: 'Request to api.todoist.com timed out', detail: { host: 'api.todoist.com' } });
  });

  it('a locked vault is a skipped check; no token means nothing to diagnose', async () => {
    t = todoistTestbed();
    await t.json('GET', '/api/todoist/tasks');
    expect(health()).toBeNull();
    t.close();

    t = withToken();
    t.ctx.vault.setState('locked');
    await t.json('GET', '/api/todoist/tasks');
    expect(health()).toMatchObject({ status: 'unknown', detail: { skipped: 'vault_locked' } });
  });

  it('saving a token Todoist accepts recovers the subject; removing the token forgets it', async () => {
    t = withToken({
      fetchRoutes: [
        { match: `${API}/tasks/filter`, respond: { status: 401 } },
        { match: `${API}/projects`, respond: { json: page([]) } },
      ],
    });
    await t.json('GET', '/api/todoist/tasks');
    expect(health()?.status).toBe('failing');
    expect((await t.json('PUT', '/api/todoist/token', { body: { token: OTHER_TOKEN } })).status).toBe(200);
    expect(health()).toMatchObject({ status: 'ok', lastCode: 'token_rejected' });
    await t.json('DELETE', '/api/todoist/token');
    expect(health()).toBeNull();
  });

  it("a candidate token Todoist rejects leaves the stored token's subject alone", async () => {
    t = withToken({ fetchRoutes: [{ match: `${API}/projects`, respond: { status: 401 } }] });
    expect((await t.json('PUT', '/api/todoist/token', { body: { token: OTHER_TOKEN } })).status).toBe(422);
    expect(health()).toBeNull();
  });

  it('tells safe-fetch what each request is for', async () => {
    const purposes: (string | undefined)[] = [];
    let inner: SafeFetch | null = null;
    t = withToken({
      fetch: async (url, options) => {
        purposes.push(options.purpose);
        return inner!(url, options);
      },
    });
    const { createFakeFetch } = await import('../../testing/fake-fetch.ts');
    inner = createSafeFetch({
      version: 't',
      log: t.ctx.log,
      fetchImpl: createFakeFetch([
        { match: `${API}/tasks/filter`, respond: { json: page([]) } },
        { match: `${API}/projects`, respond: { json: page([]) } },
      ]),
    });
    await t.json('GET', '/api/todoist/tasks');
    await t.json('GET', '/api/todoist/projects');
    expect(purposes).toEqual(['todoist.filter', 'todoist.list']);
  });
});
