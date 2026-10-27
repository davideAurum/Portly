/**
 * Launch pad sync rounds end to end in the static backend: two (or three) browsers, each its own
 * backend and storage, syncing through a fake OneDrive app folder with the real OneDrive store
 * (`createFakeFetch()`; no network). Covers the first upload (`404`, create-only), taking the
 * file, deletes, the `412` race, giving up as busy, hostile, newer, oversized and missing files,
 * the first-sync choice, a new epoch, custom icons, a bookmark whose group is gone, and a local
 * change during a round.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BookmarkGroup, type BookmarksResponse, type ImportPreviewResponse } from '@portly/shared';
import * as accounts from '../handlers/accounts.ts';
import * as bookmarks from '../handlers/bookmarks.ts';
import * as profiles from '../handlers/profiles.ts';
import * as settings from '../handlers/settings.ts';
import * as transfer from '../handlers/transfer.ts';
import { createFakeFetch, type FakeFetch } from '../providers/__fixtures__/fakeFetch.ts';
import { APPROOT, createFakeOneDrive, type FakeOneDrive } from '../providers/__fixtures__/fakeOneDrive.ts';
import { MICROSOFT_CLIENT_ID } from '../providers/__fixtures__/microsoft.ts';
import { createGraphDriveStore } from '../providers/graphDrive.ts';
import { SLICE, getAccountTokens, getAccounts, getBackups, getBookmarks, getIcons, getLaunchpadSync, getOAuthClients, getSettings } from '../slices.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createTestBackend, fileForm, PNG_BYTES, type TestBackend } from '../test/harness.ts';
import { runSyncRound, SYNC_ROUNDS, type FirstSyncChoice } from './engine.ts';
import { launchpadCommitHook } from './hook.ts';
import { SyncStoreError } from './store.ts';

const T0 = 1_700_000_000_000;
const ACCOUNT = 'acc-1';
const MAIN = '/launchpad.json';

let drive: FakeOneDrive;
let fake: FakeFetch;
const open: TestBackend[] = [];

beforeEach(() => {
  drive = createFakeOneDrive();
  fake = createFakeFetch(drive.routes);
  vi.stubGlobal('fetch', fake.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const t of open.splice(0)) t.close();
});

/** A browser: its own backend and storage, signed in to the same Microsoft account, ids of its own. */
async function browser(letter: string, storage = new MemoryStorage()): Promise<TestBackend> {
  const t = await createTestBackend([settings, profiles, transfer, bookmarks, accounts], { storage, startAt: T0 });
  open.push(t);
  let n = 0;
  t.ctx.newId = () => `00000000-0000-4000-8000-${letter.repeat(2)}${String(++n).padStart(10, '0')}`;
  getSettings(t.ctx).bookmarks.autoFetchIcons = false;
  getOAuthClients(t.ctx).microsoft = { clientId: MICROSOFT_CLIENT_ID, updatedAt: T0 };
  getAccounts(t.ctx).push({
    id: ACCOUNT,
    kind: 'microsoft',
    label: 'me@outlook.com',
    email: 'me@outlook.com',
    externalId: 'subject-1',
    color: null,
    capabilities: ['calendar', 'launchpadSync'],
    enabledCapabilities: ['calendar', 'launchpadSync'],
    grantedScopes: ['files.readwrite.appfolder'],
    requestedScopes: ['files.readwrite.appfolder'],
    status: 'ok',
    statusMessage: null,
    sort: 0,
    createdAt: T0,
    updatedAt: T0,
  });
  getAccountTokens(t.ctx)[ACCOUNT] = { refreshToken: 'RT', accessToken: 'AT', accessRefreshAt: T0 + 1e12, sessionExpiresAt: T0 + 1e12, silentAttemptAt: null };
  await t.ctx.state.commit(SLICE.settings, SLICE.oauthClients, SLICE.accounts, SLICE.accountTokens);
  t.ctx.state.setCommitHook(launchpadCommitHook(t.ctx, () => undefined));
  return t;
}

function sync(t: TestBackend, choice?: FirstSyncChoice) {
  return runSyncRound(t.ctx, createGraphDriveStore(t.ctx, ACCOUNT), { sourceId: `microsoft:${ACCOUNT}`, signal: new AbortController().signal, ...(choice ? { choice } : {}) });
}

