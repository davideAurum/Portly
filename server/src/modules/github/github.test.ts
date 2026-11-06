import { afterEach, describe, expect, it } from 'vitest';
import type { GitHubBoard } from '@portly/shared';
import { SafeFetchError } from '../../security/safe-fetch.ts';
import type { FakeRequest } from '../../testing/fake-fetch.ts';
import { CLASSIC_TOKEN, GRAPHQL, OTHER_TOKEN, TOKEN, boardAnswer, githubTestbed, upstreamRepo, type GitHubTestbed } from './__fixtures__/github.ts';
import { TOKEN_SECRET_ID } from './index.ts';

type ErrorBody = { error: { code: string; message: string; details?: { reason?: string; permissions?: string[]; retryAfterSeconds?: number } } };

let t: GitHubTestbed;
afterEach(() => t?.close());

function withToken(extra: Parameters<typeof githubTestbed>[0] = {}): GitHubTestbed {
  return githubTestbed({ secrets: { [TOKEN_SECRET_ID]: TOKEN }, ...extra });
}

function calls(): FakeRequest[] {
  return t.ctx.fakeFetch?.calls ?? [];
}

function variables(req: FakeRequest): { first: number; after: string | null } {
  return (JSON.parse(req.body ?? '{}') as { variables: { first: number; after: string | null } }).variables;
}

const health = () => t.ctx.health.get('github');
const ok = { match: GRAPHQL, method: 'POST', respond: { json: boardAnswer([upstreamRepo('sample')]) } };

describe('github: token', () => {
  it('reports configured without ever returning the token', async () => {
    t = githubTestbed({ fetchRoutes: [ok] });
    expect((await t.json('GET', '/api/github/token')).body).toEqual({ configured: false });

    const saved = await t.json('PUT', '/api/github/token', { body: { token: `  ${TOKEN}\n` } });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ configured: true });
    expect(saved.text).not.toContain(TOKEN);

    // Checked with one repository, Bearer auth, before storing.
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(variables(calls()[0]!)).toEqual({ first: 1, after: null });
    expect(t.ctx.vault.get(TOKEN_SECRET_ID)).toBe(TOKEN);

    const status = await t.json('GET', '/api/github/token');
    expect(status.body).toEqual({ configured: true });
    expect(status.text).not.toContain(TOKEN);
  });

  it('refuses classic and malformed tokens without calling GitHub', async () => {
    t = githubTestbed();
    const classic = await t.json<ErrorBody>('PUT', '/api/github/token', { body: { token: CLASSIC_TOKEN } });
    expect(classic.status).toBe(422);
    expect(classic.body.error.message).toMatch(/^Classic tokens/);
    expect(classic.text).not.toContain(CLASSIC_TOKEN);
    const nonsense = await t.json<ErrorBody>('PUT', '/api/github/token', { body: { token: 'https://github.com/settings/tokens' } });
    expect(nonsense.status).toBe(422);
    expect(calls()).toHaveLength(0);
    expect(t.ctx.vault.has(TOKEN_SECRET_ID)).toBe(false);
  });

  it('does not store a token GitHub rejects', async () => {
    t = githubTestbed({ fetchRoutes: [{ match: GRAPHQL, respond: { status: 401, json: { message: 'Bad credentials' } } }] });
    const res = await t.json<ErrorBody>('PUT', '/api/github/token', { body: { token: TOKEN } });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'validation_failed', details: { reason: 'token_rejected' } });
    expect(res.text).not.toContain('Bad credentials');
    expect(t.ctx.vault.has(TOKEN_SECRET_ID)).toBe(false);
    expect(health()).toBeNull();
  });

  it('does not store a token that can\'t read the board, and says what is missing', async () => {
    const answer = boardAnswer([null], { total: 3, errors: [{ type: 'FORBIDDEN', path: ['viewer', 'repositories', 'nodes', 0, 'issues'], message: 'Resource not accessible by personal access token' }] });
    t = githubTestbed({ fetchRoutes: [{ match: GRAPHQL, respond: { json: answer } }] });
    const res = await t.json<ErrorBody>('PUT', '/api/github/token', { body: { token: TOKEN } });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('may not read Issues');
    expect(res.body.error.details).toMatchObject({ reason: 'insufficient_scope', permissions: ['Issues'] });
    expect(t.ctx.vault.has(TOKEN_SECRET_ID)).toBe(false);
  });

  it('does not store a token that sees no repositories', async () => {
    t = githubTestbed({ fetchRoutes: [{ match: GRAPHQL, respond: { json: boardAnswer([]) } }] });
    const res = await t.json<ErrorBody>('PUT', '/api/github/token', { body: { token: TOKEN } });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('All repositories');
    expect(t.ctx.vault.has(TOKEN_SECRET_ID)).toBe(false);
  });

  it('stores a token that can\'t read CI results: the board says so instead', async () => {
    const answer = boardAnswer([upstreamRepo('sample', { defaultBranchRef: { name: 'main', target: { statusCheckRollup: null } } })], {
      errors: [{ type: 'FORBIDDEN', path: ['viewer', 'repositories', 'nodes', 0, 'defaultBranchRef', 'target', 'statusCheckRollup'] }],
    });
    t = githubTestbed({ fetchRoutes: [{ match: GRAPHQL, respond: { json: answer } }] });
    expect((await t.json('PUT', '/api/github/token', { body: { token: TOKEN } })).status).toBe(200);
    const board = await t.json<GitHubBoard>('GET', '/api/github/repos');
    expect(board.body.repos[0]?.checks).toBe('unavailable');
  });

  it('refuses to store while the vault is locked, without calling GitHub', async () => {
    t = githubTestbed();
    t.ctx.vault.setState('locked');
    const res = await t.json<ErrorBody>('PUT', '/api/github/token', { body: { token: TOKEN } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('reauth_required');
    expect(calls()).toHaveLength(0);
  });

  it('DELETE removes the token and what was cached with it', async () => {
    t = withToken({ fetchRoutes: [ok] });
    await t.json('GET', '/api/github/repos');
    expect(health()).not.toBeNull();
    expect((await t.json('DELETE', '/api/github/token')).body).toEqual({ configured: false });
    expect(t.ctx.vault.has(TOKEN_SECRET_ID)).toBe(false);
    expect(health()).toBeNull();
    expect((await t.json('GET', '/api/github/repos')).status).toBe(409);
  });
});

