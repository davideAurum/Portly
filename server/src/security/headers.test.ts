import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import type { AppEnv } from '../context.ts';
import { exempt, paired } from '../lib/routes.ts';
import type { ModuleEntry } from '../modules/index.ts';
import { createTestContext, type TestContext } from '../testing/test-context.ts';
import { TEST_PAGES_ENV, TEST_PAGES_ORIGIN, pagesHeaders, testRequest } from '../testing/test-request.ts';
import { HTML_CSP, IMAGE_CSP, appendVary, htmlCsp } from './headers.ts';

const module: ModuleEntry = {
  name: 'headers-test',
  prefixes: [],
  register(app) {
    app.get('/api/data', (c) => c.json({ ok: true }));
    app.get('/api/cors', (c) => {
      c.header('Access-Control-Allow-Origin', '*');
      c.header('Access-Control-Allow-Credentials', 'true');
      return c.json({ ok: true });
    });
    app.get('/api/boom', () => {
      throw new Error('secret internals');
    });
    app.get('/api/icons/:id', exempt('image'), (c) =>
      c.req.param('id') === 'missing'
        ? c.json({ error: { code: 'not_found', message: 'Icon not found' } }, 404)
        : c.body(new Uint8Array([0x47, 0x49, 0x46]), 200, { 'Content-Type': 'image/gif' }),
    );
    app.get('/api/uploads/:id', exempt('image'), (c) => c.body('<svg xmlns="http://www.w3.org/2000/svg"/>', 200, { 'Content-Type': 'image/svg+xml' }));
  },
};

/** The same routes, declared for the paired Pages site (plus a local-only one). */
const pagesModule: ModuleEntry = {
  name: 'headers-pages-test',
  prefixes: [],
  register(app) {
    app.get('/api/data', paired(), (c) => c.json({ ok: true }));
    app.get('/api/varied', paired(), (c) => {
      c.header('Vary', 'Accept-Language');
      return c.json({ ok: true });
    });
    app.get('/api/cors', paired(), (c) => {
      c.header('Access-Control-Allow-Origin', '*');
      c.header('Access-Control-Allow-Credentials', 'true');
      return c.json({ ok: true });
    });
    app.get('/api/local', (c) => c.json({ ok: true }));
    app.get('/api/icons/:id', exempt('image'), paired(), (c) => c.body(new Uint8Array([0x47, 0x49, 0x46]), 200, { 'Content-Type': 'image/gif' }));
  },
};

function corsHeaders(res: Response): string[] {
  return [...res.headers.keys()].filter((h) => h.startsWith('access-control-'));
}

