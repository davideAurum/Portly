import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PROFILES, MAX_WIDGETS_PER_PROFILE, type Profile, type Settings, type WidgetInstance } from '@homebase/shared';
import { isUuidV4 } from '../../lib/ids.ts';
import { createMemoryLogger } from '../../lib/logger.ts';
import { coreTestbed, type CoreTestbed } from './__fixtures__/setup.ts';
import { MAX_WIDGET_CONFIG_BYTES, findFreeSlot } from './profiles.ts';

/** What the web's `createDefaultLayout()` posts on first run. */
const seedLayout = {
  version: 1,
  items: [
    { id: 'default-search', type: 'search', x: 0, y: 0, w: 8, h: 2, config: {}, frame: { showHeader: false, transparent: false } },
    { id: 'default-clock', type: 'clock', x: 8, y: 0, w: 4, h: 3, config: { showSeconds: true }, frame: { showHeader: false, transparent: false } },
    { id: 'default-launchpad', type: 'launchpad', x: 0, y: 2, w: 8, h: 6, config: {} },
  ],
};

describe('core: profiles', () => {
  let t: CoreTestbed;
  beforeEach(() => {
    t = coreTestbed();
  });
  afterEach(() => t.close());

  const create = async (body: unknown) => t.json<Profile>('POST', '/api/profiles', { body });
  const activeId = () => t.ctx.settings.get('activeProfileId');

  it('first run: [] then the seeded profile becomes active with server-generated widget ids', async () => {
    expect((await t.json('GET', '/api/profiles')).body).toEqual([]);
    expect(activeId()).toBeNull();

    const res = await create({ name: 'Home', layout: seedLayout });
    expect(res.status).toBe(201);
    expect(isUuidV4(res.body.id)).toBe(true);
    expect(res.body).toMatchObject({ name: 'Home', sort: 0 });
    expect(res.body.layout.items.map((i) => i.type)).toEqual(['search', 'clock', 'launchpad']);
    expect(res.body.layout.items.every((i) => isUuidV4(i.id))).toBe(true);
    expect(res.body.layout.items[1]?.config).toEqual({ showSeconds: true });
    expect(res.body.layout.items[2]?.frame).toEqual({ showHeader: true, transparent: false });
    expect(activeId()).toBe(res.body.id);
    expect((await t.json<Profile[]>('GET', '/api/profiles')).body).toEqual([res.body]);
  });

  it('a corrupt stored layout reads as empty and is reported once, not on every GET (LOG-1)', async () => {
    t.close();
    const log = createMemoryLogger();
    t = coreTestbed({ log });
    const home = await create({ name: 'Home', layout: seedLayout });
    t.ctx.db.run('UPDATE profiles SET layout = ? WHERE id = ?', ['{"version":2,"items":"nope"}', home.body.id]);
    for (let i = 0; i < 4; i++) {
      const list = await t.json<Profile[]>('GET', '/api/profiles');
      expect(list.body[0]?.layout).toEqual({ version: 1, items: [] });
    }
    const warns = log.lines.filter((l) => l.level === 'warn' && l.message.includes('database column failed validation'));
    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields).toMatchObject({ column: 'profiles.layout', profileId: home.body.id });
  });

  it('later profiles are appended, keep the active one, and can copy another layout', async () => {
    const home = await create({ name: 'Home', layout: seedLayout });
    const work = await create({ name: 'Work' });
    expect(work.body).toMatchObject({ name: 'Work', sort: 1, layout: { version: 1, items: [] } });
    expect(activeId()).toBe(home.body.id);

    const copy = await create({ name: 'Copy', copyFromId: home.body.id });
    expect(copy.status).toBe(201);
    expect(copy.body.layout.items.map((i) => i.type)).toEqual(home.body.layout.items.map((i) => i.type));
    const homeIds = new Set(home.body.layout.items.map((i) => i.id));
    expect(copy.body.layout.items.some((i) => homeIds.has(i.id))).toBe(false);

    expect((await create({ name: 'X', copyFromId: 'missing' })).status).toBe(404);
    expect((await create({ name: 'X', copyFromId: home.body.id, layout: seedLayout })).status).toBe(422);
  });

  it('validates input strictly and rejects forbidden keys in widget configs', async () => {
    expect((await create({ name: '' })).status).toBe(422);
    expect((await create({ name: 'x'.repeat(65) })).status).toBe(422);
    expect((await create({ name: 'Home', extra: 1 })).status).toBe(422);
    expect((await create({ name: 'Home', layout: { version: 2, items: [] } })).status).toBe(422);
    const dupIds = { version: 1, items: [seedLayout.items[0], { ...seedLayout.items[1], id: 'default-search' }] };
    expect((await create({ name: 'Home', layout: dupIds })).status).toBe(422);
    const hostile = `{"name":"Home","layout":{"version":1,"items":[{"id":"a","type":"clock","x":0,"y":0,"w":4,"h":3,"config":{"__proto__":{"polluted":true}}}]}}`;
    const res = await t.req('POST', '/api/profiles', { body: hostile, headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((await t.json('GET', '/api/profiles')).body).toEqual([]);
  });

  it(`caps profiles at ${MAX_PROFILES}`, async () => {
    for (let i = 0; i < MAX_PROFILES; i++) {
      t.ctx.db.run('INSERT INTO profiles (id, name, sort, layout, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)', [
        `p${i}`,
        `P${i}`,
        i,
        '{"version":1,"items":[]}',
      ]);
    }
    const res = await t.json<{ error: { code: string } }>('POST', '/api/profiles', { body: { name: 'One too many' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('PATCH renames/reorders; activate switches; unknown ids 404', async () => {
    const home = await create({ name: 'Home' });
    const work = await create({ name: 'Work' });
    const renamed = await t.json<Profile>('PATCH', `/api/profiles/${home.body.id}`, { body: { name: '  Home base  ', sort: 5 } });
    expect(renamed.body).toMatchObject({ id: home.body.id, name: 'Home base', sort: 5 });
    expect((await t.json<Profile[]>('GET', '/api/profiles')).body.map((p) => p.name)).toEqual(['Work', 'Home base']);
    expect((await t.req('PATCH', `/api/profiles/${home.body.id}`, { body: { layout: {} } })).status).toBe(422);
    expect((await t.req('PATCH', '/api/profiles/missing', { body: { name: 'x' } })).status).toBe(404);

    const activated = await t.json<Settings>('POST', `/api/profiles/${work.body.id}/activate`);
    expect(activated.status).toBe(200);
    expect(activated.body.activeProfileId).toBe(work.body.id);
    expect(activeId()).toBe(work.body.id);
    expect((await t.req('POST', '/api/profiles/missing/activate')).status).toBe(404);
  });

  it('DELETE: the last profile cannot be deleted; deleting the active one activates another', async () => {
    const home = await create({ name: 'Home' });
    expect((await t.json<{ error: { code: string } }>('DELETE', `/api/profiles/${home.body.id}`)).status).toBe(409);
    const work = await create({ name: 'Work' });
    const play = await create({ name: 'Play' });
    expect(activeId()).toBe(home.body.id);

    expect((await t.req('DELETE', `/api/profiles/${home.body.id}`)).status).toBe(204);
    expect(activeId()).toBe(work.body.id);
    expect((await t.req('DELETE', `/api/profiles/${play.body.id}`)).status).toBe(204);
    expect(activeId()).toBe(work.body.id);
    expect((await t.req('DELETE', `/api/profiles/${play.body.id}`)).status).toBe(404);
    expect((await t.json<Profile[]>('GET', '/api/profiles')).body.map((p) => p.name)).toEqual(['Work']);
  });

  it('PUT positions updates listed widgets only and ignores unknown ids', async () => {
    const home = await create({ name: 'Home', layout: seedLayout });
    const [search, clock, launchpad] = home.body.layout.items as [WidgetInstance, WidgetInstance, WidgetInstance];
    const res = await t.json<Profile>('PUT', `/api/profiles/${home.body.id}/positions`, {
      body: { items: [{ id: clock.id, x: 0, y: 10, w: 6, h: 4 }, { id: 'gone', x: 0, y: 0, w: 1, h: 1 }] },
    });
    expect(res.status).toBe(200);
    const byId = new Map(res.body.layout.items.map((i) => [i.id, i]));
    expect(byId.get(clock.id)).toMatchObject({ x: 0, y: 10, w: 6, h: 4, config: { showSeconds: true } });
    expect(byId.get(search.id)).toEqual(search);
    expect(byId.get(launchpad.id)).toEqual(launchpad);
    expect((await t.json<Profile[]>('GET', '/api/profiles')).body[0]?.layout).toEqual(res.body.layout);

    const bad = await t.req('PUT', `/api/profiles/${home.body.id}/positions`, { body: { items: [{ id: clock.id, x: 10, y: 0, w: 4, h: 2 }] } });
    expect(bad.status).toBe(422);
    expect((await t.req('PUT', '/api/profiles/missing/positions', { body: { items: [] } })).status).toBe(404);
  });

  describe('widgets', () => {
    let profileId: string;
    beforeEach(async () => {
      profileId = (await create({ name: 'Home', layout: seedLayout })).body.id;
    });
    const layout = async () => (await t.json<Profile[]>('GET', '/api/profiles')).body.find((p) => p.id === profileId)!.layout;

    it('POST adds a widget in the first free slot with a default size', async () => {
      const res = await t.json<WidgetInstance>('POST', `/api/profiles/${profileId}/widgets`, { body: { type: 'weather' } });
      expect(res.status).toBe(201);
      expect(isUuidV4(res.body.id)).toBe(true);
      // search 8x2 + clock 4x3 occupy the top; launchpad 8x6 at y=2; first 4x5 hole is x=8,y=3.
      expect(res.body).toMatchObject({ type: 'weather', x: 8, y: 3, w: 4, h: 5, config: {}, frame: { showHeader: true, transparent: false } });
      expect((await layout()).items.at(-1)).toEqual(res.body);
    });

    it('stores unknown widget types with opaque config; validates type keys and frames', async () => {
      const unknown = await t.json<WidgetInstance>('POST', `/api/profiles/${profileId}/widgets`, {
        body: { type: 'stocks', config: { symbols: ['MSFT'], nested: { deep: [1, 2, { x: null }] } }, frame: { title: '  Markets  ' } },
      });
      expect(unknown.status).toBe(201);
      expect(unknown.body).toMatchObject({ type: 'stocks', w: 4, h: 4, config: { symbols: ['MSFT'] }, frame: { title: 'Markets' } });
      expect((await t.req('POST', `/api/profiles/${profileId}/widgets`, { body: { type: 'Bad Type' } })).status).toBe(422);
      expect((await t.req('POST', `/api/profiles/${profileId}/widgets`, { body: { type: 'clock', frame: { color: 'red' } } })).status).toBe(422);
      expect((await t.req('POST', `/api/profiles/${profileId}/widgets`, { body: { type: 'clock', x: 3 } })).status).toBe(422);
      expect((await t.req('POST', '/api/profiles/missing/widgets', { body: { type: 'clock' } })).status).toBe(404);
    });

    it('rejects forbidden keys and oversized configs', async () => {
      const body = '{"type":"clock","config":{"a":[{"constructor":{"prototype":{"polluted":true}}}]}}';
      expect((await t.req('POST', `/api/profiles/${profileId}/widgets`, { body, headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      const big = await t.json<{ error: { code: string } }>('POST', `/api/profiles/${profileId}/widgets`, {
        body: { type: 'clock', config: { blob: 'x'.repeat(MAX_WIDGET_CONFIG_BYTES) } },
      });
      expect(big.status).toBe(422);
      expect((await layout()).items).toHaveLength(3);
    });

    it(`caps widgets at ${MAX_WIDGETS_PER_PROFILE} per profile`, async () => {
      const results = await Promise.all(
        Array.from({ length: MAX_WIDGETS_PER_PROFILE - 3 }, () => t.req('POST', `/api/profiles/${profileId}/widgets`, { body: { type: 'clock' } })),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      const items = (await layout()).items;
      expect(items).toHaveLength(MAX_WIDGETS_PER_PROFILE);
      expect(new Set(items.map((i) => i.id)).size).toBe(MAX_WIDGETS_PER_PROFILE);
      expect((await t.req('POST', `/api/profiles/${profileId}/widgets`, { body: { type: 'clock' } })).status).toBe(409);
    });

    it('PATCH replaces config and merges frame; DELETE removes', async () => {
      const clock = (await layout()).items.find((i) => i.type === 'clock')!;
      const patched = await t.json<WidgetInstance>('PATCH', `/api/profiles/${profileId}/widgets/${clock.id}`, {
        body: { config: { format: '24h' }, frame: { title: 'Time', transparent: true } },
      });
      expect(patched.status).toBe(200);
      expect(patched.body).toEqual({ ...clock, config: { format: '24h' }, frame: { showHeader: false, transparent: true, title: 'Time' } });

      const frameOnly = await t.json<WidgetInstance>('PATCH', `/api/profiles/${profileId}/widgets/${clock.id}`, { body: { frame: { title: null } } });
      expect(frameOnly.body).toEqual({ ...clock, config: { format: '24h' }, frame: { showHeader: false, transparent: true } });
      expect((await layout()).items.find((i) => i.id === clock.id)).toEqual(frameOnly.body);

      expect((await t.req('PATCH', `/api/profiles/${profileId}/widgets/missing`, { body: { config: {} } })).status).toBe(404);
      expect((await t.req('PATCH', `/api/profiles/${profileId}/widgets/${clock.id}`, { body: { x: 1 } })).status).toBe(422);

      expect((await t.req('DELETE', `/api/profiles/${profileId}/widgets/${clock.id}`)).status).toBe(204);
      expect((await layout()).items.map((i) => i.type)).toEqual(['search', 'launchpad']);
      expect((await t.req('DELETE', `/api/profiles/${profileId}/widgets/${clock.id}`)).status).toBe(404);
    });
  });
});

describe('findFreeSlot', () => {
  const item = (x: number, y: number, w: number, h: number) => ({ id: `${x}${y}`, type: 'clock', x, y, w, h, config: {}, frame: { showHeader: true, transparent: false } });

  it('fills holes left to right, top to bottom, and falls back to below everything', () => {
    expect(findFreeSlot([], 4, 3)).toEqual({ x: 0, y: 0 });
    expect(findFreeSlot([item(0, 0, 4, 2)], 4, 2)).toEqual({ x: 4, y: 0 });
    expect(findFreeSlot([item(0, 0, 12, 2)], 12, 2)).toEqual({ x: 0, y: 2 });
    expect(findFreeSlot([item(0, 0, 6, 4), item(6, 2, 6, 2)], 6, 2)).toEqual({ x: 6, y: 0 });
    expect(findFreeSlot([item(0, 0, 6, 4), item(6, 0, 6, 4)], 12, 1)).toEqual({ x: 0, y: 4 });
  });
});
