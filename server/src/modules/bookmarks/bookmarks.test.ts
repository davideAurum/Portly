import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Bookmark, BookmarkGroup, BookmarksResponse } from '@homebase/shared';
import { bookmarksTestbed, type BookmarksTestbed } from './__fixtures__/setup.ts';

describe('bookmarks: groups and bookmarks', () => {
  let t: BookmarksTestbed;
  beforeEach(() => {
    // No favicon traffic in these tests.
    t = bookmarksTestbed();
    t.ctx.settings.set('bookmarks', { defaultGroupId: null, autoFetchIcons: false });
  });
  afterEach(() => t.close());

  const createGroup = async (name: string, extra: Record<string, unknown> = {}) => {
    const res = await t.json<BookmarkGroup>('POST', '/api/bookmark-groups', { body: { name, ...extra } });
    expect(res.status).toBe(201);
    return res.body;
  };
  const createBookmark = async (groupId: string, title: string, url = `https://${title.toLowerCase()}.example/`) => {
    const res = await t.json<Bookmark>('POST', '/api/bookmarks', { body: { groupId, title, url } });
    expect(res.status).toBe(201);
    return res.body;
  };
  const list = async () => (await t.json<BookmarksResponse>('GET', '/api/bookmarks')).body.groups;
  const titles = (groups: BookmarkGroup[], groupId: string) => groups.find((g) => g.id === groupId)!.bookmarks.map((b) => b.title);
  const sorts = (groups: BookmarkGroup[], groupId: string) => groups.find((g) => g.id === groupId)!.bookmarks.map((b) => b.sort);

  it('lists groups with their bookmarks in order', async () => {
    expect(await list()).toEqual([]);
    const work = await createGroup('Work', { color: '#3B82F6' });
    const home = await createGroup('Home');
    expect(work).toMatchObject({ name: 'Work', sort: 0, color: '#3b82f6', collapsed: false, bookmarks: [] });
    expect(home.sort).toBe(1);
    const a = await createBookmark(work.id, 'Alpha');
    await createBookmark(work.id, 'Beta');
    expect(a).toMatchObject({ groupId: work.id, title: 'Alpha', url: 'https://alpha.example/', sort: 0, iconMode: 'auto', iconId: null, letterColor: null });
    const groups = await list();
    expect(groups.map((g) => g.name)).toEqual(['Work', 'Home']);
    expect(titles(groups, work.id)).toEqual(['Alpha', 'Beta']);
    expect(sorts(groups, work.id)).toEqual([0, 1]);
  });

  it('validates bookmarks (SafeHttpUrl, title, group) and groups', async () => {
    const g = await createGroup('G');
    for (const url of ['javascript:alert(1)', 'file:///C:/x', 'https://user:pw@example.com/', 'not a url', `https://e.com/${'a'.repeat(2100)}`]) {
      const res = await t.json<{ error: { code: string } }>('POST', '/api/bookmarks', { body: { groupId: g.id, title: 'x', url } });
      expect(res.status, url).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
    }
    expect((await t.req('POST', '/api/bookmarks', { body: { groupId: g.id, title: '   ', url: 'https://e.com' } })).status).toBe(422);
    expect((await t.req('POST', '/api/bookmarks', { body: { groupId: 'nope', title: 'x', url: 'https://e.com' } })).status).toBe(422);
    expect((await t.req('POST', '/api/bookmarks', { body: { groupId: g.id, title: 'x', url: 'https://e.com', extra: 1 } })).status).toBe(422);
    expect((await t.req('POST', '/api/bookmark-groups', { body: { name: 'x', color: 'red' } })).status).toBe(422);
    expect((await t.req('POST', '/api/bookmark-groups', { body: { name: '' } })).status).toBe(422);
  });

  it('updates bookmarks through an allowlist and supports letter icons', async () => {
    const g = await createGroup('G');
    const b = await createBookmark(g.id, 'Alpha');
    const res = await t.json<Bookmark>('PATCH', `/api/bookmarks/${b.id}`, {
      body: { title: 'Renamed', url: 'https://renamed.example/path', iconMode: 'letter', letterColor: '#FF0000' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Renamed', url: 'https://renamed.example/path', iconMode: 'letter', iconId: null, letterColor: '#ff0000' });
    expect((await t.req('PATCH', `/api/bookmarks/${b.id}`, { body: { sort: 5 } })).status).toBe(422);
    expect((await t.req('PATCH', '/api/bookmarks/missing', { body: { title: 'x' } })).status).toBe(404);
    // Custom mode without a stored upload falls back to the automatic icon.
    const custom = await t.json<Bookmark>('PATCH', `/api/bookmarks/${b.id}`, { body: { iconMode: 'custom', iconId: 'no-such-icon' } });
    expect(custom.body.iconMode).toBe('auto');
  });

  it('deletes bookmarks and renumbers the group', async () => {
    const g = await createGroup('G');
    const [, b] = [await createBookmark(g.id, 'A'), await createBookmark(g.id, 'B'), await createBookmark(g.id, 'C')];
    expect((await t.req('DELETE', `/api/bookmarks/${b!.id}`)).status).toBe(204);
    const groups = await list();
    expect(titles(groups, g.id)).toEqual(['A', 'C']);
    expect(sorts(groups, g.id)).toEqual([0, 1]);
    expect((await t.req('DELETE', `/api/bookmarks/${b!.id}`)).status).toBe(404);
  });

  it('updates, collapses and reorders groups', async () => {
    const a = await createGroup('A');
    const b = await createGroup('B');
    const c = await createGroup('C');
    const patched = await t.json<BookmarkGroup>('PATCH', `/api/bookmark-groups/${a.id}`, { body: { name: 'Alpha', collapsed: true, color: null } });
    expect(patched.body).toMatchObject({ name: 'Alpha', collapsed: true, color: null });

    const reordered = await t.json<BookmarksResponse>('POST', '/api/bookmark-groups/reorder', { body: { ids: [c.id, a.id, b.id] } });
    expect(reordered.body.groups.map((g) => [g.name, g.sort])).toEqual([
      ['C', 0],
      ['Alpha', 1],
      ['B', 2],
    ]);
    // Partial / unknown ids: listed first, the rest keep their relative order.
    const partial = await t.json<BookmarksResponse>('POST', '/api/bookmark-groups/reorder', { body: { ids: [b.id, 'unknown'] } });
    expect(partial.body.groups.map((g) => g.name)).toEqual(['B', 'C', 'Alpha']);
    expect((await t.req('POST', '/api/bookmark-groups/reorder', { body: { ids: [a.id, a.id] } })).status).toBe(422);
  });

  it('deleting a group removes its bookmarks, renumbers groups and resets the default group', async () => {
    const a = await createGroup('A');
    const b = await createGroup('B');
    await createBookmark(a.id, 'One');
    t.ctx.settings.set('bookmarks', { defaultGroupId: a.id, autoFetchIcons: false });
    expect((await t.req('DELETE', `/api/bookmark-groups/${a.id}`)).status).toBe(204);
    const groups = await list();
    expect(groups.map((g) => [g.id, g.sort])).toEqual([[b.id, 0]]);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bookmarks')?.n).toBe(0);
    expect(t.ctx.settings.get('bookmarks').defaultGroupId).toBeNull();
    expect((await t.req('DELETE', `/api/bookmark-groups/${a.id}`)).status).toBe(404);
  });

  it('deleting the "No group" group resets bookmarks.ungroupedGroupId (and keeps the default group)', async () => {
    const a = await createGroup('A');
    const none = await createGroup('No group');
    t.ctx.settings.set('bookmarks', { defaultGroupId: a.id, ungroupedGroupId: none.id, autoFetchIcons: false });
    expect((await t.req('DELETE', `/api/bookmark-groups/${none.id}`)).status).toBe(204);
    expect(t.ctx.settings.get('bookmarks')).toMatchObject({ defaultGroupId: a.id, ungroupedGroupId: null });
  });

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

    const move = (id: string, groupId: string, index: number) =>
      t.json<BookmarksResponse & { error?: { code: string } }>('POST', `/api/bookmarks/${id}/move`, { body: { groupId, index } });

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
      expect((await move(ids.A!, 'missing-group', 0)).status).toBe(422);
      expect((await move('missing-bookmark', g1.id, 0)).status).toBe(404);
      expect((await move(ids.A!, g1.id, -1)).status).toBe(422);
      expect(await list()).toEqual(before);
    });

    it('repairs colliding sorts on the next move', async () => {
      t.ctx.db.run('UPDATE bookmarks SET sort = 0 WHERE group_id = ?', [g1.id]);
      const res = await move(ids.D!, g1.id, 0);
      expect(res.body.groups.find((g) => g.id === g1.id)!.bookmarks[0]!.title).toBe('D');
      expect(sorts(res.body.groups, g1.id)).toEqual([0, 1, 2, 3]);
    });
  });
});
