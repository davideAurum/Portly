import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PORTLY_API_VERSION, HealthResponseSchema, defaultSettings, type AboutResponse, type Settings } from '@portly/shared';
import { TEST_PAGES_ENV, TEST_PAGES_ORIGIN, pagesHeaders } from '../../testing/test-request.ts';
import { coreTestbed, type CoreTestbed } from './__fixtures__/setup.ts';
import { BACKUP_CHECK_INTERVAL_MS, BACKUP_INITIAL_DELAY_MS } from './index.ts';

describe('core: health and about', () => {
  let t: CoreTestbed;
  beforeEach(() => {
    t = coreTestbed();
  });
  afterEach(() => t.close());

  it('GET /api/health is exempt and reports the vault state', async () => {
    const res = await t.json('GET', '/api/health', { headers: { 'X-Portly': null, 'Sec-Fetch-Site': null } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      version: t.ctx.config.version,
      vault: 'ready',
      app: 'portly',
      apiVersion: PORTLY_API_VERSION,
      instanceId: t.ctx.pairing.instanceId(),
      appUrl: 'http://localhost:5757/',
      pagesUrl: null,
    });
    expect(HealthResponseSchema.parse(res.body)).toEqual(res.body);
    t.ctx.vault.setState('locked');
    expect((await t.json('GET', '/api/health')).body).toMatchObject({ vault: 'locked' });
  });

  it('GET /api/health keeps its instance id and points appUrl at the Vite page in dev', async () => {
    const first = (await t.json<{ instanceId: string }>('GET', '/api/health')).body.instanceId;
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await t.json<{ instanceId: string }>('GET', '/api/health')).body.instanceId).toBe(first);
    t.close();
    t = coreTestbed({ env: { PORTLY_DEV: '1', PORTLY_VITE_PORT: '5173' } });
    expect((await t.json<{ appUrl: string }>('GET', '/api/health')).body.appUrl).toBe('http://localhost:5173/');
  });

  it('GET /api/health names the Pages site (PORTLY_PAGES_URL), which the new-tab extension follows', async () => {
    t.close();
    t = coreTestbed({ env: { PORTLY_PAGES_URL: 'https://me.github.io/portly' } });
    const res = await t.json<{ pagesUrl: string | null }>('GET', '/api/health', {
      headers: { 'X-Portly': null, 'Sec-Fetch-Site': null },
    });
    expect(res.status).toBe(200);
    expect(res.body.pagesUrl).toBe('https://me.github.io/portly/');
    expect(HealthResponseSchema.parse(res.body)).toEqual(res.body);
  });

  it('GET /api/health answers the Pages site without a token, with CORS for it', async () => {
    t.close();
    t = coreTestbed({ env: { ...TEST_PAGES_ENV } });
    const res = await t.json('GET', '/api/health', { headers: pagesHeaders(null, { 'X-Portly': null }) });
    expect(res.status).toBe(200);
    expect(res.res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
    expect(res.body).toMatchObject({ app: 'portly', instanceId: t.ctx.pairing.instanceId() });
  });

  it('GET /api/about returns version, data dir, log path and vault state (gated)', async () => {
    expect((await t.req('GET', '/api/about', { headers: { 'X-Portly': null } })).status).toBe(403);
    const res = await t.json<AboutResponse>('GET', '/api/about');
    expect(res.body).toEqual({
      version: t.ctx.config.version,
      dataDir: t.ctx.config.dataDir,
      logPath: t.ctx.config.paths.logFile,
      vault: 'ready',
    });
    expect(res.res.headers.get('cache-control')).toBe('no-store');
  });

  it('GET /api/about hides the data dir and log path from the paired Pages site', async () => {
    t.close();
    t = coreTestbed({ env: { ...TEST_PAGES_ENV } });
    const { token } = t.ctx.pairing.create({ label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN });
    const pages = await t.json<AboutResponse>('GET', '/api/about', { headers: pagesHeaders(token) });
    expect(pages.status).toBe(200);
    expect(pages.body).toEqual({ version: t.ctx.config.version, dataDir: '', logPath: '', vault: 'ready' });
    expect(pages.res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
    // Portly's own page still sees them.
    const own = await t.json<AboutResponse>('GET', '/api/about');
    expect(own.body.dataDir).toBe(t.ctx.config.dataDir);
    expect(own.body.logPath).toBe(t.ctx.config.paths.logFile);
  });
});

