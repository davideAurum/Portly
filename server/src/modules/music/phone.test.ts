/**
 * What the phone is playing (docs/design/phone-now-playing.md): a fake helper app reporting through
 * the real gate as a `reporter` device, and everyone else reading or being refused.
 */
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHONE_MAX_POSITION_MS, PHONE_TEXT_MAX, PhoneReportSchema, cleanPhoneText, type PhonePlayback } from '@portly/shared';
import { createApp } from '../../app.ts';
import type { AppEnv } from '../../context.ts';
import { createTestContext, type TestContext } from '../../testing/test-context.ts';
import { connectTestDevice, type TestDevice } from '../../testing/test-devices.ts';
import { TEST_PAGES_ENV, TEST_PAGES_ORIGIN, TEST_REMOTE_ENV, pagesHeaders, remoteHeaders, remotePagesHeaders, testRequest } from '../../testing/test-request.ts';
import { prefixes as devicePrefixes, register as registerDevices } from '../devices/index.ts';
import { prefixes, register } from './index.ts';
import { PHONE_PAUSED_KEPT_MS, PHONE_PLAYING_STALE_MS, PHONE_REPORT_INTERVAL_MS, phoneHealthKey } from './phone.ts';

const T0 = Date.parse('2026-11-06T10:00:00Z');
const TITLE = 'Episode 12: The Lighthouse Keeper';
const SHOW = 'Tales of the Harbour';

const EPISODE = {
  app: 'pocket-casts',
  state: 'playing',
  title: TITLE,
  show: SHOW,
  durationMs: 1_800_000,
  positionMs: 60_000,
  speed: 1,
  episodeId: '11111111-2222-3333-4444-555555555555',
};

