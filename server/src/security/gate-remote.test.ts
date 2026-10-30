/**
 * The gate's remote branch (§4.2): requests from another PC through the HTTPS reverse proxy,
 * told apart by the port they arrive on and let in with a device cookie, or (the Pages site
 * opened on another PC) with the device secret in a header.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEVICE_COOKIE, DEVICE_IDLE_TTL_MS } from '@portly/shared';
import { clearCookieHeader } from './cookies.ts';
import { createApp } from '../app.ts';
import type { AppEnv } from '../context.ts';
import { getLogContext } from '../lib/log-context.ts';
import { createMemoryLogger } from '../lib/logger.ts';
import { RouteTable, enrollment, exempt, multipart, paired, samePc } from '../lib/routes.ts';
import { parseBody } from '../lib/validate.ts';
import type { ModuleEntry } from '../modules/index.ts';
import { createTestContext, type TestContext } from '../testing/test-context.ts';
import { connectTestDevice, setCookieFor } from '../testing/test-devices.ts';
import {
  TEST_PAGES_ENV,
  TEST_PAGES_ORIGIN,
  TEST_PORT,
  TEST_REMOTE_ENV,
  TEST_REMOTE_HOST,
  TEST_REMOTE_ORIGIN,
  TEST_REMOTE_PORT,
  pagesHeaders,
  remoteHeaders,
  remotePagesHeaders,
  testRequest,
} from '../testing/test-request.ts';
import { TOUCH_INTERVAL_MS } from './devices.ts';
import { createGate } from './gate.ts';

const MB = 1024 * 1024;

const remoteModule: ModuleEntry = {
  name: 'gate-remote-test',
  prefixes: ['/api/things'],
  register(app) {
    app.get('/api/health', exempt('health'), (c) => c.json({ ok: true }));
    app.get('/api/icons/:id', exempt('image'), paired(), (c) => c.body(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 200, { 'Content-Type': 'image/png' }));
    app.get('/api/oauth/:provider/callback', exempt('oauth-callback'), (c) => c.redirect('http://localhost:5757/?oauth=connected', 302));
    app.get('/api/things', paired(), (c) => c.json({ things: [], deviceId: c.get('deviceId') ?? null, remote: c.get('remoteClient') ?? false }));
    app.post('/api/things', paired(), async (c) => c.json(await parseBody(c, z.object({ name: z.string() }).strict())));
    app.delete('/api/things/:id', paired(), (c) => c.body(null, 204));
    app.post('/api/uploads', multipart('upload'), paired(), async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
    app.post('/api/local', (c) => c.json({ reached: true }));
    app.post('/api/this-pc', samePc(), (c) => c.json({ reached: true }));
    app.post('/api/enroll', enrollment(), (c) => c.json({ deviceId: c.get('deviceId') ?? null, remote: c.get('remoteClient') ?? false }));
    app.get('/api/raw', paired(), () => new Response('raw', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    app.delete('/api/leave', paired(), (c) => {
      c.header('Set-Cookie', clearCookieHeader(DEVICE_COOKIE), { append: true });
      return c.body(null, 204);
    });
    app.delete('/api/stop/:id', paired(), (c) => c.json({ stopped: c.get('deviceId') }));
  },
};

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

function corsHeaders(res: Response): string[] {
  return [...res.headers.keys()].filter((h) => h.startsWith('access-control-'));
}

describe('request gate: other PCs (remote origin)', () => {
  let ctx: TestContext;
  let app: Hono<AppEnv>;
  let log: ReturnType<typeof createMemoryLogger>;
  let secret: string;
  let deviceId: string;
  let now: number;

  const refusals = () => log.lines.filter((l) => l.message === 'request refused by gate');

  beforeEach(() => {
    now = Date.parse('2026-10-21T10:00:00Z');
    log = createMemoryLogger();
    ctx = createTestContext({ env: { ...TEST_REMOTE_ENV }, log, now: () => now });
    app = createApp(ctx, { modules: [remoteModule], webDist: null }).app;
    const device = connectTestDevice(ctx);
    secret = device.secret;
    deviceId = device.record.id;
  });
  afterEach(() => ctx.close());

  describe('login', () => {
    it('accepts a valid device cookie on a paired route, records the use and renews the cookie', async () => {
      const res = await testRequest(app, 'GET', '/api/things', { headers: remoteHeaders(secret) });
      expect(res.status).toBe(200);
      expect((await res.json()) as unknown).toEqual({ things: [], deviceId, remote: true });
      expect(ctx.devices.verify(secret)?.lastUsedAt).toBe(now);
      const renewed = setCookieFor(res, DEVICE_COOKIE);
      expect(renewed).toBe(`${DEVICE_COOKIE}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${DEVICE_IDLE_TTL_MS / 1000}`);
      expect(corsHeaders(res)).toEqual([]);
      // Within the touch interval nothing is written and no cookie is sent again.
      now += TOUCH_INTERVAL_MS - 1;
      const again = await testRequest(app, 'GET', '/api/things', { headers: remoteHeaders(secret) });
      expect(again.status).toBe(200);
      expect(again.headers.getSetCookie()).toEqual([]);
      now += 1;
      expect(setCookieFor(await testRequest(app, 'GET', '/api/things', { headers: remoteHeaders(secret) }), DEVICE_COOKIE)).toBeDefined();
    });

    it('never renews over a cookie the route set or cleared, nor for a device the route stopped', async () => {
      // The first use would renew (lastUsedAt is null), but the route clears the cookie: one header, the clear.
      const left = await testRequest(app, 'DELETE', '/api/leave', { headers: remoteHeaders(secret) });
      expect(left.status).toBe(204);
      expect(left.headers.getSetCookie()).toEqual([clearCookieHeader(DEVICE_COOKIE)]);
      // A route that stops the device (revoking itself) gets no renewal either.
      const other = connectTestDevice(ctx, { label: 'Other' });
      const stopApp = createApp(ctx, { modules: [{ ...remoteModule, register(sub) {
        sub.delete('/api/stop/:id', paired(), (c) => {
          ctx.devices.revoke(c.req.param('id'));
          return c.json({ stopped: true });
        });
      } }], webDist: null }).app;
      const stopped = await testRequest(stopApp, 'DELETE', `/api/stop/${other.record.id}`, { headers: remoteHeaders(other.secret) });
      expect(stopped.status).toBe(200);
      expect(stopped.headers.getSetCookie()).toEqual([]);
    });

    it('renews the cookie on answers whose headers are immutable too', async () => {
      const res = await testRequest(app, 'GET', '/api/raw', { headers: remoteHeaders(secret) });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('raw');
      expect(setCookieFor(res, DEVICE_COOKIE)).toBeDefined();
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('answers 401 login_required for a missing, malformed, unknown, revoked or expired cookie', async () => {
      const revoked = connectTestDevice(ctx, { label: 'Old laptop' });
      ctx.devices.revoke(revoked.record.id);
      const expired = connectTestDevice(ctx, { label: 'Forgotten' });
      ctx.devices.touch(expired.record.id);
      const candidates: [string | null, string][] = [
        [null, 'device_missing'],
        ['', 'device_missing'],
        ['nope', 'device_malformed'],
        ['A'.repeat(43), 'device_unknown'],
        [revoked.secret, 'device_revoked'],
      ];
      for (const [candidate, reason] of candidates) {
        const res = await testRequest(app, 'GET', '/api/things', { headers: remoteHeaders(candidate) });
        expect(res.status, reason).toBe(401);
        expect(await errorCode(res), reason).toBe('login_required');
        expect(res.headers.getSetCookie(), reason).toEqual([]);
      }
      now += DEVICE_IDLE_TTL_MS + 1;
      const idle = await testRequest(app, 'GET', '/api/things', { headers: remoteHeaders(expired.secret) });
      expect(idle.status).toBe(401);
      expect(refusals().map((l) => [l.fields?.reason, l.fields?.deviceId ?? null, l.fields?.removedBy ?? null])).toEqual([
        ['device_missing', null, null],
        ['device_missing', null, null],
        ['device_malformed', null, null],
        ['device_unknown', null, null],
        ['device_revoked', revoked.record.id, 'revoked'],
        ['device_revoked', expired.record.id, 'expired'],
      ]);
      const all = JSON.stringify(log.lines);
      for (const s of [secret, revoked.secret, expired.secret]) expect(all).not.toContain(s);
    });

    it('ignores a device cookie sent to a local host: local requests are unchanged', async () => {
      const res = await testRequest(app, 'GET', '/api/things', { headers: { Cookie: `${DEVICE_COOKIE}=${secret}` } });
      expect(res.status).toBe(200);
      expect((await res.json()) as unknown).toEqual({ things: [], deviceId: null, remote: false });
      expect(res.headers.getSetCookie()).toEqual([]);
      expect((await testRequest(app, 'POST', '/api/local')).status).toBe(200);
      expect((await testRequest(app, 'POST', '/api/this-pc')).status).toBe(200);
      expect(ctx.devices.verify(secret)?.lastUsedAt).toBeNull();
    });
  });

  describe('what another PC may call', () => {
    it('refuses local-only and same-PC routes with 403 local_only, even with a valid cookie', async () => {
      for (const [method, path] of [
        ['POST', '/api/local'],
        ['POST', '/api/this-pc'],
        ['GET', '/api/nope'],
        ['POST', '/api/health'],
        ['OPTIONS', '/api/things'],
      ] as const) {
        const res = await testRequest(app, method, path, { headers: remoteHeaders(secret) });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await errorCode(res), `${method} ${path}`).toBe('local_only');
      }
      expect(refusals().every((l) => l.fields?.reason === 'local_only' && l.fields?.deviceId === deviceId)).toBe(true);
    });

    it('refuses the OAuth callback on the remote host: sign-in stays on the main PC', async () => {
      const res = await testRequest(app, 'GET', '/api/oauth/google/callback?code=x&state=y', {
        headers: remoteHeaders(null, { 'X-Portly': null, 'Sec-Fetch-Site': 'cross-site' }),
      });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('local_only');
    });

    it('lets enrollment routes through without a cookie, ignoring a stale one and noting a valid one', async () => {
      const none = await testRequest(app, 'POST', '/api/enroll', { headers: remoteHeaders(null) });
      expect(none.status).toBe(200);
      expect((await none.json()) as unknown).toEqual({ deviceId: null, remote: true });
      const revoked = connectTestDevice(ctx, { label: 'Old' });
      ctx.devices.revoke(revoked.record.id);
      const stale = await testRequest(app, 'POST', '/api/enroll', { headers: remoteHeaders(revoked.secret) });
      expect(stale.status).toBe(200);
      expect((await stale.json()) as unknown).toEqual({ deviceId: null, remote: true });
      const valid = await testRequest(app, 'POST', '/api/enroll', { headers: remoteHeaders(secret) });
      expect((await valid.json()) as unknown).toEqual({ deviceId, remote: true });
      // Still never without the request headers of a same-origin fetch.
      expect((await testRequest(app, 'POST', '/api/enroll', { headers: remoteHeaders(null, { 'X-Portly': null }) })).status).toBe(403);
      expect((await testRequest(app, 'POST', '/api/enroll', { headers: remoteHeaders(null, { 'Sec-Fetch-Site': 'cross-site' }) })).status).toBe(403);
    });

    it('lets health through for anyone on the remote host', async () => {
      const res = await testRequest(app, 'GET', '/api/health', { headers: remoteHeaders(null, { 'X-Portly': null, 'Sec-Fetch-Site': 'none' }) });
      expect(res.status).toBe(200);
      expect(corsHeaders(res)).toEqual([]);
    });

    it('serves image routes with the cookie only (no X-Portly needed, like same-origin image loads)', async () => {
      const ok = await testRequest(app, 'GET', '/api/icons/abc', { headers: remoteHeaders(secret, { 'X-Portly': null, 'Sec-Fetch-Site': 'none' }) });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('image/png');
      expect((await testRequest(app, 'GET', '/api/icons/abc', { headers: remoteHeaders(null, { 'X-Portly': null }) })).status).toBe(401);
      expect((await testRequest(app, 'GET', '/api/icons/abc', { headers: remoteHeaders(secret, { 'X-Portly': null, 'Sec-Fetch-Site': 'cross-site' }) })).status).toBe(403);
    });
  });

  describe('cross-site request forgery', () => {
    it('requires X-Portly: 1 and an absent-or-same-origin Sec-Fetch-Site', async () => {
      const missing = await testRequest(app, 'GET', '/api/things', { headers: remoteHeaders(secret, { 'X-Portly': null }) });
      expect(missing.status).toBe(403);
      expect(await errorCode(missing)).toBe('forbidden');
      for (const site of ['same-site', 'cross-site', 'none']) {
        const res = await testRequest(app, 'GET', '/api/things', { headers: remoteHeaders(secret, { 'Sec-Fetch-Site': site }) });
        expect(res.status, site).toBe(403);
      }
      expect((await testRequest(app, 'GET', '/api/things', { headers: remoteHeaders(secret, { 'Sec-Fetch-Site': null }) })).status).toBe(200);
      expect(refusals().map((l) => l.fields?.reason)).toEqual(['x_portly_missing', 'cross_site', 'cross_site', 'cross_site']);
    });

    it('accepts an absent Origin or exactly the remote origin, nothing else', async () => {
      expect((await testRequest(app, 'POST', '/api/things', { headers: remoteHeaders(secret, { Origin: TEST_REMOTE_ORIGIN }), body: { name: 'a' } })).status).toBe(200);
      for (const origin of ['https://evil.example', 'null', `${TEST_REMOTE_ORIGIN}/`, 'https://PC.tailnet.example', 'http://pc.tailnet.example', 'http://localhost:5757', TEST_PAGES_ORIGIN]) {
        const res = await testRequest(app, 'POST', '/api/things', { headers: remoteHeaders(secret, { Origin: origin }), body: { name: 'a' } });
        expect(res.status, origin).toBe(403);
        expect(await errorCode(res), origin).toBe('forbidden');
        expect(corsHeaders(res), origin).toEqual([]);
      }
    });

    it('never answers preflights or sends CORS headers on the remote host', async () => {
      const res = await testRequest(app, 'OPTIONS', '/api/things', {
        headers: remoteHeaders(secret, { 'X-Portly': null, Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Sec-Fetch-Site': 'cross-site' }),
      });
      expect(res.status).toBe(403);
      expect(corsHeaders(res)).toEqual([]);
      const own = await testRequest(app, 'OPTIONS', '/api/things', {
        headers: remoteHeaders(secret, { 'X-Portly': null, Origin: TEST_REMOTE_ORIGIN, 'Access-Control-Request-Method': 'POST' }),
      });
      expect(own.status).toBe(403);
      expect(corsHeaders(own)).toEqual([]);
    });

    it('applies the Content-Type and body-limit rules', async () => {
      const plain = await testRequest(app, 'POST', '/api/things', { headers: remoteHeaders(secret, { 'Content-Type': 'text/plain' }), body: '{"name":"a"}' });
      expect(plain.status).toBe(400);
      expect((await testRequest(app, 'DELETE', '/api/things/7', { headers: remoteHeaders(secret) })).status).toBe(204);
      const big = await testRequest(app, 'POST', '/api/things', {
        headers: remoteHeaders(secret, { 'Content-Type': 'application/json', 'Content-Length': String(MB + 1) }),
        body: '{}',
      });
      expect(big.status).toBe(413);
      const upload = await testRequest(app, 'POST', '/api/uploads', {
        headers: remoteHeaders(secret, { 'Content-Type': 'multipart/form-data; boundary=x' }),
        body: 'x',
      });
      expect(upload.status).toBe(200);
    });
  });

  describe('hosts', () => {
    it('on the remote port accepts the remote host (any case) and the loopback forms of that port, nothing else', async () => {
      for (const host of ['evil.example', `${TEST_REMOTE_HOST}:443`, `${TEST_REMOTE_HOST}:5757`, `sub.${TEST_REMOTE_HOST}`, 'localhost', `localhost:${TEST_PORT}`]) {
        const res = await testRequest(app, 'GET', '/api/things', { headers: remoteHeaders(secret, { Host: host }), listenerPort: TEST_REMOTE_PORT });
        expect(res.status, host).toBe(403);
        expect(await errorCode(res), host).toBe('forbidden');
      }
      expect(refusals().every((l) => l.fields?.reason === 'host_not_allowed')).toBe(true);
      for (const host of [TEST_REMOTE_HOST.toUpperCase(), `localhost:${TEST_REMOTE_PORT}`, `127.0.0.1:${TEST_REMOTE_PORT}`, `[::1]:${TEST_REMOTE_PORT}`]) {
        // A proxy that rewrote the Host to its own loopback target still delivers a remote request.
        const res = await testRequest(app, 'GET', '/api/things', { headers: remoteHeaders(secret, { Host: host }), listenerPort: TEST_REMOTE_PORT });
        expect(res.status, host).toBe(200);
        expect((await res.json()) as unknown, host).toEqual({ things: [], deviceId, remote: true });
      }
    });

    it('on the main port the remote host is just another unknown host, and a loopback Host there stays local', async () => {
      const res = await testRequest(app, 'GET', '/api/things', { headers: remoteHeaders(secret), listenerPort: TEST_PORT });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('forbidden');
      expect(refusals()[0]?.fields?.reason).toBe('host_not_allowed');
      // A device cookie on the main port means nothing: the request is this PC's own.
      const local = await testRequest(app, 'GET', '/api/things', { headers: { Cookie: `${DEVICE_COOKIE}=${secret}` }, listenerPort: TEST_PORT });
      expect((await local.json()) as unknown).toEqual({ things: [], deviceId: null, remote: false });
      // An unknown listener port (no socket facts) counts as the main port.
      const unknown = await testRequest(app, 'GET', '/api/things', { headers: remoteHeaders(secret), listenerPort: 0 });
      expect(unknown.status).toBe(403);
    });

    it('serves the page and health to the remote host without a cookie (the connect screen needs them)', async () => {
      // No static files in this test app: the SPA fallback is not mounted, so the root answers 404, not 401/403.
      expect((await testRequest(app, 'GET', '/', { headers: remoteHeaders(null, { 'X-Portly': null, 'Sec-Fetch-Site': 'none' }) })).status).toBe(404);
    });

    it('refuses a local Host on the main port that carries a proxy header: the proxy must point at the remote port', async () => {
      for (const header of ['X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'Forwarded', 'Tailscale-User-Login', 'Via', 'X-Real-IP', 'CF-Connecting-IP']) {
        const res = await testRequest(app, 'GET', '/api/things', { headers: { [header]: 'x' } });
        expect(res.status, header).toBe(403);
        expect(await errorCode(res), header).toBe('forbidden');
      }
      expect(refusals().every((l) => l.fields?.reason === 'proxied_local_host')).toBe(true);
      // Through the proxy, on the remote port, the same headers are fine (with any accepted Host).
      const ok = await testRequest(app, 'GET', '/api/things', { headers: remoteHeaders(secret, { 'X-Forwarded-For': '100.64.0.2', 'Tailscale-User-Login': 'x' }) });
      expect(ok.status).toBe(200);
      const rewritten = await testRequest(app, 'GET', '/api/things', {
        headers: remoteHeaders(secret, { Host: `127.0.0.1:${TEST_REMOTE_PORT}`, 'X-Forwarded-For': '100.64.0.2' }),
        listenerPort: TEST_REMOTE_PORT,
      });
      expect(rewritten.status).toBe(200);
      // Without a remote origin configured, nothing changes for local requests with such headers.
      const offCtx = createTestContext();
      const offApp = createApp(offCtx, { modules: [remoteModule], webDist: null }).app;
      expect((await testRequest(offApp, 'GET', '/api/things', { headers: { 'X-Forwarded-For': 'x' } })).status).toBe(200);
      offCtx.close();
    });
  });

  describe('diagnostics', () => {
    it('marks the request line from: remote with the device, and puts the device on the log context', async () => {
      const probe: ModuleEntry = {
        name: 'probe',
        prefixes: ['/api/probe'],
        register(sub) {
          sub.get('/api/probe', paired(), (c) => {
            log.info('handler ran', { seen: getLogContext()?.deviceId ?? null });
            return c.json({ ok: true });
          });
          sub.post('/api/probe/ask', enrollment(), (c) => c.json({ ok: true }));
        },
      };
      const probeApp = createApp(ctx, { modules: [probe], webDist: null }).app;
      await testRequest(probeApp, 'GET', '/api/probe', { headers: remoteHeaders(secret) });
      await testRequest(probeApp, 'POST', '/api/probe/ask', { headers: remoteHeaders(null) });
      await testRequest(probeApp, 'GET', '/api/probe');
      expect(log.lines.find((l) => l.message === 'handler ran')?.fields).toEqual({ seen: deviceId });
      expect(log.lines.filter((l) => l.message === 'request').map((l) => [l.fields?.from, l.fields?.deviceId ?? null])).toEqual([
        ['remote', deviceId],
        ['remote', null],
        ['local', null],
      ]);
    });

    it('logs the remote origin as ours and never notes it as a foreign origin', async () => {
      const res = await testRequest(app, 'GET', '/api/things', { headers: remoteHeaders(secret, { Origin: TEST_REMOTE_ORIGIN, 'X-Portly': null }) });
      expect(res.status).toBe(403);
      expect(refusals()[0]?.fields).toMatchObject({ reason: 'x_portly_missing', origin: TEST_REMOTE_ORIGIN });
      expect(log.lines.some((l) => l.level === 'warn')).toBe(false);
    });
  });

  describe('feature off', () => {
    it('without PORTLY_REMOTE_ORIGIN there is no remote port: the remote host is refused at the Host check', async () => {
      const offCtx = createTestContext();
      const offApp = createApp(offCtx, { modules: [remoteModule], webDist: null }).app;
      const device = connectTestDevice(offCtx);
      const res = await testRequest(offApp, 'GET', '/api/things', { headers: remoteHeaders(device.secret) });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('forbidden');
      expect((await testRequest(offApp, 'GET', '/api/health', { headers: remoteHeaders(null, { 'X-Portly': null }) })).status).toBe(403);
      // A loopback Host on what would be the remote port is a plain unknown host.
      expect((await testRequest(offApp, 'GET', '/api/things', { headers: { Host: `localhost:${TEST_REMOTE_PORT}` }, listenerPort: TEST_REMOTE_PORT })).status).toBe(403);
      offCtx.close();
    });

    it('without a device store the gate ignores the remote host', async () => {
      const bare = new Hono<AppEnv>();
      const routes = new RouteTable();
      bare.use('*', createGate({ config: ctx.config, routes }));
      bare.get('/api/things', paired(), (c) => c.json({ ok: true }));
      routes.collect(bare);
      const res = await testRequest(bare, 'GET', '/api/things', { headers: remoteHeaders(secret) });
      expect(res.status).toBe(403);
    });
  });

  describe('with the Pages site configured too', () => {
    let bothCtx: TestContext;
    let bothApp: Hono<AppEnv>;
    let device: { secret: string; record: { id: string } };
    let token: string;

    beforeEach(() => {
      bothCtx = createTestContext({ env: { ...TEST_PAGES_ENV, ...TEST_REMOTE_ENV }, log, now: () => now });
      bothApp = createApp(bothCtx, { modules: [remoteModule], webDist: null }).app;
      device = connectTestDevice(bothCtx);
      token = bothCtx.pairing.create({ label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN }).token;
    });
    afterEach(() => bothCtx.close());

    it('keeps the two apart: a Pages token is no device secret, and a device cookie means nothing to the Pages site', async () => {
      expect((await testRequest(bothApp, 'GET', '/api/things', { headers: pagesHeaders(token) })).status).toBe(200);
      expect((await testRequest(bothApp, 'GET', '/api/things', { headers: remoteHeaders(device.secret) })).status).toBe(200);
      // The Pages site through the remote host with its pairing token and a device cookie: neither counts there.
      const mixed = await testRequest(bothApp, 'GET', '/api/things', { headers: remoteHeaders(device.secret, pagesHeaders(token)) });
      expect(mixed.status).toBe(401);
      expect(await errorCode(mixed)).toBe('login_required');
      expect(mixed.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
      // A device cookie on a Pages request means nothing there.
      const withCookie = await testRequest(bothApp, 'GET', '/api/things', { headers: pagesHeaders(null, { Cookie: `${DEVICE_COOKIE}=${device.secret}` }) });
      expect(withCookie.status).toBe(401);
      expect(await errorCode(withCookie)).toBe('pairing_required');
      // A device secret sent to the main port as the Pages site is no pairing token either.
      const onMain = await testRequest(bothApp, 'GET', '/api/things', { headers: pagesHeaders(null, { 'X-Portly-Device': device.secret }) });
      expect(onMain.status).toBe(401);
      // Same-PC routes: the Pages site on this PC may, another PC may not.
      expect((await testRequest(bothApp, 'POST', '/api/this-pc', { headers: pagesHeaders(token) })).status).toBe(200);
      expect((await testRequest(bothApp, 'POST', '/api/this-pc', { headers: remoteHeaders(device.secret) })).status).toBe(403);
      // Enrollment routes: another PC may, the Pages site on this PC may not.
      expect((await testRequest(bothApp, 'POST', '/api/enroll', { headers: remoteHeaders(null) })).status).toBe(200);
      expect((await testRequest(bothApp, 'POST', '/api/enroll', { headers: pagesHeaders(token) })).status).toBe(403);
    });

    describe('the Pages site opened on another PC', () => {
      it('lets in the device secret header, with CORS for the Pages origin and no cookie', async () => {
        const res = await testRequest(bothApp, 'GET', '/api/things', { headers: remotePagesHeaders(device.secret) });
        expect(res.status).toBe(200);
        expect((await res.json()) as unknown).toEqual({ things: [], deviceId: device.record.id, remote: true });
        expect(res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
        expect(res.headers.get('access-control-allow-credentials')).toBeNull();
        expect(res.headers.getSetCookie()).toEqual([]);
        expect(bothCtx.devices.verify(device.secret)?.lastUsedAt).toBe(now);
        const posted = await testRequest(bothApp, 'POST', '/api/things', { headers: remotePagesHeaders(device.secret), body: { name: 'a' } });
        expect(posted.status).toBe(200);
      });

      it('answers 401 login_required with CORS for a missing, unknown or revoked secret, and ignores a device cookie', async () => {
        const revoked = connectTestDevice(bothCtx, { label: 'Old laptop' });
        bothCtx.devices.revoke(revoked.record.id);
        const candidates: [string | null, string][] = [
          [null, 'device_missing'],
          ['', 'device_missing'],
          ['nope', 'device_malformed'],
          ['A'.repeat(43), 'device_unknown'],
          [revoked.secret, 'device_revoked'],
        ];
        for (const [value, reason] of candidates) {
          const res = await testRequest(bothApp, 'GET', '/api/things', { headers: remotePagesHeaders(value) });
          expect(res.status, reason).toBe(401);
          expect(await errorCode(res), reason).toBe('login_required');
          expect(res.headers.get('access-control-allow-origin'), reason).toBe(TEST_PAGES_ORIGIN);
          expect(refusals().at(-1)?.fields?.reason, reason).toBe(reason);
        }
        const cookieOnly = await testRequest(bothApp, 'GET', '/api/things', {
          headers: remotePagesHeaders(null, { Cookie: `${DEVICE_COOKIE}=${device.secret}` }),
        });
        expect(cookieOnly.status).toBe(401);
      });

      it('answers its preflights on the remote port, for the headers it needs only', async () => {
        const res = await testRequest(bothApp, 'OPTIONS', '/api/things', {
          headers: remotePagesHeaders(null, {
            'X-Portly': null,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type, x-portly, x-portly-device',
          }),
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
        expect(res.headers.get('access-control-allow-headers')).toContain('X-Portly-Device');
        expect(res.headers.get('access-control-allow-headers')).toContain('X-Portly-Enroll');
        const odd = await testRequest(bothApp, 'OPTIONS', '/api/things', {
          headers: remotePagesHeaders(null, { 'X-Portly': null, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' }),
        });
        expect(odd.status).toBe(403);
        // Any other site still gets no preflight answer on the remote port.
        const foreign = await testRequest(bothApp, 'OPTIONS', '/api/things', {
          headers: remotePagesHeaders(null, { 'X-Portly': null, Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }),
        });
        expect(foreign.status).toBe(403);
        expect(corsHeaders(foreign)).toEqual([]);
      });

      it('keeps what another PC may call: local-only, same-PC and the OAuth callback stay on the main PC', async () => {
        for (const path of ['/api/local', '/api/this-pc']) {
          const res = await testRequest(bothApp, 'POST', path, { headers: remotePagesHeaders(device.secret) });
          expect(res.status, path).toBe(403);
          expect(await errorCode(res), path).toBe('local_only');
        }
        const callback = await testRequest(bothApp, 'GET', '/api/oauth/google/callback', { headers: remotePagesHeaders(null) });
        expect(callback.status).toBe(403);
        // Enrollment needs no secret; health is for anyone, with CORS so the page can read it.
        const enroll = await testRequest(bothApp, 'POST', '/api/enroll', { headers: remotePagesHeaders(null) });
        expect((await enroll.json()) as unknown).toEqual({ deviceId: null, remote: true });
        const health = await testRequest(bothApp, 'GET', '/api/health', { headers: remotePagesHeaders(null, { 'X-Portly': null }) });
        expect(health.status).toBe(200);
        expect(health.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
      });

      it('requires X-Portly, cross-site fetch metadata and the Content-Type rules', async () => {
        const missing = await testRequest(bothApp, 'GET', '/api/things', { headers: remotePagesHeaders(device.secret, { 'X-Portly': null }) });
        expect(missing.status).toBe(403);
        const sameOrigin = await testRequest(bothApp, 'GET', '/api/things', { headers: remotePagesHeaders(device.secret, { 'Sec-Fetch-Site': 'same-origin' }) });
        expect(sameOrigin.status).toBe(403);
        const plain = await testRequest(bothApp, 'POST', '/api/things', {
          headers: remotePagesHeaders(device.secret, { 'Content-Type': 'text/plain' }),
          body: '{"name":"a"}',
        });
        expect(plain.status).toBe(400);
      });
    });
  });

  it('without a Pages site configured, the Pages origin is just another site on the remote host', async () => {
    const res = await testRequest(app, 'GET', '/api/things', { headers: remotePagesHeaders(secret) });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('forbidden');
    expect(corsHeaders(res)).toEqual([]);
  });
});
