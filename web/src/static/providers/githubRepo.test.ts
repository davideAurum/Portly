/**
 * The GitHub repository sync store against an in-memory GitHub (no live calls): the contents API's
 * sha checks as the version check, the cheap "nothing changed" read, files over 1 MB through the
 * blob API, icons as binary files, size caps, error mapping and hostile answers.
 */
import { describe, expect, it } from 'vitest';
import { SYNC_MAX_ICON_BYTES, SYNC_MAX_MAIN_BYTES, SyncStoreError } from '../sync/store.ts';
import { GITHUB_TOKEN, INLINE_LIMIT, OWNER, REPO, REPOSITORY, REPO_URL, createFakeGitHub } from './__fixtures__/github.ts';
import { failingFetch, hangingFetch } from './__fixtures__/fakeFetch.ts';
import {
  ICON_ADD_MESSAGE,
  ICON_REMOVE_MESSAGE,
  ICON_RETRY_DELAY_MS,
  ICON_WRITE_ATTEMPTS,
  MAIN_COMMIT_MESSAGE,
  MAIN_PATH,
  createGitHubRepoStore,
  iconPath,
  parseRepository,
  statusError,
  type GitHubRepoStoreOptions,
} from './githubRepo.ts';

const ICON_ID = '3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]);
const MAIN_URL = `${REPO_URL}/contents/${MAIN_PATH}`;
const signal = () => new AbortController().signal;

function setup(options: Partial<GitHubRepoStoreOptions> = {}) {
  const github = createFakeGitHub();
  const waits: number[] = [];
  const store = createGitHubRepoStore({
    token: GITHUB_TOKEN,
    repository: REPOSITORY,
    fetch: github.fake.fetch,
    now: () => 1_800_000_000_000,
    sleep: async (ms) => void waits.push(ms),
    ...options,
  });
  return { github, store, waits };
}

async function expectStoreError(promise: Promise<unknown>, code: string): Promise<SyncStoreError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SyncStoreError);
  expect((err as SyncStoreError).code).toBe(code);
  return err as SyncStoreError;
}

function bodyOf(req: { body: string | null }): Record<string, unknown> {
  return JSON.parse(req.body ?? '{}') as Record<string, unknown>;
}

