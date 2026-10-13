import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExportSchema,
  defaultSettings,
  type ExportFile,
  type ImportPreviewResponse,
  type ImportSummary,
  type Profile,
  type Settings,
} from '@portly/shared';
import { IMAGE_SAMPLES } from '../../lib/__fixtures__/images.ts';
import { newId } from '../../lib/ids.ts';
import { coreTestbed, fileForm, type CoreTestbed } from './__fixtures__/setup.ts';
import { MAX_WIDGET_CONFIG_BYTES } from './profiles.ts';
import { createPreviewStore, planImport, type ImportPlan } from './transfer.ts';

interface Seeded {
  groups: { work: string; fun: string };
  bookmarks: { custom: string; auto: string; letter: string };
  icons: { custom: string; favicon: string };
  uploads: { background: string; widgetImage: string; orphan: string };
  profile: Profile;
}

/** Fills every table: exportable data plus everything the export must never contain. */
async function seed(t: CoreTestbed): Promise<Seeded> {
  const { db } = t.ctx;
  const groups = { work: newId(), fun: newId() };
  db.run('INSERT INTO bookmark_groups (id, name, sort, color, collapsed, created_at, updated_at) VALUES (?, ?, 0, ?, 0, 1, 1)', [groups.work, 'Work', '#112233']);
  db.run('INSERT INTO bookmark_groups (id, name, sort, color, collapsed, created_at, updated_at) VALUES (?, ?, 1, ?, 1, 1, 1)', [groups.fun, 'Fun', 'rgb(1,2,3)']);

  const icons = { custom: newId(), favicon: newId() };
  db.run("INSERT INTO icons (id, kind, source_host, content_type, bytes, width, fetched_at) VALUES (?, 'upload', NULL, 'image/png', ?, 32, 1)", [
    icons.custom,
    IMAGE_SAMPLES.png,
  ]);
  db.run("INSERT INTO icons (id, kind, source_host, content_type, bytes, width, fetched_at) VALUES (?, 'favicon', 'fun.example', 'image/gif', ?, 16, 1)", [
    icons.favicon,
    IMAGE_SAMPLES.gif,
  ]);

  const bookmarks = { custom: newId(), auto: newId(), letter: newId() };
  const insertBookmark = (id: string, group: string, title: string, url: string, sort: number, mode: string, icon: string | null, letter: string | null) =>
    db.run(
      'INSERT INTO bookmarks (id, group_id, title, url, sort, icon_mode, icon_id, letter_color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)',
      [id, group, title, url, sort, mode, icon, letter],
    );
  insertBookmark(bookmarks.custom, groups.work, 'Intranet', 'https://intranet.example/', 0, 'custom', icons.custom, null);
  insertBookmark(bookmarks.auto, groups.fun, 'Fun', 'https://fun.example/', 0, 'auto', icons.favicon, null);
  insertBookmark(bookmarks.letter, groups.fun, 'Letters', 'https://letters.example/', 1, 'letter', null, '#abcdef');

  const uploads = { background: newId(), widgetImage: newId(), orphan: newId() };
  for (const [id, bytes] of [
    [uploads.background, IMAGE_SAMPLES.jpeg],
    [uploads.widgetImage, IMAGE_SAMPLES.webp],
    [uploads.orphan, IMAGE_SAMPLES.bmp],
  ] as const) {
    db.run('INSERT INTO uploads (id, content_type, bytes, created_at) VALUES (?, ?, ?, 1)', [id, 'image/png', bytes]);
  }

  t.ctx.settings.patch({
    general: { userName: 'Dana' },
    appearance: { background: { type: 'image', uploadId: uploads.background, blur: 4, dim: 0.3, angle: null, stops: null } },
    bookmarks: { defaultGroupId: groups.work },
  });

  const created = await t.json<Profile>('POST', '/api/profiles', {
    body: {
      name: 'Home',
      layout: {
        version: 1,
        items: [
          { id: 'a', type: 'launchpad', x: 0, y: 0, w: 8, h: 6, config: { groupIds: [groups.work], iconSize: 'm' } },
          { id: 'b', type: 'clock', x: 8, y: 0, w: 4, h: 3, config: { note: `bg ${uploads.widgetImage}`, image: uploads.widgetImage } },
          { id: 'c', type: 'stocks', x: 8, y: 3, w: 4, h: 3, config: { symbols: ['MSFT'] } },
        ],
      },
    },
  });

  // Never exported.
  db.run("INSERT INTO accounts (id, kind, label, email, external_id, created_at, updated_at) VALUES ('acc1', 'google', 'Personal', 'dana@private.example', 'sub-123', 1, 1)");
  t.ctx.vault.put('account:acc1', '{"refreshToken":"rt-TOPSECRET"}');
  t.ctx.vault.put('todoist:token', 'todoist-TOPSECRET');
  t.ctx.vault.put('ics:cal1', 'https://calendar.private.example/TOPSECRET.ics');
  db.run("INSERT INTO oauth_clients (provider, client_id, has_secret, updated_at) VALUES ('google', 'client-id-TOPSECRET', 1, 1)");
  db.run("INSERT INTO oauth_states (state, provider, code_verifier, account_id, return_to, created_at, expires_at) VALUES ('state-TOPSECRET', 'google', 'verifier-TOPSECRET', NULL, '#/settings/accounts', 1, 2)");
  db.run("INSERT INTO calendars (id, account_id, source, remote_id, name, display_url) VALUES ('cal1', NULL, 'ics', 'r1', 'Holidays TOPSECRET', 'calendar.private.example')");
  db.run(`INSERT INTO events (id, calendar_id, remote_id, title, start, "end", all_day, updated_at) VALUES ('cal1:x', 'cal1', 'e1', 'Dentist TOPSECRET', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z', 0, 1)`);
  db.run("INSERT INTO cache (key, value, expires_at) VALUES ('weather:TOPSECRET', '{}', 9000000000000)");

  return { groups, bookmarks, icons, uploads, profile: created.body };
}

