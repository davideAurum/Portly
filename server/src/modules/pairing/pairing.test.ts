import fs from 'node:fs';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PairingStatusResponseSchema,
  PairingsResponseSchema,
  parsePairingReturn,
  type PairingCreateResponse,
  type PairingsResponse,
} from '@homebase/shared';
import { createApp } from '../../app.ts';
import type { AppEnv } from '../../context.ts';
import { newToken } from '../../lib/ids.ts';
import { createTestContext, type TestContext, type TestContextOverrides } from '../../testing/test-context.ts';
import { TEST_PAGES_ENV, TEST_PAGES_ORIGIN, TEST_PAGES_URL, pagesHeaders, testRequest, type TestRequestOptions } from '../../testing/test-request.ts';
import { pairingLabel, prefixes, register } from './index.ts';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

describe('pairingLabel', () => {
  it.each([
    [CHROME_WINDOWS, 'Chrome on Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0', 'Edge on Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15', 'Safari on macOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1', 'Safari on iOS'],
    ['Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', 'Chrome on ChromeOS'],
    ['curl/8.0', 'A browser'],
    ['Something (Windows NT 10.0)', 'A browser on Windows'],
    [undefined, 'A browser'],
  ])('%s → %s', (ua, label) => {
    expect(pairingLabel(ua)).toBe(label);
  });
});