async function group(t: TestBackend, name: string): Promise<string> {
  const res = await t.json<BookmarkGroup>('POST', '/api/bookmark-groups', { name });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function bookmark(t: TestBackend, groupId: string, title: string): Promise<string> {
  const res = await t.json<{ id: string }>('POST', '/api/bookmarks', { groupId, title, url: `https://${title.toLowerCase()}.example/` });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** The launch pad as the app sees it: group names with their bookmark titles, in order. */
async function launchpad(t: TestBackend): Promise<Record<string, string[]>> {
  const { groups } = (await t.json<BookmarksResponse>('GET', '/api/bookmarks')).body;
  return Object.fromEntries(groups.map((g) => [g.name, g.bookmarks.map((b) => b.title)]));
}

describe('a first sync', () => {
  it('uploads this browser launch pad create-only when there is no file, and another browser takes it', async () => {
    const a = await browser('a');
    const work = await group(a, 'Work');
    await bookmark(a, work, 'Mail');
    expect(getLaunchpadSync(a.ctx).waiting).toBe(true);

    expect(await sync(a)).toEqual({ status: 'up_to_date', problem: null, received: false, sent: true });
    const put = fake.calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe(`${APPROOT}${MAIN}:/content?@microsoft.graph.conflictBehavior=fail`);
    expect(put.headers.has('if-match')).toBe(false);
    expect(JSON.parse(drive.text(MAIN)!)).toMatchObject({ format: 'portly-sync', version: 1, groups: [{ name: 'Work' }], bookmarks: [{ title: 'Mail' }] });
    expect(getLaunchpadSync(a.ctx)).toMatchObject({ waiting: false, status: 'up_to_date', sourceId: `microsoft:${ACCOUNT}`, version: drive.files.get(MAIN)!.eTag });

    const b = await browser('b');
    expect(await sync(b)).toMatchObject({ status: 'up_to_date', received: true, sent: false });
    expect(await launchpad(b)).toEqual({ Work: ['Mail'] });
    // Ids are kept, unlike an import.
    expect(getBookmarks(b.ctx).groups[0]!.id).toBe(work);
  });

  it('asks when both have a launch pad, then uses the synced one after a backup', async () => {
    const a = await browser('a');
    await bookmark(a, await group(a, 'Work'), 'Mail');
    await sync(a);
    const b = await browser('b');
    await bookmark(b, await group(b, 'Home'), 'News');

    expect(await sync(b)).toMatchObject({ status: 'needs_choice', sent: false });
    expect(await launchpad(b)).toEqual({ Home: ['News'] });
    expect(getLaunchpadSync(b.ctx).status).toBe('needs_choice');

    expect(await sync(b, 'use_synced')).toMatchObject({ status: 'up_to_date', received: true });
    expect(await launchpad(b)).toEqual({ Work: ['Mail'] });
    expect(getBackups(b.ctx).entries.map((e) => e.reason)).toEqual(['sync']);
    expect(JSON.parse(drive.text(MAIN)!).bookmarks.map((x: { title: string }) => x.title)).toEqual(['Mail']);
  });

  it('can replace the synced launch pad instead, with a new epoch the other browsers follow', async () => {
    const a = await browser('a');
    await bookmark(a, await group(a, 'Work'), 'Mail');
    await sync(a);
    const firstEpoch = JSON.parse(drive.text(MAIN)!).epoch;
    const b = await browser('b');
    await bookmark(b, await group(b, 'Home'), 'News');
    a.tick(1000);
    b.tick(1000);

    expect(await sync(b, 'replace_synced')).toMatchObject({ status: 'up_to_date', sent: true });
    const file = JSON.parse(drive.text(MAIN)!);
    expect(file.epoch).not.toBe(firstEpoch);
    expect(file.bookmarks.map((x: { title: string }) => x.title)).toEqual(['News']);

    // A sees the new epoch: a backup, then its old rows follow the new file.
    a.tick(1000);
    expect(await sync(a)).toMatchObject({ status: 'up_to_date', received: true });
    expect(await launchpad(a)).toEqual({ Home: ['News'] });
    expect(getBackups(a.ctx).entries.map((e) => e.reason)).toEqual(['sync']);
  });
});

describe('changes between browsers', () => {
  async function pair(): Promise<[TestBackend, TestBackend, string]> {
    const a = await browser('a');
    const work = await group(a, 'Work');
    await bookmark(a, work, 'Mail');
    await sync(a);
    const b = await browser('b');
    await sync(b);
    return [a, b, work];
  }

  it('stops after one small request when nothing changed', async () => {
    const [a] = await pair();
    const before = fake.calls.length;
    expect(await sync(a)).toEqual({ status: 'up_to_date', problem: null, received: false, sent: false });
    expect(fake.calls.slice(before).map((c) => c.method)).toEqual(['GET']);
    // A wrote the file and B downloaded it once; A never downloads its own write.
    expect(drive.count('download')).toBe(1);
  });

  it('carries a rename, a move and a delete across, and keeps edits made on both sides', async () => {
    const [a, b, work] = await pair();
    const home = await group(b, 'Home');
    const mail = getBookmarks(b.ctx).bookmarks[0]!.id;
    a.tick(1000);
    b.tick(2000);
    await a.json('PATCH', `/api/bookmark-groups/${work}`, { name: 'Office' });
    await b.json('POST', `/api/bookmarks/${mail}/move`, { groupId: home, index: 0 });
    await sync(a);
    await sync(b);
    await sync(a);
    expect(await launchpad(a)).toEqual({ Office: [], Home: ['Mail'] });
    expect(await launchpad(b)).toEqual(await launchpad(a));

    b.tick(1000);
    expect((await b.call('DELETE', `/api/bookmarks/${mail}`)).status).toBe(204);
    await sync(b);
    await sync(a);
    expect(await launchpad(a)).toEqual({ Office: [], Home: [] });
    expect(getBookmarks(a.ctx).deleted).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'bookmark', id: mail })]));
  });

  it('starts again when another browser writes between the read and the write (412)', async () => {
    const [a, b, work] = await pair();
    a.tick(1000);
    b.tick(1000);
    await bookmark(a, work, 'Wiki');
    await bookmark(b, work, 'News');
    await sync(b);
    // B wrote meanwhile: A's first write gets 412; it reads again, merges and writes both.
    drive.beforeNextWrite = null;
    const writesBefore = drive.count('put');
    a.tick(1000);
    await bookmark(a, work, 'Docs');
    // Another browser renames News (a later stamp) just before A writes.
    drive.beforeNextWrite = () => {
      const file = JSON.parse(drive.text(MAIN)!);
      const news = file.bookmarks.find((x: { title: string }) => x.title === 'News');
      Object.assign(news, { title: 'News (B)', updatedAt: news.updatedAt + 60_000 });
      drive.put(MAIN, JSON.stringify(file));
    };
    expect(await sync(a)).toMatchObject({ status: 'up_to_date', sent: true });
    expect(drive.count('put') - writesBefore).toBe(2);
    const titles = JSON.parse(drive.text(MAIN)!).bookmarks.map((x: { title: string }) => x.title).sort();
    expect(titles).toEqual(['Docs', 'Mail', 'News (B)', 'Wiki']);
  });

  it('gives up as busy after three lost races, and keeps the changes waiting', async () => {
    const [a, , work] = await pair();
    a.tick(1000);
    await bookmark(a, work, 'Wiki');
    let races = 0;
    const race = (): void => {
      races++;
      drive.put(MAIN, drive.text(MAIN)!);
      if (races < SYNC_ROUNDS) drive.beforeNextWrite = race;
    };
    drive.beforeNextWrite = race;
    expect(await sync(a)).toMatchObject({ status: 'busy', sent: false });
    expect(races).toBe(SYNC_ROUNDS);
    expect(getLaunchpadSync(a.ctx)).toMatchObject({ status: 'busy', waiting: true });
  });

  it('starts again when this browser changes during a round, so the change is merged too', async () => {
    const [a, , work] = await pair();
    a.tick(1000);
    await bookmark(a, work, 'Wiki');
    let once = true;
    // Right after the round reads the file, a local change comes in, as a user's would.
    const store = createGraphDriveStore(a.ctx, ACCOUNT);
    const readMain = store.readMain.bind(store);
    store.readMain = async (signal) => {
      const result = await readMain(signal);
      if (once) {
        once = false;
        await bookmark(a, work, 'Late');
      }
      return result;
    };
    expect(await runSyncRound(a.ctx, store, { sourceId: `microsoft:${ACCOUNT}`, signal: new AbortController().signal })).toMatchObject({ status: 'up_to_date', sent: true });
    expect(JSON.parse(drive.text(MAIN)!).bookmarks.map((x: { title: string }) => x.title).sort()).toEqual(['Late', 'Mail', 'Wiki']);
    expect(getLaunchpadSync(a.ctx).waiting).toBe(false);
  });

  it('shows a bookmark whose group was deleted elsewhere under "No group", without sending that back', async () => {
    const [a, b, work] = await pair();
    a.tick(1000);
    b.tick(1000);
    expect((await a.call('DELETE', `/api/bookmark-groups/${work}`)).status).toBe(204);
    await bookmark(b, work, 'Added');
    await sync(a);
    b.tick(1000);
    await sync(b);
    expect(await launchpad(b)).toEqual({ 'No group': ['Added'] });
    expect(getSettings(b.ctx).bookmarks.ungroupedGroupId).toBe(getBookmarks(b.ctx).groups[0]!.id);
    // The file keeps the bookmark's own group; the "No group" group itself is a real, synced change.
    const file = JSON.parse(drive.text(MAIN)!);
    expect(file.bookmarks.find((x: { title: string }) => x.title === 'Added').groupId).toBe(work);
    expect(file.groups.map((g: { name: string }) => g.name)).toContain('No group');
    // A gets the same view.
    await sync(a);
    expect(await launchpad(a)).toEqual({ 'No group': ['Added'] });
  });

  it('sends a bookmark shown under "No group" back with its own group, also when the write is retried', async () => {
    const [a, b, work] = await pair();
    a.tick(1000);
    b.tick(1000);
    await a.call('DELETE', `/api/bookmark-groups/${work}`);
    await bookmark(b, work, 'Added');
    await sync(a);
    b.tick(1000);
    // B's first write loses a race, so B builds its launch pad again after the repair.
    drive.beforeNextWrite = () => drive.put(MAIN, drive.text(MAIN)!);
    expect(await sync(b)).toMatchObject({ status: 'up_to_date', sent: true });
    const file = JSON.parse(drive.text(MAIN)!);
    expect(file.bookmarks.find((x: { title: string }) => x.title === 'Added').groupId).toBe(work);
    // Moved again here, it is a real move and goes up.
    const added = getBookmarks(b.ctx).bookmarks.find((x) => x.title === 'Added')!;
    const home = await group(b, 'Home');
    b.tick(1000);
    await b.json('POST', `/api/bookmarks/${added.id}/move`, { groupId: home, index: 0 });
    await sync(b);
    expect(JSON.parse(drive.text(MAIN)!).bookmarks.find((x: { title: string }) => x.title === 'Added').groupId).toBe(home);
  });

  it('keeps bookmarks in a group this browser cannot sync where they are', async () => {
    const [a] = await pair();
    // A group stored before the name limit: it stays in this browser, unsynced.
    const slice = getBookmarks(a.ctx);
    slice.groups.push({ id: 'old-group', name: 'x'.repeat(150), sort: 9, color: null, collapsed: false, createdAt: T0, updatedAt: T0, placedAt: T0 });
    await a.ctx.state.commit(SLICE.bookmarks);
    a.tick(1000);
    await bookmark(a, 'old-group', 'Kept');
    await sync(a);
    await sync(a);
    expect(getBookmarks(a.ctx).bookmarks.find((x) => x.title === 'Kept')!.groupId).toBe('old-group');
    expect(getBookmarks(a.ctx).groups.map((g) => g.name)).not.toContain('No group');
    expect(JSON.parse(drive.text(MAIN)!).groups.map((g: { id: string }) => g.id)).not.toContain('old-group');
  });

  it('syncs custom icons as separate files, checked on the way in', async () => {
    const [a, b] = await pair();
    const mail = getBookmarks(a.ctx).bookmarks[0]!.id;
    a.tick(1000);
    expect((await a.call('POST', `/api/bookmarks/${mail}/icon`, fileForm(new Uint8Array(PNG_BYTES), 'icon.png', 'image/png'))).status).toBe(200);
    const iconId = getBookmarks(a.ctx).bookmarks[0]!.iconId!;
    await sync(a);
    expect(drive.files.has(`/launchpad-icons/${iconId}`)).toBe(true);
    const iconPut = fake.calls.find((c) => c.url.includes('launchpad-icons'))!;
    expect(iconPut.url).toContain('conflictBehavior=fail');
    expect(fake.calls.findIndex((c) => c.url.includes('launchpad-icons'))).toBeLessThan(fake.calls.findLastIndex((c) => c.method === 'PUT' && c.url.includes(MAIN)));

    await sync(b);
    expect(getIcons(b.ctx).map((i) => [i.id, i.type])).toEqual([[iconId, 'image/png']]);
    expect((await b.ctx.state.getBlob(iconId))?.bytes).toEqual(new Uint8Array(PNG_BYTES));
    expect((await b.json<BookmarksResponse>('GET', '/api/bookmarks')).body.groups[0]!.bookmarks[0]).toMatchObject({ iconMode: 'custom', iconId });
  });

  it('shows a synced icon that fails its checks as automatic, in this browser only', async () => {
    const [a, b] = await pair();
    const mail = getBookmarks(a.ctx).bookmarks[0]!.id;
    await a.call('POST', `/api/bookmarks/${mail}/icon`, fileForm(new Uint8Array(PNG_BYTES), 'icon.png', 'image/png'));
    const iconId = getBookmarks(a.ctx).bookmarks[0]!.iconId!;
    await sync(a);
    drive.put(`/launchpad-icons/${iconId}`, '<svg onload="alert(1)">');
    await sync(b);
    expect(getIcons(b.ctx)).toEqual([]);
    expect((await b.json<BookmarksResponse>('GET', '/api/bookmarks')).body.groups[0]!.bookmarks[0]).toMatchObject({ iconMode: 'auto' });
    // Nothing goes back up: the file still names the custom icon.
    expect(JSON.parse(drive.text(MAIN)!).bookmarks[0]).toMatchObject({ iconMode: 'custom', iconId });
  });

  it('replaces the launch pad in every browser after a config import', async () => {
    const [a, b] = await pair();
    const exported = await (await b.call('GET', '/api/export')).text();
    a.tick(1000);
    const preview = await a.json<ImportPreviewResponse>('POST', '/api/import/preview', fileForm(exported, 'portly-export.json', 'application/json'));
    await a.json('POST', '/api/import/commit', { previewId: preview.body.previewId });
    await sync(a);
    b.tick(1000);
    await sync(b);
    // Same content, new ids: the old rows are gone everywhere, not doubled.
    expect(await launchpad(b)).toEqual({ Work: ['Mail'] });
    expect(getBookmarks(b.ctx).groups[0]!.id).toBe(getBookmarks(a.ctx).groups[0]!.id);
  });
});

