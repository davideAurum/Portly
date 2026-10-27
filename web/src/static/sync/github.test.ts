/**
 * Launch pad sync through the GitHub repository store, end to end against an in-memory GitHub (no
 * live calls): the first write to an empty repository, an unchanged file (304), a conflict with
 * another browser's write, one sync connection per browser (switching source, two at once),
 * removing and replacing the token, a refused token, and one request at a time.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bookmarks from '../handlers/bookmarks.ts';
import * as settings from '../handlers/settings.ts';
import { GITHUB_TOKEN, REPOSITORY, REPO_URL, createFakeGitHub, type FakeGitHub } from '../providers/__fixtures__/github.ts';
import type { FetchLike } from '../lib/fetch.ts';
import { MAIN_PATH } from '../providers/githubRepo.ts';
import { clearGitHubSync, openGitHubStore, storeGitHubSync } from '../providers/githubSync.ts';
import { SLICE, getAccounts, getLaunchpadSync, type StoredAccount } from '../slices.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import { CHANGE_DELAY_MS, startLaunchpadSync, type LaunchpadSyncController, type LaunchpadSyncDeps } from './scheduler.ts';
import type { SyncFileVersion, SyncStore } from './store.ts';
import type { BookmarkGroup, BookmarksResponse } from '@portly/shared';

const T0 = 1_800_000_000_000;
const MAIN_URL = `${REPO_URL}/contents/${MAIN_PATH}`;

let github: FakeGitHub;
const backends: TestBackend[] = [];
const controllers: LaunchpadSyncController[] = [];

afterEach(() => {
  for (const c of controllers.splice(0)) c.stop();
  for (const t of backends.splice(0)) t.close();
  vi.unstubAllGlobals();
});

function setupGitHub(): FakeGitHub {
  github = createFakeGitHub();
  vi.stubGlobal('fetch', github.fake.fetch);
  return github;
}

/** A browser with the GitHub settings saved and sync started (scheduled checks driven by hand). */
async function browser(options: { github?: boolean; storeFor?: LaunchpadSyncDeps['storeFor']; timers?: LaunchpadSyncDeps['timers'] } = {}) {
  const t = await createTestBackend([settings, bookmarks], { startAt: T0 });
  backends.push(t);
  if (options.github !== false) await storeGitHubSync(t.ctx, GITHUB_TOKEN, REPOSITORY);
  const timers = options.timers ?? { setTimeout: () => 0, clearTimeout: () => undefined };
  const controller = startLaunchpadSync(t.ctx, { timers, locks: null, page: null, ...(options.storeFor ? { storeFor: options.storeFor } : {}) });
  controllers.push(controller);
  // The page-load run.
  await controller.run('interval');
  return { t, controller };
}