function baseFile(): Record<string, unknown> & { data: Record<string, unknown[] | unknown> } {
  return {
    format: 'portly-export',
    version: 1,
    exportedAt: '2026-09-25T12:00:00.000Z',
    data: { settings: {}, profiles: [], bookmarkGroups: [], bookmarks: [], uploads: [], customIcons: [] },
  };
}

describe('core: export', () => {
  let t: CoreTestbed;
  beforeEach(() => {
    t = coreTestbed();
  });
  afterEach(() => t.close());

  it('serializes only the allowlisted entities, as a download', async () => {
    const seeded = await seed(t);
    const res = await t.req('GET', '/api/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="portly-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    const file = JSON.parse(text) as ExportFile;
    expect(ExportSchema.safeParse(file).success).toBe(true);
    expect(Object.keys(file)).toEqual(['format', 'version', 'exportedAt', 'data']);
    expect(Object.keys(file.data)).toEqual(['settings', 'profiles', 'bookmarkGroups', 'bookmarks', 'uploads', 'customIcons']);

    for (const forbidden of ['TOPSECRET', 'dana@private.example', 'acc1', 'sub-123', 'calendar.private.example', 'refreshToken']) {
      expect(text, forbidden).not.toContain(forbidden);
    }

    expect(file.data.settings.general.userName).toBe('Dana');
    expect(file.data.profiles.map((p) => p.id)).toEqual([seeded.profile.id]);
    expect(file.data.bookmarkGroups).toEqual([
      { id: seeded.groups.work, name: 'Work', sort: 0, color: '#112233', collapsed: false },
      { id: seeded.groups.fun, name: 'Fun', sort: 1, color: null, collapsed: true },
    ]);
    const byId = new Map(file.data.bookmarks.map((b) => [b.id, b]));
    expect(byId.get(seeded.bookmarks.custom)).toMatchObject({ iconMode: 'custom', iconId: seeded.icons.custom });
    expect(byId.get(seeded.bookmarks.auto)).toMatchObject({ iconMode: 'auto', iconId: null });
    expect(byId.get(seeded.bookmarks.letter)).toMatchObject({ iconMode: 'letter', iconId: null, letterColor: '#abcdef' });

    // Referenced uploads only (background first), content types re-sniffed; custom icons but no favicons.
    expect(file.data.uploads.map((u) => [u.id, u.contentType])).toEqual([
      [seeded.uploads.background, 'image/jpeg'],
      [seeded.uploads.widgetImage, 'image/webp'],
    ]);
    expect(Buffer.from(file.data.uploads[0]!.data, 'base64')).toEqual(IMAGE_SAMPLES.jpeg);
    expect(file.data.customIcons).toEqual([
      { id: seeded.icons.custom, contentType: 'image/png', data: IMAGE_SAMPLES.png.toString('base64'), width: 32 },
    ]);
  });
});

describe('core: import', () => {
  let t: CoreTestbed;
  beforeEach(() => {
    t = coreTestbed();
  });
  afterEach(() => {
    vi.useRealTimers();
    t.close();
  });

  const preview = (content: string | Uint8Array) =>
    t.json<ImportPreviewResponse & { error?: { code: string; details?: { path: string }[] } }>('POST', '/api/import/preview', {
      body: fileForm(content, 'portly-export.json', 'application/json'),
    });
  const previewFile = (file: unknown) => preview(JSON.stringify(file));

  it('round-trips an export: preview summary, then commit replaces data with fresh ids and remapped references', async () => {
    const seeded = await seed(t);
    const exported = await (await t.req('GET', '/api/export')).text();

    const res = await preview(exported);
    expect(res.status).toBe(200);
    const summary: ImportSummary = res.body.summary;
    expect(summary.counts).toEqual({ profiles: 1, widgets: 2, bookmarkGroups: 2, bookmarks: 3, uploads: 2, customIcons: 1 });
    expect(summary.dropped.unknownWidgets).toBe(1);
    expect(summary.dropped.notes).toContain('1 widget of unknown type "stocks" skipped');
    expect(summary.searchEngines[0]).toEqual({ name: 'Google', host: 'www.google.com' });
    // Nothing is written by a preview.
    expect((await t.json<Profile[]>('GET', '/api/profiles')).body.map((p) => p.id)).toEqual([seeded.profile.id]);

    const commit = await t.json<{ ok: boolean; summary: ImportSummary }>('POST', '/api/import/commit', { body: { previewId: res.body.previewId } });
    expect(commit.status).toBe(200);
    expect(commit.body.ok).toBe(true);

    const profiles = (await t.json<Profile[]>('GET', '/api/profiles')).body;
    expect(profiles).toHaveLength(1);
    const profile = profiles[0]!;
    expect(profile.id).not.toBe(seeded.profile.id);
    expect(profile.layout.items.map((i) => i.type)).toEqual(['launchpad', 'clock']);
    const oldWidgetIds = new Set(seeded.profile.layout.items.map((i) => i.id));
    expect(profile.layout.items.some((i) => oldWidgetIds.has(i.id))).toBe(false);

    const groups = t.ctx.db.all<{ id: string; name: string }>('SELECT id, name FROM bookmark_groups ORDER BY sort');
    const work = groups.find((g) => g.name === 'Work')!.id;
    expect(Object.values(seeded.groups)).not.toContain(work);
    expect(profile.layout.items[0]?.config).toEqual({ groupIds: [work], iconSize: 'm' });

    const uploadIds = t.ctx.db.all<{ id: string }>('SELECT id FROM uploads').map((r) => r.id);
    expect(uploadIds).toHaveLength(2);
    const clockConfig = profile.layout.items[1]?.config as { image: string; note: string };
    expect(uploadIds).toContain(clockConfig.image);
    expect(clockConfig.note).toBe(`bg ${seeded.uploads.widgetImage}`); // only exact-match strings are ids

    const settings = (await t.json<Settings>('GET', '/api/settings')).body;
    expect(settings.general.userName).toBe('Dana');
    expect(settings.activeProfileId).toBe(profile.id);
    expect(settings.bookmarks.defaultGroupId).toBe(work);
    expect(settings.appearance.background).toMatchObject({ type: 'image', blur: 4, dim: 0.3 });
    const bgId = (settings.appearance.background as { uploadId: string }).uploadId;
    expect(uploadIds).toContain(bgId);
    expect(bgId).not.toBe(seeded.uploads.background);
    expect((await t.req('GET', `/api/uploads/${bgId}`)).headers.get('content-type')).toBe('image/jpeg');

    const custom = t.ctx.db.get<{ icon_mode: string; icon_id: string }>("SELECT icon_mode, icon_id FROM bookmarks WHERE title = 'Intranet'")!;
    expect(custom.icon_mode).toBe('custom');
    expect(custom.icon_id).not.toBe(seeded.icons.custom);
    expect(t.ctx.db.get<{ kind: string }>('SELECT kind FROM icons WHERE id = ?', [custom.icon_id])?.kind).toBe('upload');
    // Fetched favicons, accounts and secrets are untouched.
    expect(t.ctx.db.get('SELECT id FROM icons WHERE id = ?', [seeded.icons.favicon])).toBeDefined();
    expect(t.ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM accounts')?.n).toBe(1);
    expect(t.ctx.vault.get('todoist:token')).toBe('todoist-TOPSECRET');

    // A pre-import backup was written; previews are single-use.
    expect(fs.readdirSync(t.ctx.config.paths.backupsDir).some((n) => /^pre-import-.*\.db$/.test(n))).toBe(true);
    expect((await t.req('POST', '/api/import/commit', { body: { previewId: res.body.previewId } })).status).toBe(404);
  });

  it('re-importing keeps automatic bookmark icons and engine favicons that exist here; missing ones are fetched now (FUNC-1, IMP-1)', async () => {
    const seeded = await seed(t);
    const engineIcon = newId();
    t.ctx.db.run("INSERT INTO icons (id, kind, source_host, content_type, bytes, width, fetched_at) VALUES (?, 'favicon', 'www.google.com', 'image/gif', ?, 16, 1)", [
      engineIcon,
      IMAGE_SAMPLES.gif,
    ]);
    const engines = t.ctx.settings.get('search').engines;
    t.ctx.settings.patch({ search: { engines: engines.map((e, i) => ({ ...e, iconId: i === 0 ? engineIcon : i === 1 ? newId() : null })) } });
    const runs: string[] = [];
    t.ctx.scheduler.every('bookmarks:icons', 60 * 60_000, async () => void runs.push('icons'));
    // A second auto bookmark on a host with no favicon yet.
    t.ctx.db.run(
      "INSERT INTO bookmarks (id, group_id, title, url, sort, icon_mode, icon_id, letter_color, created_at, updated_at) VALUES (?, ?, 'New', 'https://new.example/', 5, 'auto', NULL, NULL, 1, 1)",
      [newId(), seeded.groups.fun],
    );

    const exported = await (await t.req('GET', '/api/export')).text();
    const res = await preview(exported);
    expect((await t.req('POST', '/api/import/commit', { body: { previewId: res.body.previewId } })).status).toBe(200);

    const icons = Object.fromEntries(t.ctx.db.all<{ title: string; icon_id: string | null }>('SELECT title, icon_id FROM bookmarks').map((r) => [r.title, r.icon_id]));
    // Linked to the favicon already stored for fun.example instead of a letter tile until the hourly job.
    expect(icons.Fun).toBe(seeded.icons.favicon);
    expect(icons.New).toBeNull();
    // …and the icon job was started right away for the host that has none.
    await Promise.resolve();
    expect(runs).toEqual(['icons']);

    const after = (await t.json<Settings>('GET', '/api/settings')).body.search.engines;
    expect(after[0]!.iconId).toBe(engineIcon); // favicon still here: kept
    expect(after[1]!.iconId).toBeNull(); // not here: dropped (looked up again by the web app)
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
    file.data.uploads = [{ id: uploadId, contentType: 'image/png', data: Buffer.from('<html><script>x</script></html>').toString('base64') }];
    file.data.customIcons = [{ id: 'i1', contentType: 'image/svg+xml', data: Buffer.from('<!DOCTYPE svg><svg/>').toString('base64'), width: null }];
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
    await t.req('POST', '/api/import/commit', { body: { previewId: res.body.previewId } });
    const settings = (await t.json<Settings>('GET', '/api/settings')).body;
    expect(settings.appearance.background).toEqual(defaultSettings().appearance.background);
    expect(settings.bookmarks.defaultGroupId).toBeNull();
    const profiles = (await t.json<Profile[]>('GET', '/api/profiles')).body;
    expect(settings.activeProfileId).toBe(profiles[0]?.id);
    expect(t.ctx.db.all('SELECT icon_mode, icon_id FROM bookmarks')).toEqual([{ icon_mode: 'auto', icon_id: null }]);
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
      ['__proto__ in a widget config', JSON.stringify(baseFile()).replace('"profiles":[]', '"profiles":[{"id":"p","name":"P","sort":0,"layout":{"version":1,"items":[{"id":"w","type":"clock","x":0,"y":0,"w":4,"h":3,"config":{"__proto__":{"polluted":true}}}]}}]'), 400],
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

    for (const [name, content, status] of cases) {
      const res = await preview(content);
      expect(res.status, name).toBe(status);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const tooMany = await previewFile(withProfiles(51));
    expect(tooMany.body.error?.code).toBe('validation_failed');
    expect(tooMany.body.error?.details?.[0]?.path).toBe('data.profiles');
  });

  it('enforces the 25 MB limit and the multipart content type', async () => {
    const boundary = 'b0undary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.json"\r\n\r\n`),
      Buffer.alloc(25 * 1024 * 1024 + 10, 0x20),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await t.req('POST', '/api/import/preview', { body: new Uint8Array(body), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
    expect(res.status).toBe(413);
    expect((await t.req('POST', '/api/import/preview', { body: baseFile() })).status).toBe(400);
  });

  it('commit: unknown or expired previews are 404 and change nothing', async () => {
    expect((await t.req('POST', '/api/import/commit', { body: { previewId: 'nope' } })).status).toBe(404);
    expect((await t.req('POST', '/api/import/commit', { body: {} })).status).toBe(422);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    const res = await previewFile(baseFile());
    vi.setSystemTime(new Date('2026-09-25T12:10:01Z'));
    expect((await t.req('POST', '/api/import/commit', { body: { previewId: res.body.previewId } })).status).toBe(404);
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
    const plan = planImport(file);
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
    const plan: ImportPlan = planImport(file);
    const newGroup = plan.groups.find((g) => g.name === 'A')!.id;
    expect(plan.profiles[0]?.layout.items[0]?.config).toEqual({ engineIds: ['search'], groups: [newGroup] });
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
