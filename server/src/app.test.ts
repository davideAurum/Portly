import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOMEBASE_API_VERSION, REQUEST_ID_HEADER, REQUEST_ID_REGEX, SettingsSchema, type HealthResponse, type Profile } from '@homebase/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSET_CACHE_CONTROL,
  SLOW_REQUEST_MS,
  STILL_RUNNING_MS,
  areaForPath,
  createApp,
  hasFileExtension,
  isQuietRequest,
  requestLevel,
} from './app.ts';
import { HttpError } from './lib/errors.ts';
import { getLogContext } from './lib/log-context.ts';
import { createMemoryLogger, createTestLogger } from './lib/logger.ts';
import { exempt } from './lib/routes.ts';
import { MODULES, type ModuleEntry } from './modules/index.ts';
import { berlinForecast, springfieldGeocode } from './modules/weather/__fixtures__/open-meteo.ts';
import { isApiPath } from './security/gate.ts';
import { createTestContext, type TestContext } from './testing/test-context.ts';
import { TEST_PAGES_ENV, TEST_PAGES_ORIGIN, pagesHeaders, testRequest } from './testing/test-request.ts';

describe('app: static files and SPA fallback', () => {
  let dist: string;
  let ctx: TestContext;

  beforeAll(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-dist-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Homebase</title><div id="root"></div>');
    fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'export {}');
  });
  afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => ctx.close());

  const app = () => createApp(ctx, { webDist: dist }).app;

  it('serves index.html at / with no-cache', async () => {
    const res = await testRequest(app(), 'GET', '/', { headers: { 'X-Homebase': null } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<div id="root">');
  });

  it('falls back to index.html for extension-less client routes', async () => {
    for (const p of ['/settings', '/some/deep/route', '/?src=newtab']) {
      const res = await testRequest(app(), 'GET', p);
      expect(res.status, p).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    }
  });

  it('serves hashed assets as immutable and 404s missing assets (never index.html)', async () => {
    const ok = await testRequest(app(), 'GET', '/assets/index-abc123.js');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe(ASSET_CACHE_CONTROL);
    const missing = await testRequest(app(), 'GET', '/assets/nope-123.js');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type') ?? '').not.toMatch(/html/);
    const noExt = await testRequest(app(), 'GET', '/assets/nope');
    expect(noExt.status).toBe(404);
  });

  it('serves root files and 404s unknown files with extensions', async () => {
    const icon = await testRequest(app(), 'GET', '/favicon.svg');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toMatch(/^image\/svg\+xml/);
    expect((await testRequest(app(), 'GET', '/robots.txt')).status).toBe(404);
  });

  it('answers unknown /api routes with a JSON 404, not the SPA', async () => {
    const res = await testRequest(app(), 'GET', '/api/nope');
    expect(res.status).toBe(404);
    expect((await res.json()) as unknown).toEqual({ error: { code: 'not_found', message: 'No such API route' } });
  });

  it('does not serve the SPA for non-GET requests', async () => {
    const res = await testRequest(app(), 'POST', '/settings', { headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
  });

  it('hasFileExtension', () => {
    expect(hasFileExtension('/favicon.svg')).toBe(true);
    expect(hasFileExtension('/a.b/c')).toBe(false);
    expect(hasFileExtension('/settings')).toBe(false);
    expect(hasFileExtension('/.well-known')).toBe(true);
  });
});

describe('app: modules', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => ctx.close());

  it('GET /api/health works without X-Homebase and reports the vault state', async () => {
    const { app } = createApp(ctx, { webDist: null });
    const res = await testRequest(app, 'GET', '/api/health', { headers: { 'X-Homebase': null, 'Sec-Fetch-Site': null } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body).toEqual({
      ok: true,
      version: ctx.config.version,
      vault: 'ready',
      app: 'homebase',
      apiVersion: HOMEBASE_API_VERSION,
      instanceId: ctx.pairing.instanceId(),
      appUrl: `${ctx.config.appOrigin}/`,
      pagesUrl: null,
    });
    ctx.vault.setState('locked');
    const locked = (await (await testRequest(app, 'GET', '/api/health')).json()) as HealthResponse;
    expect(locked.vault).toBe('locked');
  });

  it('GET /api/settings returns full defaults and needs X-Homebase', async () => {
    const { app } = createApp(ctx, { webDist: null });
    expect((await testRequest(app, 'GET', '/api/settings', { headers: { 'X-Homebase': null } })).status).toBe(403);
    const res = await testRequest(app, 'GET', '/api/settings');
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual(SettingsSchema.parse({}));
  });

  it('GET /api/profiles returns [] then the stored rows (invalid layouts read as empty)', async () => {
    const { app } = createApp(ctx, { webDist: null });
    expect((await (await testRequest(app, 'GET', '/api/profiles')).json()) as unknown).toEqual([]);
    const layout = { version: 1, items: [{ id: 'w1', type: 'clock', x: 0, y: 0, w: 4, h: 3, config: {} }] };
    ctx.db.run('INSERT INTO profiles (id, name, sort, layout, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['p2', 'Work', 1, 'not json', 2, 2]);
    ctx.db.run('INSERT INTO profiles (id, name, sort, layout, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['p1', 'Home', 0, JSON.stringify(layout), 1, 1]);
    const profiles = (await (await testRequest(app, 'GET', '/api/profiles')).json()) as Profile[];
    expect(profiles.map((p) => p.name)).toEqual(['Home', 'Work']);
    expect(profiles[0]?.layout.items[0]?.frame).toEqual({ showHeader: true, transparent: false });
    expect(profiles[1]?.layout).toEqual({ version: 1, items: [] });
  });

  it('every module is implemented: no main GET route answers 501 (or 503) with an empty data dir', async () => {
    ctx.close();
    ctx = createTestContext({
      fetchRoutes: [
        { match: 'https://api.open-meteo.com/v1/forecast?', respond: { json: berlinForecast() } },
        { match: 'https://geocoding-api.open-meteo.com/v1/search?', respond: { json: springfieldGeocode() } },
        { match: 'https://suggestqueries.google.com/complete/search?', respond: { json: ['x', ['x ray', 'xkcd']] } },
      ],
    });
    const { app, modules } = createApp(ctx, { webDist: null });
    expect(modules.every((m) => m.ok)).toBe(true);
    // Documented `not_configured` (409) answers of a fresh install: nothing connected yet.
    const notConfigured = new Set(['/api/todoist/tasks', '/api/todoist/projects', '/api/calendar/events', '/api/mail/summary']);
    const routes: Record<string, string> = {
      core: '/api/settings',
      profiles: '/api/profiles',
      about: '/api/about',
      accounts: '/api/accounts',
      oauthClients: '/api/oauth-clients/google',
      bookmarks: '/api/bookmarks',
      search: '/api/search/suggest?provider=google&q=x',
      weather: '/api/weather?lat=52.52&lon=13.41',
      geocode: '/api/weather/geocode?q=Springfield',
      todoistToken: '/api/todoist/token',
      todoist: '/api/todoist/tasks',
      todoistProjects: '/api/todoist/projects',
      calendars: '/api/calendar/calendars',
      calendarEvents: '/api/calendar/events?from=2026-09-01&to=2026-10-01&tz=UTC',
      mail: '/api/mail/summary',
    };
    for (const [name, p] of Object.entries(routes)) {
      const res = await testRequest(app, 'GET', p);
      const body = (await res.json()) as { error?: { code: string } };
      const route = p.split('?')[0]!;
      if (notConfigured.has(route)) {
        expect(res.status, `${name} ${p}`).toBe(409);
        expect(body.error?.code, `${name} ${p}`).toBe('not_configured');
      } else {
        expect(res.status, `${name} ${p}: ${JSON.stringify(body)}`).toBe(200);
      }
    }
  });

  it('declares the gate metadata of the exempt, multipart and paired routes', () => {
    const { routes } = createApp(ctx, { webDist: null });
    expect(routes.match('GET', '/api/health')).toEqual({ exempt: 'health' });
    expect(routes.match('GET', '/api/icons/abc')).toEqual({ exempt: 'image', access: 'paired' });
    expect(routes.match('GET', '/api/uploads/abc')).toEqual({ exempt: 'image', access: 'paired' });
    expect(routes.match('HEAD', '/api/uploads/abc')).toEqual({ exempt: 'image', access: 'paired' });
    expect(routes.match('GET', '/api/oauth/google/callback')).toEqual({ exempt: 'oauth-callback' });
    expect(routes.match('POST', '/api/uploads')).toEqual({ body: 'upload', access: 'paired' });
    expect(routes.match('POST', '/api/bookmarks/b1/icon')).toEqual({ body: 'upload', access: 'paired' });
    expect(routes.match('POST', '/api/import/preview')).toEqual({ body: 'import', access: 'paired' });
    expect(routes.match('POST', '/api/bookmarks/import/html')).toEqual({ body: 'import', access: 'paired' });
    expect(routes.match('GET', '/api/settings')).toEqual({ access: 'paired' });
    expect(routes.match('POST', '/api/vault/reset')).toEqual({ access: 'paired' });
    expect(routes.match('POST', '/api/pairings')).toEqual({});
    expect(routes.match('PATCH', '/api/accounts/a1')).toEqual({ access: 'paired' });
    expect(routes.match('GET', '/api/nope')).toEqual({});
    expect(routes.match('OPTIONS', '/api/settings')).toEqual({});
  });

  it('declares every API route paired or local, exactly as pinned', () => {
    const { app, routes } = createApp(ctx, { webDist: null });
    const registered = new Set<string>();
    for (const r of app.routes) {
      if (r.method === 'ALL' || !isApiPath(r.path)) continue;
      registered.add(`${r.method} ${r.path}`);
    }
    expect([...registered].sort()).toEqual(Object.keys(ROUTE_ACCESS).sort());
    for (const [route, expected] of Object.entries(ROUTE_ACCESS)) {
      const [method = '', pattern = ''] = route.split(' ');
      const path = pattern.replace(/:[A-Za-z]+/g, 'sample-id');
      expect(routes.match(method, path).access === 'paired' ? 'paired' : 'local', route).toBe(expected);
    }
  });

  it('lets the paired Pages site use paired routes only (default-deny)', async () => {
    ctx.close();
    ctx = createTestContext({ env: { ...TEST_PAGES_ENV } });
    const { app } = createApp(ctx, { webDist: null });
    const { token } = ctx.pairing.create({ label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN });
    const settings = await testRequest(app, 'GET', '/api/settings', { headers: pagesHeaders(token) });
    expect(settings.status).toBe(200);
    expect(settings.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
    const local: (readonly [string, string])[] = [
      ['POST', '/api/pairings'],
      ['GET', '/api/oauth/google/callback'],
      ['GET', '/api/nope'],
    ];
    for (const [method, path] of local) {
      const body = method === 'POST' || method === 'PUT' ? {} : undefined;
      const res = await testRequest(app, method, path, { headers: pagesHeaders(token), body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code, `${method} ${path}`).toBe('local_only');
      expect(res.headers.get('access-control-allow-origin'), `${method} ${path}`).toBe(TEST_PAGES_ORIGIN);
    }
  });

  it('isolates a module whose register() throws: its prefixes answer 503, others keep working', async () => {
    const log = createMemoryLogger();
    ctx = createTestContext({ log });
    const broken: ModuleEntry = {
      name: 'broken',
      prefixes: ['/api/broken'],
      register(app) {
        app.get('/api/broken/early', (c) => c.json({ registered: true }));
        throw new Error('boom during register');
      },
    };
    const { app, modules, routes } = createApp(ctx, { modules: [...MODULES, broken], webDist: null });
    expect(modules.find((m) => m.name === 'broken')).toEqual({ name: 'broken', ok: false });
    expect(modules.filter((m) => m.ok).length).toBe(MODULES.length);

    for (const p of ['/api/broken', '/api/broken/early', '/api/broken/x/y']) {
      const res = await testRequest(app, 'GET', p);
      expect(res.status, p).toBe(503);
      expect((await res.json()) as unknown).toMatchObject({ error: { code: 'module_unavailable' } });
    }
    // The 503 answers are declared paired: the Pages site learns about the outage too.
    expect(routes.match('GET', '/api/broken/x').access).toBe('paired');
    expect(routes.match('POST', '/api/broken').access).toBe('paired');
    expect((await testRequest(app, 'GET', '/api/settings')).status).toBe(200);
    expect(log.lines.some((l) => l.level === 'error' && l.fields?.module === 'broken')).toBe(true);
  });

  it('registers every module', () => {
    expect(MODULES.map((m) => m.name)).toEqual(['core', 'accounts', 'bookmarks', 'search', 'weather', 'todoist', 'calendar', 'mail', 'feeds', 'sports', 'pairing', 'diagnostics']);
    const { modules } = createApp(ctx, { webDist: null });
    expect(modules.every((m) => m.ok)).toBe(true);
  });
});

/**
 * Every API route and who may call it: `paired` = Homebase's own page and the paired Pages site;
 * `local` = Homebase's own page on this PC only. Health and the OAuth callback are exempt routes
 * (no token, no pairing); they are listed as local because they are not declared `paired()`.
 */
const ROUTE_ACCESS: Readonly<Record<string, 'paired' | 'local'>> = {
  // core
  'GET /api/health': 'local',
  'GET /api/about': 'paired',
  'GET /api/settings': 'paired',
  'PATCH /api/settings': 'paired',
  'GET /api/profiles': 'paired',
  'POST /api/profiles': 'paired',
  'PATCH /api/profiles/:id': 'paired',
  'DELETE /api/profiles/:id': 'paired',
  'POST /api/profiles/:id/activate': 'paired',
  'PUT /api/profiles/:id/positions': 'paired',
  'POST /api/profiles/:id/widgets': 'paired',
  'PATCH /api/profiles/:id/widgets/:instanceId': 'paired',
  'DELETE /api/profiles/:id/widgets/:instanceId': 'paired',
  'POST /api/uploads': 'paired',
  'GET /api/uploads/:id': 'paired',
  'GET /api/export': 'paired',
  'POST /api/import/preview': 'paired',
  'POST /api/import/commit': 'paired',
  'POST /api/vault/reset': 'paired',
  // accounts
  'GET /api/oauth-clients/:provider': 'paired',
  'PUT /api/oauth-clients/:provider': 'paired',
  'POST /api/oauth/:provider/start': 'paired',
  'GET /api/oauth/:provider/callback': 'local',
  'GET /api/accounts': 'paired',
  'POST /api/accounts/yahoo': 'paired',
  'POST /api/accounts/caldav': 'paired',
  'POST /api/accounts/imap': 'paired',
  'PATCH /api/accounts/:id': 'paired',
  'DELETE /api/accounts/:id': 'paired',
  'POST /api/accounts/:id/test': 'paired',
  // bookmarks
  'GET /api/icons/:id': 'paired',
  'GET /api/site-meta': 'paired',
  'GET /api/bookmarks/import/sources': 'paired',
  'POST /api/bookmarks/import/browser': 'paired',
  'POST /api/bookmarks/import/html': 'paired',
  'GET /api/bookmarks': 'paired',
  'POST /api/bookmark-groups/reorder': 'paired',
  'POST /api/bookmark-groups': 'paired',
  'PATCH /api/bookmark-groups/:id': 'paired',
  'DELETE /api/bookmark-groups/:id': 'paired',
  'POST /api/bookmarks': 'paired',
  'PATCH /api/bookmarks/:id': 'paired',
  'DELETE /api/bookmarks/:id': 'paired',
  'POST /api/bookmarks/:id/move': 'paired',
  'POST /api/bookmarks/:id/refresh-icon': 'paired',
  'POST /api/bookmarks/:id/icon': 'paired',
  // search
  'GET /api/search/suggest': 'paired',
  // weather
  'GET /api/weather': 'paired',
  'GET /api/weather/geocode': 'paired',
  // todoist
  'GET /api/todoist/token': 'paired',
  'PUT /api/todoist/token': 'paired',
  'DELETE /api/todoist/token': 'paired',
  'GET /api/todoist/tasks': 'paired',
  'POST /api/todoist/tasks': 'paired',
  'POST /api/todoist/tasks/:id/close': 'paired',
  'POST /api/todoist/tasks/:id/reopen': 'paired',
  'PATCH /api/todoist/tasks/:id': 'paired',
  'GET /api/todoist/projects': 'paired',
  // calendar
  'GET /api/calendar/calendars': 'paired',
  'PATCH /api/calendar/calendars/:id': 'paired',
  'DELETE /api/calendar/calendars/:id': 'paired',
  'POST /api/calendar/ics': 'paired',
  'PATCH /api/calendar/ics/:id': 'paired',
  'GET /api/calendar/events': 'paired',
  'POST /api/calendar/events': 'paired',
  'PATCH /api/calendar/events/:id': 'paired',
  'DELETE /api/calendar/events/:id': 'paired',
  'POST /api/calendar/sync': 'paired',
  // mail
  'GET /api/mail/summary': 'paired',
  'POST /api/mail/:accountId/messages/:id/read': 'paired',
  'POST /api/mail/:accountId/messages/:id/archive': 'paired',
  'POST /api/mail/:accountId/messages/:id/trash': 'paired',
  // feeds
  'GET /api/feeds': 'paired',
  // sports
  'GET /api/sports/teams': 'paired',
  'GET /api/sports/games': 'paired',
  // pairing
  'GET /api/pairing': 'paired',
  'DELETE /api/pairing': 'paired',
  'GET /api/pairings': 'paired',
  'POST /api/pairings': 'local',
  'DELETE /api/pairings/:id': 'paired',
  // diagnostics (all paired: the Pages site is the main UI)
  'GET /api/diagnostics/summary': 'paired',
  'GET /api/diagnostics/logs': 'paired',
  'GET /api/diagnostics/health/:key/history': 'paired',
  'PUT /api/diagnostics/level': 'paired',
  'POST /api/diagnostics/jobs/:name/run': 'paired',
  'GET /api/diagnostics/report': 'paired',
  'POST /api/diagnostics/client-events': 'paired',
};

// ---------------------------------------------------------------------------
// Request log middleware (§17)
// ---------------------------------------------------------------------------

describe('app: request log', () => {
  let ctx: TestContext;
  let logs: ReturnType<typeof createTestLogger>;
  let release: (() => void) | null = null;

  const probeModule: ModuleEntry = {
    name: 'probe',
    prefixes: ['/api/probe'],
    register(app) {
      app.get('/api/health', exempt('health'), (c) => c.json({ ok: true }));
      app.get('/api/probe/items/:id', (c) => {
        ctx.log.debug('inside the handler', { id: c.req.param('id') });
        return c.json({ rid: getLogContext()?.rid ?? null, area: getLogContext()?.area ?? null });
      });
      app.post('/api/probe/items', (c) => c.json({ ok: true }, 201));
      app.get('/api/probe/missing', () => {
        throw new HttpError(404, 'not_found', 'No such item');
      });
      app.get('/api/probe/crash', () => {
        throw new Error('boom at C:\\Users\\someone\\secret-place');
      });
      app.get('/api/probe/slow', async (c) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return c.json({ ok: true });
      });
      app.get('/api/diagnostics/summary', (c) => c.json({ ok: true }));
    },
  };

  beforeEach(() => {
    logs = createTestLogger('debug');
    ctx = createTestContext({ logs });
  });
  afterEach(() => {
    vi.useRealTimers();
    ctx.close();
  });

  const requestLines = () => logs.lines().filter((r) => r.msg === 'request');

  it('stamps X-Request-Id on API, 404, error and static answers, and logs it as the line rid', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-dist-'));
    try {
      fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Homebase</title>');
      const { app } = createApp(ctx, { modules: [probeModule], webDist: dist });
      const answers = [
        await testRequest(app, 'GET', '/api/probe/items/a1'),
        await testRequest(app, 'GET', '/api/nope'),
        await testRequest(app, 'GET', '/api/probe/crash'),
        await testRequest(app, 'GET', '/'),
        await testRequest(app, 'GET', '/api/probe/items/a1', { headers: { 'X-Homebase': null } }),
      ];
      const ids = answers.map((res) => res.headers.get(REQUEST_ID_HEADER));
      for (const id of ids) expect(id).toMatch(REQUEST_ID_REGEX);
      expect(new Set(ids).size).toBe(ids.length);
      expect(requestLines().map((r) => r.rid)).toEqual(ids);
      // Handlers run inside the request's log context.
      expect(((await answers[0]!.clone().json()) as { rid: string }).rid).toBe(ids[0]);
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });

  it('logs the route pattern, the module area, the error code and where the request came from', async () => {
    const { app } = createApp(ctx, { modules: [probeModule], webDist: null });
    const body = (await (await testRequest(app, 'GET', '/api/probe/items/a1?q=secret')).json()) as { area: string };
    expect(body.area).toBe('probe');
    await testRequest(app, 'GET', '/api/probe/missing');
    await testRequest(app, 'GET', '/api/nope');
    const [item, missing, nope] = requestLines();
    expect(item).toMatchObject({ level: 'debug', area: 'probe', fields: { method: 'GET', route: '/api/probe/items/:id', path: '/api/probe/items/a1', status: 200, from: 'local' } });
    expect(missing).toMatchObject({ level: 'info', fields: { route: '/api/probe/missing', status: 404, code: 'not_found' } });
    expect(nope).toMatchObject({ level: 'info', area: 'server', fields: { route: null, status: 404, code: 'not_found' } });
    expect(JSON.stringify(logs.lines())).not.toContain('secret');
    expect(logs.lines().find((r) => r.msg === 'inside the handler')).toMatchObject({ area: 'probe', rid: item?.rid });
  });

  it('collapses repeated GET lines (same route, status and code) but never mutations', async () => {
    const { app } = createApp(ctx, { modules: [probeModule], webDist: null });
    await testRequest(app, 'GET', '/api/probe/missing');
    await testRequest(app, 'GET', '/api/probe/missing');
    await testRequest(app, 'POST', '/api/probe/items');
    await testRequest(app, 'POST', '/api/probe/items');
    const [firstGet, secondGet, firstPost, secondPost] = requestLines();
    expect(firstGet).toMatchObject({ level: 'info', fields: { method: 'GET', route: '/api/probe/missing', status: 404 } });
    expect(firstGet?.fields).not.toHaveProperty('repeats');
    expect(secondGet).toMatchObject({ level: 'debug', fields: { method: 'GET', route: '/api/probe/missing', status: 404, repeats: 1 } });
    for (const post of [firstPost, secondPost]) {
      expect(post).toMatchObject({ level: 'info', fields: { method: 'POST', route: '/api/probe/items', status: 201 } });
      expect(post?.fields).not.toHaveProperty('repeats');
    }
  });

  it('levels: reads debug, changes and 4xx info, 5xx warn (the unexpected error itself at error, frames only)', async () => {
    const { app } = createApp(ctx, { modules: [probeModule], webDist: null });
    await testRequest(app, 'GET', '/api/probe/items/a1');
    await testRequest(app, 'POST', '/api/probe/items', { body: {} });
    await testRequest(app, 'GET', '/api/probe/items/a1', { headers: { 'X-Homebase': null } });
    await testRequest(app, 'GET', '/api/probe/crash');
    expect(requestLines().map((r) => [r.level, r.fields.method, r.fields.status])).toEqual([
      ['debug', 'GET', 200],
      ['info', 'POST', 201],
      ['info', 'GET', 403],
      ['warn', 'GET', 500],
    ]);
    const failed = logs.lines().find((r) => r.msg === 'request failed');
    expect(failed).toMatchObject({ level: 'error', fields: { errName: 'Error', status: 500, path: '/api/probe/crash' } });
    expect(String(failed?.fields.stack)).toMatch(/^at /);
    expect(String(failed?.fields.stack)).not.toContain('boom');
    expect(JSON.stringify(failed)).not.toContain('someone');
  });

  it('keeps health checks and the Diagnostics page polling quiet: debug and out of the memory rings', async () => {
    const { app } = createApp(ctx, { modules: [probeModule], webDist: null });
    await testRequest(app, 'GET', '/api/health');
    await testRequest(app, 'GET', '/api/diagnostics/summary');
    const lines = requestLines();
    expect(lines.map((r) => [r.level, r.area, r.fields.path])).toEqual([
      ['debug', 'core', '/api/health'],
      ['debug', 'diagnostics', '/api/diagnostics/summary'],
    ]);
    expect(logs.query({ q: '/api/' }).records.filter((r) => r.msg === 'request')).toEqual([]);
  });

  it('counts API answers by class, registers requests in flight and warns about a request still running after 15 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const created = createApp(ctx, { modules: [probeModule], webDist: null });
    const pending = testRequest(created.app, 'GET', '/api/probe/slow');
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.runtime.inflight.snapshot().routes).toEqual(['GET /api/probe/slow']);
    await vi.advanceTimersByTimeAsync(STILL_RUNNING_MS);
    const still = logs.lines().find((r) => r.msg === 'request still running');
    expect(still).toMatchObject({ level: 'warn', area: 'probe', fields: { method: 'GET', path: '/api/probe/slow', ms: STILL_RUNNING_MS } });
    expect(still?.rid).toMatch(REQUEST_ID_REGEX);
    release?.();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(ctx.runtime.inflight.count()).toBe(0);
    // Slow reads are logged at info.
    expect(requestLines().at(-1)).toMatchObject({ level: 'info', fields: { path: '/api/probe/slow' } });
    vi.useRealTimers();

    await testRequest(created.app, 'GET', '/api/probe/missing');
    await testRequest(created.app, 'GET', '/api/probe/crash');
    await testRequest(created.app, 'GET', '/', { headers: { 'X-Homebase': null } });
    expect(created.requestCounts()).toEqual({ count: 3, s4xx: 1, s5xx: 1 });
  });

  it('areaForPath: the owning module, diagnostics, else server', () => {
    expect(areaForPath('/api/settings')).toBe('core');
    expect(areaForPath('/api/health')).toBe('core');
    expect(areaForPath('/api/oauth/google/callback')).toBe('accounts');
    expect(areaForPath('/api/icons/abc')).toBe('bookmarks');
    expect(areaForPath('/api/calendar')).toBe('calendar');
    expect(areaForPath('/api/calendarx')).toBe('server');
    expect(areaForPath('/api/diagnostics/logs')).toBe('diagnostics');
    expect(areaForPath('/api/pairings/x')).toBe('pairing');
    expect(areaForPath('/assets/x.js')).toBe('server');
  });

  it('requestLevel and isQuietRequest follow the level table', () => {
    const base = { method: 'GET', api: true, status: 200, ms: 10, quiet: false };
    expect(requestLevel(base)).toBe('debug');
    expect(requestLevel({ ...base, ms: SLOW_REQUEST_MS + 1 })).toBe('info');
    expect(requestLevel({ ...base, method: 'HEAD', status: 304 })).toBe('debug');
    expect(requestLevel({ ...base, method: 'PATCH' })).toBe('info');
    expect(requestLevel({ ...base, status: 409 })).toBe('info');
    expect(requestLevel({ ...base, status: 502 })).toBe('warn');
    expect(requestLevel({ ...base, method: 'OPTIONS', status: 204 })).toBe('debug');
    expect(requestLevel({ ...base, api: false, ms: 10_000 })).toBe('debug');
    expect(requestLevel({ ...base, quiet: true, status: 404, ms: 10_000 })).toBe('debug');
    expect(requestLevel({ ...base, quiet: true, status: 503 })).toBe('warn');
    expect(isQuietRequest('GET', '/api/health')).toBe(true);
    expect(isQuietRequest('GET', '/api/diagnostics/logs')).toBe(true);
    expect(isQuietRequest('POST', '/api/diagnostics/client-events')).toBe(true);
    expect(isQuietRequest('PUT', '/api/diagnostics/level')).toBe(false);
    expect(isQuietRequest('GET', '/api/settings')).toBe(false);
  });
});
