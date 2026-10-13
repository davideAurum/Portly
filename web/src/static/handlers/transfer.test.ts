/**
 * Static export / import: the allowlisted export over the slices, the import plan with the
 * server's note strings, preview lifetime, the pre-import backup snapshot and the replace
 * semantics (transfer.test.ts on the server side).
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExportSchema,
  defaultSettings,
  type ExportFile,
  type ImportPreviewResponse,
  type ImportSummary,
  type Profile,
  type Settings,
  type UploadResponse,
} from '@portly/shared';
import { IMAGE_SAMPLES } from '../lib/__fixtures__/images.ts';
import { decodeBase64, encodeBase64 } from '../lib/base64.ts';
import { MAX_BACKUPS, SLICE, backupKey, getBackups, getBookmarks, getIcons, getProfiles, getTodoistToken, getUploads } from '../slices.ts';
import { StaticState } from '../state.ts';
import { IndexedDbStorage } from '../storage/idb.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { StaticStorage, StoredBlob } from '../storage/types.ts';
import { createTestBackend, fileForm, type TestBackend } from '../test/harness.ts';
import { MAX_WIDGET_CONFIG_BYTES } from './profiles.ts';
import * as profiles from './profiles.ts';
import * as settings from './settings.ts';
import { PREVIEW_TTL_MS, createPreviewStore, planImport, type ImportPlan } from './transfer.ts';
import * as transfer from './transfer.ts';
import * as uploads from './uploads.ts';

const MODULES = [settings, profiles, uploads, transfer];

const newId = (): string => globalThis.crypto.randomUUID();

interface ErrorBody {
  error?: { code: string; message: string; details?: { path: string }[] };
}

interface Seeded {
  groups: { work: string; fun: string };
  bookmarks: { custom: string; auto: string; letter: string };
  icons: { custom: string };
  uploads: { background: string; widgetImage: string; orphan: string };
  profile: Profile;
}

/** Fills every slice: exportable data plus everything the export must never contain. */
async function seed(t: TestBackend): Promise<Seeded> {
  const upload = async (bytes: Uint8Array): Promise<string> => (await t.json<UploadResponse>('POST', '/api/uploads', fileForm(bytes))).body.id;
  const background = await upload(IMAGE_SAMPLES.jpeg);
  t.tick(1000);
  const widgetImage = await upload(IMAGE_SAMPLES.webp);
  t.tick(1000);
  const orphan = await upload(IMAGE_SAMPLES.bmp);

  const icons = { custom: newId() };
  await t.ctx.state.putBlob({ id: icons.custom, kind: 'icon', type: 'image/png', bytes: IMAGE_SAMPLES.png, width: 32, createdAt: 1 });
  getIcons(t.ctx).push({ id: icons.custom, type: 'image/png', width: 32, createdAt: 1, orphanedAt: null });

  const groups = { work: newId(), fun: newId() };
  const store = getBookmarks(t.ctx);
  store.groups.push(
    { id: groups.work, name: 'Work', sort: 0, color: '#112233', collapsed: false, createdAt: 1, updatedAt: 1 },
    { id: groups.fun, name: 'Fun', sort: 1, color: 'rgb(1,2,3)', collapsed: true, createdAt: 1, updatedAt: 1 },
  );
  const bookmarks = { custom: newId(), auto: newId(), letter: newId() };
  store.bookmarks.push(
    { id: bookmarks.custom, groupId: groups.work, title: 'Intranet', url: 'https://intranet.example/', sort: 0, iconMode: 'custom', iconId: icons.custom, letterColor: null, createdAt: 1, updatedAt: 1 },
    { id: bookmarks.auto, groupId: groups.fun, title: 'Fun', url: 'https://fun.example/', sort: 0, iconMode: 'auto', iconId: 'fav:fun.example', letterColor: null, createdAt: 1, updatedAt: 1 },
    { id: bookmarks.letter, groupId: groups.fun, title: 'Letters', url: 'https://letters.example/', sort: 1, iconMode: 'letter', iconId: null, letterColor: '#abcdef', createdAt: 1, updatedAt: 1 },
  );
  // Never exported.
  getTodoistToken(t.ctx).token = 'todoist-TOPSECRET';
  await t.ctx.state.commit(SLICE.bookmarks, SLICE.icons, SLICE.todoistToken);

  const patched = await t.json<Settings>('PATCH', '/api/settings', {
    general: { userName: 'Dana' },
    appearance: { background: { type: 'image', uploadId: background, blur: 4, dim: 0.3, angle: null, stops: null } },
    bookmarks: { defaultGroupId: groups.work },
  });
  expect(patched.status).toBe(200);

  const created = await t.json<Profile>('POST', '/api/profiles', {
    name: 'Home',
    layout: {
      version: 1,
      items: [
        { id: 'a', type: 'launchpad', x: 0, y: 0, w: 8, h: 6, config: { groupIds: [groups.work], iconSize: 'm' } },
        { id: 'b', type: 'clock', x: 8, y: 0, w: 4, h: 3, config: { note: `bg ${widgetImage}`, image: widgetImage } },
        { id: 'c', type: 'stocks', x: 8, y: 3, w: 4, h: 3, config: { symbols: ['MSFT'] } },
      ],
    },
  });
  expect(created.status).toBe(201);
  return { groups, bookmarks, icons, uploads: { background, widgetImage, orphan }, profile: created.body };
}

