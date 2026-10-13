/**
 * Static `GET`/`PATCH /api/settings`: the server's merge-patch semantics (core.test.ts and
 * settings.test.ts on the server side) over the settings slice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCENT, defaultSettings, defaultThemeBackground, type Settings } from '@portly/shared';
import { MemoryStorage } from '../storage/memory.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import * as profiles from './profiles.ts';
import * as settings from './settings.ts';

const MODULES = [settings, profiles];

interface ErrorBody {
  error: { code: string; message: string; details?: { path: string; message: string; code: string }[] };
}

describe('static core: settings', () => {
  let t: TestBackend;
  beforeEach(async () => {
    t = await createTestBackend(MODULES);
  });
  afterEach(() => t.close());

  const raw = (body: string | undefined) =>
    t.fetch('/api/settings', { method: 'PATCH', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body });
  const current = async () => (await t.json<Settings>('GET', '/api/settings')).body;

  it('GET returns full defaults as JSON', async () => {
    const res = await t.call('GET', '/api/settings');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual(defaultSettings());
  });

  it('PATCH merges objects, replaces arrays, resets null keys and persists', async () => {
    const a = await t.json<Settings>('PATCH', '/api/settings', { general: { userName: 'Dana', weekStartsOn: 0 } });
    expect(a.status).toBe(200);
    expect(a.body.general).toMatchObject({ userName: 'Dana', weekStartsOn: 0, timeFormat: 'system' });
    expect(a.body.appearance).toEqual(defaultSettings().appearance);

    const engines = [{ id: 'ddg', name: 'DDG', urlTemplate: 'https://duckduckgo.com/?q=%s' }];
    const b = await t.json<Settings>('PATCH', '/api/settings', { search: { engines, defaultEngineId: 'ddg' } });
    expect(b.body.search.engines).toEqual([{ ...engines[0], keyword: null, suggest: null, iconId: null }]);

    const c = await t.json<Settings>('PATCH', '/api/settings', { general: { userName: null }, search: null, appearance: { accent: null } });
    expect(c.status).toBe(200);
    expect(c.body.general.userName).toBeUndefined();
    expect(c.body.general.weekStartsOn).toBe(0);
    expect(c.body.search).toEqual(defaultSettings().search);
    expect(c.body.appearance.accent).toBe(defaultSettings().appearance.accent);
    expect(await current()).toEqual(c.body);

    // Written through to storage: a fresh backend over the same storage reads the same settings.
    expect(await t.storage.getJson('slice:settings')).toEqual(c.body);
    const again = await createTestBackend(MODULES, { storage: t.storage });
    expect((await again.json('GET', '/api/settings')).body).toEqual(c.body);
    again.close();
  });

  it('PATCH with an empty body is a no-op that returns the full settings', async () => {
    const res = await raw(undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(defaultSettings());
  });

  it('PATCH returns 422 for invalid results with the server details and changes nothing', async () => {
    const res = await t.json<ErrorBody>('PATCH', '/api/settings', { appearance: { accent: 'red' }, general: { timeFormat: '13h' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.message).toBe('Invalid settings');
    expect(res.body.error.details?.map((d) => d.path).sort()).toEqual(['appearance.accent', 'general.timeFormat']);
    expect(await current()).toEqual(defaultSettings());
    expect(await t.storage.getJson('slice:settings')).toBeUndefined();
  });

  it('PATCH rejects unknown namespaces, unknown keys and bad references (strict at every level)', async () => {
    for (const patch of [
      { unknownNamespace: {} },
      { general: { bogus: true } },
      { appearance: { accent: 'red; background:url(x)' } },
      { calendar: { syncIntervalMin: 1 } },
      { appearance: { background: { type: 'image', uploadId: 'not-a-uuid', angle: null, stops: null } } },
    ]) {
      const res = await t.json<ErrorBody>('PATCH', '/api/settings', patch);
      expect(res.status, JSON.stringify(patch)).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
    }
    expect(await current()).toEqual(defaultSettings());
  });

  it('PATCH rejects prototype-pollution payloads at any depth with 400 without polluting', async () => {
    for (const body of [
      '{"__proto__":{"polluted":true}}',
      '{"general":{"__proto__":{"polluted":true}}}',
      '{"constructor":{"prototype":{"polluted":true}}}',
      '{"appearance":{"background":{"type":"gradient","stops":[{"color":"#000000","at":0,"__proto__":{"polluted":1}}]}}}',
      '{"search":{"engines":[{"prototype":1}]}}',
    ]) {
      const res = await raw(body);
      expect(res.status, body).toBe(400);
      const parsed = (await res.json()) as ErrorBody;
      expect(parsed.error.code).toBe('bad_request');
      expect(parsed.error.message).toMatch(/^Settings patch contains a forbidden key/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(await current()).toEqual(defaultSettings());
  });

  it('PATCH rejects non-object and malformed bodies with 400', async () => {
    const cases: [string, string][] = [
      ['[]', 'A settings patch must be a JSON object'],
      ['"x"', 'A settings patch must be a JSON object'],
      ['42', 'A settings patch must be a JSON object'],
      ['null', 'A settings patch must be a JSON object'],
      ['{bad json', 'Malformed JSON body'],
    ];
    for (const [body, message] of cases) {
      const res = await raw(body);
      expect(res.status, body).toBe(400);
      expect(((await res.json()) as ErrorBody).error).toEqual({ code: 'bad_request', message });
    }
  });

  it('PATCH activeProfileId must reference an existing profile', async () => {
    const bad = await t.json<ErrorBody>('PATCH', '/api/settings', { activeProfileId: 'nope' });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toEqual({ code: 'validation_failed', message: 'activeProfileId must reference an existing profile' });

    const created = await t.json<{ id: string }>('POST', '/api/profiles', { name: 'Home' });
    await t.call('POST', '/api/profiles', { name: 'Work' });
    const res = await t.json<Settings>('PATCH', '/api/settings', { activeProfileId: created.body.id });
    expect(res.status).toBe(200);
    expect(res.body.activeProfileId).toBe(created.body.id);
  });

  it('PATCH activeProfileId null resets to the first profile, never to a dangling null', async () => {
    // No profiles yet: null is the default.
    expect((await t.json<Settings>('PATCH', '/api/settings', { activeProfileId: null })).body.activeProfileId).toBeNull();
    const home = await t.json<{ id: string }>('POST', '/api/profiles', { name: 'Home' });
    const work = await t.json<{ id: string }>('POST', '/api/profiles', { name: 'Work' });
    await t.call('POST', `/api/profiles/${work.body.id}/activate`);
    const res = await t.json<Settings>('PATCH', '/api/settings', { activeProfileId: null, general: { userName: 'Dana' } });
    expect(res.status).toBe(200);
    expect(res.body.activeProfileId).toBe(home.body.id);
    expect(res.body.general.userName).toBe('Dana');
    expect((await current()).activeProfileId).toBe(home.body.id);
  });

  it('switches the background variant only when the old variant keys are nulled', async () => {
    // Without nulling, the strict discriminated union keeps `angle`/`stops` and fails.
    const naive = await t.json<ErrorBody>('PATCH', '/api/settings', { appearance: { background: { type: 'color', color: '#000000' } } });
    expect(naive.status).toBe(422);

    const next = await t.json<Settings>('PATCH', '/api/settings', { appearance: { background: { type: 'color', color: '#000000', angle: null, stops: null } } });
    expect(next.status).toBe(200);
    expect(next.body.appearance.background).toEqual({ type: 'color', color: '#000000' });

    const image = await t.json<Settings>('PATCH', '/api/settings', {
      appearance: { background: { type: 'image', uploadId: '11111111-2222-4333-8444-555555555555', blur: 4, dim: 0.2, color: null } },
    });
    expect(image.body.appearance.background).toEqual({ type: 'image', uploadId: '11111111-2222-4333-8444-555555555555', blur: 4, dim: 0.2 });

    const reset = await t.json<Settings>('PATCH', '/api/settings', { appearance: { background: null } });
    expect(reset.body.appearance.background).toEqual(defaultSettings().appearance.background);
    expect((await t.json<Settings>('PATCH', '/api/settings', { appearance: null })).body.appearance).toEqual(defaultSettings().appearance);
  });

  it('never mutates the stored settings it merges from when a patch fails', async () => {
    await t.json('PATCH', '/api/settings', { general: { userName: 'Dana' } });
    const before = await current();
    expect((await t.call('PATCH', '/api/settings', { general: { timeFormat: 'bad' } })).status).toBe(422);
    expect(await current()).toEqual(before);
    expect(await t.storage.getJson('slice:settings')).toEqual(before);
  });
});

describe('static core: Beacon defaults upgrade (ready)', () => {
  const legacyAppearance = {
    ...defaultSettings().appearance,
    mode: 'dark' as const,
    accent: '#2563EB',
    background: { type: 'gradient' as const, angle: 160, stops: [{ color: '#1e3a8a', at: 0 }, { color: '#6D28D9', at: 100 }] },
  };

  it('moves stored legacy defaults to the Beacon ones once and keeps everything else', async () => {
    const storage = new MemoryStorage();
    await storage.setJson('slice:settings', { ...defaultSettings(), appearance: legacyAppearance, general: { ...defaultSettings().general, userName: 'Dana' } });
    const t = await createTestBackend(MODULES, { storage });
    const body = (await t.json<Settings>('GET', '/api/settings')).body;
    expect(body.appearance).toEqual({ ...legacyAppearance, accent: DEFAULT_ACCENT, background: defaultThemeBackground() });
    expect(body.general.userName).toBe('Dana');
    expect(await storage.getJson('slice:settings')).toEqual(body);
    expect(await storage.getJson('slice:upgrades')).toEqual([settings.BEACON_DEFAULTS_UPGRADE]);

    // Picking the old look again afterwards is a real choice: a restart keeps it.
    await t.json('PATCH', '/api/settings', { appearance: { accent: '#2563eb', background: legacyAppearance.background } });
    t.close();
    const again = await createTestBackend(MODULES, { storage });
    expect((await again.json<Settings>('GET', '/api/settings')).body.appearance.accent).toBe('#2563eb');
    again.close();
  });

  it('leaves chosen colors alone and does not write settings on a fresh install', async () => {
    const fresh = await createTestBackend(MODULES);
    expect(await fresh.storage.getJson('slice:settings')).toBeUndefined();
    expect(await fresh.storage.getJson('slice:upgrades')).toEqual([settings.BEACON_DEFAULTS_UPGRADE]);
    fresh.close();

    const storage = new MemoryStorage();
    const chosen = { ...legacyAppearance, accent: '#e11d48', background: { ...legacyAppearance.background, angle: 135 } };
    await storage.setJson('slice:settings', { ...defaultSettings(), appearance: chosen });
    const t = await createTestBackend(MODULES, { storage });
    expect((await t.json<Settings>('GET', '/api/settings')).body.appearance).toEqual(chosen);
    t.close();
  });
});
