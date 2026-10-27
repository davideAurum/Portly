/**
 * Static backend: the GitHub gist token for launch pad sync. Write-only (`{configured}`), checked
 * with GitHub before it is saved (classic tokens: the gist scope and nothing else), kept out of
 * exports, and the gist ids it remembers are dropped with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLASSIC_TOKEN, GITHUB_TOKEN, createFakeGitHub } from '../providers/__fixtures__/github.ts';
import { createFakeFetch, failingFetch, type FakeFetchRoute } from '../providers/__fixtures__/fakeFetch.ts';
import { MAIN_FILE } from '../providers/githubGist.ts';
import { openGistStore } from '../providers/gistToken.ts';
import { SLICE, getGistSync } from '../slices.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import * as gistSync from './gistSync.ts';
import * as transfer from './transfer.ts';

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

let t: TestBackend;
afterEach(() => {
  vi.unstubAllGlobals();
  t?.close();
});

const LIST = 'https://api.github.com/gists?per_page=1';

async function setup(routes: FakeFetchRoute[] = []) {
  const fake = createFakeFetch(routes);
  vi.stubGlobal('fetch', fake.fetch);
  t = await createTestBackend([gistSync, transfer]);
  return fake;
}

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; text: string }> {
  const res = await t.call(method, path, body);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, text };
}

async function withToken(token = GITHUB_TOKEN, ids: { main?: string; icons?: string } = {}) {
  Object.assign(getGistSync(t.ctx), { token, mainGistId: ids.main ?? null, iconsGistId: ids.icons ?? null });
  await t.ctx.state.commit(SLICE.gistSync);
}

describe('gist sync: token', () => {
  it('checks a fine-grained token with GitHub, saves it and never returns it', async () => {
    const fake = await setup([{ match: LIST, respond: { json: [] } }]);
    expect((await call('GET', '/api/sync/gist/token')).body).toEqual({ configured: false });

    const saved = await call('PUT', '/api/sync/gist/token', { token: `  Bearer ${GITHUB_TOKEN}\n` });
    expect(saved).toMatchObject({ status: 200, body: { configured: true } });
    expect(saved.text).not.toContain(GITHUB_TOKEN);
    const check = fake.calls[0]!;
    expect(check.url).toBe(LIST);
    expect(check.headers.get('authorization')).toBe(`Bearer ${GITHUB_TOKEN}`);
    expect(check.init.credentials).toBe('omit');
    expect(check.init.cache).toBe('no-store');
    expect(await t.storage.getJson(`slice:${SLICE.gistSync}`)).toEqual({ token: GITHUB_TOKEN, generation: 1, mainGistId: null, iconsGistId: null });
    expect((await call('GET', '/api/sync/gist/token')).body).toEqual({ configured: true });
  });

  it('accepts a classic token with only the gist scope, and refuses broader or narrower ones', async () => {
    const fake = await setup();
    fake.add({ match: LIST, times: 1, respond: { json: [], headers: { 'x-oauth-scopes': 'gist, repo' } } });
    const broad = await call<ErrorBody>('PUT', '/api/sync/gist/token', { token: CLASSIC_TOKEN });
    expect(broad.status).toBe(422);
    expect(broad.body.error.message).toContain('repo');
    fake.add({ match: LIST, times: 1, respond: { json: [], headers: { 'x-oauth-scopes': 'read:user' } } });
    expect((await call<ErrorBody>('PUT', '/api/sync/gist/token', { token: CLASSIC_TOKEN })).body.error.message).toContain('lacks the gist scope');
    expect(getGistSync(t.ctx).token).toBeNull();
    fake.add({ match: LIST, times: 1, respond: { json: [], headers: { 'x-oauth-scopes': 'gist' } } });
    expect((await call('PUT', '/api/sync/gist/token', { token: CLASSIC_TOKEN })).status).toBe(200);
    expect(getGistSync(t.ctx).token).toBe(CLASSIC_TOKEN);
  });

  it('refuses a malformed token without a request, and a rejected one with 422', async () => {
    const fake = await setup([{ match: LIST, respond: { status: 401, json: { message: 'Bad credentials' } } }]);
    const malformed = await call<ErrorBody>('PUT', '/api/sync/gist/token', { token: 'not a token' });
    expect([malformed.status, malformed.body.error.code]).toEqual([422, 'validation_failed']);
    expect(fake.calls).toHaveLength(0);
    const refused = await call<ErrorBody>('PUT', '/api/sync/gist/token', { token: GITHUB_TOKEN });
    expect(refused.status).toBe(422);
    expect(refused.body.error.details).toEqual({ reason: 'token_rejected' });
    expect(refused.text).not.toContain(GITHUB_TOKEN);
    expect(getGistSync(t.ctx).token).toBeNull();
  });

  it('reads a secondary rate limit from the message, as the store does', async () => {
    await setup([{ match: LIST, respond: { status: 403, json: { message: 'You have exceeded a secondary rate limit.' } } }]);
    expect((await call<ErrorBody>('PUT', '/api/sync/gist/token', { token: GITHUB_TOKEN })).body.error.code).toBe('rate_limited');
  });

  it('reports rate limits and an unreachable GitHub as such', async () => {
    const fake = await setup([{ match: LIST, times: 1, respond: { status: 403, headers: { 'x-ratelimit-remaining': '0' }, json: {} } }]);
    expect((await call<ErrorBody>('PUT', '/api/sync/gist/token', { token: GITHUB_TOKEN })).body.error.code).toBe('rate_limited');
    vi.stubGlobal('fetch', failingFetch);
    expect((await call<ErrorBody>('PUT', '/api/sync/gist/token', { token: GITHUB_TOKEN })).body.error.code).toBe('provider_error');
    expect(fake.calls).toHaveLength(1);
  });

  it('DELETE removes the token and the remembered gists, leaving them on GitHub', async () => {
    await setup();
    await withToken(GITHUB_TOKEN, { main: 'abc', icons: 'def' });
    expect((await call('DELETE', '/api/sync/gist/token')).body).toEqual({ configured: false });
    expect(getGistSync(t.ctx)).toMatchObject({ token: null, mainGistId: null, iconsGistId: null });
  });

  it('forgets the gists when another token is saved, and keeps them for the same token', async () => {
    await setup([{ match: LIST, respond: { json: [] } }]);
    await withToken(GITHUB_TOKEN, { main: 'abc', icons: 'def' });
    const generation = getGistSync(t.ctx).generation;
    await call('PUT', '/api/sync/gist/token', { token: GITHUB_TOKEN });
    expect(getGistSync(t.ctx)).toMatchObject({ mainGistId: 'abc', iconsGistId: 'def', generation });
    const other = `${GITHUB_TOKEN.slice(0, -1)}9`;
    await call('PUT', '/api/sync/gist/token', { token: other });
    expect(getGistSync(t.ctx)).toMatchObject({ token: other, mainGistId: null, iconsGistId: null });
  });

  it('is never exported', async () => {
    await setup();
    await withToken();
    const exported = await call('GET', '/api/export');
    expect(exported.status).toBe(200);
    expect(exported.text).not.toContain(GITHUB_TOKEN);
  });

  it('keeps the previous token when the new one cannot be stored', async () => {
    await setup([{ match: LIST, respond: { json: [] } }]);
    await withToken(GITHUB_TOKEN, { main: 'abc' });
    const setJson = t.storage.setJson.bind(t.storage);
    vi.spyOn(t.storage, 'setJson').mockImplementation(async (key, value) => {
      if (key === `slice:${SLICE.gistSync}`) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return setJson(key, value);
    });
    const other = `${GITHUB_TOKEN.slice(0, -1)}9`;
    expect((await call('PUT', '/api/sync/gist/token', { token: other })).status).toBeGreaterThanOrEqual(500);
    expect(getGistSync(t.ctx)).toMatchObject({ token: GITHUB_TOKEN, mainGistId: 'abc', generation: 2 });
  });
});

describe('gist sync: opening the store', () => {
  it('keeps syncing when the gist ids cannot be saved', async () => {
    await setup();
    await withToken();
    const github = createFakeGitHub();
    github.seed({ [MAIN_FILE]: 'v1' });
    const store = openGistStore(t.ctx, { fetch: github.fake.fetch })!;
    const setJson = t.storage.setJson.bind(t.storage);
    vi.spyOn(t.storage, 'setJson').mockImplementation(async (key, value) => {
      if (key === `slice:${SLICE.gistSync}`) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return setJson(key, value);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await store.readMain(new AbortController().signal))?.text).toBe('v1');
  });

  it('is null without a token, and saves the gist ids it finds for the token in use', async () => {
    await setup();
    expect(openGistStore(t.ctx)).toBeNull();
    await withToken();
    const github = createFakeGitHub();
    const gist = github.seed({ [MAIN_FILE]: 'v1' });
    const store = openGistStore(t.ctx, { fetch: github.fake.fetch })!;
    expect((await store.readMain(new AbortController().signal))?.text).toBe('v1');
    expect(await t.storage.getJson(`slice:${SLICE.gistSync}`)).toMatchObject({ token: GITHUB_TOKEN, mainGistId: gist.id });
  });

  it('does not save ids into a slice whose token changed meanwhile', async () => {
    await setup();
    await withToken();
    const github = createFakeGitHub();
    github.seed({ [MAIN_FILE]: 'v1' });
    const store = openGistStore(t.ctx, { fetch: github.fake.fetch })!;
    Object.assign(getGistSync(t.ctx), { token: CLASSIC_TOKEN, generation: getGistSync(t.ctx).generation + 1 });
    await store.readMain(new AbortController().signal);
    expect(getGistSync(t.ctx).mainGistId).toBeNull();
  });
});