function baseFile(): Record<string, unknown> & { data: Record<string, unknown[] | unknown> } {
  return {
    format: 'portly-export',
    version: 1,
    exportedAt: '2026-09-25T12:00:00.000Z',
    data: { settings: {}, profiles: [], bookmarkGroups: [], bookmarks: [], uploads: [], customIcons: [] },
  };
}

describe('static core: export', () => {
  let t: TestBackend;
  beforeEach(async () => {
    t = await createTestBackend(MODULES);
  });
  afterEach(() => t.close());

  it('serializes only the allowlisted entities, as a JSON download', async () => {
    const seeded = await seed(t);
    const res = await t.call('GET', '/api/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="portly-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    const file = JSON.parse(text) as ExportFile;
    expect(ExportSchema.safeParse(file).success).toBe(true);
    expect(Object.keys(file)).toEqual(['format', 'version', 'exportedAt', 'data']);
    expect(Object.keys(file.data)).toEqual(['settings', 'profiles', 'bookmarkGroups', 'bookmarks', 'uploads', 'customIcons']);
    expect(file.exportedAt).toBe(new Date(t.ctx.now()).toISOString());

    expect(text).not.toContain('TOPSECRET');
    expect(text).not.toContain('todoist-token');

    expect(file.data.settings.general.userName).toBe('Dana');
    expect(file.data.settings.todoist).toEqual(defaultSettings().todoist);
    expect(file.data.profiles.map((p) => p.id)).toEqual([seeded.profile.id]);
    expect(Object.keys(file.data.profiles[0]!)).toEqual(['id', 'name', 'sort', 'layout']);
    expect(file.data.bookmarkGroups).toEqual([
      { id: seeded.groups.work, name: 'Work', sort: 0, color: '#112233', collapsed: false },
      { id: seeded.groups.fun, name: 'Fun', sort: 1, color: null, collapsed: true },
    ]);
    const byId = new Map(file.data.bookmarks.map((b) => [b.id, b]));
    expect(byId.get(seeded.bookmarks.custom)).toMatchObject({ iconMode: 'custom', iconId: seeded.icons.custom });
    // Synthetic favicon ids never travel on bookmarks: an automatic icon is exported as auto/null.
    expect(byId.get(seeded.bookmarks.auto)).toMatchObject({ iconMode: 'auto', iconId: null });
    expect(byId.get(seeded.bookmarks.letter)).toMatchObject({ iconMode: 'letter', iconId: null, letterColor: '#abcdef' });

    // Referenced uploads only (background first, then newest first), types re-sniffed; custom icons embedded.
    expect(file.data.uploads.map((u) => [u.id, u.contentType])).toEqual([
      [seeded.uploads.background, 'image/jpeg'],
      [seeded.uploads.widgetImage, 'image/webp'],
    ]);
    expect(decodeBase64(file.data.uploads[0]!.data)).toEqual(IMAGE_SAMPLES.jpeg);
    expect(file.data.customIcons).toEqual([{ id: seeded.icons.custom, contentType: 'image/png', data: encodeBase64(IMAGE_SAMPLES.png), width: 32 }]);
  });

  it('exports synthetic engine icon ids as-is and demotes bookmarks whose custom icon is missing', async () => {
    const seeded = await seed(t);
    const engines = (await t.json<Settings>('GET', '/api/settings')).body.search.engines;
    await t.call('PATCH', '/api/settings', {
      search: { engines: engines.map((e, i) => ({ ...e, iconId: i === 0 ? 'fav:www.google.com' : i === 1 ? seeded.icons.custom : null })) },
    });
    // A custom bookmark whose icon blob is gone.
    const store = getBookmarks(t.ctx);
    store.bookmarks.push({
      id: newId(),
      groupId: seeded.groups.work,
      title: 'Lost icon',
      url: 'https://lost.example/',
      sort: 1,
      iconMode: 'custom',
      iconId: newId(),
      letterColor: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await t.ctx.state.commit(SLICE.bookmarks);

    const file = (await t.json<ExportFile>('GET', '/api/export')).body;
    expect(file.data.settings.search.engines[0]?.iconId).toBe('fav:www.google.com');
    expect(file.data.settings.search.engines[1]?.iconId).toBe(seeded.icons.custom);
    expect(file.data.customIcons.map((i) => i.id)).toEqual([seeded.icons.custom]);
    expect(file.data.bookmarks.find((b) => b.title === 'Lost icon')).toMatchObject({ iconMode: 'auto', iconId: null });
  });

  it('exports an empty configuration on first run', async () => {
    const file = (await t.json<ExportFile>('GET', '/api/export')).body;
    expect(ExportSchema.safeParse(file).success).toBe(true);
    expect(file.data).toEqual({ settings: defaultSettings(), profiles: [], bookmarkGroups: [], bookmarks: [], uploads: [], customIcons: [] });
  });
});

describe('static core: import', () => {
  let t: TestBackend;
  beforeEach(async () => {
    t = await createTestBackend(MODULES);
  });
  afterEach(() => t.close());

  const preview = (content: string | Uint8Array) => t.json<ImportPreviewResponse & ErrorBody>('POST', '/api/import/preview', fileForm(content, 'portly-export.json', 'application/json'));
  const previewFile = (file: unknown) => preview(JSON.stringify(file));
  const commit = (previewId: unknown) => t.json<{ ok: boolean; summary: ImportSummary } & ErrorBody>('POST', '/api/import/commit', { previewId });

  it('round-trips an export: preview summary, then commit replaces data with fresh ids and remapped references', async () => {
    const seeded = await seed(t);
    const exported = await (await t.call('GET', '/api/export')).text();
    const oldBlobIds = (await t.ctx.state.listBlobs()).map((b) => b.id).sort();
    expect(oldBlobIds).toEqual([seeded.uploads.background, seeded.uploads.widgetImage, seeded.uploads.orphan, seeded.icons.custom].sort());

    const res = await preview(exported);
    expect(res.status).toBe(200);
    expect(res.body.previewId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const summary = res.body.summary;
    expect(summary.exportedAt).toBe(new Date(t.ctx.now()).toISOString());
    expect(summary.counts).toEqual({ profiles: 1, widgets: 2, bookmarkGroups: 2, bookmarks: 3, uploads: 2, customIcons: 1 });
    expect(summary.dropped.unknownWidgets).toBe(1);
    expect(summary.dropped.notes).toEqual(['1 widget of unknown type "stocks" skipped']);
    expect(summary.searchEngines[0]).toEqual({ name: 'Google', host: 'www.google.com' });
    // Nothing is written by a preview.
    expect(getProfiles(t.ctx).map((p) => p.id)).toEqual([seeded.profile.id]);
    expect(await t.storage.getJson('slice:backups')).toBeUndefined();

    const committed = await commit(res.body.previewId);
    expect(committed.status).toBe(200);
    expect(committed.body.ok).toBe(true);
    expect(committed.body.summary).toEqual(summary);

    const list = (await t.json<Profile[]>('GET', '/api/profiles')).body;
    expect(list).toHaveLength(1);
    const profile = list[0]!;
    expect(profile.id).not.toBe(seeded.profile.id);
    expect(profile.layout.items.map((i) => i.type)).toEqual(['launchpad', 'clock']);
    const oldWidgetIds = new Set(seeded.profile.layout.items.map((i) => i.id));
    expect(profile.layout.items.some((i) => oldWidgetIds.has(i.id))).toBe(false);
    expect(getProfiles(t.ctx)[0]).toMatchObject({ createdAt: t.ctx.now(), updatedAt: t.ctx.now() });

    const groups = getBookmarks(t.ctx).groups;
    const work = groups.find((g) => g.name === 'Work')!;
    expect(Object.values(seeded.groups)).not.toContain(work.id);
    expect(work).toMatchObject({ sort: 0, color: '#112233', collapsed: false, createdAt: t.ctx.now() });
    expect(profile.layout.items[0]?.config).toEqual({ groupIds: [work.id], iconSize: 'm' });

    const uploadIds = getUploads(t.ctx).map((u) => u.id);
    expect(uploadIds).toHaveLength(2);
    const clockConfig = profile.layout.items[1]?.config as { image: string; note: string };
    expect(uploadIds).toContain(clockConfig.image);
    expect(clockConfig.note).toBe(`bg ${seeded.uploads.widgetImage}`); // only exact-match strings are ids

    const after = (await t.json<Settings>('GET', '/api/settings')).body;
    expect(after.general.userName).toBe('Dana');
    expect(after.activeProfileId).toBe(profile.id);
    expect(after.bookmarks.defaultGroupId).toBe(work.id);
    expect(after.appearance.background).toMatchObject({ type: 'image', blur: 4, dim: 0.3 });
    const bgId = (after.appearance.background as { uploadId: string }).uploadId;
    expect(uploadIds).toContain(bgId);
    expect(bgId).not.toBe(seeded.uploads.background);
    expect((await t.fetch(`/api/uploads/${bgId}`)).headers.get('content-type')).toBe('image/jpeg');
    expect(await t.storage.getJson('slice:settings')).toEqual(after);

    const bookmarks = getBookmarks(t.ctx).bookmarks;
    const custom = bookmarks.find((b) => b.title === 'Intranet')!;
    expect(custom.iconMode).toBe('custom');
    expect(custom.iconId).not.toBe(seeded.icons.custom);
    expect((await t.ctx.state.getBlob(custom.iconId!))?.kind).toBe('icon');
    expect(getIcons(t.ctx)).toEqual([{ id: custom.iconId, type: 'image/png', width: 32, createdAt: t.ctx.now(), orphanedAt: null }]);
    // Automatic icons are the synthetic favicon ids right away (nothing is left pending).
    expect(bookmarks.find((b) => b.title === 'Fun')).toMatchObject({ iconMode: 'auto', iconId: 'fav:fun.example' });
    expect(bookmarks.find((b) => b.title === 'Letters')).toMatchObject({ iconMode: 'letter', iconId: null, letterColor: '#abcdef' });

    // Old images are gone (object URLs revoked), new ones registered; the Todoist token is untouched.
    for (const id of oldBlobIds) {
      expect(await t.ctx.state.getBlob(id)).toBeUndefined();
    }
    expect(t.ctx.assets.resolve('uploads', seeded.uploads.background)).toBeUndefined();
    expect(t.ctx.assets.resolve('uploads', bgId)).toBeDefined();
    expect(t.ctx.assets.resolve('icons', custom.iconId!)).toBeDefined();
    expect(getTodoistToken(t.ctx).token).toBe('todoist-TOPSECRET');

    // A pre-import snapshot of the previous export was kept — its document outside the slices
    // (never loaded at startup), a small entry in the index — and can be downloaded.
    const backups = getBackups(t.ctx).entries;
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ at: t.ctx.now(), bytes: exported.length });
    expect(await t.storage.getJson('slice:backups')).toEqual(getBackups(t.ctx));
    // Startup loads the small index only, never the document (which embeds every image).
    const fresh = new StaticState(t.storage, { channel: null });
    await fresh.loadAll();
    expect(JSON.stringify(fresh.get(SLICE.backups, () => null)).length).toBeLessThan(200);
    expect(fresh.sliceNames().every((name) => !name.startsWith('backup:'))).toBe(true);
    const stored = await t.storage.getJson(backupKey(backups[0]!.id));
    expect(typeof stored).toBe('string');
    const snapshot = ExportSchema.parse(JSON.parse(stored as string));
    expect(snapshot.data.profiles.map((p) => p.id)).toEqual([seeded.profile.id]);
    const listed = await t.json<{ id: string; at: string; bytes: number }[]>('GET', '/api/backups');
    expect(listed.body).toEqual([{ id: backups[0]!.id, at: new Date(t.ctx.now()).toISOString(), bytes: exported.length }]);
    const download = await t.call('GET', `/api/backups/${backups[0]!.id}`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('application/json');
    expect(download.headers.get('content-disposition')).toMatch(/^attachment; filename="portly-backup-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(await download.text()).toBe(stored);
    expect((await t.call('GET', '/api/backups/nope')).status).toBe(404);
    // The import file is a valid import itself (the way back).
    expect((await preview(stored as string)).status).toBe(200);
    const again = await commit(res.body.previewId);
    expect(again.status).toBe(404);
    expect(again.body.error?.message).toBe('Import preview not found or expired; upload the file again');
  });

  it('search-engine icons: synthetic ids and embedded icons survive, fetched-favicon UUIDs become null', async () => {
    const seeded = await seed(t);
    const engines = (await t.json<Settings>('GET', '/api/settings')).body.search.engines;
    const favicon = newId();
    await t.call('PATCH', '/api/settings', {
      search: { engines: engines.map((e, i) => ({ ...e, iconId: i === 0 ? 'fav:www.google.com' : i === 1 ? favicon : i === 2 ? seeded.icons.custom : null })) },
    });
    const exported = await (await t.call('GET', '/api/export')).text();
    const res = await preview(exported);
    expect(res.body.summary.counts.customIcons).toBe(1);
    expect((await commit(res.body.previewId)).status).toBe(200);
    const after = (await t.json<Settings>('GET', '/api/settings')).body.search.engines;
    expect(after[0]?.iconId).toBe('fav:www.google.com');
    expect(after[1]?.iconId).toBeNull();
    expect(after[2]?.iconId).not.toBeNull();
    expect(after[2]?.iconId).not.toBe(seeded.icons.custom);
    expect((await t.ctx.state.getBlob(after[2]!.iconId!))?.kind).toBe('icon');
  });

  it('automatic bookmark icons stay null when the imported settings turn icon fetching off', async () => {
    await seed(t);
    await t.call('PATCH', '/api/settings', { bookmarks: { autoFetchIcons: false } });
    const exported = await (await t.call('GET', '/api/export')).text();
    const res = await preview(exported);
    await commit(res.body.previewId);
    expect(getBookmarks(t.ctx).bookmarks.find((b) => b.title === 'Fun')).toMatchObject({ iconMode: 'auto', iconId: null });
  });

  it('cleans dangling references and skips non-images', async () => {
    const file = baseFile();
    const groupId = newId();
    const uploadId = newId();
    file.data.settings = {
      appearance: { background: { type: 'image', uploadId, blur: 0, dim: 0 } },
      bookmarks: { defaultGroupId: 'gone' },
      activeProfileId: 'gone',
    };
    file.data.bookmarkGroups = [{ id: groupId, name: 'G', sort: 0, color: null, collapsed: false }];
    file.data.bookmarks = [
      { id: 'b1', groupId, title: 'Ok', url: 'https://ok.example/', sort: 0, iconMode: 'custom', iconId: 'missing-icon', letterColor: null },
      { id: 'b2', groupId: 'no-such-group', title: 'Orphan', url: 'https://orphan.example/', sort: 0, iconMode: 'auto', iconId: null, letterColor: null },
    ];
    // Declared as PNG, actually HTML: dropped (and so the background falls back to the default).
    file.data.uploads = [{ id: uploadId, contentType: 'image/png', data: encodeBase64(new TextEncoder().encode('<html><script>x</script></html>')) }];
    file.data.customIcons = [{ id: 'i1', contentType: 'image/svg+xml', data: encodeBase64(new TextEncoder().encode('<!DOCTYPE svg><svg/>')), width: null }];
    file.data.profiles = [{ id: 'p1', name: 'Only', sort: 0, layout: { version: 1, items: [] } }];

    const res = await previewFile(file);
    expect(res.status).toBe(200);
    expect(res.body.summary.counts).toEqual({ profiles: 1, widgets: 0, bookmarkGroups: 1, bookmarks: 1, uploads: 0, customIcons: 0 });
    expect(res.body.summary.dropped.notes).toEqual([
      '2 images skipped (not a supported image, too large or duplicated)',
      '1 bookmark without a group skipped',
      '1 custom bookmark icon missing; fetched icons will be used',
      'The background image was not included; the default background will be used',
    ]);
    expect((await commit(res.body.previewId)).status).toBe(200);
    const after = (await t.json<Settings>('GET', '/api/settings')).body;
    expect(after.appearance.background).toEqual(defaultSettings().appearance.background);
    expect(after.bookmarks.defaultGroupId).toBeNull();
    const list = (await t.json<Profile[]>('GET', '/api/profiles')).body;
    expect(after.activeProfileId).toBe(list[0]?.id);
    expect(getBookmarks(t.ctx).bookmarks.map((b) => [b.iconMode, b.iconId])).toEqual([['auto', 'fav:ok.example']]);
    expect(await t.ctx.state.listBlobs()).toEqual([]);
  });

  it('keeps calendar and mail widgets from an import (known types; the grid shows a notice for them)', async () => {
    const file = baseFile();
    file.data.profiles = [
      {
        id: 'p1',
        name: 'Imported',
        sort: 0,
        layout: {
          version: 1,
          items: [
            { id: 'w1', type: 'calendar', x: 0, y: 0, w: 4, h: 8, config: {} },
            { id: 'w2', type: 'mail', x: 4, y: 0, w: 4, h: 7, config: {} },
          ],
        },
      },
    ];
    const res = await previewFile(file);
    expect(res.body.summary.counts.widgets).toBe(2);
    expect(res.body.summary.dropped).toEqual({ unknownWidgets: 0, notes: [] });
    await commit(res.body.previewId);
    expect((await t.json<Profile[]>('GET', '/api/profiles')).body[0]?.layout.items.map((i) => i.type)).toEqual(['calendar', 'mail']);
  });

  it('rejects hostile files before anything is stored', async () => {
    const withProfiles = (n: number) => {
      const f = baseFile();
      f.data.profiles = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, sort: i, layout: { version: 1, items: [] } }));
      return f;
    };
    let deep: unknown = {};
    for (let i = 0; i < 200; i++) deep = { d: deep };
    const cases: [string, string | Uint8Array, number][] = [
      ['not JSON', 'definitely not json', 400],
      [
        '__proto__ in a widget config',
        JSON.stringify(baseFile()).replace(
          '"profiles":[]',
          '"profiles":[{"id":"p","name":"P","sort":0,"layout":{"version":1,"items":[{"id":"w","type":"clock","x":0,"y":0,"w":4,"h":3,"config":{"__proto__":{"polluted":true}}}]}}]',
        ),
        400,
      ],
      ['constructor.prototype in settings', JSON.stringify(baseFile()).replace('"settings":{}', '"settings":{"constructor":{"prototype":{"polluted":true}}}'), 400],
      ['deep nesting', JSON.stringify({ ...baseFile(), deep }), 400],
      ['wrong format', JSON.stringify({ ...baseFile(), format: 'other-app' }), 422],
      ['future version', JSON.stringify({ ...baseFile(), version: 2 }), 422],
      ['array root', '[]', 422],
      ['too many profiles', JSON.stringify(withProfiles(51)), 422],
      ['extra top-level key', JSON.stringify({ ...baseFile(), accounts: [] }), 422],
      ['extra data key', JSON.stringify({ ...baseFile(), data: { ...baseFile().data, secrets: [] } }), 422],
    ];
    const badUrl = baseFile();
    badUrl.data.bookmarkGroups = [{ id: 'g', name: 'G', sort: 0, color: null, collapsed: false }];
    badUrl.data.bookmarks = [{ id: 'b', groupId: 'g', title: 'x', url: 'javascript:alert(1)', sort: 0, iconMode: 'auto', iconId: null, letterColor: null }];
    cases.push(['javascript: bookmark', JSON.stringify(badUrl), 422]);
    const badEngine = baseFile();
    badEngine.data.settings = { search: { engines: [{ id: 'x', name: 'X', urlTemplate: 'javascript:%s' }], defaultEngineId: 'x' } };
    cases.push(['javascript: search template', JSON.stringify(badEngine), 422]);
    const cssInjection = baseFile();
    cssInjection.data.settings = { appearance: { accent: '#000000;background:url(//evil)' } };
    cases.push(['CSS injection in the theme', JSON.stringify(cssInjection), 422]);
    const badImage = baseFile();
    badImage.data.uploads = [{ id: newId(), contentType: 'text/html', data: 'PGh0bWw+' }];
    cases.push(['non-image content type', JSON.stringify(badImage), 422]);
    // A UTF-8 BOM is tolerated.
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(JSON.stringify(baseFile()))]);
    cases.push(['BOM-prefixed export', bom, 200]);

    for (const [name, content, status] of cases) {
      const res = await preview(content);
      expect(res.status, name).toBe(status);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    expect((await preview('definitely not json')).body.error?.message).toBe('The file is not valid JSON');
    expect((await previewFile({ ...baseFile(), format: 'other-app' })).body.error?.message).toBe('This is not a Portly export file');
    expect((await previewFile({ ...baseFile(), version: 2 })).body.error?.message).toBe('Unsupported export version (expected 1)');
    const tooMany = await previewFile(withProfiles(51));
    expect(tooMany.body.error?.code).toBe('validation_failed');
    expect(tooMany.body.error?.message).toBe('The import file is invalid');
    expect(tooMany.body.error?.details?.[0]?.path).toBe('data.profiles');
    expect(getProfiles(t.ctx)).toEqual([]);
  });

  it('enforces the 25 MB limit and the multipart body', async () => {
    const res = await t.json<ErrorBody>('POST', '/api/import/preview', fileForm(new Uint8Array(25 * 1024 * 1024 + 10), 'x.json', 'application/json'));
    expect(res.status).toBe(413);
    expect(res.body.error?.code).toBe('payload_too_large');
    expect((await t.call('POST', '/api/import/preview', baseFile())).status).toBe(400);
  });

  it('commit: unknown, expired or malformed previews are 404/422 and change nothing', async () => {
    expect((await commit('nope')).status).toBe(404);
    expect((await t.call('POST', '/api/import/commit', {})).status).toBe(422);
    expect((await t.call('POST', '/api/import/commit', { previewId: 'x', extra: 1 })).status).toBe(422);

    const res = await previewFile(baseFile());
    t.tick(PREVIEW_TTL_MS + 1);
    expect((await commit(res.body.previewId)).status).toBe(404);
    expect(getBackups(t.ctx).entries).toEqual([]);
    expect(await t.storage.getJson('slice:settings')).toBeUndefined();
  });

  it('keeps at most three live previews, oldest evicted', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await previewFile(baseFile())).body.previewId);
    expect((await commit(ids[0])).status).toBe(404);
    expect((await commit(ids[3])).status).toBe(200);
  });

  it(`keeps the newest ${MAX_BACKUPS} pre-import snapshots`, async () => {
    for (let i = 0; i < MAX_BACKUPS + 1; i++) {
      await t.call('PATCH', '/api/settings', { general: { userName: `User ${i}` } });
      const res = await previewFile(baseFile());
      t.tick(1000);
      expect((await commit(res.body.previewId)).status).toBe(200);
    }
    const entries = getBackups(t.ctx).entries;
    expect(entries).toHaveLength(MAX_BACKUPS);
    expect(entries.map((e) => e.at)).toEqual([...entries.map((e) => e.at)].sort((a, b) => b - a));
    // The newest snapshot holds the state right before the last import.
    const newest = (await t.storage.getJson(backupKey(entries[0]!.id))) as string;
    expect(ExportSchema.parse(JSON.parse(newest)).data.settings.general.userName).toBe(`User ${MAX_BACKUPS}`);
    // The evicted snapshot's document was deleted with it.
    const documents = (await t.storage.listJsonKeys()).filter((k) => k.startsWith('backup:'));
    expect(documents.sort()).toEqual(entries.map((e) => backupKey(e.id)).sort());
    // Backups are never part of an export.
    const exported = await (await t.call('GET', '/api/export')).text();
    expect(exported).not.toContain('User 0');
  });

  it('startup drops backup documents no index entry names and index entries without a document', async () => {
    await t.ctx.state.storage.setJson('backup:stray', '{"left":"behind"}');
    await t.ctx.state.storage.setJson('backup:kept', '{}');
    await t.ctx.state.storage.setJson('slice:backups', {
      entries: [
        { id: 'kept', at: 2, bytes: 2 },
        { id: 'missing', at: 1, bytes: 9 },
      ],
    });
    const second = await createTestBackend(MODULES, { storage: t.storage });
    expect(getBackups(second.ctx).entries.map((e) => e.id)).toEqual(['kept']);
    expect(await t.storage.getJson('slice:backups')).toEqual({ entries: [{ id: 'kept', at: 2, bytes: 2 }] });
    expect((await t.storage.listJsonKeys()).filter((k) => k.startsWith('backup:'))).toEqual(['backup:kept']);
    second.close();
  });
});

