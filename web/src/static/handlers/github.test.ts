/**
 * Static backend: the GitHub status board. The token is write-only (`{configured}`), checked with
 * GitHub before it is saved, kept out of exports, and separate from the launch pad sync token.
 */
import type { GitHubBoard } from '@portly/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeFetch, failingFetch, type FakeFetchRoute } from '../providers/__fixtures__/fakeFetch.ts';
import { CLASSIC_TOKEN, GRAPHQL, OTHER_TOKEN, TOKEN, boardAnswer, upstreamRepo } from '../providers/__fixtures__/githubStatus.ts';
import { SLICE, getGitHubStatusToken, getGitHubSync } from '../slices.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import * as github from './github.ts';
import * as transfer from './transfer.ts';

type ErrorBody = { error: { code: string; message: string; details?: { reason?: string; permissions?: string[]; retryAfterSeconds?: number } } };

let t: TestBackend;
afterEach(() => {
  vi.unstubAllGlobals();
  t?.close();
});

const ok: FakeFetchRoute = { match: GRAPHQL, method: 'POST', respond: { json: boardAnswer([upstreamRepo('sample')]) } };

async function setup(routes: FakeFetchRoute[] = []) {
  const fake = createFakeFetch(routes);
  vi.stubGlobal('fetch', fake.fetch);
  t = await createTestBackend([github, transfer]);
  return fake;
}

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const res = await t.call(method, path, body);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, text, headers: res.headers };
}

async function withToken(token = TOKEN) {
  Object.assign(getGitHubStatusToken(t.ctx), { token });
  await t.ctx.state.commit(SLICE.githubStatusToken);
}

function variables(body: string | null): unknown {
  return (JSON.parse(body ?? '{}') as { variables: unknown }).variables;
}

describe('GitHub status: token', () => {
  it('checks it with GitHub, saves it and never returns it', async () => {
    const fake = await setup([ok]);
    expect((await call('GET', '/api/github/token')).body).toEqual({ configured: false });

    const saved = await call('PUT', '/api/github/token', { token: `  ${TOKEN}\n` });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ configured: true });
    expect(saved.text).not.toContain(TOKEN);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(variables(fake.calls[0]!.body)).toEqual({ first: 1, after: null });
    expect(await t.storage.getJson(`slice:${SLICE.githubStatusToken}`)).toEqual({ token: TOKEN, generation: 1 });
    expect((await call('GET', '/api/github/token')).body).toEqual({ configured: true });
  });

  it('sends no cookies, follows no redirects and asks the browser to keep nothing', async () => {
    const fake = await setup([ok]);
    await call('PUT', '/api/github/token', { token: TOKEN });
    expect(fake.calls[0]!.init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
  });

  it('refuses classic and malformed tokens without calling GitHub', async () => {
    const fake = await setup();
    const classic = await call<ErrorBody>('PUT', '/api/github/token', { token: CLASSIC_TOKEN });
    expect(classic.status).toBe(422);
    expect(classic.body.error.message).toMatch(/^Classic tokens/);
    expect((await call('PUT', '/api/github/token', { token: 'not a token' })).status).toBe(422);
    expect(fake.calls).toHaveLength(0);
  });

  it('does not save a token GitHub rejects', async () => {
    await setup([{ match: GRAPHQL, respond: { status: 401, json: { message: 'Bad credentials' } } }]);
    const res = await call<ErrorBody>('PUT', '/api/github/token', { token: TOKEN });
    expect(res.status).toBe(422);
    expect(res.body.error.details?.reason).toBe('token_rejected');
    expect(res.text).not.toContain('Bad credentials');
    expect((await call('GET', '/api/github/token')).body).toEqual({ configured: false });
  });

  it('does not save a token that can\'t read the board, and says what is missing', async () => {
    const answer = boardAnswer([null], { total: 2, errors: [{ type: 'FORBIDDEN', path: ['viewer', 'repositories', 'nodes', 0, 'issues'] }] });
    await setup([{ match: GRAPHQL, respond: { json: answer } }]);
    const res = await call<ErrorBody>('PUT', '/api/github/token', { token: TOKEN });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('may not read Issues');
    expect((await call('GET', '/api/github/token')).body).toEqual({ configured: false });
  });

  it('does not save a token that sees no repositories', async () => {
    await setup([{ match: GRAPHQL, respond: { json: boardAnswer([]) } }]);
    const res = await call<ErrorBody>('PUT', '/api/github/token', { token: TOKEN });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('All repositories');
  });

  it('DELETE removes it, and keeps the launch pad sync token', async () => {
    await setup([ok]);
    Object.assign(getGitHubSync(t.ctx), { token: 'sync-token', repository: 'octo-tester/portly-sync' });
    await withToken();
    expect((await call('DELETE', '/api/github/token')).body).toEqual({ configured: false });
    expect((await call('GET', '/api/github/repos')).status).toBe(409);
    expect(getGitHubSync(t.ctx).token).toBe('sync-token');
  });

  it('keeps the token this page had when storage refuses the write', async () => {
    await setup([ok]);
    await withToken();
    const setJson = t.storage.setJson.bind(t.storage);
    vi.spyOn(t.storage, 'setJson').mockImplementation(async (key, value) => {
      if (key === `slice:${SLICE.githubStatusToken}`) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return setJson(key, value);
    });
    expect((await call('PUT', '/api/github/token', { token: OTHER_TOKEN })).status).toBeGreaterThanOrEqual(400);
    expect(getGitHubStatusToken(t.ctx).token).toBe(TOKEN);
  });

  it('is never exported', async () => {
    await setup();
    await withToken();
    const res = await call('GET', '/api/export');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(TOKEN);
    expect(res.text).not.toContain('github-status-token');
  });
});