describe('core: settings', () => {
  let t: CoreTestbed;
  beforeEach(() => {
    t = coreTestbed();
  });
  afterEach(() => t.close());

  it('GET returns full defaults', async () => {
    expect((await t.json('GET', '/api/settings')).body).toEqual(defaultSettings());
  });

  it('PATCH merges objects, replaces arrays, resets null keys and persists', async () => {
    const onChange = vi.fn();
    t.ctx.settings.onChange('general', onChange);
    const a = await t.json<Settings>('PATCH', '/api/settings', { body: { general: { userName: 'Dana', weekStartsOn: 0 } } });
    expect(a.status).toBe(200);
    expect(a.body.general).toMatchObject({ userName: 'Dana', weekStartsOn: 0, timeFormat: 'system' });
    expect(onChange).toHaveBeenCalledTimes(1);

    const b = await t.json<Settings>('PATCH', '/api/settings', {
      body: { search: { engines: [{ id: 'ddg', name: 'DDG', urlTemplate: 'https://duckduckgo.com/?q=%s' }], defaultEngineId: 'ddg' } },
    });
    expect(b.body.search.engines.map((e) => e.id)).toEqual(['ddg']);

    const c = await t.json<Settings>('PATCH', '/api/settings', { body: { general: { userName: null }, search: null } });
    expect(c.body.general.userName).toBeUndefined();
    expect(c.body.general.weekStartsOn).toBe(0);
    expect(c.body.search).toEqual(defaultSettings().search);
    expect((await t.json('GET', '/api/settings')).body).toEqual(c.body);
  });

  it('PATCH returns 422 for invalid results and changes nothing', async () => {
    const res = await t.json<{ error: { code: string; details: { path: string }[] } }>('PATCH', '/api/settings', {
      body: { appearance: { accent: 'red' }, general: { timeFormat: '13h' } },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.map((d) => d.path).sort()).toEqual(['appearance.accent', 'general.timeFormat']);
    expect((await t.json('GET', '/api/settings')).body).toEqual(defaultSettings());
  });

  it('PATCH rejects prototype-pollution payloads at any depth with 400', async () => {
    for (const body of [
      '{"__proto__":{"polluted":true}}',
      '{"general":{"__proto__":{"polluted":true}}}',
      '{"constructor":{"prototype":{"polluted":true}}}',
      '{"appearance":{"background":{"type":"gradient","stops":[{"color":"#000000","at":0,"__proto__":{"polluted":1}}]}}}',
    ]) {
      const res = await t.json<{ error: { code: string } }>('PATCH', '/api/settings', { body, headers: { 'Content-Type': 'application/json' } });
      expect(res.status, body).toBe(400);
      expect(res.body.error.code).toBe('bad_request');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((await t.json('GET', '/api/settings')).body).toEqual(defaultSettings());
  });

  it('PATCH rejects non-object and malformed bodies with 400', async () => {
    for (const body of ['[]', '"x"', '42', 'null', '{bad json']) {
      const res = await t.req('PATCH', '/api/settings', { body, headers: { 'Content-Type': 'application/json' } });
      expect(res.status, body).toBe(400);
    }
  });

  it('PATCH activeProfileId must reference an existing profile', async () => {
    expect((await t.req('PATCH', '/api/settings', { body: { activeProfileId: 'nope' } })).status).toBe(422);
    const created = await t.json<{ id: string }>('POST', '/api/profiles', { body: { name: 'Home' } });
    await t.req('POST', '/api/profiles', { body: { name: 'Work' } });
    const res = await t.json<Settings>('PATCH', '/api/settings', { body: { activeProfileId: created.body.id } });
    expect(res.status).toBe(200);
    expect(res.body.activeProfileId).toBe(created.body.id);
  });

  it('PATCH activeProfileId null resets to the first profile, never to a dangling null', async () => {
    // No profiles yet: null is the default.
    expect((await t.json<Settings>('PATCH', '/api/settings', { body: { activeProfileId: null } })).body.activeProfileId).toBeNull();
    const home = await t.json<{ id: string }>('POST', '/api/profiles', { body: { name: 'Home' } });
    const work = await t.json<{ id: string }>('POST', '/api/profiles', { body: { name: 'Work' } });
    await t.req('POST', `/api/profiles/${work.body.id}/activate`);
    const res = await t.json<Settings>('PATCH', '/api/settings', { body: { activeProfileId: null, general: { userName: 'Dana' } } });
    expect(res.status).toBe(200);
    expect(res.body.activeProfileId).toBe(home.body.id);
    expect(res.body.general.userName).toBe('Dana');
    expect(t.ctx.settings.get('activeProfileId')).toBe(home.body.id);
  });
});

describe('core: vault reset', () => {
  let t: CoreTestbed;
  beforeEach(() => {
    t = coreTestbed({
      secrets: { 'account:g1': '{"refreshToken":"rt"}', 'todoist:token': 'tok' },
      accounts: [
        { id: 'g1', kind: 'google', token: 't' },
        { id: 'y1', kind: 'yahoo', password: 'pw' },
      ],
    });
  });
  afterEach(() => t.close());

  it('deletes every secret, unlocks the vault and marks accounts for reconnect', async () => {
    t.ctx.vault.setState('locked');
    const res = await t.json('POST', '/api/vault/reset');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ vault: 'ready' });
    expect(t.ctx.vault.state).toBe('ready');
    expect(t.ctx.vault.list()).toEqual([]);
    const fake = t.ctx.accounts as unknown as { statusChanges: { id: string; status: string }[] };
    // The health tracker and the account status line learn why (credentials_reset by core).
    const meta = { reason: 'credentials_reset', source: 'core' };
    expect(fake.statusChanges).toEqual([
      { id: 'g1', status: 'reauth', message: 'Credentials were reset', meta },
      { id: 'y1', status: 'reauth', message: 'Credentials were reset', meta },
    ]);
  });

  it('re-runs the ICS job right away: feed addresses were vault secrets too (UX-1)', async () => {
    t.ctx.vault.setState('locked');
    const runs: string[] = [];
    t.ctx.scheduler.every('calendar:ics', 30 * 60_000, async () => void runs.push('ics'));
    expect((await t.json('POST', '/api/vault/reset')).status).toBe(200);
    expect(runs).toEqual(['ics']);
  });

  it('is a gated POST (no X-Portly → 403, nothing deleted)', async () => {
    expect((await t.req('POST', '/api/vault/reset', { headers: { 'X-Portly': null } })).status).toBe(403);
    expect(t.ctx.vault.list()).toEqual(['account:g1', 'todoist:token']);
  });
});

describe('core: backup job', () => {
  let t: CoreTestbed;
  beforeEach(() => {
    t = coreTestbed();
  });
  afterEach(() => t.close());

  it('registers an hourly check that writes today’s backup', async () => {
    const job = t.ctx.scheduler.jobs().find((j) => j.name === 'core:backup');
    expect(job).toMatchObject({ intervalMs: BACKUP_CHECK_INTERVAL_MS, dueAt: BACKUP_INITIAL_DELAY_MS });
    await t.ctx.scheduler.advance(BACKUP_INITIAL_DELAY_MS);
    const files = fs.readdirSync(t.ctx.config.paths.backupsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^portly-\d{4}-\d{2}-\d{2}\.db$/);
    await t.ctx.scheduler.advance(BACKUP_CHECK_INTERVAL_MS);
    expect(fs.readdirSync(t.ctx.config.paths.backupsDir)).toHaveLength(1);
  });
});