describe('repository store: main file', () => {
  it('reads null in an empty repository, creates the file without a sha, then reads it back', async () => {
    const { github, store } = setup();
    expect(await store.readMain(signal())).toBeNull();
    const written = await store.writeMain('{"v":1} ✓', null, signal());
    expect(written.ok).toBe(true);
    const put = github.calls('PUT')[0]!;
    expect(put.url).toBe(MAIN_URL);
    expect(bodyOf(put)).toEqual({ message: MAIN_COMMIT_MESSAGE, content: expect.any(String) });
    expect(github.text(MAIN_PATH)).toBe('{"v":1} ✓');
    expect(written).toEqual({ ok: true, version: github.sha(MAIN_PATH) });
    expect(await store.readMain(signal())).toEqual({ text: '{"v":1} ✓', version: github.sha(MAIN_PATH) });
  });

  it('writes only while the version is unchanged', async () => {
    const { github, store } = setup();
    const v1 = github.put(MAIN_PATH, 'one');
    const v2 = github.put(MAIN_PATH, 'two');
    expect(await store.writeMain('mine', v1, signal())).toEqual({ ok: false, reason: 'conflict' });
    expect(github.text(MAIN_PATH)).toBe('two');
    expect(bodyOf(github.calls('PUT')[0]!).sha).toBe(v1);
    const ok = await store.writeMain('mine', v2, signal());
    expect(ok).toEqual({ ok: true, version: github.sha(MAIN_PATH) });
    expect(github.text(MAIN_PATH)).toBe('mine');
  });

  it('refuses a create-only write when the file exists, and a versioned one when it is gone', async () => {
    const { github, store } = setup();
    const v1 = github.put(MAIN_PATH, 'theirs');
    // GitHub answers 422 ("sha" wasn't supplied); the store confirms the file is there.
    expect(await store.writeMain('mine', null, signal())).toEqual({ ok: false, reason: 'conflict' });
    expect(github.text(MAIN_PATH)).toBe('theirs');
    github.put('other.txt', 'keeps the repository non-empty');
    github.remove(MAIN_PATH);
    expect(await store.writeMain('mine', v1, signal())).toEqual({ ok: false, reason: 'conflict' });
    expect(github.text(MAIN_PATH)).toBeUndefined();
  });

  it('answers conflict to a 409 from another write on the branch, and the next write goes through', async () => {
    const { github, store } = setup();
    const v1 = github.put(MAIN_PATH, 'one');
    let busy = true;
    github.beforeWrite = () => (busy ? ((busy = false), { status: 409, json: { message: 'refs/heads/main is at abc but expected def' } }) : undefined);
    expect(await store.writeMain('two', v1, signal())).toEqual({ ok: false, reason: 'conflict' });
    expect((await store.writeMain('two', v1, signal())).ok).toBe(true);
  });

  it('does not call a 422 a conflict while the file is unchanged', async () => {
    const { github, store } = setup();
    const v1 = github.put(MAIN_PATH, 'one');
    github.beforeWrite = () => ({ status: 422, json: { message: 'Validation Failed' } });
    await expectStoreError(store.writeMain('two', v1, signal()), 'unavailable');
  });

  it('answers conflict, without a request, to a version that is not a sha', async () => {
    const { github, store } = setup();
    expect(await store.writeMain('x', '../../etc', signal())).toEqual({ ok: false, reason: 'conflict' });
    expect(github.calls('PUT')).toHaveLength(0);
  });

  it('reads an unchanged file with If-None-Match (a 304) and keeps the text of its own write', async () => {
    const { github, store } = setup();
    const version = github.put(MAIN_PATH, 'v1');
    expect(await store.readMain(signal())).toEqual({ text: 'v1', version });
    expect(await store.readMain(signal())).toEqual({ text: 'v1', version });
    const gets = github.calls('GET', /contents\/launchpad\.json$/);
    expect(gets[0]!.headers.get('if-none-match')).toBeNull();
    expect(gets[1]!.headers.get('if-none-match')).toBe(`"${version}"`);

    // Over 1 MB, so a read that did not reuse the written text would need the blob API.
    const big = 'y'.repeat(INLINE_LIMIT + 1);
    const written = await store.writeMain(big, version, signal());
    const before = github.fake.calls.length;
    expect(await store.readMain(signal())).toEqual({ text: big, version: written.ok ? written.version : '' });
    expect(github.fake.calls.length - before).toBe(1);
    expect(github.calls('GET', /git\/blobs/)).toHaveLength(0);
  });

  it('reads a file over 1 MB through the blob API, never a download URL', async () => {
    const { github, store } = setup();
    const big = 'x'.repeat(INLINE_LIMIT + 10);
    const version = github.put(MAIN_PATH, big);
    expect(await store.readMain(signal())).toEqual({ text: big, version });
    expect(github.calls('GET', new RegExp(`/git/blobs/${version}$`))).toHaveLength(1);
    expect(github.fake.calls.every((c) => c.url.startsWith('https://api.github.com/'))).toBe(true);
  });

  it('refuses files over the cap before downloading them, and a launch pad too large to write', async () => {
    const { github, store } = setup();
    const version = github.put(MAIN_PATH, 'small');
    github.override = (req) =>
      req.url === MAIN_URL ? { json: { type: 'file', sha: version, size: SYNC_MAX_MAIN_BYTES + 1, content: '', encoding: 'none' } } : null;
    await expectStoreError(store.readMain(signal()), 'too_large');
    expect(github.calls('GET', /git\/blobs/)).toHaveLength(0);
    github.override = null;
    await expectStoreError(store.writeMain('x'.repeat(SYNC_MAX_MAIN_BYTES + 1), null, signal()), 'too_large');
    expect(github.calls('PUT')).toHaveLength(0);
  });

  it('refuses a blob that is not the one asked for, the wrong size, or not UTF-8', async () => {
    const { github, store } = setup();
    const version = github.put(MAIN_PATH, 'x'.repeat(INLINE_LIMIT + 1));
    github.override = (req) => (req.url.includes('/git/blobs/') ? { json: { sha: 'f'.repeat(40), size: 3, encoding: 'base64', content: 'YWJj' } } : null);
    await expectStoreError(store.readMain(signal()), 'unavailable');
    github.override = (req) => (req.url.includes('/git/blobs/') ? { json: { sha: version, size: 3, encoding: 'base64', content: 'YWJj' } } : null);
    await expectStoreError(store.readMain(signal()), 'unavailable');
    github.override = null;
    github.put(MAIN_PATH, new Uint8Array([0xff, 0xfe, 0x00]));
    await expectStoreError(store.readMain(signal()), 'unavailable');
  });
});