/** Fails chosen single writes, like a full disk would (MemoryStorage.applyBatch then rolls back). */
class FlakyStorage extends MemoryStorage {
  failOn: ((op: 'setJson' | 'putBlob' | 'deleteBlob', key: string) => boolean) | null = null;
  private check(op: 'setJson' | 'putBlob' | 'deleteBlob', key: string): void {
    if (this.failOn?.(op, key)) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  }
  override async setJson(key: string, value: unknown): Promise<void> {
    this.check('setJson', key);
    return super.setJson(key, value);
  }
  override async putBlob(entry: StoredBlob): Promise<void> {
    this.check('putBlob', entry.id);
    return super.putBlob(entry);
  }
  override async deleteBlob(id: string): Promise<void> {
    this.check('deleteBlob', id);
    return super.deleteBlob(id);
  }
}

async function dumpStorage(storage: StaticStorage): Promise<{ json: Record<string, unknown>; blobs: string[] }> {
  const json: Record<string, unknown> = {};
  for (const key of await storage.listJsonKeys()) json[key] = await storage.getJson(key);
  return { json, blobs: await storage.listBlobIds() };
}

describe('static core: a failed import commit changes nothing', () => {
  const failures: [string, (op: string, key: string) => boolean][] = [
    ['the backups index (first write)', (op, key) => op === 'setJson' && key === 'slice:backups'],
    ['the backup document', (op, key) => op === 'setJson' && key.startsWith('backup:')],
    ['the bookmarks (mid-way)', (op, key) => op === 'setJson' && key === 'slice:bookmarks'],
    ['the settings (last slice)', (op, key) => op === 'setJson' && key === 'slice:settings'],
    ['deleting an old image', (op) => op === 'deleteBlob'],
    ['writing a new image', (op) => op === 'putBlob'],
  ];

  it.each(failures)('when writing %s fails: 500, storage, memory and image URLs as before, and a retry works', async (_name, failOn) => {
    const storage = new FlakyStorage();
    const t = await createTestBackend(MODULES, { storage });
    const seeded = await seed(t);
    const exported = await (await t.call('GET', '/api/export')).text();
    const preview = await t.json<ImportPreviewResponse>('POST', '/api/import/preview', fileForm(exported, 'portly-export.json', 'application/json'));
    const before = await dumpStorage(storage);
    const settingsBefore = (await t.json<Settings>('GET', '/api/settings')).body;
    const profilesBefore = (await t.json<Profile[]>('GET', '/api/profiles')).body;
    const backgroundUrl = t.ctx.assets.resolve('uploads', seeded.uploads.background);
    // (The bookmarks module, which registers icons, is not loaded here.)
    const iconUrl = t.ctx.assets.registerBlob('icons', seeded.icons.custom, new Blob([IMAGE_SAMPLES.png]));
    expect(backgroundUrl).toBeDefined();
    expect(iconUrl).toBeDefined();

    storage.failOn = failOn;
    const failed = await t.json<ErrorBody>('POST', '/api/import/commit', { previewId: preview.body.previewId });
    storage.failOn = null;
    expect(failed.status).toBe(500);
    expect(failed.body.error?.code).toBe('internal');
    expect(failed.body.error?.message).toMatch(/storage is full/);

    expect(await dumpStorage(storage)).toEqual(before);
    expect((await t.json<Settings>('GET', '/api/settings')).body).toEqual(settingsBefore);
    expect((await t.json<Profile[]>('GET', '/api/profiles')).body).toEqual(profilesBefore);
    expect(getBackups(t.ctx).entries).toEqual([]);
    expect(getBookmarks(t.ctx).bookmarks.map((b) => b.id).sort()).toEqual(Object.values(seeded.bookmarks).sort());
    expect((await t.fetch(`/api/uploads/${seeded.uploads.background}`)).status).toBe(200);
    expect(t.ctx.assets.resolve('uploads', seeded.uploads.background)).toBe(backgroundUrl);
    expect(t.ctx.assets.resolve('icons', seeded.icons.custom)).toBe(iconUrl);

    // The preview survives a failed commit.
    expect((await t.json('POST', '/api/import/commit', { previewId: preview.body.previewId })).status).toBe(200);
    expect(getBackups(t.ctx).entries).toHaveLength(1);
    expect(await t.ctx.state.getBlob(seeded.uploads.background)).toBeUndefined();
    t.close();
  });

  it('is one IndexedDB transaction: a request failing inside it rolls every write back', async () => {
    const storage = await IndexedDbStorage.open(new IDBFactory(), 'portly-static-transfer-test');
    const t = await createTestBackend(MODULES, { storage });
    const seeded = await seed(t);
    const exported = await (await t.call('GET', '/api/export')).text();
    const preview = await t.json<ImportPreviewResponse>('POST', '/api/import/preview', fileForm(exported, 'portly-export.json', 'application/json'));
    const before = await dumpStorage(storage);

    // The settings put is issued after the backup, profiles, bookmarks, uploads and icons puts.
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (key === 'slice:settings') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return put.call(this, value, key);
    });
    const failed = await t.json<ErrorBody>('POST', '/api/import/commit', { previewId: preview.body.previewId });
    spy.mockRestore();
    expect(failed.status).toBe(500);
    expect(await dumpStorage(storage)).toEqual(before);
    expect((await t.fetch(`/api/uploads/${seeded.uploads.background}`)).status).toBe(200);
    expect(getProfiles(t.ctx).map((p) => p.id)).toEqual([seeded.profile.id]);
    t.close();
    storage.close();
  });
});