describe('GitHub status: repositories', () => {
  it('answers the board', async () => {
    const repo = upstreamRepo('sample', { isPrivate: true, issues: { totalCount: 3 }, defaultBranchRef: { name: 'main', target: { statusCheckRollup: { state: 'PENDING' } } } });
    await setup([{ match: GRAPHQL, respond: { json: boardAnswer([repo]) } }]);
    await withToken();
    const res = await call<GitHubBoard>('GET', '/api/github/repos');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ login: 'octo-tester', total: 1, truncated: false });
    expect(res.body.repos[0]).toMatchObject({ fullName: 'octo-tester/sample', isPrivate: true, openIssues: 3, checks: 'pending' });
    expect(res.text).not.toContain(TOKEN);
  });

  it('reads every page', async () => {
    const first = Array.from({ length: 100 }, (_, i) => upstreamRepo(`a${i}`));
    const fake = await setup([
      { match: GRAPHQL, times: 1, respond: { json: boardAnswer(first, { total: 101, hasNextPage: true, endCursor: 'next' }) } },
      { match: GRAPHQL, times: 1, respond: { json: boardAnswer([upstreamRepo('b')], { total: 101 }) } },
    ]);
    await withToken();
    const res = await call<GitHubBoard>('GET', '/api/github/repos');
    expect(res.body.repos).toHaveLength(101);
    expect(variables(fake.calls[1]!.body)).toEqual({ first: 100, after: 'next' });
  });

  it('serves one answer for a while, and never across tokens', async () => {
    const fake = await setup([
      { match: GRAPHQL, times: 2, respond: { json: boardAnswer([upstreamRepo('old')]) } },
      { match: GRAPHQL, respond: { json: boardAnswer([upstreamRepo('new')]) } },
    ]);
    await withToken();
    await call('GET', '/api/github/repos');
    await call('GET', '/api/github/repos');
    expect(fake.calls).toHaveLength(1);
    fake.add({ match: GRAPHQL, respond: { json: boardAnswer([upstreamRepo('new')]) } });
    await call('PUT', '/api/github/token', { token: OTHER_TOKEN });
    const res = await call<GitHubBoard>('GET', '/api/github/repos');
    expect(res.body.repos.map((r) => r.fullName)).toEqual(['octo-tester/new']);
  });

  it('answers 409 not_configured without a token', async () => {
    const fake = await setup();
    const res = await call<ErrorBody>('GET', '/api/github/repos');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'not_configured', details: { reason: 'no_token' } });
    expect(fake.calls).toHaveLength(0);
  });

  it('a revoked or expired token asks for a new one', async () => {
    await setup([{ match: GRAPHQL, respond: { status: 401, json: { message: 'Bad credentials' } } }]);
    await withToken();
    const res = await call<ErrorBody>('GET', '/api/github/repos');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'not_configured', details: { reason: 'token_rejected' } });
  });

  it('keeps showing repositories when the token can\'t read CI results', async () => {
    const repo = upstreamRepo('sample', { defaultBranchRef: { name: 'main', target: { statusCheckRollup: null } } });
    const errors = [{ type: 'FORBIDDEN', path: ['viewer', 'repositories', 'nodes', 0, 'defaultBranchRef', 'target', 'statusCheckRollup'] }];
    await setup([{ match: GRAPHQL, respond: { json: boardAnswer([repo], { errors }) } }]);
    await withToken();
    const res = await call<GitHubBoard>('GET', '/api/github/repos');
    expect(res.status).toBe(200);
    expect(res.body.repos[0]?.checks).toBe('unavailable');
  });

  it('a rate limit waits, carries Retry-After and sends nothing until then', async () => {
    const fake = await setup([{ match: GRAPHQL, respond: { status: 403, headers: { 'retry-after': '120' }, json: { message: 'secondary rate limit' } } }]);
    await withToken();
    const res = await call<ErrorBody>('GET', '/api/github/repos');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
    expect(res.body.error).toMatchObject({ code: 'rate_limited', details: { retryAfterSeconds: 120 } });
    expect((await call('GET', '/api/github/repos')).status).toBe(429);
    expect(fake.calls).toHaveLength(1);
  });

  it('a limit reported in a 200 waits too', async () => {
    await setup([{ match: GRAPHQL, respond: { json: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } } }]);
    await withToken();
    expect((await call('GET', '/api/github/repos')).status).toBe(429);
  });

  it('GitHub errors, unreadable answers and network failures are provider errors', async () => {
    await setup([
      { match: GRAPHQL, times: 1, respond: { status: 503, text: 'down' } },
      { match: GRAPHQL, times: 1, respond: { text: '<html>captive portal</html>' } },
    ]);
    await withToken();
    for (let i = 0; i < 2; i++) {
      const res = await call<ErrorBody>('GET', '/api/github/repos');
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('provider_error');
    }
    vi.stubGlobal('fetch', failingFetch);
    expect((await call('GET', '/api/github/repos')).status).toBe(502);
  });
});
