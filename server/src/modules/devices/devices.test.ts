import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_CODE_REGEX,
  DEVICE_COOKIE,
  DEVICE_IDLE_TTL_MS,
  DEVICE_REQUEST_TTL_MS,
  DeviceNameSuggestionResponseSchema,
  DeviceRequestCreateResponseSchema,
  DeviceRequestStatusResponseSchema,
  DeviceStatusResponseSchema,
  DevicesResponseSchema,
  ENROLL_COOKIE,
  MAX_PENDING_DEVICE_REQUESTS,
  type DeviceNameSuggestionResponse,
  type DeviceRequestCreateResponse,
  type DeviceRequestStatusResponse,
  type DeviceStatusResponse,
  type DevicesResponse,
} from '@portly/shared';
import { createApp } from '../../app.ts';
import type { AppEnv } from '../../context.ts';
import { createTestContext, type TestContext } from '../../testing/test-context.ts';
import { REQUEST_RETENTION_MS, TOUCH_INTERVAL_MS } from '../../security/devices.ts';
import { connectTestDevice, cookieValueOf, setCookieFor } from '../../testing/test-devices.ts';
import {
  TEST_PAGES_ENV,
  TEST_PAGES_ORIGIN,
  TEST_REMOTE_ENV,
  TEST_REMOTE_ORIGIN,
  pagesHeaders,
  remoteHeaders,
  testRequest,
  type TestRequestOptions,
} from '../../testing/test-request.ts';
import { prefixes, register } from './index.ts';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

interface ErrorBody {
  error: { code: string };
}

