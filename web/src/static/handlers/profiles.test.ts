/**
 * Static profile and widget routes: the server's semantics (profiles.test.ts on the server side)
 * over the profiles slice, plus the browser-only refusal of calendar/mail/feeds widgets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PROFILES, MAX_WIDGETS_PER_PROFILE, type Profile, type Settings, type WidgetInstance } from '@homebase/shared';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { isUuidV4 } from '../lib/ids.ts';
import { getProfiles } from '../slices.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import { MAX_WIDGET_CONFIG_BYTES, findFreeSlot } from './profiles.ts';
import * as profiles from './profiles.ts';
import * as settings from './settings.ts';

const MODULES = [settings, profiles];

interface ErrorBody {
  error: { code: string; message: string };
}

/** What the web's `createDefaultLayout()` posts on first run. */
const seedLayout = {
  version: 1,
  items: [
    { id: 'default-search', type: 'search', x: 0, y: 0, w: 8, h: 2, config: {}, frame: { showHeader: false, transparent: false } },
    { id: 'default-clock', type: 'clock', x: 8, y: 0, w: 4, h: 3, config: { showSeconds: true }, frame: { showHeader: false, transparent: false } },
    { id: 'default-launchpad', type: 'launchpad', x: 0, y: 2, w: 8, h: 6, config: {} },
  ],
};