describe('repository store: the repository', () => {
  it('checks once per store that the repository exists and is private, even for calls at the same time', async () => {
    const { github, store } = setup();
    await Promise.all([store.readMain(signal()), store.readIcon(ICON_ID, signal())]);
    await store.readMain(signal());
    await store.writeMain('x', null, signal());
    await store.readIcon(ICON_ID, signal());
    expect(github.calls('GET', new RegExp(`/repos/${OWNER}/${REPO}$`))).toHaveLength(1);
  });

  it('refuses a public repository before reading or writing anything', async () => {
    const { github, store } = setup();
    github.repo.private = false;
    const err = await expectStoreError(store.writeMain('x', null, signal()), 'reauth_required');
    expect(err.message).toContain('public');
    expect(github.fake.calls).toHaveLength(1);
  });

  it('reports a repository it cannot find without naming it', async () => {
    const { github, store } = setup();
    github.repo.exists = false;
    const err = await expectStoreError(store.readMain(signal()), 'reauth_required');
    expect(err.message).not.toContain(REPO);
  });

  it('accepts only owner/name with valid GitHub names', () => {
    expect(parseRepository('octo-user/portly-sync')).toEqual({ owner: 'octo-user', name: 'portly-sync' });
    expect(parseRepository('a/b.c_d-e')).toEqual({ owner: 'a', name: 'b.c_d-e' });
    for (const bad of ['', 'octo', 'octo/', '/repo', 'a/b/c', '-octo/repo', 'octo-/repo', 'oc--to/repo', 'octo/..', 'octo/.', 'octo/repo.git', 'octo/re po', 'octo/re%2fpo', `${'a'.repeat(40)}/r`, `o/${'r'.repeat(101)}`]) {
      expect(parseRepository(bad), bad).toBeNull();
    }
    expect(() => createGitHubRepoStore({ token: GITHUB_TOKEN, repository: { owner: '../x', name: 'y' } })).toThrow(RangeError);
  });
});

