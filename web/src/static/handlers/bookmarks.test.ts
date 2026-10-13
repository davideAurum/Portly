/**
 * Static bookmarks module: the server's bookmarks.test.ts cases (ordering, validation, allowlists,
 * renumbering, reorder, move clamping/atomicity, default-group reset) plus the browser-only icon
 * rules (synthetic favicon ids, custom uploads, orphans and the undo window, `ready` GC) and the
 * site-meta substitute. Imports are covered in bookmarkImport.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BOOKMARKS, MAX_BOOKMARK_GROUPS, type Bookmark, type BookmarkGroup, type BookmarksResponse, type SiteMeta } from '@portly/shared';
import { getBookmarks, getIcons, getSettings, ORPHAN_GRACE_MS, SLICE, type StoredBookmark, type StoredBookmarkGroup, type StoredIconMeta } from '../slices.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createTestBackend, fileForm, PNG_BYTES, type TestBackend } from '../test/harness.ts';
import * as bookmarks from './bookmarks.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: { path: string; message: string; code: string }[] };
}

const T0 = 1_700_000_000_000;

describe('static bookmarks', () => {
  let t: TestBackend;
  beforeEach(async () => {
    t = await createTestBackend([bookmarks]);
    // Like the server tests: no automatic icons unless a test turns them on.
    getSettings(t.ctx).bookmarks.autoFetchIcons = false;
  });
  afterEach(() => t.close());

  const autoIcons = (on: boolean) => {
    getSettings(t.ctx).bookmarks.autoFetchIcons = on;
  };
  const createGroup = async (name: string, extra: Record<string, unknown> = {}): Promise<BookmarkGroup> => {
    const res = await t.json<BookmarkGroup>('POST', '/api/bookmark-groups', { name, ...extra });
    expect(res.status).toBe(201);
    return res.body;
  };
  const createBookmark = async (groupId: string, title: string, url = `https://${title.toLowerCase()}.example/`, extra: Record<string, unknown> = {}): Promise<Bookmark> => {
    const res = await t.json<Bookmark>('POST', '/api/bookmarks', { groupId, title, url, ...extra });
    expect(res.status).toBe(201);
    return res.body;
  };
  const list = async (): Promise<BookmarkGroup[]> => (await t.json<BookmarksResponse>('GET', '/api/bookmarks')).body.groups;
  const titles = (groups: BookmarkGroup[], groupId: string) => groups.find((g) => g.id === groupId)!.bookmarks.map((b) => b.title);
  const sorts = (groups: BookmarkGroup[], groupId: string) => groups.find((g) => g.id === groupId)!.bookmarks.map((b) => b.sort);
  const error = async (method: string, path: string, body?: unknown) => {
    const res = await t.json<ErrorBody>(method, path, body);
    return { status: res.status, ...res.body.error };
  };

  // -------------------------------------------------------------------------
  // Groups and bookmarks (server bookmarks.test.ts)
  // -------------------------------------------------------------------------

  describe('groups and bookmarks', () => {
    it('lists groups with their bookmarks in order, as JSON', async () => {
      const empty = await t.call('GET', '/api/bookmarks');
      expect(empty.status).toBe(200);
      expect(empty.headers.get('content-type')).toContain('application/json');
      expect(await empty.json()).toEqual({ groups: [] });

      const work = await createGroup('Work', { color: '#3B82F6' });
      const home = await createGroup('Home');
      expect(work).toEqual({ id: work.id, name: 'Work', sort: 0, color: '#3b82f6', collapsed: false, bookmarks: [] });
      expect(home.sort).toBe(1);
      const a = await createBookmark(work.id, 'Alpha');
      await createBookmark(work.id, 'Beta');
      expect(a).toEqual({ id: a.id, groupId: work.id, title: 'Alpha', url: 'https://alpha.example/', sort: 0, iconMode: 'auto', iconId: null, letterColor: null });
      const groups = await list();
      expect(groups.map((g) => g.name)).toEqual(['Work', 'Home']);
      expect(titles(groups, work.id)).toEqual(['Alpha', 'Beta']);
      expect(sorts(groups, work.id)).toEqual([0, 1]);
      expect(groups[1]!.bookmarks).toEqual([]);
    });

    it('persists every mutation to storage', async () => {
      const g = await createGroup('G');
      await createBookmark(g.id, 'A');
      const stored = (await t.storage.getJson(`slice:${SLICE.bookmarks}`)) as { groups: StoredBookmarkGroup[]; bookmarks: StoredBookmark[] };
      expect(stored.groups.map((x) => x.name)).toEqual(['G']);
      expect(stored.bookmarks.map((x) => [x.title, x.createdAt])).toEqual([['A', T0]]);
    });

    it('validates bookmarks (SafeHttpUrl, title, group, strict keys) and groups', async () => {
      const g = await createGroup('G');
      for (const url of ['javascript:alert(1)', 'file:///C:/x', 'https://user:pw@example.com/', 'not a url', `https://e.com/${'a'.repeat(2100)}`]) {
        const err = await error('POST', '/api/bookmarks', { groupId: g.id, title: 'x', url });
        expect(err.status, url).toBe(422);
        expect(err.code).toBe('validation_failed');
        expect(err.details?.[0]?.path).toBe('url');
      }
      expect((await error('POST', '/api/bookmarks', { groupId: g.id, title: '   ', url: 'https://e.com' })).status).toBe(422);
      const unknownGroup = await error('POST', '/api/bookmarks', { groupId: 'nope', title: 'x', url: 'https://e.com' });
      expect(unknownGroup).toMatchObject({ status: 422, code: 'validation_failed', message: 'The bookmark group does not exist' });
      expect((await error('POST', '/api/bookmarks', { groupId: g.id, title: 'x', url: 'https://e.com', extra: 1 })).status).toBe(422);
      expect((await error('POST', '/api/bookmark-groups', { name: 'x', color: 'red' })).status).toBe(422);
      expect((await error('POST', '/api/bookmark-groups', { name: '' })).status).toBe(422);
      // Malformed JSON and forbidden keys are 400, not 422.
      const malformed = await t.fetch('/api/bookmark-groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
      expect(malformed.status).toBe(400);
      const forbidden = await t.fetch('/api/bookmark-groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x","__proto__":{"a":1}}' });
      expect(forbidden.status).toBe(400);
      expect(await list()).toEqual([{ ...g, bookmarks: [] }]);
    });

    it('trims titles and names, normalizes colors and defaults collapsed to false', async () => {
      const g = await createGroup('  Spaced  ', { color: '#ABCDEF80', collapsed: true });
      expect(g).toMatchObject({ name: 'Spaced', color: '#abcdef80', collapsed: true });
      const b = await createBookmark(g.id, 'A', '  https://a.example/  ', { title: '  Padded ', letterColor: '#FFFFFF' });
      expect(b).toMatchObject({ title: 'Padded', url: 'https://a.example/', letterColor: '#ffffff' });
    });

    it('updates bookmarks through an allowlist and supports letter icons', async () => {
      const g = await createGroup('G');
      const b = await createBookmark(g.id, 'Alpha');
      const res = await t.json<Bookmark>('PATCH', `/api/bookmarks/${b.id}`, {
        title: 'Renamed',
        url: 'https://renamed.example/path',
        iconMode: 'letter',
        letterColor: '#FF0000',
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ...b, title: 'Renamed', url: 'https://renamed.example/path', iconMode: 'letter', iconId: null, letterColor: '#ff0000' });
      expect((await error('PATCH', `/api/bookmarks/${b.id}`, { sort: 5 })).status).toBe(422);
      expect((await error('PATCH', `/api/bookmarks/${b.id}`, { groupId: g.id })).status).toBe(422);
      expect(await error('PATCH', '/api/bookmarks/missing', { title: 'x' })).toMatchObject({ status: 404, code: 'not_found', message: 'Bookmark not found' });
      // Custom mode without a stored upload falls back to the automatic icon.
      const custom = await t.json<Bookmark>('PATCH', `/api/bookmarks/${b.id}`, { iconMode: 'custom', iconId: 'no-such-icon' });
      expect(custom.body.iconMode).toBe('auto');
      expect(custom.body.iconId).toBeNull();
      // An empty patch is fine and changes nothing.
      expect((await t.json<Bookmark>('PATCH', `/api/bookmarks/${b.id}`, {})).body).toEqual(custom.body);
    });

    it('deletes bookmarks and renumbers the group', async () => {
      const g = await createGroup('G');
      const [, b] = [await createBookmark(g.id, 'A'), await createBookmark(g.id, 'B'), await createBookmark(g.id, 'C')];
      const res = await t.call('DELETE', `/api/bookmarks/${b!.id}`);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      const groups = await list();
      expect(titles(groups, g.id)).toEqual(['A', 'C']);
      expect(sorts(groups, g.id)).toEqual([0, 1]);
      expect((await t.call('DELETE', `/api/bookmarks/${b!.id}`)).status).toBe(404);
    });

    it('updates, collapses and reorders groups', async () => {
      const a = await createGroup('A');
      const b = await createGroup('B');
      const c = await createGroup('C');
      const patched = await t.json<BookmarkGroup>('PATCH', `/api/bookmark-groups/${a.id}`, { name: 'Alpha', collapsed: true, color: null });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ name: 'Alpha', collapsed: true, color: null, sort: 0 });
      expect((await error('PATCH', `/api/bookmark-groups/${a.id}`, { sort: 2 })).status).toBe(422);
      expect(await error('PATCH', '/api/bookmark-groups/missing', { name: 'x' })).toMatchObject({ status: 404, message: 'Bookmark group not found' });

      const reordered = await t.json<BookmarksResponse>('POST', '/api/bookmark-groups/reorder', { ids: [c.id, a.id, b.id] });
      expect(reordered.status).toBe(200);
      expect(reordered.body.groups.map((g) => [g.name, g.sort])).toEqual([
        ['C', 0],
        ['Alpha', 1],
        ['B', 2],
      ]);
      // Partial / unknown ids: listed first, the rest keep their relative order.
      const partial = await t.json<BookmarksResponse>('POST', '/api/bookmark-groups/reorder', { ids: [b.id, 'unknown'] });
      expect(partial.body.groups.map((g) => g.name)).toEqual(['B', 'C', 'Alpha']);
      expect(partial.body.groups.map((g) => g.sort)).toEqual([0, 1, 2]);
      const duplicate = await error('POST', '/api/bookmark-groups/reorder', { ids: [a.id, a.id] });
      expect(duplicate.status).toBe(422);
      expect(duplicate.details?.[0]).toMatchObject({ path: 'ids', message: 'Group ids must be unique' });
    });

    it('deleting a group removes its bookmarks, renumbers groups and resets the default group', async () => {
      const a = await createGroup('A');
      const b = await createGroup('B');
      await createBookmark(a.id, 'One');
      getSettings(t.ctx).bookmarks.defaultGroupId = a.id;
      expect((await t.call('DELETE', `/api/bookmark-groups/${a.id}`)).status).toBe(204);
      const groups = await list();
      expect(groups.map((g) => [g.id, g.sort])).toEqual([[b.id, 0]]);
      expect(getBookmarks(t.ctx).bookmarks).toEqual([]);
      expect(getSettings(t.ctx).bookmarks.defaultGroupId).toBeNull();
      // The settings slice was committed too (the web re-reads settings after this call).
      expect(((await t.storage.getJson(`slice:${SLICE.settings}`)) as { bookmarks: { defaultGroupId: string | null } }).bookmarks.defaultGroupId).toBeNull();
      expect((await t.call('DELETE', `/api/bookmark-groups/${a.id}`)).status).toBe(404);
    });

    it('leaves another default group alone when a group is deleted', async () => {
      const a = await createGroup('A');
      const b = await createGroup('B');
      getSettings(t.ctx).bookmarks.defaultGroupId = b.id;
      expect((await t.call('DELETE', `/api/bookmark-groups/${a.id}`)).status).toBe(204);
      expect(getSettings(t.ctx).bookmarks.defaultGroupId).toBe(b.id);
      expect(await t.storage.getJson(`slice:${SLICE.settings}`)).toBeUndefined();
    });

    it('enforces the group and bookmark caps with 409 conflict', async () => {
      const slice = getBookmarks(t.ctx);
      for (let i = 0; i < MAX_BOOKMARK_GROUPS; i++) {
        slice.groups.push({ id: `g${i}`, name: `G${i}`, sort: i, color: null, collapsed: false, createdAt: T0, updatedAt: T0 });
      }
      expect(await error('POST', '/api/bookmark-groups', { name: 'One more' })).toMatchObject({
        status: 409,
        code: 'conflict',
        message: 'You can have at most 200 bookmark groups',
      });
      for (let i = 0; i < MAX_BOOKMARKS; i++) {
        slice.bookmarks.push({ id: `b${i}`, groupId: 'g0', title: 'x', url: `https://x.example/${i}`, sort: i, iconMode: 'auto', iconId: null, letterColor: null, createdAt: T0, updatedAt: T0 });
      }
      expect(await error('POST', '/api/bookmarks', { groupId: 'g0', title: 'x', url: 'https://x.example/more' })).toMatchObject({
        status: 409,
        code: 'conflict',
        message: 'You can have at most 5000 bookmarks',
      });
    });

    it('answers 404 for over-long path ids and unknown ids on every :id route', async () => {
      const long = 'x'.repeat(513);
      for (const [method, path] of [
        ['PATCH', `/api/bookmark-groups/${long}`],
        ['DELETE', `/api/bookmark-groups/${long}`],
        ['PATCH', `/api/bookmarks/${long}`],
        ['DELETE', `/api/bookmarks/${long}`],
        ['POST', `/api/bookmarks/${long}/move`],
        ['POST', `/api/bookmarks/${long}/refresh-icon`],
        ['POST', '/api/bookmarks/missing/refresh-icon'],
      ] as const) {
        const body = method === 'DELETE' ? undefined : path.endsWith('/move') ? { groupId: 'g', index: 0 } : path.endsWith('refresh-icon') ? undefined : {};
        const res = await error(method, path, body);
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.code).toBe('not_found');
      }
      expect((await t.call('POST', '/api/bookmarks/missing/icon', fileForm(PNG_BYTES))).status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Move
  // -------------------------------------------------------------------------

  describe('POST /api/bookmarks/:id/move', () => {
    let g1: BookmarkGroup;
    let g2: BookmarkGroup;
    let ids: Record<string, string>;
    beforeEach(async () => {
      g1 = await createGroup('One');
      g2 = await createGroup('Two');
      ids = {};
      for (const name of ['A', 'B', 'C', 'D']) ids[name] = (await createBookmark(g1.id, name)).id;
      for (const name of ['X', 'Y']) ids[name] = (await createBookmark(g2.id, name)).id;
    });

    const move = (id: string, groupId: string, index: number) => t.json<BookmarksResponse & ErrorBody>('POST', `/api/bookmarks/${id}/move`, { groupId, index });

    it('moves forward and backward within a group and renumbers 0..n-1', async () => {
      let res = await move(ids.A!, g1.id, 2);
      expect(res.status).toBe(200);
      expect(titles(res.body.groups, g1.id)).toEqual(['B', 'C', 'A', 'D']);
      expect(sorts(res.body.groups, g1.id)).toEqual([0, 1, 2, 3]);
      res = await move(ids.D!, g1.id, 0);
      expect(titles(res.body.groups, g1.id)).toEqual(['D', 'B', 'C', 'A']);
      expect(sorts(res.body.groups, g1.id)).toEqual([0, 1, 2, 3]);
      // Same position: no change.
      res = await move(ids.B!, g1.id, 1);
      expect(titles(res.body.groups, g1.id)).toEqual(['D', 'B', 'C', 'A']);
      expect(res.body.groups).toEqual(await list());
    });

    it('moves across groups, renumbering both', async () => {
      const res = await move(ids.B!, g2.id, 1);
      expect(titles(res.body.groups, g1.id)).toEqual(['A', 'C', 'D']);
      expect(sorts(res.body.groups, g1.id)).toEqual([0, 1, 2]);
      expect(titles(res.body.groups, g2.id)).toEqual(['X', 'B', 'Y']);
      expect(sorts(res.body.groups, g2.id)).toEqual([0, 1, 2]);
      expect(res.body.groups.find((g) => g.id === g2.id)!.bookmarks[1]!.groupId).toBe(g2.id);
    });

    it('clamps the index to the end of the target group (and into empty groups)', async () => {
      let res = await move(ids.A!, g2.id, 99);
      expect(titles(res.body.groups, g2.id)).toEqual(['X', 'Y', 'A']);
      const empty = await createGroup('Empty');
      res = await move(ids.C!, empty.id, 5);
      expect(titles(res.body.groups, empty.id)).toEqual(['C']);
      expect(sorts(res.body.groups, empty.id)).toEqual([0]);
    });

    it('is atomic: an invalid target leaves everything unchanged', async () => {
      const before = await list();
      const missingGroup = await move(ids.A!, 'missing-group', 0);
      expect(missingGroup.status).toBe(422);
      expect(missingGroup.body.error).toEqual({ code: 'validation_failed', message: 'The target group does not exist' });
      expect((await move('missing-bookmark', g1.id, 0)).status).toBe(404);
      expect((await move(ids.A!, g1.id, -1)).status).toBe(422);
      expect((await move(ids.A!, g1.id, 1.5)).status).toBe(422);
      expect(await list()).toEqual(before);
    });

    it('repairs colliding sorts on the next move', async () => {
      for (const b of getBookmarks(t.ctx).bookmarks) if (b.groupId === g1.id) b.sort = 0;
      const res = await move(ids.D!, g1.id, 0);
      expect(res.body.groups.find((g) => g.id === g1.id)!.bookmarks[0]!.title).toBe('D');
      expect(sorts(res.body.groups, g1.id)).toEqual([0, 1, 2, 3]);
    });
  });

  // -------------------------------------------------------------------------
  // Automatic icons: synthetic favicon ids
  // -------------------------------------------------------------------------

  describe('automatic icons (synthetic favicon ids)', () => {
    it('assigns the host id synchronously when automatic icons are on, never for local-looking hosts', async () => {
      autoIcons(true);
      const g = await createGroup('G');
      expect((await createBookmark(g.id, 'GitHub', 'https://GitHub.com/portly')).iconId).toBe('fav:github.com');
      expect((await createBookmark(g.id, 'Port', 'http://example.com:8080/x')).iconId).toBe('fav:example.com:8080');
      for (const url of ['http://nas/', 'http://192.168.1.10:8080/', 'http://localhost:3000/', 'http://printer.local/', 'http://[::1]/', 'http://10.0.0.1/']) {
        const b = await createBookmark(g.id, 'Local', url);
        expect(b.iconMode, url).toBe('auto');
        expect(b.iconId, url).toBeNull();
      }
    });

    it('gives no icon when automatic icons are off, even for public hosts', async () => {
      const g = await createGroup('G');
      expect((await createBookmark(g.id, 'GitHub', 'https://github.com/')).iconId).toBeNull();
      // A requested favicon id (e.g. from an earlier site-meta answer or Undo) is still honoured.
      expect((await createBookmark(g.id, 'Kept', 'https://kept.example/', { iconId: 'fav:kept.example' })).iconId).toBe('fav:kept.example');
    });

    it('accepts a requested favicon id only when it is usable', async () => {
      autoIcons(true);
      const g = await createGroup('G');
      // Any usable synthetic id is accepted as-is (the server accepts any stored favicon id).
      expect((await createBookmark(g.id, 'Other', 'https://a.example/', { iconId: 'fav:b.example' })).iconId).toBe('fav:b.example');
      // Unknown or local-host ids fall back to the URL's host.
      expect((await createBookmark(g.id, 'Unknown', 'https://a.example/', { iconId: '11111111-1111-4111-8111-111111111111' })).iconId).toBe('fav:a.example');
      expect((await createBookmark(g.id, 'Local', 'https://a.example/', { iconId: 'fav:nas' })).iconId).toBe('fav:a.example');
      expect((await createBookmark(g.id, 'Empty', 'https://a.example/', { iconId: 'fav:' })).iconId).toBe('fav:a.example');
      // Letter mode never carries an icon id; custom with a favicon id degrades to auto with it.
      expect(await createBookmark(g.id, 'Letter', 'https://a.example/', { iconMode: 'letter', iconId: 'fav:a.example' })).toMatchObject({ iconMode: 'letter', iconId: null });
      expect(await createBookmark(g.id, 'Custom', 'https://a.example/', { iconMode: 'custom', iconId: 'fav:c.example' })).toMatchObject({ iconMode: 'auto', iconId: 'fav:c.example' });
    });

    it('recomputes the icon on update exactly when the server does', async () => {
      autoIcons(true);
      const g = await createGroup('G');
      const b = await createBookmark(g.id, 'A', 'https://a.example/');
      const patch = async (body: Record<string, unknown>) => (await t.json<Bookmark>('PATCH', `/api/bookmarks/${b.id}`, body)).body;
      // Same host: nothing changes.
      expect((await patch({ url: 'https://a.example/other' })).iconId).toBe('fav:a.example');
      // Host changed in auto mode: the new host's id.
      expect((await patch({ url: 'https://b.example/' })).iconId).toBe('fav:b.example');
      // The iconId key present (even null) triggers a recompute → host id again.
      expect((await patch({ iconId: null })).iconId).toBe('fav:b.example');
      expect((await patch({ iconId: 'fav:c.example' })).iconId).toBe('fav:c.example');
      // Switching to letter and back.
      expect(await patch({ iconMode: 'letter' })).toMatchObject({ iconMode: 'letter', iconId: null });
      expect(await patch({ iconMode: 'auto' })).toMatchObject({ iconMode: 'auto', iconId: 'fav:b.example' });
      // Host change while in letter mode keeps letter mode.
      expect(await patch({ iconMode: 'letter' })).toMatchObject({ iconMode: 'letter' });
      expect(await patch({ url: 'https://d.example/' })).toMatchObject({ iconMode: 'letter', iconId: null, url: 'https://d.example/' });
      // With automatic icons off a recompute yields no icon.
      autoIcons(false);
      expect(await patch({ iconMode: 'auto' })).toMatchObject({ iconMode: 'auto', iconId: null });
    });

    it('refresh-icon sets auto mode with the host id even when automatic icons are off', async () => {
      const g = await createGroup('G');
      const b = await createBookmark(g.id, 'A', 'https://a.example/', { iconMode: 'letter', letterColor: '#123456' });
      const res = await t.json<Bookmark>('POST', `/api/bookmarks/${b.id}/refresh-icon`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ...b, iconMode: 'auto', iconId: 'fav:a.example' });
      // Nothing is looked up: any public host gets its id (DuckDuckGo then serves its placeholder
      // for a host it does not know), so the UI cannot tell "found" from "not found" here.
      const unknown = await createBookmark(g.id, 'Unknown', 'https://tiny-site-nobody-knows.example/');
      expect((await t.json<Bookmark>('POST', `/api/bookmarks/${unknown.id}/refresh-icon`)).body).toMatchObject({ iconId: 'fav:tiny-site-nobody-knows.example' });
      const local = await createBookmark(g.id, 'Nas', 'http://nas/');
      expect((await t.json<Bookmark>('POST', `/api/bookmarks/${local.id}/refresh-icon`)).body).toMatchObject({ iconMode: 'auto', iconId: null });
      expect((await list()).find((x) => x.id === g.id)!.bookmarks.map((x) => x.iconId)).toEqual(['fav:a.example', 'fav:tiny-site-nobody-knows.example', null]);
    });

    it('lists the host’s icon for automatic bookmarks added while automatic icons were off, once they are on', async () => {
      const g = await createGroup('G');
      const github = await createBookmark(g.id, 'GitHub', 'https://github.com/');
      await createBookmark(g.id, 'Nas', 'http://nas./');
      await createBookmark(g.id, 'Letter', 'https://letter.example/', { iconMode: 'letter' });
      const custom = await createBookmark(g.id, 'Custom', 'https://custom.example/');
      const iconId = (await t.json<Bookmark>('POST', `/api/bookmarks/${custom.id}/icon`, fileForm(PNG_BYTES))).body.iconId!;
      const icons = getIcons(t.ctx);
      icons.splice(0, icons.length); // the custom icon vanished: the bookmark degrades to auto without an id
      const iconsOf = async () => (await list())[0]!.bookmarks.map((b) => [b.title, b.iconMode, b.iconId]);
      expect(await iconsOf()).toEqual([
        ['GitHub', 'auto', null],
        ['Nas', 'auto', null],
        ['Letter', 'letter', null],
        ['Custom', 'auto', null],
      ]);

      // The server's maintenance job fills in missing automatic icons once the setting is on.
      autoIcons(true);
      expect(await iconsOf()).toEqual([
        ['GitHub', 'auto', 'fav:github.com'],
        ['Nas', 'auto', null], // local-looking (a trailing dot does not change that)
        ['Letter', 'letter', null],
        ['Custom', 'auto', null], // stored as custom: the server's job only looks at automatic rows
      ]);
      expect((await t.json<Bookmark>('PATCH', `/api/bookmarks/${github.id}`, { title: 'GH' })).body).toMatchObject({ iconMode: 'auto', iconId: 'fav:github.com' });
      expect(getBookmarks(t.ctx).bookmarks.find((b) => b.id === github.id)!.iconId).toBeNull(); // derived, not written
      expect(getBookmarks(t.ctx).bookmarks.find((b) => b.id === custom.id)!.iconId).toBe(iconId);

      // Off again: rows that never stored an icon show their letter tile again.
      autoIcons(false);
      expect((await iconsOf())[0]).toEqual(['GH', 'auto', null]);
    });
  });

  // -------------------------------------------------------------------------
  // Custom icons: uploads, GET /api/icons/:id, orphans and Undo
  // -------------------------------------------------------------------------

  describe('custom icons', () => {
    const upload = (id: string, form = fileForm(PNG_BYTES)) => t.json<Bookmark & ErrorBody>('POST', `/api/bookmarks/${id}/icon`, form);

    it('stores the sniffed image as an icon blob, registers it and sets custom mode', async () => {
      const g = await createGroup('G');
      const b = await createBookmark(g.id, 'A');
      const res = await upload(b.id, fileForm(PNG_BYTES, 'anything.txt', 'text/plain'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ...b, iconMode: 'custom', iconId: res.body.iconId });
      const iconId = res.body.iconId!;
      expect(iconId).toMatch(/^[0-9a-f-]{36}$/);
      expect(getIcons(t.ctx)).toEqual([{ id: iconId, type: 'image/png', width: 16, createdAt: T0, orphanedAt: null }]);
      const blob = await t.storage.getBlob(iconId);
      expect(blob).toMatchObject({ id: iconId, kind: 'icon', type: 'image/png', width: 16 });
      expect([...blob!.bytes]).toEqual([...PNG_BYTES]);
      expect(t.ctx.assets.resolve('icons', iconId)).toBe(t.objectUrls[0]);
      expect(await t.storage.getJson(`slice:${SLICE.icons}`)).toEqual(getIcons(t.ctx));
      // The list projection keeps custom mode while the icon exists.
      expect((await list())[0]!.bookmarks[0]).toMatchObject({ iconMode: 'custom', iconId });
    });

    it('serves custom icon bytes on GET /api/icons/:id and 404s for everything else', async () => {
      const g = await createGroup('G');
      const b = await createBookmark(g.id, 'A');
      const iconId = (await upload(b.id)).body.iconId!;
      const res = await t.call('GET', `/api/icons/${iconId}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...PNG_BYTES]);
      expect((await t.call('GET', `/api/icons/${iconId.toUpperCase()}`)).status).toBe(200);
      expect((await t.call('GET', '/api/icons/fav%3Aexample.com')).status).toBe(404);
      expect((await t.call('GET', '/api/icons/11111111-1111-4111-8111-111111111111')).status).toBe(404);
      expect((await t.call('GET', '/api/icons/not-a-uuid')).status).toBe(404);
      // Metadata without bytes is not served.
      await t.storage.deleteBlob(iconId);
      expect((await t.call('GET', `/api/icons/${iconId}`)).status).toBe(404);
    });

    it('rejects bad uploads with the server’s codes', async () => {
      const g = await createGroup('G');
      const b = await createBookmark(g.id, 'A');
      expect((await upload('missing')).status).toBe(404);
      const notMultipart = await t.json<ErrorBody>('POST', `/api/bookmarks/${b.id}/icon`, { file: 'x' });
      expect(notMultipart.status).toBe(400);
      const noFile = new FormData();
      noFile.append('other', 'x');
      expect((await upload(b.id, noFile)).status).toBe(400);
      const twoFiles = fileForm(PNG_BYTES);
      twoFiles.append('file', new File([PNG_BYTES], 'b.png', { type: 'image/png' }));
      expect((await upload(b.id, twoFiles)).status).toBe(400);
      const textPart = new FormData();
      textPart.append('file', 'not a file');
      expect((await upload(b.id, textPart)).status).toBe(400);
      const empty = await upload(b.id, fileForm(new Uint8Array(0)));
      expect(empty.status).toBe(400);
      expect(empty.body.error.message).toBe('The file is empty');
      const huge = await upload(b.id, fileForm(new Uint8Array(bookmarks.MAX_UPLOAD_ICON_BYTES + 1)));
      expect(huge.status).toBe(413);
      expect(huge.body.error.code).toBe('payload_too_large');
      const notImage = await upload(b.id, fileForm('<html>not an image</html>', 'x.png', 'image/png'));
      expect(notImage.status).toBe(422);
      expect(notImage.body.error).toEqual({ code: 'validation_failed', message: 'Unsupported image type (png, gif, jpeg, webp, avif, ico, bmp or svg)' });
      // Nothing was stored and the bookmark is untouched.
      expect(getIcons(t.ctx)).toEqual([]);
      expect(await t.storage.listBlobs()).toEqual([]);
      expect((await list())[0]!.bookmarks[0]).toEqual(b);
    });

    it('orphans a replaced icon and keeps the newest one referenced', async () => {
      const g = await createGroup('G');
      const b = await createBookmark(g.id, 'A');
      const first = (await upload(b.id)).body.iconId!;
      t.tick(1000);
      const second = (await upload(b.id)).body.iconId!;
      expect(second).not.toBe(first);
      expect(getIcons(t.ctx).map((i) => [i.id, i.orphanedAt])).toEqual([
        [first, T0 + 1000],
        [second, null],
      ]);
      expect(t.objectUrls).toHaveLength(2);
    });

    /** Makes `commit` reject whenever it writes `slice` (a full or failing IndexedDB, a private window). */
    const failCommitsOf = (slice: string) => {
      const commit = t.ctx.state.commit.bind(t.ctx.state);
      return vi.spyOn(t.ctx.state, 'commit').mockImplementation(async (...names: string[]) => {
        if (names.includes(slice)) throw new Error('QuotaExceededError');
        return commit(...names);
      });
    };

    it('leaves no icon behind when the icon metadata cannot be saved', async () => {
      const g = await createGroup('G');
      const b = await createBookmark(g.id, 'A');
      const rowBefore = { ...getBookmarks(t.ctx).bookmarks[0]! };
      failCommitsOf(SLICE.icons);
      const res = await upload(b.id);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('internal');
      // Memory, storage, the blob store and the asset registry all agree: no icon.
      expect(getIcons(t.ctx)).toEqual([]);
      expect(await t.storage.getJson(`slice:${SLICE.icons}`)).toBeUndefined();
      expect(await t.storage.listBlobs()).toEqual([]);
      expect(t.ctx.assets.has('icons', '00000000-0000-4000-8000-000000000003')).toBe(false);
      expect(t.objectUrls).toEqual([]);
      expect(getBookmarks(t.ctx).bookmarks[0]).toEqual(rowBefore);
      expect((await list())[0]!.bookmarks[0]).toEqual(b);
    });

    it('puts the bookmark back when it cannot be saved with its new icon, and the unreferenced icon is collected later', async () => {
      const g = await createGroup('G');
      const b = await createBookmark(g.id, 'A');
      const first = (await upload(b.id)).body.iconId!;
      const rowBefore = { ...getBookmarks(t.ctx).bookmarks[0]! };
      t.tick(1000);
      const spy = failCommitsOf(SLICE.bookmarks);
      const res = await upload(b.id);
      expect(res.status).toBe(500);
      spy.mockRestore();
      // The bookmark keeps its first icon, which is not marked orphaned.
      expect(getBookmarks(t.ctx).bookmarks[0]).toEqual(rowBefore);
      expect((await list())[0]!.bookmarks[0]).toMatchObject({ iconMode: 'custom', iconId: first });
      expect(getIcons(t.ctx).find((i) => i.id === first)!.orphanedAt).toBeNull();
      // The second icon was stored (metadata first) but nothing refers to it: GC'd after the grace period.
      const second = getIcons(t.ctx).find((i) => i.id !== first)!;
      expect(second).toMatchObject({ createdAt: T0 + 1000, orphanedAt: null });
      expect(await t.storage.getJson(`slice:${SLICE.icons}`)).toEqual(getIcons(t.ctx));
      t.tick(ORPHAN_GRACE_MS);
      await bookmarks.ready(t.ctx);
      expect(getIcons(t.ctx).map((i) => i.id)).toEqual([first]);
      expect((await t.storage.listBlobs()).map((blob) => blob.id)).toEqual([first]);
    });

    it('custom mode is kept through PATCHes that do not touch the icon, and orphans on a switch', async () => {
      autoIcons(true);
      const g = await createGroup('G');
      const b = await createBookmark(g.id, 'A', 'https://a.example/');
      const iconId = (await upload(b.id)).body.iconId!;
      const patch = async (body: Record<string, unknown>) => (await t.json<Bookmark>('PATCH', `/api/bookmarks/${b.id}`, body)).body;
      // Host change in custom mode: the upload stays.
      expect(await patch({ title: 'B', url: 'https://b.example/' })).toMatchObject({ iconMode: 'custom', iconId });
      // Same custom icon requested again: no-op.
      expect(await patch({ iconMode: 'custom', iconId })).toMatchObject({ iconMode: 'custom', iconId });
      expect(getIcons(t.ctx)[0]!.orphanedAt).toBeNull();
      // Switching to auto orphans the upload and assigns the host id.
      t.tick(5000);
      expect(await patch({ iconMode: 'auto' })).toMatchObject({ iconMode: 'auto', iconId: 'fav:b.example' });
      expect(getIcons(t.ctx)[0]!.orphanedAt).toBe(T0 + 5000);
      // Back to custom with the orphaned (still stored) icon: referenced again.
      expect(await patch({ iconMode: 'custom', iconId })).toMatchObject({ iconMode: 'custom', iconId });
      expect(getIcons(t.ctx)[0]!.orphanedAt).toBeNull();
      // refresh-icon orphans too.
      await t.call('POST', `/api/bookmarks/${b.id}/refresh-icon`);
      expect(getIcons(t.ctx)[0]!.orphanedAt).toBe(T0 + 5000);
    });

    it('supports Undo: delete, then re-create with the same custom icon id within the grace period', async () => {
      const g = await createGroup('G');
      const b = await createBookmark(g.id, 'A');
      const iconId = (await upload(b.id)).body.iconId!;
      t.tick(60_000);
      expect((await t.call('DELETE', `/api/bookmarks/${b.id}`)).status).toBe(204);
      expect(getIcons(t.ctx)[0]).toMatchObject({ id: iconId, orphanedAt: T0 + 60_000 });
      expect(await t.storage.getBlob(iconId)).toBeDefined();
      // restoreBookmark re-creates with the deleted bookmark's iconMode/iconId (then moves it).
      t.tick(30 * 60_000);
      const restored = await createBookmark(g.id, 'A', 'https://a.example/', { iconMode: 'custom', iconId, letterColor: null });
      expect(restored).toMatchObject({ iconMode: 'custom', iconId });
      expect(getIcons(t.ctx)[0]!.orphanedAt).toBeNull();
      // Deleting the whole group orphans it again.
      await t.call('DELETE', `/api/bookmark-groups/${g.id}`);
      expect(getIcons(t.ctx)[0]!.orphanedAt).toBe(T0 + 60_000 + 30 * 60_000);
    });

    it('projects a custom bookmark whose icon vanished as auto, and letter bookmarks without an id', async () => {
      const g = await createGroup('G');
      const b = await createBookmark(g.id, 'A');
      const iconId = (await upload(b.id)).body.iconId!;
      const icons = getIcons(t.ctx);
      icons.splice(0, icons.length); // the icon row is gone (e.g. GC'd)
      expect((await list())[0]!.bookmarks[0]).toMatchObject({ iconMode: 'auto', iconId: null });
      // A letter bookmark never reports a stored id; colors are normalized on the way out.
      const row = getBookmarks(t.ctx).bookmarks[0]!;
      row.iconMode = 'letter';
      row.iconId = iconId;
      row.letterColor = '#ABCDEF';
      getBookmarks(t.ctx).groups[0]!.color = '#FFFFFF';
      const [group] = await list();
      expect(group!.color).toBe('#ffffff');
      expect(group!.bookmarks[0]).toMatchObject({ iconMode: 'letter', iconId: null, letterColor: '#abcdef' });
    });
  });

  // -------------------------------------------------------------------------
  // ready(): asset registration and orphan GC
  // -------------------------------------------------------------------------

  describe('ready()', () => {
    const png = (): Uint8Array => new Uint8Array(PNG_BYTES);
    const meta = (id: string, extra: Partial<StoredIconMeta> = {}): StoredIconMeta => ({ id, type: 'image/png', width: 16, createdAt: T0 - 2 * ORPHAN_GRACE_MS, orphanedAt: null, ...extra });
    const row = (id: string, sort: number, iconId: string | null, iconMode: StoredBookmark['iconMode'] = 'custom'): StoredBookmark => ({
      id,
      groupId: 'g1',
      title: id,
      url: `https://${id}.example/`,
      sort,
      iconMode,
      iconId,
      letterColor: null,
      createdAt: T0,
      updatedAt: T0,
    });
    const LIVE = '00000000-0000-4000-8000-00000000aaaa';
    const GHOST = '00000000-0000-4000-8000-00000000bbbb';
    const EXPIRED = '00000000-0000-4000-8000-00000000cccc';
    const FRESH = '00000000-0000-4000-8000-00000000dddd';
    const REREFERENCED = '00000000-0000-4000-8000-00000000eeee';
    const UNREFERENCED_NEW = '00000000-0000-4000-8000-00000000ffff';

    it('registers stored icons, drops dangling metadata and deletes expired orphans', async () => {
      const storage = new MemoryStorage();
      for (const id of [LIVE, EXPIRED, FRESH, REREFERENCED, UNREFERENCED_NEW]) {
        await storage.putBlob({ id, kind: 'icon', type: 'image/png', bytes: png(), width: 16, createdAt: T0 - 2 * ORPHAN_GRACE_MS });
      }
      await storage.setJson(`slice:${SLICE.icons}`, [
        meta(LIVE),
        meta(GHOST), // no blob
        meta(EXPIRED, { orphanedAt: T0 - ORPHAN_GRACE_MS }),
        meta(FRESH, { orphanedAt: T0 - ORPHAN_GRACE_MS + 1 }),
        meta(REREFERENCED, { orphanedAt: T0 - 2 * ORPHAN_GRACE_MS }),
        meta(UNREFERENCED_NEW, { createdAt: T0 - 1000 }), // never orphaned, nobody references it, but young
      ]);
      await storage.setJson(`slice:${SLICE.bookmarks}`, {
        groups: [{ id: 'g1', name: 'G', sort: 0, color: null, collapsed: false, createdAt: T0, updatedAt: T0 }],
        bookmarks: [row('live', 0, LIVE), row('ghost', 1, GHOST), row('again', 2, REREFERENCED), row('letter', 3, FRESH, 'letter')],
      });
      t.close();
      t = await createTestBackend([bookmarks], { storage, startAt: T0 });

      const icons = getIcons(t.ctx);
      expect(icons.map((i) => i.id)).toEqual([LIVE, FRESH, REREFERENCED, UNREFERENCED_NEW]);
      expect(icons.find((i) => i.id === REREFERENCED)!.orphanedAt).toBeNull();
      expect(icons.find((i) => i.id === FRESH)!.orphanedAt).toBe(T0 - ORPHAN_GRACE_MS + 1);
      expect(await storage.getBlob(EXPIRED)).toBeUndefined();
      expect(await storage.getBlob(FRESH)).toBeDefined();
      expect(await storage.getJson(`slice:${SLICE.icons}`)).toEqual(icons);
      expect(t.objectUrls).toHaveLength(4);
      for (const id of [LIVE, FRESH, REREFERENCED, UNREFERENCED_NEW]) expect(t.ctx.assets.has('icons', id)).toBe(true);
      expect(t.ctx.assets.has('icons', EXPIRED)).toBe(false);
      // The bookmark whose icon vanished reports auto; the others keep their mode.
      const [group] = await list();
      expect(group!.bookmarks.map((b) => [b.title, b.iconMode, b.iconId])).toEqual([
        ['live', 'custom', LIVE],
        ['ghost', 'auto', null],
        ['again', 'custom', REREFERENCED],
        ['letter', 'letter', null],
      ]);
    });

    it('deletes icon bytes that never got metadata once they are older than the grace period', async () => {
      const storage = new MemoryStorage();
      const stray = { kind: 'icon' as const, type: 'image/png', bytes: png(), width: 16 };
      await storage.putBlob({ ...stray, id: EXPIRED, createdAt: T0 - ORPHAN_GRACE_MS });
      await storage.putBlob({ ...stray, id: FRESH, createdAt: T0 - 1000 }); // maybe another tab's upload in progress
      await storage.putBlob({ ...stray, id: LIVE, createdAt: T0 - 2 * ORPHAN_GRACE_MS });
      await storage.putBlob({ id: UNREFERENCED_NEW, kind: 'upload', type: 'image/png', bytes: png(), width: null, createdAt: T0 - 2 * ORPHAN_GRACE_MS });
      await storage.setJson(`slice:${SLICE.icons}`, [meta(LIVE)]);
      await storage.setJson(`slice:${SLICE.bookmarks}`, { groups: [{ id: 'g1', name: 'G', sort: 0, color: null, collapsed: false, createdAt: T0, updatedAt: T0 }], bookmarks: [row('live', 0, LIVE)] });
      t.close();
      t = await createTestBackend([bookmarks], { storage, startAt: T0 });
      expect((await storage.listBlobs()).map((blob) => blob.id).sort()).toEqual([FRESH, LIVE, UNREFERENCED_NEW].sort());
      expect(getIcons(t.ctx).map((i) => i.id)).toEqual([LIVE]);
      // Also without any icon metadata at all.
      await storage.setJson(`slice:${SLICE.icons}`, []);
      t.close();
      t = await createTestBackend([bookmarks], { storage, startAt: T0 + ORPHAN_GRACE_MS });
      expect((await storage.listBlobs()).map((blob) => blob.id)).toEqual([UNREFERENCED_NEW]);
    });

    it('is idempotent and a no-op without icons', async () => {
      await bookmarks.ready(t.ctx);
      expect(await t.storage.getJson(`slice:${SLICE.icons}`)).toBeUndefined();
      const g = await createGroup('G');
      const b = await createBookmark(g.id, 'A');
      const iconId = (await t.json<Bookmark>('POST', `/api/bookmarks/${b.id}/icon`, fileForm(PNG_BYTES))).body.iconId!;
      await bookmarks.ready(t.ctx);
      expect(getIcons(t.ctx).map((i) => i.id)).toEqual([iconId]);
      expect(t.ctx.assets.has('icons', iconId)).toBe(true);
      // Icons the search engines reference count as references too.
      await t.call('DELETE', `/api/bookmarks/${b.id}`);
      getSettings(t.ctx).search.engines[0]!.iconId = iconId;
      t.tick(2 * ORPHAN_GRACE_MS);
      await bookmarks.ready(t.ctx);
      expect(getIcons(t.ctx)).toEqual([{ id: iconId, type: 'image/png', width: 16, createdAt: T0, orphanedAt: null }]);
    });
  });

  // -------------------------------------------------------------------------
  // Site meta substitute
  // -------------------------------------------------------------------------

  describe('GET /api/site-meta', () => {
    const meta = async (url: string) => t.json<SiteMeta & ErrorBody>('GET', `/api/site-meta?url=${encodeURIComponent(url)}`);

    it('answers the site name and the host’s favicon id without any network', async () => {
      autoIcons(true);
      expect((await meta('https://www.netflix.com/browse')).body).toEqual({ title: 'Netflix', iconId: 'fav:www.netflix.com' });
      expect((await meta('https://news.bbc.co.uk/')).body).toEqual({ title: 'Bbc', iconId: 'fav:news.bbc.co.uk' });
      expect((await meta('  https://Example.COM:8443/x  ')).body).toEqual({ title: 'Example', iconId: 'fav:example.com:8443' });
    });

    it('never names a local-looking host to the icon service', async () => {
      autoIcons(true);
      expect((await meta('http://192.168.1.10:8080/')).body).toEqual({ title: '192.168.1.10', iconId: null });
      expect((await meta('http://nas/')).body).toEqual({ title: 'nas', iconId: null });
      expect((await meta('http://printer.local/')).body).toEqual({ title: 'Printer', iconId: null });
    });

    it('answers no icon when automatic icons are off', async () => {
      expect((await meta('https://github.com/')).body).toEqual({ title: 'Github', iconId: null });
    });

    it('validates the query (422 Invalid query)', async () => {
      for (const url of ['javascript:alert(1)', 'ftp://x.example/', 'not a url', 'https://user:pw@x.example/']) {
        const res = await meta(url);
        expect(res.status, url).toBe(422);
        expect(res.body.error).toMatchObject({ code: 'validation_failed', message: 'Invalid query' });
        expect(res.body.error.details?.[0]?.path).toBe('url');
      }
      expect((await t.json<ErrorBody>('GET', '/api/site-meta')).status).toBe(422);
    });
  });
});