describe('github: repositories', () => {
  it('answers the board', async () => {
    const repo = upstreamRepo('sample', { isPrivate: true, pullRequests: { totalCount: 2 }, defaultBranchRef: { name: 'trunk', target: { statusCheckRollup: { state: 'FAILURE' } } } });
    t = withToken({ fetchRoutes: [{ match: GRAPHQL, respond: { json: boardAnswer([repo]) } }] });
    const res = await t.json<GitHubBoard>('GET', '/api/github/repos');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ login: 'octo-tester', total: 1, truncated: false, skipped: 0 });
    expect(res.body.repos[0]).toMatchObject({ fullName: 'octo-tester/sample', isPrivate: true, openPullRequests: 2, defaultBranch: 'trunk', checks: 'failure' });
    expect(res.text).not.toContain(TOKEN);
  });

  it('asks only GitHub, with no redirects, as a provider call', async () => {
    t = withToken({ fetchRoutes: [ok] });
    await t.json('GET', '/api/github/repos');
    expect(calls().map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${GRAPHQL}`]);
    expect(calls()[0]!.headers.get('content-type')).toBe('application/json');
  });

  it('reads every page', async () => {
    const first = Array.from({ length: 100 }, (_, i) => upstreamRepo(`a${i}`));
    t = withToken({
      fetchRoutes: [
        { match: GRAPHQL, times: 1, respond: { json: boardAnswer(first, { total: 101, hasNextPage: true, endCursor: 'next' }) } },
        { match: GRAPHQL, times: 1, respond: { json: boardAnswer([upstreamRepo('b')], { total: 101 }) } },
      ],
    });
    const res = await t.json<GitHubBoard>('GET', '/api/github/repos');
    expect(res.body.repos).toHaveLength(101);
    expect(calls().map(variables)).toEqual([
      { first: 100, after: null },
      { first: 100, after: 'next' },
    ]);
  });

  it('serves one answer to every widget for a while', async () => {
    t = withToken({ fetchRoutes: [ok] });
    await t.json('GET', '/api/github/repos');
    await t.json('GET', '/api/github/repos');
    expect(calls()).toHaveLength(1);
  });

  it('a new token never gets the old token\'s board', async () => {
    t = withToken({
      fetchRoutes: [
        { match: GRAPHQL, times: 1, respond: { json: boardAnswer([upstreamRepo('old')]) } },
        { match: GRAPHQL, respond: { json: boardAnswer([upstreamRepo('new')]) } },
      ],
    });
    await t.json('GET', '/api/github/repos');
    await t.json('PUT', '/api/github/token', { body: { token: OTHER_TOKEN } });
    const res = await t.json<GitHubBoard>('GET', '/api/github/repos');
    expect(res.body.repos.map((r) => r.fullName)).toEqual(['octo-tester/new']);
  });

  it('answers 409 not_configured without a token', async () => {
    t = githubTestbed();
    const res = await t.json<ErrorBody>('GET', '/api/github/repos');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'not_configured', details: { reason: 'no_token' } });
    expect(calls()).toHaveLength(0);
  });

  it('answers 409 reauth_required when the token is stored but the vault is locked', async () => {
    t = withToken();
    t.ctx.vault.setState('locked');
    const res = await t.json<ErrorBody>('GET', '/api/github/repos');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('reauth_required');
    expect(calls()).toHaveLength(0);
    expect(health()).toMatchObject({ status: 'unknown', detail: { skipped: 'vault_locked' } });
  });

  it('a revoked or expired token asks for a new one', async () => {
    t = withToken({ fetchRoutes: [{ match: GRAPHQL, respond: { status: 401, json: { message: 'Bad credentials' } } }] });
    const res = await t.json<ErrorBody>('GET', '/api/github/repos');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'not_configured', details: { reason: 'token_rejected' } });
    expect(health()).toMatchObject({ status: 'failing', lastCode: 'token_rejected', lastStatus: 401 });
  });

  it('a token that lost a permission says which', async () => {
    const answer = boardAnswer([null], { total: 2, errors: [{ type: 'FORBIDDEN', path: ['viewer', 'repositories', 'nodes', 0, 'pullRequests'], message: 'Resource not accessible by personal access token' }] });
    t = withToken({ fetchRoutes: [{ match: GRAPHQL, respond: { json: answer } }] });
    const res = await t.json<ErrorBody>('GET', '/api/github/repos');
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ reason: 'insufficient_scope', permissions: ['Pull requests'] });
    expect(health()).toMatchObject({ status: 'failing', lastCode: 'insufficient_scope' });
  });

  it('a 403 with rate-limit signs waits, and sends nothing until then', async () => {
    t = withToken({ fetchRoutes: [{ match: GRAPHQL, respond: { status: 403, headers: { 'retry-after': '120' }, json: { message: 'secondary rate limit' } } }] });
    const res = await t.json<ErrorBody>('GET', '/api/github/repos');
    expect(res.status).toBe(429);
    expect(res.res.headers.get('retry-after')).toBe('120');
    expect(res.body.error).toMatchObject({ code: 'rate_limited', details: { retryAfterSeconds: 120 } });
    expect(health()).toMatchObject({ status: 'failing', lastCode: 'rate_limited' });

    const again = await t.json<ErrorBody>('GET', '/api/github/repos');
    expect(again.status).toBe(429);
    expect(calls()).toHaveLength(1);
    expect(health()).toMatchObject({ consecutiveFailures: 1, detail: { skipped: 'backoff' } });
  });

  it('a limit reported in a 200 waits too', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    t = withToken({
      fetchRoutes: [{ match: GRAPHQL, respond: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }, json: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } } }],
    });
    const res = await t.json<ErrorBody>('GET', '/api/github/repos');
    expect(res.status).toBe(429);
    expect(res.body.error.details?.retryAfterSeconds).toBeGreaterThan(590);
  });

  it('GitHub errors, unreadable answers and transport failures fail the subject', async () => {
    t = withToken({
      fetchRoutes: [
        { match: GRAPHQL, times: 1, respond: { status: 503, text: 'down' } },
        { match: GRAPHQL, times: 1, respond: { status: 200, text: '<html>captive portal</html>' } },
        { match: GRAPHQL, times: 1, respond: { json: { data: { viewer: 'nope' } } } },
      ],
    });
    const down = await t.json<ErrorBody>('GET', '/api/github/repos');
    expect(down.status).toBe(502);
    expect(down.body.error.code).toBe('provider_error');
    expect(health()).toMatchObject({ status: 'failing', lastCode: 'http_5xx', lastStatus: 503 });
    await t.json('GET', '/api/github/repos');
    expect(health()).toMatchObject({ lastCode: 'parse_error', lastStatus: 200 });
    await t.json('GET', '/api/github/repos');
    expect(health()).toMatchObject({ lastCode: 'parse_error', consecutiveFailures: 3 });
  });

  it('a timeout is recorded with its transport code', async () => {
    t = withToken({
      fetch: async () => {
        throw new SafeFetchError('timeout', 'Request to api.github.com timed out', 'api.github.com');
      },
    });
    const res = await t.json<ErrorBody>('GET', '/api/github/repos');
    expect(res.status).toBe(504);
    expect(health()).toMatchObject({ status: 'failing', lastCode: 'timeout' });
  });

  it('a good answer records ok, and never logs a repository name', async () => {
    t = withToken({ fetchRoutes: [{ match: GRAPHQL, respond: { json: boardAnswer([upstreamRepo('very-private-name', { isPrivate: true })]) } }] });
    await t.json('GET', '/api/github/repos');
    expect(health()).toMatchObject({ key: 'github', area: 'github', label: 'GitHub', status: 'ok', expectEveryMs: null });
    expect(JSON.stringify(health())).not.toContain('very-private-name');
  });
});