async function group(t: TestBackend, name: string): Promise<string> {
  const res = await t.json<BookmarkGroup>('POST', '/api/bookmark-groups', { name });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function bookmark(t: TestBackend, groupId: string, title: string): Promise<void> {
  const res = await t.json('POST', '/api/bookmarks', { groupId, title, url: `https://${title.toLowerCase()}.example/` });
  expect(res.status).toBe(201);
}

async function launchpad(t: TestBackend): Promise<Record<string, string[]>> {
  const { groups } = (await t.json<BookmarksResponse>('GET', '/api/bookmarks')).body;
  return Object.fromEntries(groups.map((g) => [g.name, g.bookmarks.map((b) => b.title)]));
}

function syncedTitles(): string[] {
  return (JSON.parse(github.text(MAIN_PATH)!) as { bookmarks: { title: string }[] }).bookmarks.map((b) => b.title).sort();
}

function microsoftAccount(): StoredAccount {
  return {
    id: 'acc-1',
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
    createdAt: T0,
    updatedAt: T0,
  };
}

/** A OneDrive stand-in kept in memory. */
function memoryStore(): SyncStore & { file: SyncFileVersion | null } {
  let n = 0;
  const store = {
    kind: 'onedrive' as const,
    file: null as SyncFileVersion | null,
    readMain: async () => store.file,
    async writeMain(text: string, ifVersion: string | null) {
      if ((store.file?.version ?? null) !== ifVersion) return { ok: false as const, reason: 'conflict' as const };
      store.file = { text, version: `od-${++n}` };
      return { ok: true as const, version: store.file.version };
    },
    readIcon: async () => null,
    writeIcon: async () => undefined,
    deleteIcon: async () => undefined,
  };
  return store;
}

describe('launch pad sync through GitHub', () => {
  it('writes the first file to an empty repository without a sha, and another browser takes it', async () => {
    setupGitHub();
    // A launch pad first, then the repository and token saved: the next check takes them.
    const a = await browser({ github: false });
    expect(getLaunchpadSync(a.t.ctx).status).toBe('off');
    await bookmark(a.t, await group(a.t, 'Work'), 'Mail');
    await storeGitHubSync(a.t.ctx, GITHUB_TOKEN, REPOSITORY);

    expect(await a.controller.syncNow()).toEqual({ status: 'up_to_date', problem: null, received: false, sent: true });
    const put = github.calls('PUT', /contents\/launchpad\.json$/);
    expect(put).toHaveLength(1);
    expect(JSON.parse(put[0]!.body!)).not.toHaveProperty('sha');
    expect(syncedTitles()).toEqual(['Mail']);
    const state = getLaunchpadSync(a.t.ctx);
    expect(state).toMatchObject({ status: 'up_to_date', waiting: false, version: github.sha(MAIN_PATH) });
    // The source is the repository's hash: its name is never kept in the sync state.
    expect(state.sourceId).toMatch(/^github:[0-9a-f]{64}$/);
    expect(JSON.stringify(state)).not.toContain(REPOSITORY.name);

    const b = await browser();
    expect(await launchpad(b.t)).toEqual({ Work: ['Mail'] });
    expect(getLaunchpadSync(b.t.ctx).sourceId).toBe(state.sourceId);
  });

  it('checks an unchanged file with If-None-Match: a 304, nothing written', async () => {
    setupGitHub();
    const a = await browser();
    await bookmark(a.t, await group(a.t, 'Work'), 'Mail');
    await a.controller.syncNow();
    await a.controller.syncNow();
    const before = github.fake.calls.length;

    expect(await a.controller.syncNow()).toEqual({ status: 'up_to_date', problem: null, received: false, sent: false });
    const calls = github.fake.calls.slice(before);
    // One store per page load: the private-repository check is not repeated, only the file is asked for.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${MAIN_URL}`]);
    expect(calls[0]!.headers.get('if-none-match')).toBe(`"${github.sha(MAIN_PATH)}"`);
    expect(github.calls('GET', new RegExp(`${REPO_URL}$`))).toHaveLength(1);
  });

  it('merges again when another browser wrote between the read and the write (409)', async () => {
    setupGitHub();
    const a = await browser();
    const work = await group(a.t, 'Work');
    await bookmark(a.t, work, 'Mail');
    await a.controller.syncNow();
    const first = github.text(MAIN_PATH)!;

    // Another browser adds News; the file is put back so this browser reads the old one.
    const b = await browser();
    await bookmark(b.t, work, 'News');
    await b.controller.syncNow();
    const theirs = github.text(MAIN_PATH)!;
    github.put(MAIN_PATH, first);

    await bookmark(a.t, work, 'Docs');
    let raced = false;
    github.beforeWrite = (req) => {
      if (raced || !req.url.endsWith(MAIN_PATH)) return;
      raced = true;
      github.put(MAIN_PATH, theirs);
    };
    expect(await a.controller.syncNow()).toMatchObject({ status: 'up_to_date', sent: true, received: true });
    expect(raced).toBe(true);
    // The refused write and the one after the second merge.
    expect(github.calls('PUT', /contents\/launchpad\.json$/).length).toBeGreaterThanOrEqual(3);
    expect(syncedTitles()).toEqual(['Docs', 'Mail', 'News']);
    expect(await launchpad(a.t)).toEqual({ Work: ['Mail', 'News', 'Docs'] });
  });

  it('syncs with nothing while two sync connections are set up, and starts over when the source changes', async () => {
    setupGitHub();
    const onedrive = memoryStore();
    const storeFor: LaunchpadSyncDeps['storeFor'] = (ctx, source) => (source.kind === 'github' ? openGitHubStore(ctx) : onedrive);
    const a = await browser({ storeFor });
    await bookmark(a.t, await group(a.t, 'Work'), 'Mail');
    await a.controller.syncNow();
    const githubSource = getLaunchpadSync(a.t.ctx).sourceId;

    // A Microsoft connection with Launch pad sync on as well: neither is used.
    getAccounts(a.t.ctx).push(microsoftAccount());
    await a.t.ctx.state.commit(SLICE.accounts);
    const before = github.fake.calls.length;
    expect(await a.controller.syncNow()).toBeNull();
    expect(getLaunchpadSync(a.t.ctx).status).toBe('several_sources');
    expect(github.fake.calls.length).toBe(before);
    expect(onedrive.file).toBeNull();

    // GitHub removed: OneDrive is the only one left, a new source whose file is unknown here.
    await clearGitHubSync(a.t.ctx);
    expect(await a.controller.syncNow()).toMatchObject({ status: 'up_to_date', sent: true });
    const state = getLaunchpadSync(a.t.ctx);
    expect(state.sourceId).toBe('microsoft:acc-1');
    expect(JSON.parse(onedrive.file!.text).bookmarks.map((b: { title: string }) => b.title)).toEqual(['Mail']);
    expect(github.fake.calls.length).toBe(before);

    // Back to GitHub (the Microsoft connection's service off): a first sync there again, and both have a launch pad.
    getAccounts(a.t.ctx)[0]!.enabledCapabilities = ['calendar'];
    await a.t.ctx.state.commit(SLICE.accounts);
    await storeGitHubSync(a.t.ctx, GITHUB_TOKEN, REPOSITORY);
    expect(await a.controller.syncNow()).toMatchObject({ status: 'needs_choice' });
    expect(getLaunchpadSync(a.t.ctx).sourceId).toBe(githubSource);
  });

  it('stops when the token is removed, and a new token for the same repository carries on without a first sync', async () => {
    setupGitHub();
    const a = await browser();
    await bookmark(a.t, await group(a.t, 'Work'), 'Mail');
    await a.controller.syncNow();
    const synced = { ...getLaunchpadSync(a.t.ctx) };

    await clearGitHubSync(a.t.ctx);
    const before = github.fake.calls.length;
    expect(await a.controller.syncNow()).toBeNull();
    expect(getLaunchpadSync(a.t.ctx).status).toBe('off');
    expect(github.fake.calls.length).toBe(before);

    // Saved again (a new token): a new store, which checks the repository again, and the same source.
    await storeGitHubSync(a.t.ctx, GITHUB_TOKEN, REPOSITORY);
    expect(await a.controller.syncNow()).toMatchObject({ status: 'up_to_date', sent: false });
    expect(github.calls('GET', new RegExp(`${REPO_URL}$`))).toHaveLength(2);
    expect(getLaunchpadSync(a.t.ctx)).toMatchObject({ sourceId: synced.sourceId, epoch: synced.epoch });
  });

  it('pauses scheduled checks after GitHub refuses the token, until new settings are saved or Sync now', async () => {
    setupGitHub();
    const a = await browser();
    github.override = () => ({ status: 401, json: { message: 'Bad credentials', status: '401' } });
    await bookmark(a.t, await group(a.t, 'Work'), 'Mail');

    expect(await a.controller.run('interval')).toBeNull();
    expect(getLaunchpadSync(a.t.ctx)).toMatchObject({ status: 'paused_reauth', failures: 0 });
    const before = github.fake.calls.length;
    await a.controller.run('interval');
    await a.controller.run('change');
    expect(github.fake.calls.length).toBe(before);

    github.override = null;
    await storeGitHubSync(a.t.ctx, GITHUB_TOKEN, REPOSITORY);
    expect(await a.controller.run('interval')).toMatchObject({ status: 'up_to_date', sent: true });
    expect(getLaunchpadSync(a.t.ctx).pausedFor).toBeNull();
  });

  it('syncs a few seconds after the repository and token are saved, without waiting for the next check', async () => {
    setupGitHub();
    const due: { fn: () => void; ms: number }[] = [];
    const a = await browser({ github: false, timers: { setTimeout: (fn, ms) => due.push({ fn, ms }), clearTimeout: () => undefined } });
    await bookmark(a.t, await group(a.t, 'Work'), 'Mail');
    due.length = 0;
    await storeGitHubSync(a.t.ctx, GITHUB_TOKEN, REPOSITORY);
    expect(due.map((d) => d.ms)).toEqual([CHANGE_DELAY_MS]);
    due[0]!.fn();
    await vi.waitFor(() => expect(github.text(MAIN_PATH)).toBeDefined());
    expect(syncedTitles()).toEqual(['Mail']);
  });

  it('tries a new source at once, whatever backoff the old one had', async () => {
    setupGitHub();
    const onedrive = memoryStore();
    const storeFor: LaunchpadSyncDeps['storeFor'] = (ctx, source) => (source.kind === 'github' ? openGitHubStore(ctx) : onedrive);
    const a = await browser({ storeFor });
    await bookmark(a.t, await group(a.t, 'Work'), 'Mail');
    github.override = () => ({ status: 503, json: { message: 'Unavailable' } });
    await a.controller.run('interval');
    expect(getLaunchpadSync(a.t.ctx)).toMatchObject({ status: 'error', failures: 1 });
    expect(getLaunchpadSync(a.t.ctx).retryAt).toBeGreaterThan(a.t.ctx.now());

    await clearGitHubSync(a.t.ctx);
    getAccounts(a.t.ctx).push(microsoftAccount());
    await a.t.ctx.state.commit(SLICE.accounts);
    expect(await a.controller.run('interval')).toMatchObject({ status: 'up_to_date', sent: true });
    expect(getLaunchpadSync(a.t.ctx)).toMatchObject({ sourceId: 'microsoft:acc-1', failures: 0, retryAt: 0 });
  });

  it('sends one request at a time, however many runs are asked for at once', async () => {
    setupGitHub();
    let inFlight = 0;
    let most = 0;
    const slow: FetchLike = async (input, init) => {
      inFlight++;
      most = Math.max(most, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await github.fake.fetch(input, init);
      } finally {
        inFlight--;
      }
    };
    vi.stubGlobal('fetch', slow);
    const a = await browser();
    await bookmark(a.t, await group(a.t, 'Work'), 'Mail');
    await Promise.all([a.controller.syncNow(), a.controller.run('change'), a.controller.syncNow(), a.controller.run('online')]);
    expect(most).toBe(1);
    expect(syncedTitles()).toEqual(['Mail']);
  });
});