describe('devices routes', () => {
  let ctx: TestContext;
  let app: Hono<AppEnv>;
  let now: number;

  function setup(env: Record<string, string> = { ...TEST_REMOTE_ENV }, peerNames?: TestContext['peerNames']): void {
    now = Date.parse('2026-10-21T10:00:00Z');
    ctx = createTestContext({ env, now: () => now, peerNames });
    app = createApp(ctx, { modules: [{ name: 'devices', prefixes, register }], webDist: null }).app;
  }

  afterEach(() => ctx.close());

  const json = async <T>(method: string, path: string, options?: TestRequestOptions): Promise<{ status: number; body: T; res: Response }> => {
    const res = await testRequest(app, method, path, options);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, res };
  };

  /** The other PC asks: 201 and the enrollment cookie's value. */
  async function ask(label = 'Laptop'): Promise<{ body: DeviceRequestCreateResponse; enroll: string; res: Response }> {
    const res = await testRequest(app, 'POST', '/api/devices/requests', {
      headers: remoteHeaders(null, { 'User-Agent': CHROME_WINDOWS, Origin: TEST_REMOTE_ORIGIN }),
      body: { label },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as DeviceRequestCreateResponse;
    const line = setCookieFor(res, ENROLL_COOKIE);
    if (line === undefined) throw new Error('no enrollment cookie');
    return { body, enroll: cookieValueOf(line), res };
  }

  const poll = (enroll: string | null) =>
    json<DeviceRequestStatusResponse>('GET', '/api/devices/requests/current', { headers: remoteHeaders(null, { Cookie: enroll === null ? null : `${ENROLL_COOKIE}=${enroll}` }) });

  const infoLines = () =>
    ctx.logs
      .query({ level: 'info' })
      .records.filter((r) => r.msg.startsWith('device '))
      .map((r) => [r.msg, r.msg.startsWith('device request') ? r.fields.deviceRequestId : r.fields.deviceId, r.fields.by ?? null]);

  describe('asking to connect', () => {
    beforeEach(() => setup());

    it('creates a request with a code and the enrollment cookie, logging only its id', async () => {
      const { body, res } = await ask('Laptop');
      expect(body.code).toMatch(DEVICE_CODE_REGEX);
      expect(body.expiresAt).toBe(new Date(now + DEVICE_REQUEST_TTL_MS).toISOString());
      expect(DeviceRequestCreateResponseSchema.parse(body)).toEqual(body);
      const cookie = setCookieFor(res, ENROLL_COOKIE) ?? '';
      expect(cookie).toMatch(
        new RegExp(`^${ENROLL_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${(DEVICE_REQUEST_TTL_MS + REQUEST_RETENTION_MS) / 1000}$`),
      );
      expect(setCookieFor(res, DEVICE_COOKIE)).toBeUndefined();
      expect(ctx.devices.listRequests().map((r) => [r.label, r.browser, r.code])).toEqual([['Laptop', 'Chrome on Windows', body.code]]);
      expect(infoLines()).toEqual([['device request created', body.id, null]]);
      const logged = JSON.stringify(ctx.logs.query({}).records);
      expect(logged).not.toContain('Laptop');
      expect(logged).not.toContain(body.code);
      expect(logged).not.toContain(cookieValueOf(cookie));
    });

    it('validates the label (422)', async () => {
      for (const body of [
        {},
        { label: '' },
        { label: '   ' },
        { label: 'x'.repeat(61) },
        { label: 'ok', extra: 1 },
        { label: 'Lap\ntop' },
        { label: 'Lap\u0000top' },
        { label: 'Laptop\u202E' },
        { label: 'Lap\u2028top' },
      ]) {
        const res = await json<ErrorBody>('POST', '/api/devices/requests', { headers: remoteHeaders(null), body });
        expect(res.status, JSON.stringify(body)).toBe(422);
      }
      expect(ctx.devices.listRequests()).toEqual([]);
    });

    it('refuses a fourth pending request with 429 and Retry-After', async () => {
      for (let i = 0; i < MAX_PENDING_DEVICE_REQUESTS; i++) await ask(`PC ${i}`);
      const res = await json<ErrorBody>('POST', '/api/devices/requests', { headers: remoteHeaders(null), body: { label: 'one more' } });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('rate_limited');
      expect(res.res.headers.get('retry-after')).toBe('60');
      expect(setCookieFor(res.res, ENROLL_COOKIE)).toBeUndefined();
    });

    it("is for other PCs: Portly's own page answers 409 conflict", async () => {
      const res = await json<ErrorBody>('POST', '/api/devices/requests', { body: { label: 'this PC' } });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('conflict');
      expect(ctx.devices.listRequests()).toEqual([]);
    });

    it('shows a pending request to its own cookie only', async () => {
      const { body, enroll } = await ask();
      const pending = await poll(enroll);
      expect(pending.status).toBe(200);
      expect(pending.body).toEqual({ status: 'pending', id: body.id, code: body.code, expiresAt: body.expiresAt, device: null });
      expect(DeviceRequestStatusResponseSchema.parse(pending.body)).toEqual(pending.body);
      expect(pending.res.headers.getSetCookie()).toEqual([]);
      expect((await poll(null)).status).toBe(404);
      const unknown = await poll('A'.repeat(43));
      expect(unknown.status).toBe(404);
      expect(setCookieFor(unknown.res, ENROLL_COOKIE)).toBe(`${ENROLL_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
    });

    it('hands the device cookie out again while the first answer may have been lost (never after first use)', async () => {
      const { body, enroll } = await ask('Laptop');
      await testRequest(app, 'POST', `/api/devices/requests/${body.id}/approve`);
      const first = await poll(enroll);
      expect(first.body.status).toBe('approved');
      const firstSecret = cookieValueOf(setCookieFor(first.res, DEVICE_COOKIE) ?? '');
      // The answer never arrived: the same enrollment cookie asks again and gets a fresh secret for the same device.
      const again = await poll(enroll);
      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
      const secondSecret = cookieValueOf(setCookieFor(again.res, DEVICE_COOKIE) ?? '');
      expect(secondSecret).not.toBe(firstSecret);
      expect(setCookieFor(again.res, ENROLL_COOKIE)).toContain('Max-Age=0');
      expect(ctx.devices.verify(firstSecret)).toBeNull();
      expect(ctx.devices.verify(secondSecret)?.id).toBe(first.body.device?.id);
      expect((await json<DevicesResponse>('GET', '/api/devices')).body.devices).toHaveLength(1);
      // Once the device has been used, the enrollment cookie is spent for good.
      expect((await json<DevicesResponse>('GET', '/api/devices', { headers: remoteHeaders(secondSecret) })).status).toBe(200);
      expect((await poll(enroll)).status).toBe(404);
      expect(ctx.devices.verify(secondSecret)?.id).toBe(first.body.device?.id);
    });

    it('swaps a still-valid older device cookie for the new one without renewing the old', async () => {
      const older = connectTestDevice(ctx, { label: 'Before' });
      ctx.devices.touch(older.record.id);
      // The older device is due for a renewal, the new request is fresh.
      now += TOUCH_INTERVAL_MS + 1;
      const { body, enroll } = await ask('Laptop again');
      await testRequest(app, 'POST', `/api/devices/requests/${body.id}/approve`);
      const res = await testRequest(app, 'GET', '/api/devices/requests/current', {
        headers: remoteHeaders(older.secret, { Cookie: `${DEVICE_COOKIE}=${older.secret}; ${ENROLL_COOKIE}=${enroll}` }),
      });
      expect(res.status).toBe(200);
      const deviceLines = res.headers.getSetCookie().filter((l) => l.startsWith(`${DEVICE_COOKIE}=`));
      expect(deviceLines).toHaveLength(1);
      expect(cookieValueOf(deviceLines[0] ?? '')).not.toBe(older.secret);
      expect(ctx.devices.verify(older.secret)?.lastUsedAt).toBe(now);
    });

    it('reports an expired request once and clears its cookie', async () => {
      const { body, enroll } = await ask();
      now += DEVICE_REQUEST_TTL_MS + 1;
      const expired = await poll(enroll);
      expect(expired.body).toMatchObject({ status: 'expired', id: body.id, device: null });
      expect(setCookieFor(expired.res, ENROLL_COOKIE)).toContain('Max-Age=0');
      expect((await json<ErrorBody>('POST', `/api/devices/requests/${body.id}/approve`)).status).toBe(404);
    });
  });

  describe('the name to suggest', () => {
    const lookup = vi.fn(async (address: string) => (address === '100.101.102.103' ? 'STUDY-LAPTOP' : null));
    beforeEach(() => {
      lookup.mockClear();
      setup({ ...TEST_REMOTE_ENV }, { lookup });
    });

    it("asks Tailscale about the address the proxy itself added (the last one) for a request from the other PC", async () => {
      const res = await json<DeviceNameSuggestionResponse>('GET', '/api/devices/requests/suggestion', {
        headers: remoteHeaders(null, { 'X-Forwarded-For': '100.64.0.9, 10.0.0.2 , 100.101.102.103 ' }),
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ label: 'STUDY-LAPTOP' });
      expect(DeviceNameSuggestionResponseSchema.parse(res.body)).toEqual(res.body);
      expect(lookup).toHaveBeenCalledWith('100.101.102.103');
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it('answers no name when Tailscale has none, or when no address was forwarded', async () => {
      const unknown = await json<DeviceNameSuggestionResponse>('GET', '/api/devices/requests/suggestion', {
        headers: remoteHeaders(null, { 'X-Forwarded-For': '100.64.0.9' }),
      });
      expect(unknown.body).toEqual({ label: null });
      const bare = await json<DeviceNameSuggestionResponse>('GET', '/api/devices/requests/suggestion', { headers: remoteHeaders(null) });
      expect(bare.body).toEqual({ label: null });
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it("never looks anything up for this PC's own page, and is not for the Pages site", async () => {
      const own = await json<DeviceNameSuggestionResponse>('GET', '/api/devices/requests/suggestion');
      expect(own.status).toBe(200);
      expect(own.body).toEqual({ label: null });
      expect(lookup).not.toHaveBeenCalled();
      ctx.close();
      setup({ ...TEST_REMOTE_ENV, ...TEST_PAGES_ENV }, { lookup });
      const { token } = ctx.pairing.create({ label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN });
      const pages = await json<ErrorBody>('GET', '/api/devices/requests/suggestion', { headers: pagesHeaders(token) });
      expect(pages.status).toBe(403);
    });
  });

  describe('approving on the main PC', () => {
    beforeEach(() => setup());

    it('lists the waiting request, approves it, and the other PC gets its device cookie on the next poll', async () => {
      const { body, enroll } = await ask('Laptop');
      const list = await json<DevicesResponse>('GET', '/api/devices');
      expect(list.status).toBe(200);
      expect(list.body).toEqual({
        remoteOrigin: TEST_REMOTE_ORIGIN,
        devices: [],
        requests: [{ id: body.id, code: body.code, label: 'Laptop', browser: 'Chrome on Windows', createdAt: new Date(now).toISOString(), expiresAt: body.expiresAt }],
      });
      expect(DevicesResponseSchema.parse(list.body)).toEqual(list.body);

      const approved = await json<{ approved: true }>('POST', `/api/devices/requests/${body.id}/approve`);
      expect(approved.status).toBe(200);
      expect(approved.body).toEqual({ approved: true });
      expect((await json<ErrorBody>('POST', `/api/devices/requests/${body.id}/approve`)).status).toBe(404);
      expect((await json<DevicesResponse>('GET', '/api/devices')).body.requests).toEqual([]);

      now += 2000;
      const connected = await poll(enroll);
      expect(connected.status).toBe(200);
      expect(connected.body).toEqual({
        status: 'approved',
        id: body.id,
        code: body.code,
        expiresAt: body.expiresAt,
        device: { id: expect.any(String), label: 'Laptop', createdAt: new Date(now).toISOString() },
      });
      const deviceCookie = setCookieFor(connected.res, DEVICE_COOKIE) ?? '';
      expect(deviceCookie).toMatch(new RegExp(`^${DEVICE_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${DEVICE_IDLE_TTL_MS / 1000}$`));
      expect(setCookieFor(connected.res, ENROLL_COOKIE)).toContain('Max-Age=0');
      const secret = cookieValueOf(deviceCookie);
      expect(secret).not.toBe(enroll);

      // The device works, sees itself as current, and the main PC sees it too.
      const mine = await json<DevicesResponse>('GET', '/api/devices', { headers: remoteHeaders(secret) });
      expect(mine.status).toBe(200);
      expect(mine.body.devices).toEqual([
        { id: connected.body.device?.id, label: 'Laptop', browser: 'Chrome on Windows', createdAt: new Date(now).toISOString(), lastUsedAt: new Date(now).toISOString(), current: true },
      ]);
      expect((await json<DevicesResponse>('GET', '/api/devices')).body.devices[0]?.current).toBe(false);
      // Used once, the enrollment cookie is spent.
      expect((await poll(enroll)).status).toBe(404);
      const self = await json<DeviceStatusResponse>('GET', '/api/device', { headers: remoteHeaders(secret) });
      expect(self.body).toEqual({ device: connected.body.device });
      expect(DeviceStatusResponseSchema.parse(self.body)).toEqual(self.body);
      expect((await json<ErrorBody>('GET', '/api/device')).status).toBe(409);

      expect(infoLines()).toEqual([
        ['device request created', body.id, null],
        ['device request approved', body.id, null],
        ['device connected', connected.body.device?.id, null],
      ]);
      const logged = JSON.stringify(ctx.logs.query({}).records);
      expect(logged).not.toContain(secret);
      expect(logged).not.toContain(enroll);
      expect(logged).not.toContain(body.code);
      expect(logged).not.toContain('Laptop');
    });

    it('denies a request: the other PC learns it once and loses its cookie', async () => {
      const { body, enroll } = await ask();
      expect((await testRequest(app, 'POST', `/api/devices/requests/${body.id}/deny`)).status).toBe(204);
      expect((await testRequest(app, 'POST', `/api/devices/requests/${body.id}/deny`)).status).toBe(404);
      expect((await testRequest(app, 'POST', '/api/devices/requests/nope/deny')).status).toBe(404);
      const denied = await poll(enroll);
      expect(denied.body).toMatchObject({ status: 'denied', id: body.id, device: null });
      expect(setCookieFor(denied.res, ENROLL_COOKIE)).toContain('Max-Age=0');
      expect(infoLines()).toEqual([
        ['device request created', body.id, null],
        ['device request denied', body.id, null],
      ]);
    });

    it("approving and denying stay with this PC's own page: 403 local_only from another PC or the Pages site", async () => {
      ctx.close();
      setup({ ...TEST_REMOTE_ENV, ...TEST_PAGES_ENV });
      const device = connectTestDevice(ctx, { label: 'Desk' });
      const token = ctx.pairing.create({ label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN }).token;
      const { body } = await ask('Laptop');
      for (const headers of [remoteHeaders(device.secret), pagesHeaders(token)]) {
        for (const action of ['approve', 'deny']) {
          const res = await json<ErrorBody>('POST', `/api/devices/requests/${body.id}/${action}`, { headers });
          expect(res.status, action).toBe(403);
          expect(res.body.error.code, action).toBe('local_only');
        }
      }
      expect(ctx.devices.listRequests().map((r) => r.id)).toEqual([body.id]);
      // Listing is open to both; the Pages site may not ask to connect.
      expect((await json<DevicesResponse>('GET', '/api/devices', { headers: remoteHeaders(device.secret) })).status).toBe(200);
      expect((await json<DevicesResponse>('GET', '/api/devices', { headers: pagesHeaders(token) })).status).toBe(200);
      expect((await json<ErrorBody>('POST', '/api/devices/requests', { headers: pagesHeaders(token), body: { label: 'x' } })).body.error.code).toBe('local_only');
    });
  });

  describe('connected devices', () => {
    beforeEach(() => setup());

    it('revokes a device from the main PC: its cookie stops working at once', async () => {
      const device = connectTestDevice(ctx, { label: 'Laptop' });
      expect((await json<DevicesResponse>('GET', '/api/devices', { headers: remoteHeaders(device.secret) })).status).toBe(200);
      expect((await testRequest(app, 'DELETE', `/api/devices/${device.record.id}`)).status).toBe(204);
      expect((await testRequest(app, 'DELETE', `/api/devices/${device.record.id}`)).status).toBe(404);
      const after = await json<ErrorBody>('GET', '/api/devices', { headers: remoteHeaders(device.secret) });
      expect(after.status).toBe(401);
      expect(after.body.error.code).toBe('login_required');
      expect((await json<DevicesResponse>('GET', '/api/devices')).body.devices).toEqual([]);
      expect(infoLines()).toEqual([
        ['device connected', device.record.id, null],
        ['device removed', device.record.id, 'revoked'],
      ]);
    });

    it('lets a device disconnect itself, clearing its cookie', async () => {
      const device = connectTestDevice(ctx, { label: 'Laptop' });
      const res = await testRequest(app, 'DELETE', '/api/device', { headers: remoteHeaders(device.secret) });
      expect(res.status).toBe(204);
      // The first use would have renewed the cookie; the clear is the only Set-Cookie.
      expect(res.headers.getSetCookie()).toEqual([`${DEVICE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`]);
      expect((await json<ErrorBody>('GET', '/api/device', { headers: remoteHeaders(device.secret) })).status).toBe(401);
      expect((await json<ErrorBody>('DELETE', '/api/device')).status).toBe(409);
      expect(infoLines().at(-1)).toEqual(['device removed', device.record.id, 'disconnected']);
      // A stray device cookie on a local request names no device for these routes either.
      const fresh = connectTestDevice(ctx, { label: 'Fresh' });
      expect((await json<ErrorBody>('GET', '/api/device', { headers: { Cookie: `${DEVICE_COOKIE}=${fresh.secret}` } })).status).toBe(409);
      expect((await json<ErrorBody>('DELETE', '/api/device', { headers: { Cookie: `${DEVICE_COOKIE}=${fresh.secret}` } })).status).toBe(409);
      expect(ctx.devices.verify(fresh.secret)).not.toBeNull();
    });

    it('a device may not remove another device (nor approve one): other PCs are managed on the main PC', async () => {
      const a = connectTestDevice(ctx, { label: 'A' });
      const b = connectTestDevice(ctx, { label: 'B' });
      const res = await json<ErrorBody>('DELETE', `/api/devices/${b.record.id}`, { headers: remoteHeaders(a.secret) });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('local_only');
      expect(ctx.devices.verify(b.secret)).not.toBeNull();
      // It may still disconnect itself, and read the list.
      expect((await json<DevicesResponse>('GET', '/api/devices', { headers: remoteHeaders(a.secret) })).status).toBe(200);
      expect((await testRequest(app, 'DELETE', '/api/device', { headers: remoteHeaders(a.secret) })).status).toBe(204);
    });
  });

  describe('feature off', () => {
    it('without PORTLY_REMOTE_ORIGIN the list says so and asking answers 409 not_configured', async () => {
      setup({});
      const list = await json<DevicesResponse>('GET', '/api/devices');
      expect(list.body).toEqual({ remoteOrigin: null, devices: [], requests: [] });
      const res = await json<ErrorBody>('POST', '/api/devices/requests', { body: { label: 'x' } });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('not_configured');
      expect((await poll(null)).status).toBe(403); // the remote host itself is refused
    });
  });
});
