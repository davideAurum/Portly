import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../app.ts';
import type { AppEnv } from '../context.ts';
import { getLogContext } from '../lib/log-context.ts';
import { createMemoryLogger } from '../lib/logger.ts';
import { parseBody } from '../lib/validate.ts';
import { RouteTable, exempt, multipart, paired } from '../lib/routes.ts';
import type { ModuleEntry } from '../modules/index.ts';
import { createTestContext, type TestContext } from '../testing/test-context.ts';
import { TEST_PAGES_ENV, TEST_PAGES_ORIGIN, pagesHeaders, testRequest } from '../testing/test-request.ts';
import { foreignOrigins } from './foreign-origins.ts';
import { createGate, rawPathOf, rawPathProblem } from './gate.ts';

const MB = 1024 * 1024;

const testModule: ModuleEntry = {
  name: 'gate-test',
  prefixes: ['/api/things'],
  register(app) {
    app.get('/api/health', exempt('health'), (c) => c.json({ ok: true }));
    app.get('/api/icons/:id', exempt('image'), (c) => c.body(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 200, { 'Content-Type': 'image/png' }));
    app.get('/api/uploads/:id', exempt('image'), (c) => c.body(new Uint8Array([1]), 200, { 'Content-Type': 'image/png' }));
    app.get('/api/oauth/:provider/callback', exempt('oauth-callback'), (c) => c.redirect('http://localhost:5757/?oauth=connected', 302));
    app.get('/api/things', (c) => c.json({ things: [] }));
    app.post('/api/things', async (c) => c.json(await parseBody(c, z.object({ name: z.string() }).strict())));
    app.post('/api/things/:id/close', (c) => c.json({ closed: c.req.param('id') }));
    app.delete('/api/things/:id', (c) => c.body(null, 204));
    app.post('/api/uploads', multipart('upload'), async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
    app.post('/api/import/preview', multipart('import'), async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
  },
};

function streamOf(totalBytes: number, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(new Uint8Array(size).fill(0x61));
      sent += size;
    },
  });
}