describe('static core: profiles', () => {
  let t: TestBackend;
  beforeEach(async () => {
    t = await createTestBackend(MODULES);
  });
  afterEach(() => t.close());

  const create = (body: unknown) => t.json<Profile & ErrorBody>('POST', '/api/profiles', body);
  const activeId = async () => (await t.json<Settings>('GET', '/api/settings')).body.activeProfileId;
  const list = async () => (await t.json<Profile[]>('GET', '/api/profiles')).body;
  const rawPost = (path: string, body: string) => t.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

  it('first run: [] then the seeded profile becomes active with fresh widget ids', async () => {
    expect(await list()).toEqual([]);
    expect(await activeId()).toBeNull();

    const res = await create({ name: 'Home', layout: seedLayout });
    expect(res.status).toBe(201);
    expect(isUuidV4(res.body.id)).toBe(true);
    expect(Object.keys(res.body)).toEqual(['id', 'name', 'sort', 'layout']);
    expect(res.body).toMatchObject({ name: 'Home', sort: 0 });
    expect(res.body.layout.items.map((i) => i.type)).toEqual(['search', 'clock', 'launchpad']);
    expect(res.body.layout.items.every((i) => isUuidV4(i.id))).toBe(true);
    expect(res.body.layout.items[1]?.config).toEqual({ showSeconds: true });
    expect(res.body.layout.items[2]?.frame).toEqual({ showHeader: true, transparent: false });
    expect(await activeId()).toBe(res.body.id);
    expect(await list()).toEqual([res.body]);
    // Persisted with timestamps, served without them.
    expect(getProfiles(t.ctx)[0]).toMatchObject({ id: res.body.id, createdAt: t.ctx.now(), updatedAt: t.ctx.now() });
    expect(await t.storage.getJson('slice:profiles')).toEqual(getProfiles(t.ctx));
  });

  it('a corrupt stored layout reads as empty', async () => {
    const home = await create({ name: 'Home', layout: seedLayout });
    getProfiles(t.ctx).find((p) => p.id === home.body.id)!.layout = { version: 2, items: 'nope' } as never;
    expect((await list())[0]?.layout).toEqual({ version: 1, items: [] });
  });

  it('later profiles are appended, keep the active one, and can copy another layout', async () => {
    const home = await create({ name: 'Home', layout: seedLayout });
    const work = await create({ name: 'Work' });
    expect(work.body).toMatchObject({ name: 'Work', sort: 1, layout: { version: 1, items: [] } });
    expect(await activeId()).toBe(home.body.id);

    const copy = await create({ name: 'Copy', copyFromId: home.body.id });
    expect(copy.status).toBe(201);
    expect(copy.body.layout.items.map((i) => i.type)).toEqual(home.body.layout.items.map((i) => i.type));
    const homeIds = new Set(home.body.layout.items.map((i) => i.id));
    expect(copy.body.layout.items.some((i) => homeIds.has(i.id))).toBe(false);

    expect((await create({ name: 'X', copyFromId: 'missing' })).status).toBe(404);
    const both = await create({ name: 'X', copyFromId: home.body.id, layout: seedLayout });
    expect(both.status).toBe(422);
    expect(both.body.error.message).toBe('Pass either copyFromId or layout, not both');
  });

  it('a dangling active pointer is repaired by the next created profile', async () => {
    const home = await create({ name: 'Home' });
    getProfiles(t.ctx).splice(0, 1);
    expect(await activeId()).toBe(home.body.id);
    const work = await create({ name: 'Work' });
    expect(await activeId()).toBe(work.body.id);
  });

  it('orders by sort, then createdAt, then id (the server order, not the name)', async () => {
    const b = await create({ name: 'B' });
    t.tick(1000);
    const a = await create({ name: 'A' });
    await t.call('PATCH', `/api/profiles/${a.body.id}`, { sort: 0 });
    expect((await list()).map((p) => p.name)).toEqual(['B', 'A']);
    await t.call('PATCH', `/api/profiles/${b.body.id}`, { sort: 7 });
    expect((await list()).map((p) => p.name)).toEqual(['A', 'B']);
    expect((await create({ name: 'C' })).body.sort).toBe(8);
  });

  it('validates input strictly and rejects forbidden keys in widget configs', async () => {
    expect((await create({ name: '' })).status).toBe(422);
    expect((await create({ name: 'x'.repeat(65) })).status).toBe(422);
    expect((await create({ name: 'Home', extra: 1 })).status).toBe(422);
    expect((await create({ name: 'Home', layout: { version: 2, items: [] } })).status).toBe(422);
    const dupIds = { version: 1, items: [seedLayout.items[0], { ...seedLayout.items[1], id: 'default-search' }] };
    expect((await create({ name: 'Home', layout: dupIds })).status).toBe(422);
    const hostile = `{"name":"Home","layout":{"version":1,"items":[{"id":"a","type":"clock","x":0,"y":0,"w":4,"h":3,"config":{"__proto__":{"polluted":true}}}]}}`;
    expect((await rawPost('/api/profiles', hostile)).status).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const big = { version: 1, items: [{ ...seedLayout.items[1], config: { blob: 'x'.repeat(MAX_WIDGET_CONFIG_BYTES) } }] };
    const oversized = await create({ name: 'Home', layout: big });
    expect(oversized.status).toBe(422);
    expect(oversized.body.error.message).toBe(`Widget config exceeds ${MAX_WIDGET_CONFIG_BYTES} bytes`);
    expect(await list()).toEqual([]);
  });

  it(`caps profiles at ${MAX_PROFILES}`, async () => {
    const rows = getProfiles(t.ctx);
    for (let i = 0; i < MAX_PROFILES; i++) rows.push({ id: `p${i}`, name: `P${i}`, sort: i, layout: { version: 1, items: [] }, createdAt: 1, updatedAt: 1 });
    const res = await create({ name: 'One too many' });
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'conflict', message: `At most ${MAX_PROFILES} profiles are allowed` });
  });

  it('PATCH renames/reorders; activate switches and returns the settings; unknown ids 404', async () => {
    const home = await create({ name: 'Home' });
    const work = await create({ name: 'Work' });
    const renamed = await t.json<Profile>('PATCH', `/api/profiles/${home.body.id}`, { name: '  Home base  ', sort: 5 });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ id: home.body.id, name: 'Home base', sort: 5, layout: { version: 1, items: [] } });
    expect((await list()).map((p) => p.name)).toEqual(['Work', 'Home base']);
    expect((await t.call('PATCH', `/api/profiles/${home.body.id}`, { layout: {} })).status).toBe(422);
    expect((await t.call('PATCH', '/api/profiles/missing', { name: 'x' })).status).toBe(404);

    const activated = await t.json<Settings>('POST', `/api/profiles/${work.body.id}/activate`);
    expect(activated.status).toBe(200);
    expect(activated.body.activeProfileId).toBe(work.body.id);
    expect(activated.body.general).toBeDefined();
    expect(await activeId()).toBe(work.body.id);
    expect((await t.call('POST', '/api/profiles/missing/activate')).status).toBe(404);
  });

  it('path ids longer than 512 characters are 404, not 422', async () => {
    const long = 'x'.repeat(513);
    const home = await create({ name: 'Home' });
    for (const [method, path, body] of [
      ['PATCH', `/api/profiles/${long}`, { name: 'x' }],
      ['DELETE', `/api/profiles/${long}`, undefined],
      ['POST', `/api/profiles/${long}/activate`, undefined],
      ['PUT', `/api/profiles/${long}/positions`, { items: [] }],
      ['POST', `/api/profiles/${long}/widgets`, { type: 'clock' }],
      ['PATCH', `/api/profiles/${home.body.id}/widgets/${long}`, { config: {} }],
      ['DELETE', `/api/profiles/${home.body.id}/widgets/${long}`, undefined],
    ] as const) {
      const res = await t.json<ErrorBody>(method, path, body);
      expect(res.status, `${method} ${path.slice(0, 40)}`).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
  });

  it('DELETE: the last profile cannot be deleted; deleting the active one activates another', async () => {
    const home = await create({ name: 'Home' });
    const last = await t.json<ErrorBody>('DELETE', `/api/profiles/${home.body.id}`);
    expect(last.status).toBe(409);
    expect(last.body.error).toEqual({ code: 'conflict', message: 'The last profile cannot be deleted' });
    const work = await create({ name: 'Work' });
    const play = await create({ name: 'Play' });
    expect(await activeId()).toBe(home.body.id);

    const deleted = await t.call('DELETE', `/api/profiles/${home.body.id}`);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
    expect(await activeId()).toBe(work.body.id);
    expect((await t.call('DELETE', `/api/profiles/${play.body.id}`)).status).toBe(204);
    expect(await activeId()).toBe(work.body.id);
    expect((await t.call('DELETE', `/api/profiles/${play.body.id}`)).status).toBe(404);
    expect((await list()).map((p) => p.name)).toEqual(['Work']);
    expect(await t.storage.getJson('slice:profiles')).toEqual(getProfiles(t.ctx));
  });

  it('PUT positions updates listed widgets only and ignores unknown ids', async () => {
    const home = await create({ name: 'Home', layout: seedLayout });
    const [search, clock, launchpad] = home.body.layout.items as [WidgetInstance, WidgetInstance, WidgetInstance];
    const res = await t.json<Profile>('PUT', `/api/profiles/${home.body.id}/positions`, {
      items: [
        { id: clock.id, x: 0, y: 10, w: 6, h: 4 },
        { id: 'gone', x: 0, y: 0, w: 1, h: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['id', 'name', 'sort', 'layout']);
    const byId = new Map(res.body.layout.items.map((i) => [i.id, i]));
    expect(byId.get(clock.id)).toMatchObject({ x: 0, y: 10, w: 6, h: 4, config: { showSeconds: true } });
    expect(byId.get(search.id)).toEqual(search);
    expect(byId.get(launchpad.id)).toEqual(launchpad);
    expect((await list())[0]?.layout).toEqual(res.body.layout);

    // Overlaps are not checked; bounds, duplicate ids and extra keys are.
    expect((await t.call('PUT', `/api/profiles/${home.body.id}/positions`, { items: [{ id: clock.id, x: 0, y: 0, w: 8, h: 2 }] })).status).toBe(200);
    expect((await t.call('PUT', `/api/profiles/${home.body.id}/positions`, { items: [{ id: clock.id, x: 10, y: 0, w: 4, h: 2 }] })).status).toBe(422);
    const dup = { items: [{ id: clock.id, x: 0, y: 0, w: 1, h: 1 }, { id: clock.id, x: 1, y: 0, w: 1, h: 1 }] };
    expect((await t.call('PUT', `/api/profiles/${home.body.id}/positions`, dup)).status).toBe(422);
    expect((await t.call('PUT', `/api/profiles/${home.body.id}/positions`, { items: [], extra: 1 })).status).toBe(422);
    expect((await t.call('PUT', '/api/profiles/missing/positions', { items: [] })).status).toBe(404);
  });

  describe('widgets', () => {
    let profileId: string;
    beforeEach(async () => {
      profileId = (await create({ name: 'Home', layout: seedLayout })).body.id;
    });
    const layout = async () => (await list()).find((p) => p.id === profileId)!.layout;
    const add = (body: unknown) => t.json<WidgetInstance & ErrorBody>('POST', `/api/profiles/${profileId}/widgets`, body);

    it('POST adds a widget in the first free slot with a default size', async () => {
      const res = await add({ type: 'weather' });
      expect(res.status).toBe(201);
      expect(isUuidV4(res.body.id)).toBe(true);
      // search 8x2 + clock 4x3 occupy the top; launchpad 8x6 at y=2; first 4x5 hole is x=8,y=3.
      expect(res.body).toMatchObject({ type: 'weather', x: 8, y: 3, w: 4, h: 5, config: {}, frame: { showHeader: true, transparent: false } });
      expect((await layout()).items.at(-1)).toEqual(res.body);
      const todoist = await add({ type: 'todoist' });
      expect(todoist.body).toMatchObject({ x: 0, y: 8, w: 4, h: 7 });
    });

    it('stores unknown widget types with opaque config; validates type keys and frames', async () => {
      const unknown = await add({ type: 'stocks', config: { symbols: ['MSFT'], nested: { deep: [1, 2, { x: null }] } }, frame: { title: '  Markets  ' } });
      expect(unknown.status).toBe(201);
      expect(unknown.body).toMatchObject({ type: 'stocks', w: 4, h: 4, config: { symbols: ['MSFT'] }, frame: { title: 'Markets' } });
      expect((await add({ type: 'Bad Type' })).status).toBe(422);
      expect((await add({ type: 'clock', frame: { color: 'red' } })).status).toBe(422);
      expect((await add({ type: 'clock', x: 3 })).status).toBe(422);
      expect((await t.call('POST', '/api/profiles/missing/widgets', { type: 'clock' })).status).toBe(404);
    });

    it('refuses the widget types the browser-only build cannot run', async () => {
      for (const type of ['calendar', 'mail', 'feeds']) {
        const res = await add({ type });
        expect(res.status, type).toBe(422);
        expect(res.body.error).toEqual({ code: 'validation_failed', message: `Widget type "${type}" is not available in the browser-only build` });
      }
      expect((await layout()).items).toHaveLength(3);
    });

    it('refuses them whatever the page load uses: the in-browser dataset never gets a server-only widget', async () => {
      setCapabilitiesForTests(capabilitiesFor(true, 'server'));
      expect((await add({ type: 'calendar' })).status).toBe(422);
      expect((await add({ type: 'clock' })).status).toBe(201);
      expect((await layout()).items.map((i) => i.type)).not.toContain('calendar');
    });

    it('rejects forbidden keys and oversized configs', async () => {
      const body = '{"type":"clock","config":{"a":[{"constructor":{"prototype":{"polluted":true}}}]}}';
      expect((await rawPost(`/api/profiles/${profileId}/widgets`, body)).status).toBe(400);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      const big = await add({ type: 'clock', config: { blob: 'x'.repeat(MAX_WIDGET_CONFIG_BYTES) } });
      expect(big.status).toBe(422);
      expect(big.body.error.code).toBe('validation_failed');
      expect((await layout()).items).toHaveLength(3);
    });

    it(`caps widgets at ${MAX_WIDGETS_PER_PROFILE} per profile`, async () => {
      const results = await Promise.all(Array.from({ length: MAX_WIDGETS_PER_PROFILE - 3 }, () => t.call('POST', `/api/profiles/${profileId}/widgets`, { type: 'clock' })));
      expect(results.every((r) => r.status === 201)).toBe(true);
      const items = (await layout()).items;
      expect(items).toHaveLength(MAX_WIDGETS_PER_PROFILE);
      expect(new Set(items.map((i) => i.id)).size).toBe(MAX_WIDGETS_PER_PROFILE);
      const over = await add({ type: 'clock' });
      expect(over.status).toBe(409);
      expect(over.body.error.message).toBe(`At most ${MAX_WIDGETS_PER_PROFILE} widgets per profile are allowed`);
    });

    it('PATCH replaces config and merges frame; DELETE removes', async () => {
      const clock = (await layout()).items.find((i) => i.type === 'clock')!;
      const patched = await t.json<WidgetInstance>('PATCH', `/api/profiles/${profileId}/widgets/${clock.id}`, {
        config: { format: '24h' },
        frame: { title: 'Time', transparent: true },
      });
      expect(patched.status).toBe(200);
      expect(patched.body).toEqual({ ...clock, config: { format: '24h' }, frame: { showHeader: false, transparent: true, title: 'Time' } });

      // The config is opaque: anything JSON-safe is stored, even what the clock's schema would reject.
      const opaque = await t.json<WidgetInstance>('PATCH', `/api/profiles/${profileId}/widgets/${clock.id}`, { config: { nonsense: [1, 2, 3] } });
      expect(opaque.body.config).toEqual({ nonsense: [1, 2, 3] });

      const frameOnly = await t.json<WidgetInstance>('PATCH', `/api/profiles/${profileId}/widgets/${clock.id}`, { frame: { title: null } });
      expect(frameOnly.body).toEqual({ ...clock, config: { nonsense: [1, 2, 3] }, frame: { showHeader: false, transparent: true } });
      expect((await layout()).items.find((i) => i.id === clock.id)).toEqual(frameOnly.body);

      // A blank or whitespace-only title also removes it (the server trims).
      await t.call('PATCH', `/api/profiles/${profileId}/widgets/${clock.id}`, { frame: { title: 'Named' } });
      const blank = await t.json<WidgetInstance>('PATCH', `/api/profiles/${profileId}/widgets/${clock.id}`, { frame: { title: '   ', showHeader: true } });
      expect(blank.body.frame).toEqual({ showHeader: true, transparent: true });

      expect((await t.call('PATCH', `/api/profiles/${profileId}/widgets/missing`, { config: {} })).status).toBe(404);
      expect((await t.call('PATCH', `/api/profiles/${profileId}/widgets/${clock.id}`, { x: 1 })).status).toBe(422);
      expect((await t.call('PATCH', `/api/profiles/${profileId}/widgets/${clock.id}`, { config: { blob: 'x'.repeat(MAX_WIDGET_CONFIG_BYTES) } })).status).toBe(422);

      expect((await t.call('DELETE', `/api/profiles/${profileId}/widgets/${clock.id}`)).status).toBe(204);
      expect((await layout()).items.map((i) => i.type)).toEqual(['search', 'launchpad']);
      expect((await t.call('DELETE', `/api/profiles/${profileId}/widgets/${clock.id}`)).status).toBe(404);
      expect((await t.call('DELETE', `/api/profiles/missing/widgets/${clock.id}`)).status).toBe(404);
    });
  });
});

describe('findFreeSlot', () => {
  const item = (x: number, y: number, w: number, h: number): WidgetInstance => ({
    id: `${x}${y}`,
    type: 'clock',
    x,
    y,
    w,
    h,
    config: {},
    frame: { showHeader: true, transparent: false },
  });

  it('fills holes left to right, top to bottom, and falls back to below everything', () => {
    expect(findFreeSlot([], 4, 3)).toEqual({ x: 0, y: 0 });
    expect(findFreeSlot([item(0, 0, 4, 2)], 4, 2)).toEqual({ x: 4, y: 0 });
    expect(findFreeSlot([item(0, 0, 12, 2)], 12, 2)).toEqual({ x: 0, y: 2 });
    expect(findFreeSlot([item(0, 0, 6, 4), item(6, 2, 6, 2)], 6, 2)).toEqual({ x: 6, y: 0 });
    expect(findFreeSlot([item(0, 0, 6, 4), item(6, 0, 6, 4)], 12, 1)).toEqual({ x: 0, y: 4 });
  });
});