describe('music: what the phone is playing', () => {
  let ctx: TestContext;
  let app: Hono<AppEnv>;
  let now: number;
  let phone: TestDevice;
  let pc: TestDevice;

  const build = (): Hono<AppEnv> =>
    createApp(ctx, {
      modules: [
        { name: 'music', prefixes, register: (a, c) => register(a, c, { now: () => now }) },
        { name: 'devices', prefixes: devicePrefixes, register: registerDevices },
      ],
      webDist: null,
    }).app;

  beforeEach(() => {
    now = T0;
    ctx = createTestContext({ env: { ...TEST_PAGES_ENV, ...TEST_REMOTE_ENV }, now: () => now });
    app = build();
    phone = connectTestDevice(ctx, { label: 'Phone', browser: 'Portly helper', scope: 'reporter' });
    pc = connectTestDevice(ctx);
  });
  afterEach(() => ctx.close());

  const send = (body: unknown, secret: string | null = phone.secret) => testRequest(app, 'POST', '/api/music/phone', { headers: remoteHeaders(secret), body });

  /** Sends a report a full interval after the last one. */
  const report = async (body: unknown = EPISODE, secret: string = phone.secret): Promise<void> => {
    now += PHONE_REPORT_INTERVAL_MS;
    expect((await send(body, secret)).status).toBe(204);
  };

  const read = async (): Promise<PhonePlayback | null> => {
    const res = await testRequest(app, 'GET', '/api/music/phone');
    expect(res.status).toBe(200);
    return (await res.json()) as PhonePlayback | null;
  };

  describe('reading', () => {
    it('answers null with nothing reported', async () => {
      expect(await read()).toBeNull();
    });

    it('shows a report to this PC, to another PC and to the paired Pages site on either', async () => {
      await report();
      const expected: PhonePlayback = {
        app: 'pocket-casts',
        state: 'playing',
        title: TITLE,
        show: SHOW,
        durationMs: 1_800_000,
        positionMs: 60_000,
        speed: 1,
        startedAt: new Date(now).toISOString(),
      };
      expect(await read()).toEqual(expected);

      const fromPc = await testRequest(app, 'GET', '/api/music/phone', { headers: remoteHeaders(pc.secret) });
      expect(fromPc.status).toBe(200);
      expect((await fromPc.json()) as unknown).toEqual(expected);
      expect(fromPc.headers.get('cache-control')).toBe('no-store');

      const { token } = ctx.pairing.create({ label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN });
      const fromPages = await testRequest(app, 'GET', '/api/music/phone', { headers: pagesHeaders(token) });
      expect(fromPages.status).toBe(200);
      expect((await fromPages.json()) as unknown).toEqual(expected);

      const fromPagesElsewhere = await testRequest(app, 'GET', '/api/music/phone', { headers: remotePagesHeaders(pc.secret) });
      expect(fromPagesElsewhere.status).toBe(200);
      expect((await fromPagesElsewhere.json()) as unknown).toEqual(expected);
    });

    it('does not let a reporter read back, and gives nobody the episode id', async () => {
      await report();
      const res = await testRequest(app, 'GET', '/api/music/phone', { headers: remoteHeaders(phone.secret) });
      expect(res.status).toBe(403);
      expect(JSON.stringify(await read())).not.toContain(EPISODE.episodeId);
    });

    it('keeps out a PC that is not connected', async () => {
      await report();
      const res = await testRequest(app, 'GET', '/api/music/phone', { headers: remoteHeaders(null) });
      expect(res.status).toBe(401);
    });
  });

  describe('position', () => {
    it('moves a playing position on by its age times the speed, and each report corrects it', async () => {
      await report({ ...EPISODE, speed: 1.5 });
      now += 10_000;
      expect((await read())?.positionMs).toBe(75_000);
      await report({ ...EPISODE, positionMs: 500_000 });
      expect((await read())?.positionMs).toBe(500_000);
    });

    it('never moves past the end, and keeps counting when the length is unknown', async () => {
      await report({ ...EPISODE, positionMs: 1_799_000 });
      now += 60_000;
      expect((await read())?.positionMs).toBe(1_800_000);
      await report({ ...EPISODE, durationMs: null, positionMs: 1_000 });
      now += 5_000;
      expect((await read())?.positionMs).toBe(6_000);
    });

    it('leaves a paused position where it is', async () => {
      await report({ ...EPISODE, state: 'paused' });
      now += 60_000;
      expect((await read())?.positionMs).toBe(60_000);
    });
  });

  describe('going stale', () => {
    it('drops a playing report after 90 seconds without a follow-up, and a follow-up keeps it', async () => {
      await report();
      now += PHONE_PLAYING_STALE_MS;
      expect(await read()).not.toBeNull();
      await report();
      now += PHONE_PLAYING_STALE_MS;
      expect(await read()).not.toBeNull();
      now += 1;
      expect(await read()).toBeNull();
    });

    it('keeps a paused report for 15 minutes', async () => {
      await report({ ...EPISODE, state: 'paused' });
      now += PHONE_PAUSED_KEPT_MS;
      expect((await read())?.state).toBe('paused');
      now += 1;
      expect(await read()).toBeNull();
    });

    it('clears on stopped', async () => {
      await report();
      await report({ app: 'pocket-casts', state: 'stopped' });
      expect(await read()).toBeNull();
      await report({ app: 'pocket-casts', state: 'stopped' });
      expect(await read()).toBeNull();
    });

    it('forgets everything on a restart', async () => {
      await report();
      app = build();
      expect(await read()).toBeNull();
    });
  });

  describe('more than one phone', () => {
    it('shows the latest report, and a phone clears only its own', async () => {
      const second = connectTestDevice(ctx, { label: 'Tablet', scope: 'reporter' });
      await report();
      await report({ ...EPISODE, title: 'Another episode' }, second.secret);
      expect((await read())?.title).toBe('Another episode');
      await report({ app: 'pocket-casts', state: 'stopped' });
      expect((await read())?.title).toBe('Another episode');
      await report({ app: 'pocket-casts', state: 'stopped' }, second.secret);
      expect(await read()).toBeNull();
    });
  });

  describe('when it started', () => {
    it('keeps the time through follow-ups, and takes a new one on a resume or another episode', async () => {
      await report();
      const started = (await read())?.startedAt;
      now += 30_000;
      await report({ ...EPISODE, positionMs: 90_000 });
      expect((await read())?.startedAt).toBe(started);

      await report({ ...EPISODE, state: 'paused' });
      await report({ ...EPISODE, positionMs: 91_000 });
      const resumed = (await read())?.startedAt;
      expect(resumed).toBe(new Date(now).toISOString());

      await report({ ...EPISODE, episodeId: 'another-episode' });
      expect((await read())?.startedAt).toBe(new Date(now).toISOString());
    });

    it('tells episodes apart by title when the app gives no id', async () => {
      const noId = { ...EPISODE, episodeId: null };
      await report(noId);
      const started = (await read())?.startedAt;
      await report(noId);
      expect((await read())?.startedAt).toBe(started);
      await report({ ...noId, title: 'The next one' });
      expect((await read())?.startedAt).toBe(new Date(now).toISOString());
    });

    it('starts again after a report went stale', async () => {
      await report();
      now += PHONE_PLAYING_STALE_MS + 1;
      await report();
      expect((await read())?.startedAt).toBe(new Date(now).toISOString());
    });
  });

  describe('the limit', () => {
    it('takes one report a second per device, then answers 429 with Retry-After', async () => {
      await report();
      const tooSoon = await send(EPISODE);
      expect(tooSoon.status).toBe(429);
      expect(tooSoon.headers.get('retry-after')).toBe('1');
      expect(((await tooSoon.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
      now += PHONE_REPORT_INTERVAL_MS - 1;
      expect((await send(EPISODE)).status).toBe(429);
      now += 1;
      expect((await send(EPISODE)).status).toBe(204);
    });

    it('counts each device on its own', async () => {
      const second = connectTestDevice(ctx, { label: 'Tablet', scope: 'reporter' });
      await report();
      expect((await send(EPISODE, second.secret)).status).toBe(204);
    });

    it('counts a stopped report too, and a refused one does not touch what is shown', async () => {
      await report();
      expect((await send({ app: 'pocket-casts', state: 'stopped' })).status).toBe(429);
      expect((await read())?.title).toBe(TITLE);
    });
  });

  describe('a removed device', () => {
    it('hides its report as soon as it is revoked', async () => {
      await report();
      expect(ctx.devices.revoke(phone.record.id)).toBe(true);
      expect(await read()).toBeNull();
    });

    it('hides its report when it disconnects itself, the one other route open to it', async () => {
      await report();
      const res = await testRequest(app, 'DELETE', '/api/device', { headers: remoteHeaders(phone.secret) });
      expect(res.status).toBe(204);
      expect(await read()).toBeNull();
      expect((await send(EPISODE)).status).toBe(401);
    });

    it('hides a paused report once the device has gone idle for good', async () => {
      await report({ ...EPISODE, state: 'paused' });
      ctx.devices.revoke(phone.record.id, 'expired');
      expect(await read()).toBeNull();
    });
  });

  describe('diagnostics', () => {
    const key = (device: TestDevice = phone): string => phoneHealthKey(device.record.id);

    it('says when the last report came, with nothing of what it said', async () => {
      expect(ctx.health.get(key())).toBeNull();
      const recorded = vi.spyOn(ctx.health, 'record');
      await report();
      expect(ctx.health.get(key())).toMatchObject({ area: 'music', status: 'ok', expectEveryMs: null });
      expect(ctx.health.get(key())?.lastOkAt).toEqual(expect.any(Number));
      await report({ app: 'pocket-casts', state: 'stopped' });
      expect(recorded).toHaveBeenCalledTimes(2);
      const everything = JSON.stringify([ctx.health.list(), ctx.health.history(key())]);
      for (const text of [TITLE, SHOW, EPISODE.episodeId]) expect(everything).not.toContain(text);
    });

    it('does not count a report that was refused', async () => {
      await report();
      const recorded = vi.spyOn(ctx.health, 'record');
      now += 1;
      expect((await send(EPISODE)).status).toBe(429);
      now += PHONE_REPORT_INTERVAL_MS;
      expect((await send({ ...EPISODE, positionMs: -1 })).status).toBe(422);
      expect(recorded).not.toHaveBeenCalled();
    });

    it('forgets a phone removed on the main PC, and one that disconnects itself', async () => {
      await report();
      expect((await testRequest(app, 'DELETE', `/api/devices/${phone.record.id}`)).status).toBe(204);
      expect(ctx.health.get(key())).toBeNull();

      const other = connectTestDevice(ctx, { label: 'Other phone', browser: 'Portly helper', scope: 'reporter' });
      await report(EPISODE, other.secret);
      expect((await testRequest(app, 'DELETE', '/api/device', { headers: remoteHeaders(other.secret) })).status).toBe(204);
      expect(ctx.health.get(key(other))).toBeNull();
    });
  });

  describe('who may report', () => {
    it("refuses Portly's own page: only a device has something to report", async () => {
      const res = await testRequest(app, 'POST', '/api/music/phone', { body: EPISODE });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_configured');
      expect(await read()).toBeNull();
    });

    it('refuses a full device, the paired Pages site and anyone without a cookie', async () => {
      const full = await send(EPISODE, pc.secret);
      expect(full.status).toBe(403);
      expect(((await full.json()) as { error: { code: string } }).error.code).toBe('local_only');
      expect((await send(EPISODE, null)).status).toBe(401);
      const { token } = ctx.pairing.create({ label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN });
      expect((await testRequest(app, 'POST', '/api/music/phone', { headers: pagesHeaders(token), body: EPISODE })).status).toBe(403);
      expect((await testRequest(app, 'POST', '/api/music/phone', { headers: remotePagesHeaders(pc.secret), body: EPISODE })).status).toBe(403);
      expect((await testRequest(app, 'POST', '/api/music/phone', { headers: remotePagesHeaders(phone.secret), body: EPISODE })).status).toBe(403);
      expect(await read()).toBeNull();
    });
  });

  describe('hostile reports', () => {
    it('cleans a title and a show before anyone sees them', async () => {
      await report({ ...EPISODE, title: 'Line\none\u202E\u0000 <b>bold</b>\u2028two', show: '   \u2066 ' });
      expect(await read()).toMatchObject({ title: 'Line one <b>bold</b> two', show: null });
    });

    it('refuses what the schema does not name, with 422', async () => {
      for (const body of [
        {},
        { ...EPISODE, url: 'https://example.com/episode' },
        { ...EPISODE, artworkUrl: 'https://example.com/art.png' },
        { ...EPISODE, app: 'spotify' },
        { ...EPISODE, state: 'buffering' },
        { ...EPISODE, title: '' },
        { ...EPISODE, title: ' \u0007\n ' },
        { ...EPISODE, title: null },
        { ...EPISODE, show: 7 },
        { ...EPISODE, durationMs: 0 },
        { ...EPISODE, durationMs: PHONE_MAX_POSITION_MS + 1 },
        { ...EPISODE, positionMs: -1 },
        { ...EPISODE, positionMs: 1.5 },
        { ...EPISODE, speed: -1 },
        { ...EPISODE, speed: 17 },
        { ...EPISODE, episodeId: 'https://example.com/episode' },
        { ...EPISODE, episodeId: 'x'.repeat(129) },
        { app: 'pocket-casts', state: 'stopped', title: TITLE },
      ]) {
        now += PHONE_REPORT_INTERVAL_MS;
        const res = await send(body);
        expect(res.status, JSON.stringify(body)).toBe(422);
      }
      expect(await read()).toBeNull();
    });

    it('keeps a report in memory only: nothing in the database, nothing in any log', async () => {
      await report({ ...EPISODE, state: 'paused' });
      await report();
      await read();
      now += PHONE_REPORT_INTERVAL_MS;
      await send({ ...EPISODE, title: `${TITLE} `.repeat(3), positionMs: -1 });

      const tables = ctx.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
      const stored = JSON.stringify(tables.map((table) => ctx.db.all(`SELECT * FROM "${table}"`)));
      const logged = JSON.stringify(ctx.logs.query({}).records);
      for (const secret of [TITLE, SHOW, EPISODE.episodeId, phone.secret]) {
        expect(stored).not.toContain(secret);
        expect(logged).not.toContain(secret);
      }
    });
  });
});

describe('PhoneReportSchema', () => {
  it('reads a stopped report with nothing else in it', () => {
    expect(PhoneReportSchema.parse({ app: 'pocket-casts', state: 'stopped' })).toEqual({ app: 'pocket-casts', state: 'stopped' });
  });

  it('treats a missing episode id as none, and a show with nothing left in it as null', () => {
    const { episodeId: _unused, ...rest } = EPISODE;
    expect(PhoneReportSchema.parse({ ...rest, show: ' \u0000 ' })).toMatchObject({ show: null, episodeId: null });
  });

  it('accepts a day-long episode, which the Spotify seek limit would not', () => {
    const long = 25 * 60 * 60 * 1000;
    expect(PhoneReportSchema.safeParse({ ...EPISODE, durationMs: long, positionMs: long }).success).toBe(true);
  });
});

describe('cleanPhoneText', () => {
  it('leaves ordinary titles alone, whatever their language', () => {
    for (const title of ['Plain title', 'Café – 第12回 🎧', 'פרק 7: הדרך', 'Emoji 👩‍🚀 joined']) expect(cleanPhoneText(title)).toBe(title);
  });

  it('turns control, line-separator and bidi-override characters into spaces, once', () => {
    expect(cleanPhoneText('a\tb\r\nc\u2028d\u2029e\u202Ef\u2066g\u0000h')).toBe('a b c d e f g h');
    expect(cleanPhoneText('  many    spaces\u00A0here  ')).toBe('many spaces here');
  });

  it('drops half of a surrogate pair', () => {
    expect(cleanPhoneText('lone \uD83D here')).toBe('lone here');
    expect(cleanPhoneText('lone \uDC00 here')).toBe('lone here');
  });

  it('cuts to the cap without leaving half a pair or a trailing space', () => {
    expect(cleanPhoneText('x'.repeat(PHONE_TEXT_MAX + 50))).toHaveLength(PHONE_TEXT_MAX);
    const emojiAtTheCut = `${'x'.repeat(PHONE_TEXT_MAX - 1)}🎧 more`;
    expect(cleanPhoneText(emojiAtTheCut)).toBe('x'.repeat(PHONE_TEXT_MAX - 1));
    const spaceAtTheCut = `${'x'.repeat(PHONE_TEXT_MAX - 1)} more`;
    expect(cleanPhoneText(spaceAtTheCut)).toBe('x'.repeat(PHONE_TEXT_MAX - 1));
  });

  it('stays fast on a very long hostile title', () => {
    const started = performance.now();
    expect(cleanPhoneText(' \n'.repeat(200_000))).toBe('');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
