/**
 * The gist sync store against an in-memory GitHub (no live calls): finding and creating the
 * secret gists, the version check and the repair of an interleaved write, files over 1 MB through
 * `raw_url`, icons as base64 files, size caps, error mapping and hostile answers.
 */
import { describe, expect, it } from 'vitest';
import { SyncStoreError } from '../sync/store.ts';
import { CLASSIC_TOKEN, GITHUB_TOKEN, INLINE_LIMIT, OWNER, createFakeGitHub } from './__fixtures__/github.ts';
import { failingFetch, hangingFetch } from './__fixtures__/fakeFetch.ts';
import {
  GIST_ICON_MAX_BYTES,
  GIST_MAIN_MAX_BYTES,
  ICONS_MARKER_FILE,
  MAIN_FILE,
  createGistStore,
  iconFileName,
  rawUrl,
  statusError,
  type GistIds,
  type GistStoreOptions,
} from './githubGist.ts';

const ICON_ID = '3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const OTHER_ICON = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
const signal = () => new AbortController().signal;

function setup(options: Partial<GistStoreOptions> = {}) {
  const github = createFakeGitHub();
  const saved: GistIds[] = [];
  const store = createGistStore({ token: GITHUB_TOKEN, fetch: github.fake.fetch, onIdsChange: (ids) => void saved.push(ids), now: () => 1_800_000_000_000, ...options });
  return { github, store, saved };
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

describe('gist store: main file', () => {
  it('reads null with no sync gist, then creates a secret gist and remembers it', async () => {
    const { github, store, saved } = setup();
    expect(await store.readMain(signal())).toBeNull();
    const written = await store.writeMain('{"a":1}', null, signal());
    expect(written.ok).toBe(true);
    const created = github.calls('POST')[0]!;
    expect(JSON.parse(created.body!)).toMatchObject({ public: false, files: { [MAIN_FILE]: { content: '{"a":1}' } } });
    expect(created.headers.get('authorization')).toBe(`Bearer ${GITHUB_TOKEN}`);
    expect(created.headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(created.init.cache).toBe('no-store');
    expect(created.init.credentials).toBe('omit');
    expect(created.init.redirect).toBe('error');
    const gist = [...github.gists.values()][0]!;
    expect(gist.public).toBe(false);
    expect(saved.at(-1)).toEqual({ main: gist.id, icons: null });

    const read = await store.readMain(signal());
    expect(read).toEqual({ text: '{"a":1}', version: written.ok ? written.version : '' });
    expect(read?.version).toBe(gist.history[0]!.version);
  });

  it('finds an existing sync gist by its file name, oldest first, and ignores public ones', async () => {
    const { github, store, saved } = setup();
    github.seed({ 'notes.md': 'other' });
    github.seed({ [MAIN_FILE]: 'public copy' }, { public: true, createdAt: '2026-01-01T00:00:00Z' });
    const oldest = github.seed({ [MAIN_FILE]: 'oldest' }, { createdAt: '2026-02-01T00:00:00Z' });
    github.seed({ [MAIN_FILE]: 'newer' }, { createdAt: '2026-03-01T00:00:00Z' });
    expect((await store.readMain(signal()))?.text).toBe('oldest');
    expect(saved).toEqual([{ main: oldest.id, icons: null }]);
    // Remembered: the next read goes straight to the gist.
    const lists = github.calls('GET', /\/gists\?/).length;
    await store.readMain(signal());
    expect(github.calls('GET', /\/gists\?/)).toHaveLength(lists);
  });

  it('looks through every page of the account gists', async () => {
    const { github, store } = setup();
    const target = github.seed({ [MAIN_FILE]: 'found' }, { createdAt: '2020-01-01T00:00:00Z' });
    for (let i = 0; i < 150; i++) github.seed({ [`n${i}.md`]: 'x' });
    expect((await store.readMain(signal()))?.text).toBe('found');
    expect(github.calls('GET', /\/gists\?.*page=2/)).toHaveLength(1);
    expect(target.id).toBeTruthy();
  });

  it('writes only while the version is unchanged', async () => {
    const { github, store } = setup();
    const gist = github.seed({ [MAIN_FILE]: 'v1' });
    const first = await store.readMain(signal());
    github.write(gist.id, { [MAIN_FILE]: 'from another browser' });
    expect(await store.writeMain('mine', first!.version, signal())).toEqual({ ok: false, reason: 'conflict' });
    expect(gist.files.get(MAIN_FILE)).toBe('from another browser');

    const second = await store.readMain(signal());
    const result = await store.writeMain('merged', second!.version, signal());
    expect(result).toEqual({ ok: true, version: gist.history[0]!.version });
    expect(gist.files.get(MAIN_FILE)).toBe('merged');
  });

  it('refuses a create-only write when the file exists, and a versioned one when it is gone', async () => {
    const { github, store } = setup();
    const gist = github.seed({ [MAIN_FILE]: 'v1' });
    expect(await store.writeMain('x', null, signal())).toEqual({ ok: false, reason: 'conflict' });
    const read = await store.readMain(signal());
    github.write(gist.id, { [MAIN_FILE]: null, 'other.txt': 'y' });
    expect(await store.writeMain('x', read!.version, signal())).toEqual({ ok: false, reason: 'conflict' });
    // The file is missing now: a create-only write adds it to the same gist.
    expect(await store.readMain(signal())).toBeNull();
    expect((await store.writeMain('x', null, signal())).ok).toBe(true);
    expect(gist.files.get(MAIN_FILE)).toBe('x');
    expect(github.gists.size).toBe(1);
  });

  it('answers ok with the same version when the text did not change', async () => {
    const { github, store } = setup();
    const gist = github.seed({ [MAIN_FILE]: 'same' });
    const read = await store.readMain(signal());
    expect(await store.writeMain('same', read!.version, signal())).toEqual({ ok: true, version: read!.version });
    expect(gist.history).toHaveLength(1);
  });

  it('puts back a write that landed between the check and the write, and answers conflict', async () => {
    const { github, store } = setup();
    const gist = github.seed({ [MAIN_FILE]: 'base' });
    const read = await store.readMain(signal());
    let theirs = '';
    github.beforePatch = (req, g) => {
      github.beforePatch = null;
      theirs = github.write(g.id, { [MAIN_FILE]: 'theirs' });
      expect(req.body).toContain('mine');
    };
    expect(await store.writeMain('mine', read!.version, signal())).toEqual({ ok: false, reason: 'conflict' });
    // Their text is current again, so the engine's next read merges it.
    expect(gist.files.get(MAIN_FILE)).toBe('theirs');
    expect(gist.history.map((r) => r.files.get(MAIN_FILE))).toEqual(['theirs', 'mine', 'theirs', 'base']);
    expect(github.calls('GET', new RegExp(`/gists/${gist.id}/${theirs}$`))).toHaveLength(1);
  });

  it('treats a 409 from GitHub as a conflict', async () => {
    const { github, store } = setup();
    github.seed({ [MAIN_FILE]: 'base' });
    const read = await store.readMain(signal());
    github.beforePatch = () => ({ status: 409, json: { message: 'Gist cannot be updated.' } });
    expect(await store.writeMain('mine', read!.version, signal())).toEqual({ ok: false, reason: 'conflict' });
  });

  it('forgets a deleted gist and starts again', async () => {
    const { github, store, saved } = setup();
    const gist = github.seed({ [MAIN_FILE]: 'v1' });
    const read = await store.readMain(signal());
    github.gists.delete(gist.id);
    expect(await store.readMain(signal())).toBeNull();
    expect(saved.at(-1)).toEqual({ main: null, icons: null });
    expect(await store.writeMain('new', read!.version, signal())).toEqual({ ok: false, reason: 'conflict' });
    expect((await store.writeMain('new', null, signal())).ok).toBe(true);
    expect(github.gists.size).toBe(1);
  });

  it('keeps the oldest gist when two browsers create one at the same time', async () => {
    const { github, store, saved } = setup();
    const created: string[] = [];
    github.override = (req) => {
      // The other browser's gist appears while ours is being created.
      if (req.method === 'POST' && created.length === 0) created.push(github.seed({ [MAIN_FILE]: 'theirs' }, { createdAt: '2026-01-01T00:00:00Z' }).id);
      return null;
    };
    expect(await store.writeMain('mine', null, signal())).toEqual({ ok: false, reason: 'conflict' });
    expect([...github.gists.keys()]).toEqual(created);
    expect(saved.at(-1)).toEqual({ main: created[0], icons: null });
    expect((await store.readMain(signal()))?.text).toBe('theirs');
  });

  it('reads a file over 1 MB from its raw_url as a simple request', async () => {
    const { github, store } = setup();
    const big = 'x'.repeat(INLINE_LIMIT + 10);
    github.seed({ [MAIN_FILE]: big });
    expect((await store.readMain(signal()))?.text).toBe(big);
    const raw = github.calls('GET', /gist\.githubusercontent\.com/)[0]!;
    expect(raw.headers.has('authorization')).toBe(false);
    expect([...raw.headers.keys()]).toEqual([]);
    expect(raw.init.credentials).toBe('omit');
    expect(raw.init.referrerPolicy).toBe('no-referrer');
  });

  it('refuses files over the cap before downloading them', async () => {
    const { github, store } = setup();
    expect(GIST_MAIN_MAX_BYTES).toBe(10 * 1024 * 1024);
    await expectStoreError(store.writeMain('x'.repeat(GIST_MAIN_MAX_BYTES + 1), null, signal()), 'too_large');
    expect(github.fake.calls).toHaveLength(0);
    const gist = github.seed({ [MAIN_FILE]: 'small' });
    github.override = (req) =>
      req.method === 'GET' && req.url.endsWith(gist.id)
        ? {
            json: {
              id: gist.id,
              public: false,
              created_at: gist.createdAt,
              files: { [MAIN_FILE]: { size: GIST_MAIN_MAX_BYTES + 1, truncated: true, content: 'x', raw_url: `https://gist.githubusercontent.com/${OWNER}/${gist.id}/raw/${'a'.repeat(40)}/${MAIN_FILE}` } },
              history: [{ version: 'c'.repeat(40) }],
            },
          }
        : null;
    await expectStoreError(store.readMain(signal()), 'too_large');
    expect(github.calls('GET', /gist\.githubusercontent\.com/)).toHaveLength(0);
  });

  it('refuses a public sync gist it remembered', async () => {
    const { github, store } = setup();
    const gist = github.seed({ [MAIN_FILE]: 'v1' });
    await store.readMain(signal());
    gist.public = true;
    await expectStoreError(store.readMain(signal()), 'unavailable');
  });
});

describe('gist store: icons', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 250, 251, 252]);
  const PNG_BASE64 = 'iVBORw0KGgoAAQL6+/w=';

  it('keeps icons as base64 files in their own secret gist, create-only', async () => {
    const { github, store, saved } = setup();
    const main = github.seed({ [MAIN_FILE]: 'v1' });
    const before = (await store.readMain(signal()))!.version;
    await store.writeIcon(ICON_ID, new Blob([png]), signal());
    const icons = [...github.gists.values()].find((g) => g.files.has(ICONS_MARKER_FILE))!;
    expect(icons.public).toBe(false);
    expect(icons.files.get(iconFileName(ICON_ID))).toBe(PNG_BASE64);
    expect(saved.at(-1)).toEqual({ main: main.id, icons: icons.id });
    // Icons don't move the main file's version.
    expect((await store.readMain(signal()))!.version).toBe(before);

    const patches = github.calls('PATCH').length;
    await store.writeIcon(ICON_ID, new Blob([new Uint8Array([1])]), signal());
    expect(github.calls('PATCH')).toHaveLength(patches);
    expect(icons.files.get(iconFileName(ICON_ID))).toBe(PNG_BASE64);

    await store.writeIcon(OTHER_ICON, new Blob([new Uint8Array([7, 8, 9])]), signal());
    expect(icons.files.size).toBe(3);
  });

  it('reads an icon back as bytes with no type, and null when it is missing or not base64', async () => {
    const { github, store } = setup();
    github.seed({ [ICONS_MARKER_FILE]: 'x', [iconFileName(ICON_ID)]: PNG_BASE64, [iconFileName(OTHER_ICON)]: 'not base64!' });
    const blob = await store.readIcon(ICON_ID, signal());
    expect(blob?.type).toBe('');
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(png);
    expect(await store.readIcon(OTHER_ICON, signal())).toBeNull();
    expect(await store.readIcon('11111111-2222-4333-8444-555555555555', signal())).toBeNull();
  });

  it('reuses the icons gist it read, and reads it again on a miss', async () => {
    const { github, store } = setup();
    const icons = github.seed({ [ICONS_MARKER_FILE]: 'x', [iconFileName(ICON_ID)]: 'AQID' });
    await store.readIcon(ICON_ID, signal());
    const gets = github.calls('GET', new RegExp(`/gists/${icons.id}$`)).length;
    await store.readIcon(ICON_ID, signal());
    expect(github.calls('GET', new RegExp(`/gists/${icons.id}$`))).toHaveLength(gets);
    github.write(icons.id, { [iconFileName(OTHER_ICON)]: 'BAUG' });
    expect(new Uint8Array(await (await store.readIcon(OTHER_ICON, signal()))!.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('deletes an icon file, and does nothing for one that is not there', async () => {
    const { github, store } = setup();
    const icons = github.seed({ [ICONS_MARKER_FILE]: 'x', [iconFileName(ICON_ID)]: 'AQID' });
    await store.deleteIcon(OTHER_ICON, signal());
    expect(github.calls('PATCH')).toHaveLength(0);
    await store.deleteIcon(ICON_ID, signal());
    expect(JSON.parse(github.calls('PATCH')[0]!.body!)).toEqual({ files: { [iconFileName(ICON_ID)]: null } });
    expect(icons.files.has(iconFileName(ICON_ID))).toBe(false);
  });

  it('refuses ids that are not UUIDv4 before any request', async () => {
    const { github, store } = setup();
    await expect(store.readIcon('../../gists', signal())).rejects.toThrow(RangeError);
    await expect(store.writeIcon('x', new Blob([png]), signal())).rejects.toThrow(RangeError);
    await expect(store.deleteIcon('3f2b8c4e-1a2b-1c3d-8e9f-0a1b2c3d4e5f', signal())).rejects.toThrow(RangeError);
    expect(github.fake.calls).toHaveLength(0);
  });

  it('refuses an icon too large for one gist file, and a full icons gist', async () => {
    const { github, store } = setup();
    await expectStoreError(store.writeIcon(ICON_ID, new Blob([new Uint8Array(GIST_ICON_MAX_BYTES + 1)]), signal()), 'too_large');
    const files: Record<string, string> = { [ICONS_MARKER_FILE]: 'x' };
    for (let i = 0; i < 299; i++) files[`icon-${i}.b64`] = 'AA==';
    github.seed(files);
    await expectStoreError(store.writeIcon(ICON_ID, new Blob([png]), signal()), 'too_large');
  });
});

describe('gist store: errors and hostile answers', () => {
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

  it('turns refused requests into store errors that never carry the token', async () => {
    const { github, store } = setup();
    github.override = () => ({ status: 401, json: { message: 'Bad credentials' } });
    const err = await expectStoreError(store.readMain(signal()), 'reauth_required');
    expect(err.message).not.toContain(GITHUB_TOKEN);
    github.override = () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000300' }, json: { message: 'API rate limit exceeded' } });
    expect((await expectStoreError(store.readMain(signal()), 'rate_limited')).retryAfterMs).toBe(300_000);
    github.override = () => ({ status: 503, text: 'unavailable' });
    await expectStoreError(store.writeMain('x', null, signal()), 'unavailable');
  });

  it('maps network failures and timeouts to network_error, and rethrows the caller abort', async () => {
    await expectStoreError(createGistStore({ token: CLASSIC_TOKEN, fetch: failingFetch }).readMain(signal()), 'network_error');
    const controller = new AbortController();
    const pending = createGistStore({ token: CLASSIC_TOKEN, fetch: hangingFetch }).readMain(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses answers of the wrong shape', async () => {
    const { github, store } = setup();
    github.override = (req) => (req.url.includes('/gists?') ? { json: { not: 'a list' } } : null);
    await expectStoreError(store.readMain(signal()), 'unavailable');
    github.override = (req) => (req.url.includes('/gists?') ? { text: '<html>' } : null);
    await expectStoreError(store.readMain(signal()), 'unavailable');
  });

  it('never fetches a raw_url outside the gist raw host and path', async () => {
    const { github, store } = setup();
    const gist = github.seed({ [MAIN_FILE]: 'v' });
    github.override = (req) =>
      req.method === 'GET' && req.url.endsWith(gist.id)
        ? {
            json: {
              id: gist.id,
              public: false,
              created_at: gist.createdAt,
              files: { [MAIN_FILE]: { size: 10, truncated: true, raw_url: 'https://evil.example/steal' } },
              history: [{ version: 'c'.repeat(40) }],
            },
          }
        : null;
    await expectStoreError(store.readMain(signal()), 'unavailable');
    expect(github.calls('GET', /evil/)).toHaveLength(0);
  });

  it('checks raw URLs strictly', () => {
    const sha = 'a'.repeat(40);
    const ok = `https://gist.githubusercontent.com/${OWNER}/abc123/raw/${sha}/${MAIN_FILE}`;
    expect(rawUrl(ok, 'abc123', MAIN_FILE)).toBe(ok);
    for (const bad of [
      `http://gist.githubusercontent.com/${OWNER}/abc123/raw/${sha}/${MAIN_FILE}`,
      `https://gist.githubusercontent.com:8443/${OWNER}/abc123/raw/${sha}/${MAIN_FILE}`,
      `https://raw.githubusercontent.com/${OWNER}/abc123/raw/${sha}/${MAIN_FILE}`,
      `https://gist.githubusercontent.com/${OWNER}/other/raw/${sha}/${MAIN_FILE}`,
      `https://gist.githubusercontent.com/${OWNER}/abc123/raw/${MAIN_FILE}`,
      `https://gist.githubusercontent.com/${OWNER}/abc123/raw/${sha}/other.json`,
      `https://gist.githubusercontent.com/${OWNER}/abc123/raw/${sha}/${MAIN_FILE}?x=1`,
      `https://user@gist.githubusercontent.com/${OWNER}/abc123/raw/${sha}/${MAIN_FILE}`,
      'not a url',
    ]) {
      expect(rawUrl(bad, 'abc123', MAIN_FILE), bad).toBeNull();
    }
  });

  it('ignores a remembered id of the wrong shape', async () => {
    const { github, store } = setup({ ids: { main: '../user', icons: null } });
    expect(await store.readMain(signal())).toBeNull();
    expect(github.fake.calls.every((c) => !c.url.includes('..'))).toBe(true);
  });
});