describe('repository store: icons', () => {
  it('writes an icon as a binary file under launchpad-icons/, create-only, and reads it back without a type', async () => {
    const { github, store } = setup();
    expect(await store.readIcon(ICON_ID, signal())).toBeNull();
    await store.writeIcon(ICON_ID, new Blob([PNG], { type: 'image/png' }), signal());
    expect(github.bytes(iconPath(ICON_ID))).toEqual(PNG);
    expect(github.commits.at(-1)).toEqual({ path: `launchpad-icons/${ICON_ID}`, message: ICON_ADD_MESSAGE });
    // Written again: GitHub refuses (no sha), the store sees it is there and leaves it.
    await store.writeIcon(ICON_ID, new Blob([new Uint8Array([1, 2, 3])]), signal());
    expect(github.bytes(iconPath(ICON_ID))).toEqual(PNG);
    const blob = await store.readIcon(ICON_ID, signal());
    expect(blob?.type).toBe('');
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(PNG);
  });

  it('reads an icon over 1 MB through the blob API', async () => {
    const { github, store } = setup();
    const big = new Uint8Array(INLINE_LIMIT + 5).fill(7);
    github.put(iconPath(ICON_ID), big);
    expect((await store.readIcon(ICON_ID, signal()))?.size).toBe(big.byteLength);
    expect(github.calls('GET', /git\/blobs/)).toHaveLength(1);
  });

  it('treats a folder or a file that is not base64 as a missing icon', async () => {
    const { github, store } = setup();
    github.put(`${iconPath(ICON_ID)}/inside`, 'a folder put there by hand');
    expect(await store.readIcon(ICON_ID, signal())).toBeNull();
    github.override = (req) => (req.url.endsWith(ICON_ID) ? { json: { type: 'file', sha: 'a'.repeat(40), size: 3, content: '!!!', encoding: 'base64' } } : null);
    expect(await store.readIcon(ICON_ID, signal())).toBeNull();
  });

  it('tries an icon write again, after a growing pause, while other writes move the branch, and gives up after a few', async () => {
    const { github, store, waits } = setup();
    let busy = 1;
    github.beforeWrite = () => (busy-- > 0 ? { status: 409, json: { message: 'is at abc but expected def' } } : undefined);
    await store.writeIcon(ICON_ID, new Blob([PNG]), signal());
    expect(github.bytes(iconPath(ICON_ID))).toEqual(PNG);
    github.beforeWrite = () => ({ status: 409, json: {} });
    const other = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
    const puts = github.calls('PUT').length;
    await expectStoreError(store.writeIcon(other, new Blob([PNG]), signal()), 'unavailable');
    expect(github.calls('PUT').length - puts).toBe(ICON_WRITE_ATTEMPTS);
    expect(waits).toEqual([ICON_RETRY_DELAY_MS, ICON_RETRY_DELAY_MS, 2 * ICON_RETRY_DELAY_MS]);
  });

  it('stops waiting between attempts when the caller aborts', async () => {
    const { github, store } = setup({ sleep: undefined });
    github.beforeWrite = () => ({ status: 409, json: {} });
    const controller = new AbortController();
    const pending = store.writeIcon(ICON_ID, new Blob([PNG]), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('checks the repository again when a delete finds nothing, and reports it gone', async () => {
    const { github, store } = setup();
    github.put(iconPath(ICON_ID), PNG);
    github.beforeWrite = () => {
      github.repo.exists = false;
      return { status: 404, json: { message: 'Not Found' } };
    };
    await expectStoreError(store.deleteIcon(ICON_ID, signal()), 'reauth_required');
  });

  it('deletes an icon with its sha, and does nothing for one that is not there', async () => {
    const { github, store } = setup();
    const sha = github.put(iconPath(ICON_ID), PNG);
    github.put('keep.txt', 'k');
    await store.deleteIcon(ICON_ID, signal());
    expect(github.sha(iconPath(ICON_ID))).toBeUndefined();
    const del = github.calls('DELETE')[0]!;
    expect(bodyOf(del)).toEqual({ message: ICON_REMOVE_MESSAGE, sha });
    await store.deleteIcon(ICON_ID, signal());
    expect(github.calls('DELETE')).toHaveLength(1);
  });

  it('deletes again with the new sha when the first attempt was refused', async () => {
    const { github, store } = setup();
    github.put(iconPath(ICON_ID), PNG);
    let busy = 1;
    github.beforeWrite = () => (busy-- > 0 ? { status: 409, json: {} } : undefined);
    await store.deleteIcon(ICON_ID, signal());
    expect(github.sha(iconPath(ICON_ID))).toBeUndefined();
    expect(github.calls('DELETE')).toHaveLength(2);
  });

  it('refuses ids that are not UUIDv4 before any request', async () => {
    const { github, store } = setup();
    await expect(store.readIcon('../launchpad.json', signal())).rejects.toThrow(RangeError);
    await expect(store.writeIcon('ABC', new Blob([PNG]), signal())).rejects.toThrow(RangeError);
    await expect(store.deleteIcon('3f2b8c4e-1a2b-1c3d-8e9f-0a1b2c3d4e5f', signal())).rejects.toThrow(RangeError);
    expect(github.fake.calls).toHaveLength(0);
  });

  it('refuses an icon too large to write, and one listed too large to read', async () => {
    const { github, store } = setup();
    await expectStoreError(store.writeIcon(ICON_ID, new Blob([new Uint8Array(SYNC_MAX_ICON_BYTES + 1)]), signal()), 'too_large');
    expect(github.fake.calls).toHaveLength(0);
    github.override = (req) =>
      req.url.endsWith(ICON_ID) ? { json: { type: 'file', sha: 'a'.repeat(40), size: SYNC_MAX_ICON_BYTES + 1, content: '', encoding: 'none' } } : null;
    await expectStoreError(store.readIcon(ICON_ID, signal()), 'too_large');
  });
});

describe('repository store: errors and hostile answers', () => {
  it('maps 401 and 403 to reauth_required, and rate limits with their wait', () => {
    const now = 1_800_000_000_000;
    expect(statusError(401, new Headers(), null, now).code).toBe('reauth_required');
    expect(statusError(403, new Headers(), { message: 'Resource not accessible by personal access token' }, now).code).toBe('reauth_required');
    const primary = statusError(403, new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 120) }), null, now);
    expect([primary.code, primary.retryAfterMs]).toEqual(['rate_limited', 120_000]);
    const secondary = statusError(403, new Headers({ 'retry-after': '30' }), null, now);
    expect([secondary.code, secondary.retryAfterMs]).toEqual(['rate_limited', 30_000]);
    const worded = statusError(403, new Headers(), { message: 'You have exceeded a secondary rate limit.' }, now);
    expect([worded.code, worded.retryAfterMs]).toEqual(['rate_limited', 60_000]);
    expect(statusError(429, new Headers({ 'retry-after': '999999' }), null, now).retryAfterMs).toBe(60 * 60_000);
    expect(statusError(413, new Headers(), null, now).code).toBe('too_large');
    expect(statusError(502, new Headers(), null, now).code).toBe('unavailable');
    expect(statusError(422, new Headers(), null, now).code).toBe('unavailable');
  });

  it('turns refused requests into store errors that never carry the token or the repository', async () => {
    const { github, store } = setup();
    github.override = () => ({ status: 401, json: { message: 'Bad credentials' } });
    const err = await expectStoreError(store.readMain(signal()), 'reauth_required');
    expect(err.message).not.toContain(GITHUB_TOKEN);
    expect(err.message).not.toContain(OWNER);
    github.override = () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000300' }, json: { message: 'API rate limit exceeded' } });
    expect((await expectStoreError(store.readMain(signal()), 'rate_limited')).retryAfterMs).toBe(300_000);
    github.override = () => ({ status: 503, text: 'unavailable' });
    await expectStoreError(store.writeMain('x', null, signal()), 'unavailable');
  });

  it('maps network failures and timeouts to network_error, and rethrows the caller abort', async () => {
    await expectStoreError(createGitHubRepoStore({ token: GITHUB_TOKEN, repository: REPOSITORY, fetch: failingFetch }).readMain(signal()), 'network_error');
    const controller = new AbortController();
    const pending = createGitHubRepoStore({ token: GITHUB_TOKEN, repository: REPOSITORY, fetch: hangingFetch }).readMain(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses answers of the wrong shape', async () => {
    const { github, store } = setup();
    github.override = (req) => (req.url === REPO_URL ? { json: { private: 'yes' } } : null);
    await expectStoreError(store.readMain(signal()), 'unavailable');
    github.override = (req) => (req.url === REPO_URL ? { text: '<html>' } : null);
    await expectStoreError(store.readMain(signal()), 'unavailable');
    github.override = null;
    github.put(MAIN_PATH, 'x');
    github.override = (req) => (req.url === MAIN_URL ? { json: { type: 'file', sha: 'not a sha', size: 1, content: 'eA==', encoding: 'base64' } } : null);
    await expectStoreError(store.readMain(signal()), 'unavailable');
    github.override = (req) => (req.method === 'PUT' ? { status: 201, json: { content: { sha: '../../x' } } } : null);
    await expectStoreError(store.writeMain('y', github.sha(MAIN_PATH)!, signal()), 'unavailable');
  });

  it('sends every request to api.github.com with the token, no cookies, no cache, no referrer and no redirects', async () => {
    const { github, store } = setup();
    await store.writeMain('x', null, signal());
    await store.readMain(signal());
    await store.writeIcon(ICON_ID, new Blob([PNG]), signal());
    await store.deleteIcon(ICON_ID, signal());
    expect(github.fake.calls.length).toBeGreaterThan(4);
    for (const call of github.fake.calls) {
      expect(call.url.startsWith(`${REPO_URL}`)).toBe(true);
      expect(call.headers.get('authorization')).toBe(`Bearer ${GITHUB_TOKEN}`);
      expect(call.headers.get('x-github-api-version')).toBe('2022-11-28');
      expect(call.init).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    }
  });
});