describe('a file that cannot be used', () => {
  async function synced(): Promise<TestBackend> {
    const a = await browser('a');
    await bookmark(a, await group(a, 'Work'), 'Mail');
    await sync(a);
    return a;
  }

  it('refuses a hostile file, changes nothing and never overwrites it', async () => {
    const a = await synced();
    const hostile = drive.text(MAIN)!.replace('"title":"Mail"', '"title":"Mail","__proto__":{"admin":true}');
    drive.put(MAIN, hostile);
    a.tick(1000);
    await bookmark(a, getBookmarks(a.ctx).groups[0]!.id, 'Wiki');
    expect(await sync(a)).toEqual({ status: 'refused', problem: 'unsafe_json', received: false, sent: false });
    expect(drive.text(MAIN)).toBe(hostile);
    expect(await launchpad(a)).toEqual({ Work: ['Mail', 'Wiki'] });
    expect(getLaunchpadSync(a.ctx)).toMatchObject({ status: 'refused', problem: 'unsafe_json', waiting: true, refused: drive.files.get(MAIN)!.eTag });
    // The same file again is not read again; a repaired one syncs.
    expect(await sync(a)).toMatchObject({ status: 'refused', problem: 'unsafe_json' });
    drive.put(MAIN, hostile.replace(',"__proto__":{"admin":true}', ''));
    expect(await sync(a)).toMatchObject({ status: 'up_to_date', sent: true });
    expect(getLaunchpadSync(a.ctx).refused).toBeNull();
  });

  it('stops at a file from a newer Portly', async () => {
    const a = await synced();
    const newer = JSON.stringify({ ...JSON.parse(drive.text(MAIN)!), version: 2 });
    drive.put(MAIN, newer);
    expect(await sync(a)).toMatchObject({ status: 'stopped_newer', problem: 'newer_version', sent: false });
    expect(drive.text(MAIN)).toBe(newer);
  });

  it('refuses an oversized file before downloading it', async () => {
    const a = await synced();
    drive.failNext = [{ json: { id: 'x', eTag: '"x,1"', size: 25 * 1024 * 1024 + 1, '@microsoft.graph.downloadUrl': 'https://my.microsoftpersonalcontent.com/download/t1' } }];
    const downloads = drive.count('download');
    await expect(sync(a)).rejects.toMatchObject({ name: 'SyncStoreError', code: 'too_large' });
    expect(drive.count('download')).toBe(downloads);
  });

  it('uploads again when the file disappeared after this browser synced, without deleting anything here', async () => {
    const a = await synced();
    drive.files.delete(MAIN);
    expect(await sync(a)).toMatchObject({ status: 'up_to_date', sent: true });
    expect(await launchpad(a)).toEqual({ Work: ['Mail'] });
    expect(JSON.parse(drive.text(MAIN)!).bookmarks.map((x: { title: string }) => x.title)).toEqual(['Mail']);
  });

  it('passes store failures on for the backoff', async () => {
    const a = await synced();
    drive.failNext = [{ status: 429, headers: { 'retry-after': '120' }, json: { error: { code: 'activityLimitReached' } } }];
    await expect(sync(a)).rejects.toEqual(new SyncStoreError('rate_limited', 'OneDrive is rate limiting requests', 120_000));
  });
});