describe('pairing routes', () => {
  let ctx: TestContext;
  let app: Hono<AppEnv>;

  function setup(overrides: TestContextOverrides = { env: { ...TEST_PAGES_ENV } }): void {
    ctx = createTestContext(overrides);
    app = createApp(ctx, { modules: [{ name: 'pairing', prefixes, register }], webDist: null }).app;
  }

  afterEach(() => {
    ctx.close();
    fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
  });

  /** `[message, pairingId, label or by]` of the pairing module's info lines. */
  const pairingLines = () =>
    ctx.logs
      .query({ area: 'pairing', level: 'info' })
      .records.filter((r) => r.msg.startsWith('pairing '))
      .map((r) => [r.msg, r.fields.pairingId, r.fields.label ?? r.fields.by]);

  const json = async <T>(method: string, path: string, options?: TestRequestOptions): Promise<{ status: number; body: T; res: Response }> => {
    const res = await testRequest(app, method, path, options);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, res };
  };

  describe('own page: GET/POST /api/pairings, DELETE /api/pairings/:id', () => {
    it('lists nothing yet, with the Pages URL and the instance id', async () => {
      setup();
      const res = await json<PairingsResponse>('GET', '/api/pairings');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ pagesUrl: TEST_PAGES_URL, instanceId: ctx.pairing.instanceId(), pairings: [] });
      expect(PairingsResponseSchema.parse(res.body)).toEqual(res.body);
    });

    it('reports pagesUrl null and refuses to pair (409) without HOMEBASE_PAGES_URL', async () => {
      setup({});
      expect((await json<PairingsResponse>('GET', '/api/pairings')).body.pagesUrl).toBeNull();
      const res = await json<{ error: { code: string } }>('POST', '/api/pairings', { body: { nonce: newToken(32) } });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('not_configured');
      expect(ctx.pairing.list()).toEqual([]);
    });

    it('pairs: 201 with a redirect to the configured Pages URL carrying token, nonce and instance', async () => {
      setup();
      const nonce = newToken(32);
      const res = await json<PairingCreateResponse>('POST', '/api/pairings', {
        body: { nonce },
        headers: { 'User-Agent': CHROME_WINDOWS, Origin: 'http://localhost:5757', Referer: 'https://evil.example/' },
      });
      expect(res.status).toBe(201);
      const url = new URL(res.body.redirectUrl);
      expect(`${url.origin}${url.pathname}`).toBe(TEST_PAGES_URL);
      expect(url.search).toBe('');
      const value = parsePairingReturn(url.hash);
      expect(value).toMatchObject({ nonce, instanceId: ctx.pairing.instanceId() });
      const record = ctx.pairing.verify(value?.token ?? '');
      expect(record).toMatchObject({ label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN, lastUsedAt: null });

      const list = await json<PairingsResponse>('GET', '/api/pairings');
      expect(list.body.pairings).toEqual([
        { id: record?.id, label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN, createdAt: expect.any(String), lastUsedAt: null, current: true },
      ]);
      expect(PairingsResponseSchema.parse(list.body)).toEqual(list.body);
      expect(JSON.stringify(list.body)).not.toContain(value?.token ?? 'token');
      expect(pairingLines()).toEqual([['pairing created', record?.id, 'Chrome on Windows']]);
      expect(JSON.stringify(ctx.logs.query({}).records)).not.toContain(value?.token ?? 'token');
    });

    it('validates the nonce (422)', async () => {
      setup();
      for (const body of [{}, { nonce: 'short' }, { nonce: newToken(32), extra: 1 }]) {
        const res = await json<{ error: { code: string } }>('POST', '/api/pairings', { body });
        expect(res.status, JSON.stringify(body)).toBe(422);
      }
      expect(ctx.pairing.list()).toEqual([]);
    });

    it('marks pairings made for another Pages address as not current', async () => {
      setup();
      ctx.pairing.create({ label: 'old', origin: 'https://old.example' });
      const list = await json<PairingsResponse>('GET', '/api/pairings');
      expect(list.body.pairings.map((p) => [p.label, p.current])).toEqual([['old', false]]);
    });

    it('revokes by id: 204, then 404', async () => {
      setup();
      const { token, record } = ctx.pairing.create({ label: 'x', origin: TEST_PAGES_ORIGIN });
      expect((await testRequest(app, 'DELETE', `/api/pairings/${record.id}`)).status).toBe(204);
      expect(ctx.pairing.verify(token)).toBeNull();
      const again = await json<{ error: { code: string } }>('DELETE', `/api/pairings/${record.id}`);
      expect(again.status).toBe(404);
      expect(again.body.error.code).toBe('not_found');
      // The revoked browser is refused from now on, and the store remembers why.
      expect((await testRequest(app, 'GET', '/api/pairing', { headers: pagesHeaders(token) })).status).toBe(401);
      expect(ctx.pairing.explain(token)).toMatchObject({ status: 'removed', pairingId: record.id, removedBy: 'revoked' });
      expect(pairingLines()).toEqual([['pairing removed', record.id, 'revoked']]);
    });

    it('approving a pairing is not available to the Pages site, even paired (403 local_only)', async () => {
      setup();
      const { token } = ctx.pairing.create({ label: 'x', origin: TEST_PAGES_ORIGIN });
      const res = await json<{ error: { code: string } }>('POST', '/api/pairings', { headers: pagesHeaders(token), body: { nonce: newToken(32) } });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('local_only');
      expect(ctx.pairing.list()).toHaveLength(1);
    });

    it('lets a paired Pages site list and revoke pairings', async () => {
      setup();
      const { token } = ctx.pairing.create({ label: 'me', origin: TEST_PAGES_ORIGIN });
      const other = ctx.pairing.create({ label: 'other', origin: TEST_PAGES_ORIGIN });
      const list = await json<{ pairings: { id: string }[] }>('GET', '/api/pairings', { headers: pagesHeaders(token) });
      expect(list.status).toBe(200);
      expect(list.body.pairings).toHaveLength(2);
      const revoked = await testRequest(app, 'DELETE', `/api/pairings/${other.record.id}`, { headers: pagesHeaders(token) });
      expect(revoked.status).toBe(204);
      expect(ctx.pairing.list()).toHaveLength(1);
    });
  });

  describe('Pages site: GET/DELETE /api/pairing', () => {
    it('reports the presenting browser\'s pairing', async () => {
      setup();
      const { token, record } = ctx.pairing.create({ label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN });
      const res = await json('GET', '/api/pairing', { headers: pagesHeaders(token) });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        paired: true,
        pairingId: record.id,
        instanceId: ctx.pairing.instanceId(),
        label: 'Chrome on Windows',
        createdAt: new Date(record.createdAt).toISOString(),
      });
      expect(PairingStatusResponseSchema.parse(res.body)).toEqual(res.body);
      expect(res.res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
    });

    it('answers 401 for an unknown token and 409 without one (own page)', async () => {
      setup();
      const pages = await json<{ error: { code: string } }>('GET', '/api/pairing', { headers: pagesHeaders(newToken(32)) });
      expect(pages.status).toBe(401);
      expect(pages.body.error.code).toBe('pairing_required');
      const own = await json<{ error: { code: string } }>('GET', '/api/pairing');
      expect(own.status).toBe(409);
      expect(own.body.error.code).toBe('not_configured');
      const ownUnknown = await json<{ error: { code: string } }>('GET', '/api/pairing', { headers: { 'X-Homebase-Token': newToken(32) } });
      expect(ownUnknown.status).toBe(401);
    });

    it('lets the browser unpair itself: 204, then its token is refused', async () => {
      setup();
      const { token } = ctx.pairing.create({ label: 'x', origin: TEST_PAGES_ORIGIN });
      const other = ctx.pairing.create({ label: 'y', origin: TEST_PAGES_ORIGIN });
      const res = await testRequest(app, 'DELETE', '/api/pairing', { headers: pagesHeaders(token) });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
      expect(ctx.pairing.verify(token)).toBeNull();
      expect(ctx.pairing.verify(other.token)).not.toBeNull();
      const after = await json<{ error: { code: string } }>('DELETE', '/api/pairing', { headers: pagesHeaders(token) });
      expect(after.status).toBe(401);
      expect(after.body.error.code).toBe('pairing_required');
      const check = ctx.pairing.explain(token);
      expect(check).toMatchObject({ status: 'removed', removedBy: 'unpaired-itself' });
      expect(pairingLines()).toEqual([['pairing removed', check.status === 'removed' ? check.pairingId : null, 'unpaired-itself']]);
    });
  });
});