describe('import planning and previews', () => {
  it('resets widget configs over the 64 KB cap to defaults (with a note)', () => {
    const file = ExportSchema.parse({
      ...baseFile(),
      data: {
        ...baseFile().data,
        profiles: [
          {
            id: 'p',
            name: 'P',
            sort: 0,
            layout: {
              version: 1,
              items: [
                { id: 'big', type: 'clock', x: 0, y: 0, w: 4, h: 3, config: { blob: 'x'.repeat(MAX_WIDGET_CONFIG_BYTES) } },
                { id: 'ok', type: 'clock', x: 4, y: 0, w: 4, h: 3, config: { showSeconds: true } },
              ],
            },
          },
        ],
      },
    });
    const plan = planImport(file, newId);
    expect(plan.profiles[0]?.layout.items.map((i) => i.config)).toEqual([{}, { showSeconds: true }]);
    expect(plan.summary.counts.widgets).toBe(2);
    expect(plan.summary.dropped.notes).toContain('1 widget with oversized settings will use default settings');
  });

  it('only rewrites UUID ids inside widget configs', () => {
    const groupId = newId();
    const file = ExportSchema.parse({
      ...baseFile(),
      data: {
        ...baseFile().data,
        bookmarkGroups: [
          { id: groupId, name: 'A', sort: 0, color: null, collapsed: false },
          { id: 'search', name: 'B', sort: 1, color: null, collapsed: false },
        ],
        profiles: [
          {
            id: 'p',
            name: 'P',
            sort: 0,
            layout: { version: 1, items: [{ id: 'w', type: 'search', x: 0, y: 0, w: 8, h: 2, config: { engineIds: ['search'], groups: [groupId] } }] },
          },
        ],
      },
    });
    const plan: ImportPlan = planImport(file, newId);
    const newGroup = plan.groups.find((g) => g.name === 'A')!.id;
    expect(plan.profiles[0]?.layout.items[0]?.config).toEqual({ engineIds: ['search'], groups: [newGroup] });
  });

  it('reports duplicate ids and sorts unknown-type notes by type', () => {
    const file = ExportSchema.parse({
      ...baseFile(),
      data: {
        ...baseFile().data,
        bookmarkGroups: [
          { id: 'g', name: 'A', sort: 0, color: null, collapsed: false },
          { id: 'g', name: 'B', sort: 1, color: null, collapsed: false },
        ],
        profiles: [
          {
            id: 'p',
            name: 'P',
            sort: 0,
            layout: {
              version: 1,
              items: [
                { id: 'w1', type: 'zeta', x: 0, y: 0, w: 4, h: 3, config: {} },
                { id: 'w2', type: 'alpha', x: 4, y: 0, w: 4, h: 3, config: {} },
                { id: 'w3', type: 'alpha', x: 8, y: 0, w: 4, h: 3, config: {} },
              ],
            },
          },
          { id: 'p', name: 'Dup', sort: 1, layout: { version: 1, items: [] } },
        ],
      },
    });
    const plan = planImport(file, newId);
    expect(plan.summary.counts).toMatchObject({ profiles: 1, widgets: 0, bookmarkGroups: 1 });
    expect(plan.summary.dropped.unknownWidgets).toBe(3);
    expect(plan.summary.dropped.notes).toEqual([
      '1 bookmark group with a duplicate id skipped',
      '1 profile with a duplicate id skipped',
      '2 widgets of unknown type "alpha" skipped',
      '1 widget of unknown type "zeta" skipped',
    ]);
  });

  it('expires previews after the TTL and keeps at most three', () => {
    let now = 0;
    const store = createPreviewStore({ now: () => now, ttlMs: 1000, max: 3 });
    const plan = {} as ImportPlan;
    const a = store.add(plan);
    now = 999;
    expect(store.get(a)).toBe(plan);
    now = 1000;
    expect(store.get(a)).toBeNull();
    const ids = [store.add(plan), store.add(plan), store.add(plan), store.add(plan)];
    expect(store.size).toBe(3);
    expect(store.get(ids[0]!)).toBeNull();
    expect(store.get(ids[3]!)).toBe(plan);
    expect(ids.every((id) => /^[A-Za-z0-9_-]{32}$/.test(id))).toBe(true);
  });
});
