/**
 * Launch pad sync groundwork in the bookmarks slice (design phase 1, ROADMAP 6.3): the launch pad
 * clock, `placedAt` apart from `updatedAt`, lasting tombstones from every removing path (listed
 * here from the source, so a new path cannot be added without one), the one-time upgrade and the
 * backup slots.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BookmarkGroup, ImportPreviewResponse } from '@portly/shared';
import * as bookmarks from '../handlers/bookmarks.ts';
import { SYNC_FIELDS_UPGRADE } from '../handlers/bookmarks.ts';
import * as profiles from '../handlers/profiles.ts';
import * as settings from '../handlers/settings.ts';
import * as transfer from '../handlers/transfer.ts';
import {
  MAX_BACKUPS,
  SLICE,
  TOMBSTONE_TTL_MS,
  getBackups,
  getBookmarks,
  getLaunchpadSync,
  getUpgrades,
  keepBackups,
  type BackupEntry,
  type BookmarksSlice,
  type Tombstone,
} from '../slices.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createTestBackend, fileForm, type TestBackend } from '../test/harness.ts';
import { nextStamp, observeStamp } from './clock.ts';
import { withTombstones } from './tombstones.ts';

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
/** The static backend's source (no tests, fixtures or harness), by path under `web/src/static/`. */
const SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>(['../**/*.ts', '!../**/*.test.ts', '!../test/**', '!../**/__fixtures__/**'], { query: '?raw', import: 'default', eager: true }),
  ).map(([path, text]) => [path.replace(/^\.\.\//, '').replace(/^\.\//, 'sync/'), text]),
);

let t: TestBackend;
afterEach(() => t?.close());

async function setup(storage?: MemoryStorage): Promise<TestBackend> {
  t = await createTestBackend([settings, profiles, transfer, bookmarks], { startAt: T0, ...(storage ? { storage } : {}) });
  return t;
}

async function group(name: string): Promise<BookmarkGroup> {
  const res = await t.json<BookmarkGroup>('POST', '/api/bookmark-groups', { name });
  expect(res.status).toBe(201);
  return res.body;
}

async function bookmark(groupId: string, title: string): Promise<string> {
  const res = await t.json<{ id: string }>('POST', '/api/bookmarks', { groupId, title, url: `https://${title.toLowerCase()}.example/` });
  expect(res.status).toBe(201);
  return res.body.id;
}

const rows = () => getBookmarks(t.ctx);
const groupRow = (id: string) => rows().groups.find((g) => g.id === id)!;
const bookmarkRow = (id: string) => rows().bookmarks.find((b) => b.id === id)!;
const stored = async () => (await t.storage.getJson(`slice:${SLICE.bookmarks}`)) as BookmarksSlice;

describe('the paths that remove launch pad rows', () => {
  /** Code that drops groups or bookmarks from the bookmarks slice (or replaces the slice). */
  const REMOVAL = /\.(groups|bookmarks)\s*=[^=]|\.(groups|bookmarks)\.(splice|pop|shift)\(|state\.(set|remove)\(\s*SLICE\.bookmarks|\.clearAll\(/;

  it('are exactly the known ones, each of which writes tombstones (or only adds rows)', () => {
    expect(Object.keys(SOURCES)).toContain('handlers/bookmarks.ts');
    const found: string[] = [];
    for (const [file, text] of Object.entries(SOURCES).sort(([a], [b]) => (a < b ? -1 : 1))) {
      for (const line of text.split('\n')) if (REMOVAL.test(line)) found.push(`${file}: ${line.trim()}`);
    }
    // A new line here must write tombstones in the same commit (sync/tombstones.ts) and get a test below.
    expect(found).toEqual([
      // HTML import: replaces the slice with a copy that only has rows added.
      'handlers/bookmarkImport.ts: ctx.state.set(SLICE.bookmarks, next);',
      // Deleting a group, with its bookmarks: tombstones for both.
      'handlers/bookmarks.ts: slice.bookmarks = slice.bookmarks.filter((b) => b.groupId !== id); // cascade',
      'handlers/bookmarks.ts: slice.groups = slice.groups.filter((g) => g.id !== id);',
      // Deleting a bookmark: its tombstone.
      'handlers/bookmarks.ts: slice.bookmarks = slice.bookmarks.filter((b) => b.id !== id);',
      // A config import or backup restore: tombstones for every old row.
      'handlers/transfer.ts: ctx.state.set(SLICE.bookmarks, bookmarks);',
      // Applying a merged sync file: the rows it removed come with the file's own tombstones, written too.
      'sync/local.ts: fresh.groups = groups;',
      'sync/local.ts: fresh.bookmarks = bookmarks;',
    ]);
  });

  it('deleting a group tombstones it and its bookmarks, in the same commit', async () => {
    await setup();
    const g = await group('Work');
    const keep = await group('Keep');
    const a = await bookmark(g.id, 'A');
    const b = await bookmark(g.id, 'B');
    await bookmark(keep.id, 'C');
    t.tick(1000);
    expect((await t.call('DELETE', `/api/bookmark-groups/${g.id}`)).status).toBe(204);
    const at = getLaunchpadSync(t.ctx).clock;
    const expected: Tombstone[] = [
      { kind: 'group', id: g.id, at },
      { kind: 'bookmark', id: a, at },
      { kind: 'bookmark', id: b, at },
    ];
    expect(rows().deleted).toEqual(expected);
    expect((await stored()).deleted).toEqual(expected);
    expect(await t.storage.getJson(`slice:${SLICE.launchpadSync}`)).toMatchObject({ clock: at });
  });

  it('deleting a bookmark tombstones it', async () => {
    await setup();
    const g = await group('Work');
    const a = await bookmark(g.id, 'A');
    expect((await t.call('DELETE', `/api/bookmarks/${a}`)).status).toBe(204);
    expect((await stored()).deleted).toEqual([{ kind: 'bookmark', id: a, at: getLaunchpadSync(t.ctx).clock }]);
  });

  it('a config import, and restoring the backup it took, tombstone every row they replace', async () => {
    await setup();
    const g = await group('Work');
    const a = await bookmark(g.id, 'A');
    const exported = await (await t.call('GET', '/api/export')).text();

    const importFile = async (text: string): Promise<void> => {
      const preview = await t.json<ImportPreviewResponse>('POST', '/api/import/preview', fileForm(text, 'portly-export.json', 'application/json'));
      expect(preview.status).toBe(200);
      expect((await t.json('POST', '/api/import/commit', { previewId: preview.body.previewId })).status).toBe(200);
    };
    t.tick(1000);
    await importFile(exported);
    const first = getLaunchpadSync(t.ctx).clock;
    const imported = rows();
    expect(imported.deleted).toEqual([
      { kind: 'group', id: g.id, at: first },
      { kind: 'bookmark', id: a, at: first },
    ]);
    // The new rows (fresh ids) carry the import's stamp on both parts.
    expect(imported.groups.map((r) => [r.name, r.updatedAt, r.placedAt])).toEqual([['Work', first, first]]);
    expect(imported.bookmarks.map((r) => [r.title, r.updatedAt, r.placedAt])).toEqual([['A', first, first]]);
    expect(getBackups(t.ctx).entries.map((e) => e.reason)).toEqual(['import']);

    // Restoring the backup is an import of its document: the rows of the first import get tombstones too.
    const [backup] = getBackups(t.ctx).entries as [BackupEntry];
    t.tick(1000);
    await importFile(await (await t.call('GET', `/api/backups/${backup.id}`)).text());
    const second = getLaunchpadSync(t.ctx).clock;
    expect(second).toBeGreaterThan(first);
    expect(rows().deleted).toEqual(
      expect.arrayContaining([
        { kind: 'group', id: g.id, at: first },
        { kind: 'group', id: imported.groups[0]!.id, at: second },
        { kind: 'bookmark', id: imported.bookmarks[0]!.id, at: second },
      ]),
    );
    expect(rows().deleted).toHaveLength(4);
  });

  it('an HTML import only adds rows and writes no tombstone', async () => {
    await setup();
    const html = '<DL><DT><H3>Dev</H3><DL><DT><A HREF="https://github.com/">GitHub</A></DL></DL>';
    const res = await t.json('POST', '/api/bookmarks/import/html', fileForm(html, 'bookmarks.html', 'text/html'));
    expect(res.status).toBe(200);
    expect(rows().deleted).toEqual([]);
    const stamp = getLaunchpadSync(t.ctx).clock;
    expect(rows().bookmarks.map((b) => [b.title, b.updatedAt, b.placedAt])).toEqual([['GitHub', stamp, stamp]]);
  });

  it('the export never carries stamps or tombstones', async () => {
    await setup();
    const g = await group('Work');
    await t.call('DELETE', `/api/bookmarks/${await bookmark(g.id, 'A')}`);
    await bookmark(g.id, 'B');
    const text = await (await t.call('GET', '/api/export')).text();
    expect(text).not.toContain('placedAt');
    expect(text).not.toContain('deleted');
    expect(text).not.toContain('updatedAt');
  });
});

describe('content and placement stamps', () => {
  it('a rename stamps the content, a reorder or move the placement only', async () => {
    await setup();
    const a = await group('A');
    const b = await group('B');
    const x = await bookmark(a.id, 'X');
    const y = await bookmark(a.id, 'Y');
    const created = groupRow(a.id).updatedAt;

    t.tick(10);
    await t.json('PATCH', `/api/bookmark-groups/${a.id}`, { name: 'A2' });
    expect(groupRow(a.id).updatedAt).toBeGreaterThan(created);
    expect(groupRow(a.id).placedAt).toBe(created);

    t.tick(10);
    const renamed = groupRow(a.id).updatedAt;
    await t.json('POST', '/api/bookmark-groups/reorder', { ids: [b.id, a.id] });
    expect(groupRow(a.id)).toMatchObject({ sort: 1, updatedAt: renamed });
    expect(groupRow(a.id).placedAt).toBeGreaterThan(renamed);

    t.tick(10);
    const titled = bookmarkRow(x).updatedAt;
    const sibling = bookmarkRow(y).updatedAt;
    await t.json('POST', `/api/bookmarks/${x}/move`, { groupId: b.id, index: 0 });
    expect(bookmarkRow(x)).toMatchObject({ groupId: b.id, updatedAt: titled });
    expect(bookmarkRow(x).placedAt).toBeGreaterThan(titled);
    // The sibling left behind was renumbered: a placement change too.
    expect(bookmarkRow(y)).toMatchObject({ sort: 0, updatedAt: sibling });
    expect(bookmarkRow(y).placedAt).toBe(bookmarkRow(x).placedAt);

    t.tick(10);
    await t.json('PATCH', `/api/bookmarks/${y}`, { title: 'Y2' });
    expect(bookmarkRow(y).updatedAt).toBeGreaterThan(bookmarkRow(y).placedAt);
  });
});

describe('the launch pad clock', () => {
  it('gives every change a stamp above the last one, also within one millisecond', async () => {
    await setup();
    const g = await group('A');
    const first = groupRow(g.id).updatedAt;
    expect(first).toBe(T0);
    await t.json('PATCH', `/api/bookmark-groups/${g.id}`, { name: 'B' });
    expect(groupRow(g.id).updatedAt).toBe(T0 + 1);
    expect(nextStamp(t.ctx)).toBe(T0 + 2);
  });

  it('stamps after a stamp seen from another PC, however far ahead its clock is', async () => {
    await setup();
    const g = await group('A');
    observeStamp(t.ctx, T0 + 5 * HOUR);
    await t.json('PATCH', `/api/bookmark-groups/${g.id}`, { name: 'B' });
    expect(groupRow(g.id).updatedAt).toBe(T0 + 5 * HOUR + 1);
    // Never backwards.
    observeStamp(t.ctx, T0);
    expect(nextStamp(t.ctx)).toBe(T0 + 5 * HOUR + 2);
  });

  it('starts above the stored rows when its own state is missing', async () => {
    const storage = new MemoryStorage();
    await setup(storage);
    const g = await group('A');
    observeStamp(t.ctx, T0 + HOUR);
    await t.json('PATCH', `/api/bookmark-groups/${g.id}`, { name: 'B' });
    t.close();
    await storage.setJson(`slice:${SLICE.launchpadSync}`, 'garbage');
    await setup(storage);
    expect(nextStamp(t.ctx)).toBe(T0 + HOUR + 2);
  });
});

describe('the one-time upgrade', () => {
  it('gives older rows placedAt = updatedAt and an empty tombstone list, once', async () => {
    const storage = new MemoryStorage();
    await storage.setJson(`slice:${SLICE.bookmarks}`, {
      groups: [{ id: 'g1', name: 'Old', sort: 0, color: null, collapsed: false, createdAt: 5, updatedAt: 7 }],
      bookmarks: [{ id: 'b1', groupId: 'g1', title: 'T', url: 'https://t.example/', sort: 0, iconMode: 'auto', iconId: null, letterColor: null, createdAt: 5, updatedAt: 9 }],
    });
    await setup(storage);
    expect(getUpgrades(t.ctx)).toContain(SYNC_FIELDS_UPGRADE);
    const saved = await stored();
    expect(saved.groups[0]).toMatchObject({ updatedAt: 7, placedAt: 7 });
    expect(saved.bookmarks[0]).toMatchObject({ updatedAt: 9, placedAt: 9 });
    expect(saved.deleted).toEqual([]);
    // Listing and the API shape are unchanged.
    const listed = (await t.json<{ groups: BookmarkGroup[] }>('GET', '/api/bookmarks')).body.groups;
    expect(listed).toEqual([{ id: 'g1', name: 'Old', sort: 0, color: null, collapsed: false, bookmarks: [expect.objectContaining({ id: 'b1', sort: 0 })] }]);
  });

  it('fills rows written later by an older build in memory too', async () => {
    await setup();
    const slice = getBookmarks(t.ctx);
    const old = { groups: [{ id: 'g9', name: 'X', sort: 0, color: null, collapsed: false, createdAt: 1, updatedAt: 3 }], bookmarks: [] };
    await t.storage.setJson(`slice:${SLICE.bookmarks}`, old);
    await t.ctx.state.reload([SLICE.bookmarks]);
    expect(getBookmarks(t.ctx)).not.toBe(slice);
    expect(getBookmarks(t.ctx)).toMatchObject({ groups: [{ id: 'g9', placedAt: 3 }], deleted: [] });
  });

  it('drops malformed tombstones and keeps the rows', async () => {
    const storage = new MemoryStorage();
    await storage.setJson(`slice:${SLICE.bookmarks}`, { groups: [], bookmarks: [], deleted: [{ kind: 'bookmark', id: 'b1', at: 4 }, { kind: 'profile', id: 'x', at: 1 }] });
    await setup(storage);
    expect(getBookmarks(t.ctx).deleted).toEqual([{ kind: 'bookmark', id: 'b1', at: 4 }]);
  });
});

describe('withTombstones', () => {
  it('keeps one tombstone per row, the newest, and drops those older than 90 days', () => {
    const now = T0 + TOMBSTONE_TTL_MS;
    const existing: Tombstone[] = [
      { kind: 'bookmark', id: 'old', at: T0 - 1 },
      { kind: 'bookmark', id: 'edge', at: T0 },
      { kind: 'group', id: 'g', at: T0 + 5 },
    ];
    expect(withTombstones(existing, { groups: [{ id: 'g' }], bookmarks: [{ id: 'g' }] }, T0 + 10, now)).toEqual([
      { kind: 'bookmark', id: 'edge', at: T0 },
      { kind: 'group', id: 'g', at: T0 + 10 },
      { kind: 'bookmark', id: 'g', at: T0 + 10 },
    ]);
    // An older stamp never replaces a newer tombstone.
    expect(withTombstones([{ kind: 'group', id: 'g', at: 9 }], { groups: [{ id: 'g' }] }, 5, 9)).toEqual([{ kind: 'group', id: 'g', at: 9 }]);
  });
});

describe('backup slots', () => {
  const entry = (id: string, at: number, reason?: BackupEntry['reason']): BackupEntry => ({ id, at, bytes: 1, ...(reason ? { reason } : {}) });

  it('keeps three import backups and one sync backup of its own', () => {
    const entries = [entry('s2', 9, 'sync'), entry('i4', 8, 'import'), entry('s1', 7, 'sync'), entry('i3', 6), entry('i2', 5, 'import'), entry('i1', 4, 'import')];
    const { kept, evicted } = keepBackups(entries);
    expect(kept.map((e) => e.id)).toEqual(['s2', 'i4', 'i3', 'i2']);
    expect(evicted.map((e) => e.id)).toEqual(['s1', 'i1']);
    expect(kept.filter((e) => e.reason !== 'sync')).toHaveLength(MAX_BACKUPS);
  });

  it('never lets an import push out the sync backup', async () => {
    await setup();
    getBackups(t.ctx).entries.push(entry('sync-1', T0 - 1, 'sync'));
    await t.storage.setJson('backup:sync-1', '{}');
    await t.ctx.state.commit(SLICE.backups);
    const exported = await (await t.call('GET', '/api/export')).text();
    for (let i = 0; i < MAX_BACKUPS + 1; i++) {
      t.tick(1000);
      const preview = await t.json<ImportPreviewResponse>('POST', '/api/import/preview', fileForm(exported, 'portly-export.json', 'application/json'));
      await t.json('POST', '/api/import/commit', { previewId: preview.body.previewId });
    }
    const reasons = getBackups(t.ctx).entries.map((e) => e.reason);
    expect(reasons.filter((r) => r === 'import')).toHaveLength(MAX_BACKUPS);
    expect(getBackups(t.ctx).entries.map((e) => e.id)).toContain('sync-1');
  });
});