function multipartBody(bytes: number): { body: Uint8Array; type: string } {
  const boundary = 'portly-test-boundary';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const body = new Uint8Array(Buffer.concat([Buffer.from(head), Buffer.alloc(bytes, 1), Buffer.from(tail)]));
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

describe('request gate', () => {
  let ctx: TestContext;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    ctx = createTestContext();
    app = createApp(ctx, { modules: [testModule], webDist: null }).app;
  });
  afterEach(() => ctx.close());

  describe('step 1: raw path normalization', () => {
    it.each([
      ['/api//things', 'empty segment'],
      ['//api/things', 'leading double slash'],
      ['/api/things/..', 'trailing dot-dot'],
      ['/api/things/../settings', 'dot-dot'],
      ['/api/./things', 'dot'],
      ['/api/%2e%2e/settings', 'encoded dot-dot'],
      ['/api/%2E./settings', 'mixed-case encoded dot'],
      ['/api/.%2e/settings', 'half-encoded dot-dot'],
      ['/api/things%2fx', 'encoded slash'],
      ['/api/things%2Fx', 'encoded slash upper'],
      ['/api/things%5cx', 'encoded backslash'],
      ['/api/things\\x', 'backslash'],
      ['/api/things%00', 'encoded NUL'],
      ['/assets/../index.html', 'dot-dot on static path'],
    ])('rejects %s (%s) with 400', async (path) => {
      const res = await testRequest(app, 'GET', path);
      expect(res.status).toBe(400);
      expect((await res.json()) as unknown).toMatchObject({ error: { code: 'bad_request' } });
    });

    it('does not inspect the query string', async () => {
      const res = await testRequest(app, 'GET', '/api/things?next=https://example.com//a/../b');
      expect(res.status).toBe(200);
    });

    it('parses absolute-form targets', () => {
      expect(rawPathOf('http://localhost:5757/api/x?y=1')).toBe('/api/x');
      expect(rawPathOf('http://localhost:5757')).toBe('/');
      expect(rawPathProblem(rawPathOf('http://localhost:5757/a/../b'))).not.toBeNull();
      expect(rawPathProblem('*')).not.toBeNull();
      expect(rawPathProblem('/api/things/a.b..c')).toBeNull();
    });
  });

  describe('step 2: host allowlist', () => {
    it.each(['localhost:5757', '127.0.0.1:5757', '[::1]:5757', 'LOCALHOST:5757'])('accepts Host %s', async (host) => {
      const res = await testRequest(app, 'GET', '/api/things', { headers: { Host: host } });
      expect(res.status).toBe(200);
    });

    it.each(['evil.example', 'evil.example:5757', 'localhost', 'localhost:5173', 'localhost:80', '127.0.0.1:5758', 'localhost.evil.example:5757'])(
      'rejects Host %s with 403',
      async (host) => {
        const res = await testRequest(app, 'GET', '/api/things', { headers: { Host: host } });
        expect(res.status).toBe(403);
        expect((await res.json()) as unknown).toMatchObject({ error: { code: 'forbidden' } });
      },
    );

    it('rejects a missing Host header', async () => {
      const res = await testRequest(app, 'GET', '/api/things', { headers: { Host: null } });
      expect(res.status).toBe(403);
    });

    it('applies to exempt routes and static paths too', async () => {
      expect((await testRequest(app, 'GET', '/api/health', { headers: { Host: 'evil.example' } })).status).toBe(403);
      expect((await testRequest(app, 'GET', '/', { headers: { Host: 'evil.example' } })).status).toBe(403);
    });

    it('allows the Vite dev host only in dev mode', async () => {
      const devCtx = createTestContext({ env: { PORTLY_DEV: '1', PORTLY_VITE_PORT: '5173' } });
      const devApp = createApp(devCtx, { modules: [testModule], webDist: null }).app;
      const res = await testRequest(devApp, 'GET', '/api/things', {
        headers: { Host: 'localhost:5173', Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      devCtx.close();
    });
  });

  describe('step 3/4: non-exempt /api requests', () => {
    it('requires X-Portly: 1', async () => {
      expect((await testRequest(app, 'GET', '/api/things', { headers: { 'X-Portly': null } })).status).toBe(403);
      expect((await testRequest(app, 'GET', '/api/things', { headers: { 'X-Portly': '0' } })).status).toBe(403);
      expect((await testRequest(app, 'GET', '/api/things', { headers: { 'X-Portly': 'true' } })).status).toBe(403);
      expect((await testRequest(app, 'GET', '/api/things')).status).toBe(200);
    });

    it('requires the header on unknown /api paths too (non-exempt by default)', async () => {
      expect((await testRequest(app, 'GET', '/api/nope', { headers: { 'X-Portly': null } })).status).toBe(403);
      const res = await testRequest(app, 'GET', '/api/nope');
      expect(res.status).toBe(404);
      expect((await res.json()) as unknown).toMatchObject({ error: { code: 'not_found' } });
    });

    it('accepts an absent or allowlisted Origin and rejects others', async () => {
      expect((await testRequest(app, 'GET', '/api/things', { headers: { Origin: 'http://localhost:5757' } })).status).toBe(200);
      expect((await testRequest(app, 'GET', '/api/things', { headers: { Origin: 'http://127.0.0.1:5757' } })).status).toBe(200);
      for (const origin of ['https://evil.example', 'null', 'http://localhost:5173', 'http://localhost:5757/', 'http://localhost']) {
        const res = await testRequest(app, 'GET', '/api/things', { headers: { Origin: origin } });
        expect(res.status, origin).toBe(403);
      }
    });

    it('accepts Sec-Fetch-Site absent or same-origin only', async () => {
      expect((await testRequest(app, 'GET', '/api/things', { headers: { 'Sec-Fetch-Site': null } })).status).toBe(200);
      for (const site of ['same-site', 'cross-site', 'none']) {
        const res = await testRequest(app, 'GET', '/api/things', { headers: { 'Sec-Fetch-Site': site } });
        expect(res.status, site).toBe(403);
      }
    });

    it('requires application/json for bodies', async () => {
      expect((await testRequest(app, 'POST', '/api/things', { body: { name: 'a' } })).status).toBe(200);
      expect(
        (await testRequest(app, 'POST', '/api/things', { body: { name: 'a' }, headers: { 'Content-Type': 'application/json; charset=utf-8' } }))
          .status,
      ).toBe(200);
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
        const res = await testRequest(app, 'POST', '/api/things', { body: '{"name":"a"}', headers: { 'Content-Type': type } });
        expect(res.status, type).toBe(400);
      }
      const noType = await testRequest(app, 'POST', '/api/things', { body: new TextEncoder().encode('{"name":"a"}') });
      expect(noType.status).toBe(400);
    });

    it('allows body-less POST/DELETE without a Content-Type', async () => {
      expect((await testRequest(app, 'POST', '/api/things/7/close')).status).toBe(200);
      expect((await testRequest(app, 'DELETE', '/api/things/7')).status).toBe(204);
    });

    it('requires multipart/form-data on routes declared multipart', async () => {
      const { body, type } = multipartBody(10);
      expect((await testRequest(app, 'POST', '/api/uploads', { body, headers: { 'Content-Type': type } })).status).toBe(200);
      expect((await testRequest(app, 'POST', '/api/uploads', { body: { a: 1 } })).status).toBe(400);
    });

    it('never answers preflights and never sends CORS headers', async () => {
      const res = await testRequest(app, 'OPTIONS', '/api/things', {
        headers: {
          'X-Portly': null,
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'POST',
          'Sec-Fetch-Site': 'cross-site',
        },
      });
      expect(res.status).toBe(403);
      expect([...res.headers.keys()].some((h) => h.startsWith('access-control-'))).toBe(false);
    });

    it('validates JSON bodies (422) and malformed JSON (400)', async () => {
      const bad = await testRequest(app, 'POST', '/api/things', { body: { name: 1 } });
      expect(bad.status).toBe(422);
      expect((await bad.json()) as unknown).toMatchObject({ error: { code: 'validation_failed' } });
      const malformed = await testRequest(app, 'POST', '/api/things', { body: '{nope', headers: { 'Content-Type': 'application/json' } });
      expect(malformed.status).toBe(400);
    });
  });

  describe('exemptions', () => {
    it('health needs no X-Portly and accepts cross-site fetches', async () => {
      const res = await testRequest(app, 'GET', '/api/health', {
        headers: { 'X-Portly': null, 'Sec-Fetch-Site': 'cross-site', Origin: 'chrome-extension://abcdef' },
      });
      expect(res.status).toBe(200);
    });

    it('health exemption covers only GET /api/health', async () => {
      expect((await testRequest(app, 'POST', '/api/health', { headers: { 'X-Portly': null } })).status).toBe(403);
      expect((await testRequest(app, 'GET', '/api/health/x', { headers: { 'X-Portly': null } })).status).toBe(403);
    });

    it('image routes accept Sec-Fetch-Site same-origin/none/absent without X-Portly', async () => {
      for (const site of ['same-origin', 'none', null]) {
        const res = await testRequest(app, 'GET', '/api/icons/abc', { headers: { 'X-Portly': null, 'Sec-Fetch-Site': site } });
        expect(res.status, String(site)).toBe(200);
      }
      expect((await testRequest(app, 'GET', '/api/uploads/abc', { headers: { 'X-Portly': null } })).status).toBe(200);
    });

    it('image routes reject same-site/cross-site and foreign origins', async () => {
      for (const site of ['same-site', 'cross-site']) {
        const res = await testRequest(app, 'GET', '/api/icons/abc', { headers: { 'X-Portly': null, 'Sec-Fetch-Site': site } });
        expect(res.status, site).toBe(403);
      }
      const foreign = await testRequest(app, 'GET', '/api/icons/abc', { headers: { Origin: 'https://evil.example' } });
      expect(foreign.status).toBe(403);
    });

    it('image exemption does not extend to other methods or sub-paths', async () => {
      expect((await testRequest(app, 'GET', '/api/icons/abc/extra', { headers: { 'X-Portly': null } })).status).toBe(403);
      expect((await testRequest(app, 'DELETE', '/api/icons/abc', { headers: { 'X-Portly': null } })).status).toBe(403);
      expect((await testRequest(app, 'GET', '/api/icons', { headers: { 'X-Portly': null } })).status).toBe(403);
    });

    it('the OAuth callback accepts top-level cross-site navigations', async () => {
      const res = await testRequest(app, 'GET', '/api/oauth/google/callback?code=x&state=y', {
        headers: { 'X-Portly': null, 'Sec-Fetch-Site': 'cross-site' },
      });
      expect(res.status).toBe(302);
    });

    it('exemptions still require an allowed Host', async () => {
      const res = await testRequest(app, 'GET', '/api/oauth/google/callback', { headers: { 'X-Portly': null, Host: 'evil.example' } });
      expect(res.status).toBe(403);
    });

    it('matching uses the decoded route path, not string prefixes', async () => {
      // %68 = 'h': Hono routes this to /api/health, and so does the gate's router.
      const res = await testRequest(app, 'GET', '/api/%68ealth', { headers: { 'X-Portly': null } });
      expect(res.status).toBe(200);
      const lookalike = await testRequest(app, 'GET', '/api/healthz', { headers: { 'X-Portly': null } });
      expect(lookalike.status).toBe(403);
    });
  });

  describe('step 5: body limits', () => {
    it('rejects a declared Content-Length over the JSON limit without reading', async () => {
      const res = await testRequest(app, 'POST', '/api/things', {
        body: '{}',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(MB + 1) },
      });
      expect(res.status).toBe(413);
      expect((await res.json()) as unknown).toMatchObject({ error: { code: 'payload_too_large' } });
    });

    it('counts streamed (chunked) bytes for JSON bodies', async () => {
      const res = await testRequest(app, 'POST', '/api/things', {
        body: streamOf(MB + 10),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(413);
    });

    it('allows uploads up to 10 MB and rejects larger streams', async () => {
      const ok = multipartBody(2 * MB);
      expect((await testRequest(app, 'POST', '/api/uploads', { body: ok.body, headers: { 'Content-Type': ok.type } })).status).toBe(200);
      const big = await testRequest(app, 'POST', '/api/uploads', {
        body: streamOf(10 * MB + 1),
        headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
      });
      expect(big.status).toBe(413);
    });

    it('allows imports over 10 MB but not over 25 MB', async () => {
      const ok = await testRequest(app, 'POST', '/api/import/preview', {
        body: streamOf(12 * MB),
        headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
      });
      expect(ok.status).toBe(200);
      expect((await ok.json()) as unknown).toEqual({ bytes: 12 * MB });
      const big = await testRequest(app, 'POST', '/api/import/preview', {
        body: streamOf(25 * MB + 1),
        headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
      });
      expect(big.status).toBe(413);
    });

    it('rejects an invalid Content-Length', async () => {
      const res = await testRequest(app, 'POST', '/api/things', {
        body: '{}',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 'abc' },
      });
      expect(res.status).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------
// Pages site (hybrid mode)
// ---------------------------------------------------------------------------

const pagesModule: ModuleEntry = {
  name: 'gate-pages-test',
  prefixes: ['/api/things'],
  register(app) {
    app.get('/api/health', exempt('health'), (c) => c.json({ ok: true }));
    app.get('/api/icons/:id', exempt('image'), paired(), (c) => c.body(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 200, { 'Content-Type': 'image/png' }));
    app.get('/api/oauth/:provider/callback', exempt('oauth-callback'), (c) => c.redirect('http://localhost:5757/?oauth=connected', 302));
    app.get('/api/things', paired(), (c) => c.json({ things: [], pairingId: c.get('pairingId') ?? null }));
    app.post('/api/things', paired(), async (c) => c.json(await parseBody(c, z.object({ name: z.string() }).strict())));
    app.delete('/api/things/:id', paired(), (c) => c.body(null, 204));
    app.post('/api/uploads', multipart('upload'), paired(), async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
    app.post('/api/local', (c) => c.json({ reached: true }));
  },
};

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

function corsHeaders(res: Response): string[] {
  return [...res.headers.keys()].filter((h) => h.startsWith('access-control-'));
}

describe('request gate: Pages site (hybrid mode)', () => {
  let ctx: TestContext;
  let app: Hono<AppEnv>;
  let log: ReturnType<typeof createMemoryLogger>;
  let token: string;

  beforeEach(() => {
    log = createMemoryLogger();
    ctx = createTestContext({ env: { ...TEST_PAGES_ENV }, log });
    app = createApp(ctx, { modules: [pagesModule], webDist: null }).app;
    token = ctx.pairing.create({ label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN }).token;
  });
  afterEach(() => ctx.close());

  const preflight = (headers: Record<string, string | null>, path = '/api/things'): Promise<Response> =>
    testRequest(app, 'OPTIONS', path, {
      headers: { Origin: TEST_PAGES_ORIGIN, 'Sec-Fetch-Site': 'cross-site', 'X-Portly': null, 'Access-Control-Request-Method': 'POST', ...headers },
    });

  describe('preflights', () => {
    it('refuses a foreign origin as before: 403, no CORS headers', async () => {
      const res = await preflight({ Origin: 'https://evil.example', 'Access-Control-Request-Headers': 'content-type' });
      expect(res.status).toBe(403);
      expect(corsHeaders(res)).toEqual([]);
    });

    it('answers the configured origin with 204 and the allowed method and headers, without reaching a route', async () => {
      const res = await preflight({ 'Access-Control-Request-Headers': 'content-type,x-portly,x-portly-token' });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      expect(res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
      expect(res.headers.get('access-control-allow-methods')).toBe('POST');
      expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type, X-Portly, X-Portly-Token, X-Portly-Device, X-Portly-Enroll');
      expect(res.headers.get('access-control-max-age')).toBe('600');
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
      expect(res.headers.get('access-control-allow-private-network')).toBeNull();
    });

    it('accepts every method the API uses, header lists in any case, and no requested headers at all', async () => {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await preflight({ 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'X-Portly, X-Portly-Token' });
        expect(res.status, method).toBe(204);
        expect(res.headers.get('access-control-allow-methods'), method).toBe(method);
      }
      expect((await preflight({ 'Access-Control-Request-Headers': null })).status).toBe(204);
      // Preflights are answered whatever the route: the real request is checked on its own.
      expect((await preflight({}, '/api/local')).status).toBe(204);
    });

    it('allows Private Network Access only when asked', async () => {
      const res = await preflight({ 'Access-Control-Request-Private-Network': 'true' });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-private-network')).toBe('true');
    });

    it('refuses other methods and headers, readably', async () => {
      const refused: Record<string, string>[] = [
        { 'Access-Control-Request-Method': 'TRACE' },
        { 'Access-Control-Request-Method': 'patch' },
        { 'Access-Control-Request-Method': '' },
        { 'Access-Control-Request-Headers': 'content-type, authorization' },
        { 'Access-Control-Request-Headers': 'x-portly, cookie' },
      ];
      for (const headers of refused) {
        const res = await preflight(headers);
        expect(res.status, JSON.stringify(headers)).toBe(403);
        expect(res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
        expect(res.headers.get('access-control-allow-methods')).toBeNull();
        expect(res.headers.get('access-control-allow-headers')).toBeNull();
      }
    });

    it('logs preflights and successful reads at debug, changes at info, marked as Pages requests', async () => {
      await preflight({});
      await testRequest(app, 'GET', '/api/things', { headers: pagesHeaders(token) });
      await testRequest(app, 'POST', '/api/things', { headers: pagesHeaders(token), body: { name: 'x' } });
      const requests = log.lines.filter((l) => l.message === 'request');
      expect(requests.map((l) => [l.level, l.fields?.method, l.fields?.from])).toEqual([
        ['debug', 'OPTIONS', 'pages'],
        ['debug', 'GET', 'pages'],
        ['info', 'POST', 'pages'],
      ]);
      expect(requests[1]?.fields?.pairingId).toBe(ctx.pairing.verify(token)?.id);
    });
  });

  describe('requests', () => {
    it('accepts a valid token for the configured origin and records the pairing in use', async () => {
      const record = ctx.pairing.verify(token);
      const res = await testRequest(app, 'GET', '/api/things', { headers: pagesHeaders(token) });
      expect(res.status).toBe(200);
      expect((await res.json()) as unknown).toEqual({ things: [], pairingId: record?.id });
      expect(res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
      expect(ctx.pairing.verify(token)?.lastUsedAt).not.toBeNull();
    });

    it('answers 401 pairing_required for a missing, malformed, unknown or revoked token', async () => {
      const other = ctx.pairing.create({ label: 'x', origin: TEST_PAGES_ORIGIN });
      ctx.pairing.revoke(other.record.id);
      for (const candidate of [null, '', 'nope', 'A'.repeat(43), other.token]) {
        const res = await testRequest(app, 'GET', '/api/things', { headers: pagesHeaders(candidate) });
        expect(res.status, String(candidate)).toBe(401);
        expect(await errorCode(res)).toBe('pairing_required');
        expect(res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
      }
    });

    it('refuses a token made for another Pages origin (the address changed since)', async () => {
      const old = ctx.pairing.create({ label: 'old', origin: 'https://old.example' });
      const res = await testRequest(app, 'GET', '/api/things', { headers: pagesHeaders(old.token) });
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('pairing_required');
    });

    it('refuses local-only and unknown routes with 403 local_only, even with a valid token', async () => {
      for (const [method, path] of [
        ['POST', '/api/local'],
        ['GET', '/api/nope'],
        ['GET', '/api/oauth/google/callback'],
        ['POST', '/api/health'],
        ['OPTIONS', '/api/things'],
      ] as const) {
        const res = await testRequest(app, method, path, { headers: pagesHeaders(token) });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await errorCode(res), `${method} ${path}`).toBe('local_only');
        expect(res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
      }
    });

    it('requires X-Portly: 1', async () => {
      const res = await testRequest(app, 'GET', '/api/things', { headers: pagesHeaders(token, { 'X-Portly': null }) });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('forbidden');
    });

    it('accepts Sec-Fetch-Site cross-site, same-site or absent with the configured origin only', async () => {
      for (const site of ['cross-site', 'same-site', null]) {
        const res = await testRequest(app, 'GET', '/api/things', { headers: pagesHeaders(token, { 'Sec-Fetch-Site': site }) });
        expect(res.status, String(site)).toBe(200);
      }
      for (const site of ['same-origin', 'none']) {
        const res = await testRequest(app, 'GET', '/api/things', { headers: pagesHeaders(token, { 'Sec-Fetch-Site': site }) });
        expect(res.status, site).toBe(403);
      }
      for (const origin of ['https://evil.example', 'https://pages.example/', 'https://PAGES.example', 'http://pages.example', 'null']) {
        for (const site of ['cross-site', 'same-site']) {
          const res = await testRequest(app, 'GET', '/api/things', { headers: pagesHeaders(token, { Origin: origin, 'Sec-Fetch-Site': site }) });
          expect(res.status, `${origin} ${site}`).toBe(403);
          expect(await errorCode(res)).toBe('forbidden');
          expect(corsHeaders(res), `${origin} ${site}`).toEqual([]);
        }
      }
    });

    it('applies the Content-Type and body-limit rules of step 4/5', async () => {
      expect((await testRequest(app, 'POST', '/api/things', { headers: pagesHeaders(token), body: { name: 'a' } })).status).toBe(200);
      const plain = await testRequest(app, 'POST', '/api/things', {
        headers: pagesHeaders(token, { 'Content-Type': 'text/plain' }),
        body: '{"name":"a"}',
      });
      expect(plain.status).toBe(400);
      expect(plain.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
      expect((await testRequest(app, 'DELETE', '/api/things/7', { headers: pagesHeaders(token) })).status).toBe(204);
      const big = await testRequest(app, 'POST', '/api/things', {
        headers: pagesHeaders(token, { 'Content-Type': 'application/json', 'Content-Length': String(MB + 1) }),
        body: '{}',
      });
      expect(big.status).toBe(413);
      expect(big.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
      const { body, type } = multipartBody(10);
      expect((await testRequest(app, 'POST', '/api/uploads', { headers: pagesHeaders(token, { 'Content-Type': type }), body })).status).toBe(200);
    });

    it('serves image routes to the page with its token (and X-Portly) only', async () => {
      const ok = await testRequest(app, 'GET', '/api/icons/abc', { headers: pagesHeaders(token) });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('image/png');
      expect(ok.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
      expect((await testRequest(app, 'GET', '/api/icons/abc', { headers: pagesHeaders(null, { 'X-Portly': null }) })).status).toBe(403);
      expect((await testRequest(app, 'GET', '/api/icons/abc', { headers: pagesHeaders(null) })).status).toBe(401);
      // Portly's own page is unchanged: same-origin image loads need no token.
      expect((await testRequest(app, 'GET', '/api/icons/abc', { headers: { 'X-Portly': null } })).status).toBe(200);
    });

    it('lets health through without a token or X-Portly', async () => {
      const res = await testRequest(app, 'GET', '/api/health', { headers: pagesHeaders(null, { 'X-Portly': null }) });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
    });

    it('keeps the Host check in front of everything (no CORS headers then)', async () => {
      const res = await testRequest(app, 'GET', '/api/things', { headers: pagesHeaders(token, { Host: 'evil.example' }) });
      expect(res.status).toBe(403);
      expect(corsHeaders(res)).toEqual([]);
    });

    it('leaves requests from Portly\'s own page as they were', async () => {
      expect((await testRequest(app, 'GET', '/api/things')).status).toBe(200);
      expect((await testRequest(app, 'POST', '/api/local')).status).toBe(200);
      const own = await testRequest(app, 'GET', '/api/things', { headers: { Origin: 'http://localhost:5757' } });
      expect(own.status).toBe(200);
      expect(corsHeaders(own)).toEqual([]);
    });
  });

  describe('feature off', () => {
    it('without PORTLY_PAGES_URL the Pages origin is just another foreign origin', async () => {
      const offCtx = createTestContext();
      const offApp = createApp(offCtx, { modules: [pagesModule], webDist: null }).app;
      const offToken = offCtx.pairing.create({ label: 'x', origin: TEST_PAGES_ORIGIN }).token;
      const res = await testRequest(offApp, 'GET', '/api/things', { headers: pagesHeaders(offToken) });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('forbidden');
      expect(corsHeaders(res)).toEqual([]);
      expect(res.headers.get('vary')).toBeNull();
      const pre = await testRequest(offApp, 'OPTIONS', '/api/things', {
        headers: { Origin: TEST_PAGES_ORIGIN, 'X-Portly': null, 'Access-Control-Request-Method': 'GET' },
      });
      expect(pre.status).toBe(403);
      expect(corsHeaders(pre)).toEqual([]);
      offCtx.close();
    });

    it('without a pairing store the gate ignores the Pages origin', async () => {
      const bare = new Hono<AppEnv>();
      const routes = new RouteTable();
      bare.use('*', createGate({ config: ctx.config, routes }));
      bare.get('/api/things', paired(), (c) => c.json({ ok: true }));
      routes.collect(bare);
      const res = await testRequest(bare, 'GET', '/api/things', { headers: pagesHeaders(token) });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('forbidden');
    });
  });
});

// ---------------------------------------------------------------------------
// Diagnostics: refusal lines, token reasons, foreign origins
// ---------------------------------------------------------------------------

describe('request gate: diagnostics', () => {
  let ctx: TestContext;
  let app: Hono<AppEnv>;
  let log: ReturnType<typeof createMemoryLogger>;
  let token: string;

  const diagModule: ModuleEntry = {
    name: 'gate-diag-test',
    prefixes: ['/api/things'],
    register(app) {
      app.get('/api/health', exempt('health'), (c) => c.json({ ok: true }));
      app.get('/api/things', paired(), (c) => {
        log.info('handler ran', { seen: getLogContext()?.pairingId ?? null });
        return c.json({ things: [] });
      });
      app.post('/api/local', (c) => c.json({ reached: true }));
    },
  };

  const refusals = () => log.lines.filter((l) => l.message === 'request refused by gate');

  beforeEach(() => {
    foreignOrigins.reset();
    log = createMemoryLogger();
    ctx = createTestContext({ env: { ...TEST_PAGES_ENV }, log });
    app = createApp(ctx, { modules: [diagModule], webDist: null }).app;
    token = ctx.pairing.create({ label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN }).token;
  });
  afterEach(() => {
    ctx.close();
    foreignOrigins.reset();
  });

  it('logs every refusal at info with a machine reason, repeat-collapsed per reason and origin', async () => {
    await testRequest(app, 'GET', '/api/things', { headers: { 'X-Portly': null } });
    await testRequest(app, 'GET', '/api/things', { headers: { Host: 'evil.example' } });
    await testRequest(app, 'GET', '/a//b');
    await testRequest(app, 'POST', '/api/local', { headers: pagesHeaders(token), body: {} });
    expect(refusals().map((l) => [l.level, l.fields?.reason, l.fields?.status])).toEqual([
      ['info', 'x_portly_missing', 403],
      ['info', 'host_not_allowed', 403],
      ['info', 'bad_path', 400],
      ['info', 'local_only', 403],
    ]);
    const local = refusals()[3];
    expect(local?.fields).toMatchObject({ method: 'POST', path: '/api/local', origin: TEST_PAGES_ORIGIN, secFetchSite: 'cross-site' });
    expect(local?.fields?.repeatKey).toBe(`gate local_only ${TEST_PAGES_ORIGIN}`);
    // The request line carries the answer's error code.
    expect(log.lines.filter((l) => l.message === 'request').map((l) => l.fields?.code)).toEqual(['forbidden', 'forbidden', 'bad_request', 'local_only']);
  });

  it('says why a Pages token is refused, never logging the token', async () => {
    const removed = ctx.pairing.create({ label: 'gone', origin: TEST_PAGES_ORIGIN });
    ctx.pairing.revoke(removed.record.id, 'revoked');
    const unpaired = ctx.pairing.create({ label: 'left', origin: TEST_PAGES_ORIGIN });
    ctx.pairing.revokeByToken(unpaired.token);
    const old = ctx.pairing.create({ label: 'old', origin: 'https://old.example' });
    const never = 'B'.repeat(43);

    for (const candidate of [null, 'nope', never, removed.token, unpaired.token, old.token]) {
      const res = await testRequest(app, 'GET', '/api/things', { headers: pagesHeaders(candidate) });
      expect(res.status).toBe(401);
    }
    expect(refusals().map((l) => [l.fields?.reason, l.fields?.pairingId ?? null, l.fields?.removedBy ?? null])).toEqual([
      ['token_missing', null, null],
      ['token_malformed', null, null],
      ['token_unknown', null, null],
      ['token_revoked', removed.record.id, 'revoked'],
      ['token_revoked', unpaired.record.id, 'unpaired-itself'],
      ['token_origin_mismatch', old.record.id, null],
    ]);
    const all = JSON.stringify(log.lines);
    for (const secret of [token, never, removed.token, unpaired.token, old.token]) expect(all).not.toContain(secret);
  });

  it('puts the pairing on the log context of the route a paired Pages browser calls', async () => {
    const id = ctx.pairing.verify(token)?.id;
    expect((await testRequest(app, 'GET', '/api/things', { headers: pagesHeaders(token) })).status).toBe(200);
    expect(log.lines.find((l) => l.message === 'handler ran')?.fields).toEqual({ seen: id });
    expect((await testRequest(app, 'GET', '/api/things')).status).toBe(200);
    expect(log.lines.filter((l) => l.message === 'handler ran').at(-1)?.fields).toEqual({ seen: null });
  });

  it('names foreign origins worth naming (GitHub Pages, loopback, the Pages domain) and only counts others', async () => {
    const send = (origin: string, path = '/api/things') =>
      testRequest(app, 'GET', path, { headers: { Origin: origin, 'Sec-Fetch-Site': 'cross-site', 'X-Portly': null } });
    expect((await send('https://someone.github.io')).status).toBe(403);
    await send('https://someone.github.io');
    await send('http://localhost:4173');
    await send('https://www.pages.example');
    await send('https://unrelated.example');
    await send('chrome-extension://abcdefghijklmnop');
    await send(TEST_PAGES_ORIGIN, '/api/health');

    const snapshot = foreignOrigins.snapshot();
    expect(snapshot.origins.map((o) => [o.origin, o.count])).toEqual([
      ['https://www.pages.example', 1],
      ['http://localhost:4173', 1],
      ['https://someone.github.io', 2],
    ]);
    expect(snapshot.requests).toBe(1);

    const warnings = log.lines.filter((l) => l.level === 'warn');
    expect(warnings.map((l) => [l.message, l.fields?.origin])).toEqual([
      ['request from a site that is not the configured Pages site', 'https://someone.github.io'],
      ['request from a site that is not the configured Pages site', 'https://someone.github.io'],
      ['request from a site that is not the configured Pages site', 'http://localhost:4173'],
      ['request from a site that is not the configured Pages site', 'https://www.pages.example'],
    ]);
    expect(warnings[0]?.fields).toMatchObject({ pagesOrigin: TEST_PAGES_ORIGIN, repeatKey: 'foreign origin https://someone.github.io' });
    // A third-party site is never recorded: not even on its refusal line.
    expect(JSON.stringify(log.lines)).not.toContain('unrelated.example');
    expect(refusals().map((l) => [l.fields?.reason, l.fields?.origin ?? null])).toEqual([
      ['origin_not_allowed', 'https://someone.github.io'],
      ['origin_not_allowed', 'https://someone.github.io'],
      ['origin_not_allowed', 'http://localhost:4173'],
      ['origin_not_allowed', 'https://www.pages.example'],
      ['origin_not_allowed', null],
      // A browser extension: its scheme only, never which extension (its id).
      ['origin_not_allowed', 'chrome-extension:'],
    ]);
    expect(JSON.stringify(log.lines)).not.toContain('abcdefghijklmnop');
  });

  it('warns about a health check from another site (answered without CORS): a Pages site that is not configured', async () => {
    const res = await testRequest(app, 'GET', '/api/health', { headers: { Origin: 'https://someone.github.io', 'X-Portly': null } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(log.lines.find((l) => l.level === 'warn')?.message).toBe('health check from another site (no CORS answer)');
    expect(foreignOrigins.snapshot().origins.map((o) => o.origin)).toEqual(['https://someone.github.io']);
  });

  it('notes nothing for our own page, the configured Pages site or requests without an Origin', async () => {
    await testRequest(app, 'GET', '/api/things');
    await testRequest(app, 'GET', '/api/things', { headers: { Origin: 'http://localhost:5757' } });
    await testRequest(app, 'GET', '/api/things', { headers: pagesHeaders(token) });
    expect(foreignOrigins.snapshot()).toEqual({ origins: [], requests: 0 });
  });

  it('notes foreign origins in the tracker it is given', async () => {
    const noted: [string, boolean][] = [];
    const tracker = { note: (origin: string, opts: { named: boolean }) => void noted.push([origin, opts.named]), snapshot: () => ({ origins: [], requests: 0 }), reset: () => {} };
    const own = new Hono<AppEnv>();
    const routes = new RouteTable();
    own.use('*', createGate({ config: ctx.config, routes, foreignOrigins: tracker }));
    own.get('/api/things', (c) => c.json({ ok: true }));
    routes.collect(own);
    await testRequest(own, 'GET', '/api/things', { headers: { Origin: 'https://x.github.io' } });
    expect(noted).toEqual([['https://x.github.io', true]]);
    expect(foreignOrigins.snapshot().origins).toEqual([]);
  });
});
