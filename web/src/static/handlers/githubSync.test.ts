/**
 * Static backend: the private GitHub repository and token for launch pad sync. Write-only
 * (`{configured}`), checked with GitHub before they are saved (the repository must be private and
 * readable; classic tokens are refused), kept out of exports.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLASSIC_TOKEN, GITHUB_TOKEN, OWNER, REPO, REPO_URL, createFakeGitHub } from '../providers/__fixtures__/github.ts';
import { createFakeFetch, failingFetch, type FakeFetchRoute } from '../providers/__fixtures__/fakeFetch.ts';
import { MAIN_PATH } from '../providers/githubRepo.ts';
import { openGitHubStore } from '../providers/githubSync.ts';
import { SLICE, getAccounts, getGitHubSync } from '../slices.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import * as githubSync from './githubSync.ts';
import * as transfer from './transfer.ts';

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

let t: TestBackend;
afterEach(() => {
  vi.unstubAllGlobals();
  t?.close();
});

const REPOSITORY = `${OWNER}/${REPO}`;
const CONTENTS = `${REPO_URL}/contents/${MAIN_PATH}`;
const repoOk: FakeFetchRoute = { match: REPO_URL, respond: (req) => (req.url === REPO_URL ? { json: { private: true } } : { status: 404, json: { message: 'Not Found' } }) };

async function setup(routes: FakeFetchRoute[] = []) {
  const fake = createFakeFetch(routes);
  vi.stubGlobal('fetch', fake.fetch);
  t = await createTestBackend([githubSync, transfer]);
  return fake;
}

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; text: string }> {
  const res = await t.call(method, path, body);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, text };
}

async function withSettings(token = GITHUB_TOKEN, repository = REPOSITORY) {
  Object.assign(getGitHubSync(t.ctx), { token, repository });
  await t.ctx.state.commit(SLICE.githubSync);
}

describe('GitHub sync: repository and token', () => {
  it('checks them with GitHub, saves them and never returns them', async () => {
    const fake = await setup([repoOk]);
    expect((await call('GET', '/api/sync/github')).body).toEqual({ configured: false });

    const saved = await call('PUT', '/api/sync/github', { repository: ` ${REPOSITORY} `, token: `  Bearer ${GITHUB_TOKEN}\n` });
    expect(saved).toMatchObject({ status: 200, body: { configured: true } });
    expect(saved.text).not.toContain(GITHUB_TOKEN);
    expect(saved.text).not.toContain(REPO);
    expect(fake.calls.map((c) => c.url)).toEqual([REPO_URL, CONTENTS]);
    for (const check of fake.calls) {
      expect(check.headers.get('authorization')).toBe(`Bearer ${GITHUB_TOKEN}`);
      expect(check.init).toMatchObject({ credentials: 'omit', cache: 'no-store' });
    }
    expect(await t.storage.getJson(`slice:${SLICE.githubSync}`)).toEqual({ token: GITHUB_TOKEN, repository: REPOSITORY, generation: 1 });
    const status = await call('GET', '/api/sync/github');
    expect(status.body).toEqual({ configured: true });
    expect(status.text).not.toContain(REPO);
  });

  it('refuses classic tokens and malformed input without a request', async () => {
    const fake = await setup([repoOk]);
    const classic = await call<ErrorBody>('PUT', '/api/sync/github', { repository: REPOSITORY, token: CLASSIC_TOKEN });
    expect([classic.status, classic.body.error.code]).toEqual([422, 'validation_failed']);
    expect(classic.body.error.message).toContain('fine-grained');
    expect((await call<ErrorBody>('PUT', '/api/sync/github', { repository: REPOSITORY, token: 'not a token' })).status).toBe(422);
    for (const repository of ['octo', 'a/b/c', '../x/y', 'octo/repo.git', `https://github.com/${REPOSITORY}`]) {
      const bad = await call<ErrorBody>('PUT', '/api/sync/github', { repository, token: GITHUB_TOKEN });
      expect([bad.status, bad.body.error.details], repository).toEqual([422, [expect.objectContaining({ path: 'repository' })]]);
    }
    expect(fake.calls).toHaveLength(0);
    expect(getGitHubSync(t.ctx).token).toBeNull();
  });

  it('refuses a public repository, one it cannot find, and a token that may not read it', async () => {
    const fake = await setup();
    fake.add({ match: REPO_URL, times: 1, respond: { json: { private: false } } });
    const pub = await call<ErrorBody>('PUT', '/api/sync/github', { repository: REPOSITORY, token: GITHUB_TOKEN });
    expect([pub.status, pub.body.error.details]).toEqual([422, { reason: 'token_rejected', field: 'repository' }]);
    expect(pub.body.error.message).toContain('public');

    fake.add({ match: REPO_URL, times: 1, respond: { status: 404, json: { message: 'Not Found' } } });
    expect((await call<ErrorBody>('PUT', '/api/sync/github', { repository: REPOSITORY, token: GITHUB_TOKEN })).body.error.message).toContain("can't find");

    fake.add({ match: CONTENTS, times: 1, respond: { status: 403, json: { message: 'Resource not accessible by personal access token' } } });
    fake.add({ match: REPO_URL, times: 1, respond: { json: { private: true } } });
    expect((await call<ErrorBody>('PUT', '/api/sync/github', { repository: REPOSITORY, token: GITHUB_TOKEN })).body.error.message).toContain('Contents');

    fake.add({ match: REPO_URL, times: 1, respond: { status: 401, json: { message: 'Bad credentials' } } });
    const refused = await call<ErrorBody>('PUT', '/api/sync/github', { repository: REPOSITORY, token: GITHUB_TOKEN });
    expect(refused.body.error.details).toEqual({ reason: 'token_rejected', field: 'token' });
    expect(refused.text).not.toContain(GITHUB_TOKEN);
    expect(getGitHubSync(t.ctx).token).toBeNull();
  });

  it('accepts a repository whose launch pad file exists already', async () => {
    await setup([{ match: CONTENTS, respond: { json: { type: 'file' } } }, repoOk]);
    expect((await call('PUT', '/api/sync/github', { repository: REPOSITORY, token: GITHUB_TOKEN })).status).toBe(200);
  });

  it('reports rate limits (headers, or the wording of a secondary limit) and an unreachable GitHub as such', async () => {
    const fake = await setup([{ match: REPO_URL, times: 1, respond: { status: 403, headers: { 'x-ratelimit-remaining': '0' }, json: {} } }]);
    expect((await call<ErrorBody>('PUT', '/api/sync/github', { repository: REPOSITORY, token: GITHUB_TOKEN })).body.error.code).toBe('rate_limited');
    fake.add({ match: REPO_URL, times: 1, respond: { status: 403, json: { message: 'You have exceeded a secondary rate limit.' } } });
    expect((await call<ErrorBody>('PUT', '/api/sync/github', { repository: REPOSITORY, token: GITHUB_TOKEN })).body.error.code).toBe('rate_limited');
    vi.stubGlobal('fetch', failingFetch);
    expect((await call<ErrorBody>('PUT', '/api/sync/github', { repository: REPOSITORY, token: GITHUB_TOKEN })).body.error.code).toBe('provider_error');
  });

  it('refuses to be set up while a Microsoft connection syncs the launch pad, before asking GitHub', async () => {
    const fake = await setup([repoOk]);
    getAccounts(t.ctx).push({
      id: 'ms-1',
      kind: 'microsoft',
      label: 'someone@outlook.example',
      email: 'someone@outlook.example',
      externalId: 'subject-1',
      color: null,
      capabilities: ['calendar', 'launchpadSync'],
      enabledCapabilities: ['calendar', 'launchpadSync'],
      grantedScopes: [],
      requestedScopes: [],
      status: 'ok',
      statusMessage: null,
      sort: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    await t.ctx.state.commit(SLICE.accounts);
    const res = await call<ErrorBody>('PUT', '/api/sync/github', { repository: REPOSITORY, token: GITHUB_TOKEN });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'conflict', message: expect.stringContaining('someone@outlook.example') });
    expect(fake.calls).toHaveLength(0);
    expect(getGitHubSync(t.ctx).token).toBeNull();
  });

  it('DELETE removes both, leaving the repository on GitHub', async () => {
    const fake = await setup();
    await withSettings();
    expect((await call('DELETE', '/api/sync/github')).body).toEqual({ configured: false });
    expect(getGitHubSync(t.ctx)).toMatchObject({ token: null, repository: null });
    expect(fake.calls).toHaveLength(0);
  });

  it('is never exported', async () => {
    await setup();
    await withSettings();
    const exported = await call('GET', '/api/export');
    expect(exported.status).toBe(200);
    expect(exported.text).not.toContain(GITHUB_TOKEN);
    expect(exported.text).not.toContain(REPO);
  });

  it('keeps the previous settings when the new ones cannot be stored', async () => {
    await setup([repoOk]);
    await withSettings();
    const setJson = t.storage.setJson.bind(t.storage);
    vi.spyOn(t.storage, 'setJson').mockImplementation(async (key, value) => {
      if (key === `slice:${SLICE.githubSync}`) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return setJson(key, value);
    });
    const other = `${GITHUB_TOKEN.slice(0, -1)}9`;
    expect((await call('PUT', '/api/sync/github', { repository: REPOSITORY, token: other })).status).toBeGreaterThanOrEqual(500);
    expect(getGitHubSync(t.ctx)).toMatchObject({ token: GITHUB_TOKEN, repository: REPOSITORY, generation: 2 });
  });
});

describe('GitHub sync: opening the store', () => {
  it('is null without settings, and reads the saved repository with the saved token', async () => {
    await setup();
    expect(openGitHubStore(t.ctx)).toBeNull();
    await withSettings();
    const github = createFakeGitHub();
    github.put(MAIN_PATH, 'v1');
    const store = openGitHubStore(t.ctx, { fetch: github.fake.fetch })!;
    expect(store.kind).toBe('github');
    expect((await store.readMain(new AbortController().signal))?.text).toBe('v1');
    expect(github.fake.calls[0]!.headers.get('authorization')).toBe(`Bearer ${GITHUB_TOKEN}`);
  });

  it('is null, and not configured, for a saved repository name that is not valid', async () => {
    await setup();
    await withSettings(GITHUB_TOKEN, '../x');
    expect(openGitHubStore(t.ctx)).toBeNull();
    expect((await call('GET', '/api/sync/github')).body).toEqual({ configured: false });
  });
});