const BASE = {
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

function expectBaseHeaders(res: Response): void {
  for (const [name, value] of Object.entries(BASE)) expect(res.headers.get(name), name).toBe(value);
}

describe('security headers', () => {
  let dist: string;
  let ctx: TestContext;
  let app: Hono<AppEnv>;

  beforeAll(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-dist-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><title>Homebase</title></head><body></body></html>');
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  });
  afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

  beforeEach(() => {
    ctx = createTestContext();
    app = createApp(ctx, { modules: [module], webDist: dist }).app;
  });
  afterEach(() => ctx.close());

  it('API JSON: base headers + Cache-Control no-store, no CSP', async () => {
    const res = await testRequest(app, 'GET', '/api/data');
    expect(res.status).toBe(200);
    expectBaseHeaders(res);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('gate refusals, errors and API 404s carry the headers too', async () => {
    for (const res of [
      await testRequest(app, 'GET', '/api/data', { headers: { 'X-Homebase': null } }),
      await testRequest(app, 'GET', '/api/data', { headers: { Host: 'evil.example' } }),
      await testRequest(app, 'GET', '/api/nope'),
      await testRequest(app, 'GET', '/api/boom'),
    ]) {
      expectBaseHeaders(res);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    }
  });

  it('unexpected errors are 500 internal without leaking the message', async () => {
    const res = await testRequest(app, 'GET', '/api/boom');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('secret internals');
    expect(JSON.parse(text)).toEqual({ error: { code: 'internal', message: 'Internal server error' } });
  });

  it('HTML gets the strict CSP (script-src without unsafe-inline/unsafe-eval)', async () => {
    const res = await testRequest(app, 'GET', '/');
    expect(res.status).toBe(200);
    expectBaseHeaders(res);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBe(HTML_CSP);
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    const scriptSrc = csp?.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it('the HTML CSP lets the page connect to the configured Pages origin only', () => {
    expect(HTML_CSP).toContain("connect-src 'self';");
    const csp = htmlCsp('https://user.github.io');
    expect(csp).toContain("connect-src 'self' https://user.github.io;");
    expect(csp.replace(" https://user.github.io", '')).toBe(HTML_CSP);
  });

  it('image routes: sandbox CSP and private caching on success', async () => {
    for (const p of ['/api/icons/abc', '/api/uploads/def']) {
      const res = await testRequest(app, 'GET', p, { headers: { 'X-Homebase': null } });
      expect(res.status).toBe(200);
      expectBaseHeaders(res);
      expect(res.headers.get('content-security-policy')).toBe(IMAGE_CSP);
      expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    }
  });

  it('image route errors are not cached', async () => {
    const res = await testRequest(app, 'GET', '/api/icons/missing', { headers: { 'X-Homebase': null } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-security-policy')).toBe(IMAGE_CSP);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('strips any Access-Control-* header', async () => {
    const res = await testRequest(app, 'GET', '/api/cors');
    expect(res.status).toBe(200);
    expect([...res.headers.keys()].filter((h) => h.startsWith('access-control-'))).toEqual([]);
  });

  it('static assets get base headers (no CSP needed on JS)', async () => {
    const res = await testRequest(app, 'GET', '/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expectBaseHeaders(res);
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('without a Pages site: no Vary and no CORS header, whatever the Origin', async () => {
    for (const origin of [null, TEST_PAGES_ORIGIN]) {
      const res = await testRequest(app, 'GET', '/api/data', { headers: { Origin: origin } });
      expect(res.headers.get('vary')).toBeNull();
      expect(corsHeaders(res)).toEqual([]);
    }
  });
});

describe('security headers: Pages site (hybrid mode)', () => {
  let dist: string;
  let ctx: TestContext;
  let app: Hono<AppEnv>;
  let token: string;

  beforeAll(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-dist-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><title>Homebase</title></head><body></body></html>');
  });
  afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

  beforeEach(() => {
    ctx = createTestContext({ env: { ...TEST_PAGES_ENV } });
    app = createApp(ctx, { modules: [pagesModule], webDist: dist }).app;
    token = ctx.pairing.create({ label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN }).token;
  });
  afterEach(() => ctx.close());

  it('answers the Pages origin with exactly its ACAO, Vary: Origin and the exposed headers; never ACAC', async () => {
    const res = await testRequest(app, 'GET', '/api/data', { headers: pagesHeaders(token) });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
    expect(res.headers.get('vary')).toBe('Origin');
    expect(res.headers.get('access-control-expose-headers')).toBe('Retry-After, Content-Disposition, X-Request-Id');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
    expectBaseHeaders(res);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('still strips CORS headers a handler sets, and replaces them with the configured ones', async () => {
    const pages = await testRequest(app, 'GET', '/api/cors', { headers: pagesHeaders(token) });
    expect(pages.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
    expect(pages.headers.get('access-control-allow-credentials')).toBeNull();
    const own = await testRequest(app, 'GET', '/api/cors');
    expect(corsHeaders(own)).toEqual([]);
  });

  it('adds Vary: Origin to every /api answer (also for Homebase\'s own page), keeping the handler\'s Vary', async () => {
    const own = await testRequest(app, 'GET', '/api/data');
    expect(own.headers.get('vary')).toBe('Origin');
    expect(corsHeaders(own)).toEqual([]);
    const varied = await testRequest(app, 'GET', '/api/varied', { headers: pagesHeaders(token) });
    expect(varied.headers.get('vary')).toBe('Accept-Language, Origin');
    const refused = await testRequest(app, 'GET', '/api/data', { headers: { 'X-Homebase': null } });
    expect(refused.headers.get('vary')).toBe('Origin');
    const html = await testRequest(app, 'GET', '/', { headers: pagesHeaders(token) });
    expect(html.headers.get('vary')).toBeNull();
    expect(corsHeaders(html)).toEqual([]);
  });

  it('preflight answers: methods, headers, max-age, the full Vary list once, PNA only when asked', async () => {
    const res = await testRequest(app, 'OPTIONS', '/api/data', {
      headers: {
        Origin: TEST_PAGES_ORIGIN,
        'X-Homebase': null,
        'Sec-Fetch-Site': 'cross-site',
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'content-type,x-homebase-token',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toBe('PATCH');
    expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type, X-Homebase, X-Homebase-Token');
    expect(res.headers.get('access-control-max-age')).toBe('600');
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
    expect(res.headers.get('vary')).toBe('Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('keeps CORP and COOP same-origin, and the image CSP, on Pages answers', async () => {
    const res = await testRequest(app, 'GET', '/api/icons/abc', { headers: pagesHeaders(token) });
    expect(res.status).toBe(200);
    expectBaseHeaders(res);
    expect(res.headers.get('content-security-policy')).toBe(IMAGE_CSP);
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
  });

  it('refusals for the Pages origin are readable (CORS headers on 401/403)', async () => {
    for (const res of [
      await testRequest(app, 'GET', '/api/data', { headers: pagesHeaders(null) }),
      await testRequest(app, 'GET', '/api/local', { headers: pagesHeaders(token) }),
    ]) {
      expect([401, 403]).toContain(res.status);
      expect(res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
      expect(res.headers.get('vary')).toBe('Origin');
    }
  });

  it('appendVary merges without duplicates', () => {
    const headers = new Headers({ Vary: 'accept-encoding, origin' });
    appendVary(headers, 'Origin', 'Access-Control-Request-Method');
    expect(headers.get('vary')).toBe('accept-encoding, origin, Access-Control-Request-Method');
  });
});
