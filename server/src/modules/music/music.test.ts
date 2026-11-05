import { afterEach, describe, expect, it } from 'vitest';
import type { MusicDevice, MusicPlayback, MusicStatus } from '@portly/shared';
import { createApp } from '../../app.ts';
import { createMemoryCache } from '../../lib/cache.ts';
import { HttpError } from '../../lib/errors.ts';
import { ProviderHttpError } from '../../lib/provider-errors.ts';
import type { FakeAccountSeed } from '../../testing/fake-accounts.ts';
import type { FakeFetchRoute } from '../../testing/fake-fetch.ts';
import { createTestContext, type TestContext } from '../../testing/test-context.ts';
import { testRequest } from '../../testing/test-request.ts';
import { API, TITLE, upstreamDevice, upstreamError, upstreamState } from './__fixtures__/spotify.ts';
import { prefixes, register } from './index.ts';
import type { MusicProvider } from './providers/types.ts';
import { MUSIC_STATUS_TTL_MS, createMusicService, musicHealthKey } from './service.ts';

type ErrorBody = { error: { code: string; message: string; accountId?: string; details?: { reason?: string; retryAfterSeconds?: number } } };

const ACCOUNT: FakeAccountSeed = { id: 'a1', kind: 'spotify', label: 'Sam', capabilities: ['music'], token: 'access-token-1' };
const PLAYER = `${API}/me/player`;

let ctx: TestContext;
afterEach(() => ctx?.close());

function testbed(routes: FakeFetchRoute[] = [], accounts: FakeAccountSeed[] = [ACCOUNT]) {
  ctx = createTestContext({ accounts, fetchRoutes: routes });
  const { app } = createApp(ctx, { modules: [{ name: 'music', prefixes, register }], webDist: null });
  return {
    get: async <T>(path: string) => {
      const res = await testRequest(app, 'GET', path);
      return { res, status: res.status, body: (await res.json()) as T };
    },
    post: async <T = unknown>(body: unknown) => {
      const res = await testRequest(app, 'POST', '/api/music/command', { body });
      const text = await res.text();
      return { res, status: res.status, body: (text === '' ? null : JSON.parse(text)) as T };
    },
  };
}

const playing: FakeFetchRoute = { match: PLAYER, method: 'GET', respond: { json: upstreamState() } };
const calls = () => ctx.fakeFetch?.calls ?? [];
const playerCalls = () => calls().filter((c) => new URL(c.url).pathname === '/v1/me/player' && c.method === 'GET');

describe('music: status', () => {
  it('reports what is playing, with the provider’s features', async () => {
    const t = testbed([playing]);
    const { status, body, res } = await t.get<MusicStatus>('/api/music/status');
    expect(status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({
      accountId: 'a1',
      provider: 'spotify',
      features: { seek: true, volume: true, shuffle: true, repeat: true, devices: true },
      playback: { isPlaying: true, item: { title: TITLE }, device: { name: 'Desk PC' } },
    });
    const [call] = calls();
    expect(call?.headers.get('authorization')).toBe('Bearer access-token-1');
    expect(new URL(call!.url).searchParams.get('additional_types')).toBe('track,episode');
  });

  it('never sends the token to the browser', async () => {
    const t = testbed([playing]);
    const { res } = await t.get('/api/music/status');
    expect(JSON.stringify(Object.fromEntries(res.headers))).not.toContain('access-token-1');
    expect(JSON.stringify(calls().map((c) => c.url))).not.toContain('access-token-1');
  });

  it('204 means nothing is active', async () => {
    const t = testbed([{ match: PLAYER, method: 'GET', respond: { status: 204 } }]);
    expect((await t.get<MusicStatus>('/api/music/status')).body.playback).toBeNull();
    expect(ctx.health.get(musicHealthKey('a1'))).toMatchObject({ status: 'ok' });
  });

  it('an empty 200 means the same', async () => {
    const t = testbed([{ match: PLAYER, method: 'GET', respond: { status: 200, text: '' } }]);
    expect((await t.get<MusicStatus>('/api/music/status')).body.playback).toBeNull();
  });

  it('an unreadable 200 is a provider error', async () => {
    const t = testbed([{ match: PLAYER, method: 'GET', respond: { status: 200, text: '<html>' } }]);
    const { status, body } = await t.get<ErrorBody>('/api/music/status');
    expect(status).toBe(502);
    expect(body.error.code).toBe('provider_error');
  });

  it('shares one upstream read between tabs', async () => {
    const t = testbed([playing]);
    await Promise.all([t.get('/api/music/status'), t.get('/api/music/status'), t.get('/api/music/status')]);
    await t.get('/api/music/status');
    expect(playerCalls()).toHaveLength(1);
  });

  it('keeps titles out of the logs and out of the persistent cache', async () => {
    const t = testbed([playing]);
    await t.get('/api/music/status');
    expect(JSON.stringify((ctx.logs as unknown as { lines(): unknown[] }).lines())).not.toContain(TITLE);
    expect(JSON.stringify(ctx.db.all('SELECT * FROM cache'))).not.toContain(TITLE);
  });
});

describe('music: choosing the account', () => {
  const second: FakeAccountSeed = { id: 'a2', kind: 'spotify', label: 'Robin', capabilities: ['music'], token: 'access-token-2', sort: 1 };

  it('uses the first music account unless told otherwise', async () => {
    const t = testbed([playing], [ACCOUNT, second]);
    expect((await t.get<MusicStatus>('/api/music/status')).body.accountId).toBe('a1');
    expect((await t.get<MusicStatus>('/api/music/status?accountId=a2')).body.accountId).toBe('a2');
    expect(calls().at(-1)?.headers.get('authorization')).toBe('Bearer access-token-2');
  });

  it.each([
    ['no account at all', []],
    ['only accounts of other kinds', [{ id: 'g1', kind: 'google', capabilities: ['calendar'], token: 'x' }]],
    ['music switched off', [{ ...ACCOUNT, enabledCapabilities: [] }]],
  ] as [string, FakeAccountSeed[]][])('asks to connect with %s', async (_name, accounts) => {
    const t = testbed([], accounts);
    const { status, body } = await t.get<ErrorBody>('/api/music/status');
    expect(status).toBe(409);
    expect(body.error).toMatchObject({ code: 'not_configured', details: { reason: 'no_account' } });
    expect(calls()).toEqual([]);
  });

  it('a named account that is gone falls back to what is connected', async () => {
    const t = testbed([playing]);
    expect((await t.get<MusicStatus>('/api/music/status?accountId=gone')).body.accountId).toBe('a1');
  });

  it('an account that needs reconnecting says which, and its health points at the account', async () => {
    const t = testbed([], [{ ...ACCOUNT, token: undefined }]);
    const { status, body } = await t.get<ErrorBody>('/api/music/status');
    expect(status).toBe(409);
    expect(body.error).toMatchObject({ code: 'reauth_required', accountId: 'a1' });
    expect(ctx.health.get(musicHealthKey('a1'))).toMatchObject({ status: 'failing', lastCode: 'account_unavailable', causeKey: 'account:a1' });
  });

  it('refreshes a rejected token once and retries', async () => {
    const t = testbed(
      [
        { match: PLAYER, method: 'GET', times: 1, respond: { status: 401, json: upstreamError(401) } },
        playing,
      ],
      [{ ...ACCOUNT, refreshedTokens: ['access-token-new'] }],
    );
    expect((await t.get<MusicStatus>('/api/music/status')).status).toBe(200);
    expect(calls().map((c) => c.headers.get('authorization'))).toEqual(['Bearer access-token-1', 'Bearer access-token-new']);
  });

  it('forgets an account’s health when it is removed', async () => {
    const t = testbed([playing]);
    await t.get('/api/music/status');
    expect(ctx.health.get(musicHealthKey('a1'))).not.toBeNull();
    (ctx.accounts as unknown as { emit(e: { type: string; accountId: string }): void }).emit({ type: 'deleted', accountId: 'a1' });
    expect(ctx.health.get(musicHealthKey('a1'))).toBeNull();
  });
});

describe('music: devices', () => {
  it('lists those that can be picked', async () => {
    const t = testbed([
      {
        match: `${PLAYER}/devices`,
        method: 'GET',
        respond: { json: { devices: [upstreamDevice(), upstreamDevice({ id: 'phone-1', name: 'Phone', type: 'Smartphone', is_active: false }), upstreamDevice({ id: null })] } },
      },
    ]);
    const { body } = await t.get<MusicDevice[]>('/api/music/devices');
    expect(body.map((d) => [d.id, d.type, d.active])).toEqual([
      ['device-desk-01', 'computer', true],
      ['phone-1', 'phone', false],
    ]);
  });

  it('answers an empty list for an unusable answer', async () => {
    const t = testbed([{ match: `${PLAYER}/devices`, method: 'GET', respond: { json: { nope: true } } }]);
    expect((await t.get('/api/music/devices')).body).toEqual([]);
  });
});

describe('music: commands', () => {
  it('sends the command and answers 204', async () => {
    const t = testbed([{ match: `${PLAYER}/pause`, method: 'PUT', respond: { status: 204 } }]);
    expect((await t.post({ command: { type: 'pause' } })).status).toBe(204);
    expect(calls().map((c) => [c.method, new URL(c.url).pathname])).toEqual([['PUT', '/v1/me/player/pause']]);
  });

  it('moves playback with a JSON body', async () => {
    const t = testbed([{ match: PLAYER, method: 'PUT', respond: { status: 204 } }]);
    await t.post({ accountId: 'a1', command: { type: 'transfer', deviceId: 'phone-1', play: true } });
    expect(JSON.parse(calls()[0]!.body ?? 'null')).toEqual({ device_ids: ['phone-1'], play: true });
    expect(calls()[0]!.headers.get('content-type')).toBe('application/json');
  });

  it('a command’s answer is not read, whatever its body', async () => {
    const t = testbed([{ match: `${PLAYER}/next`, method: 'POST', respond: { status: 200, text: 'snapshot-not-json' } }]);
    expect((await t.post({ command: { type: 'next' } })).status).toBe(204);
  });

  it.each([
    [{ command: { type: 'dance' } }],
    [{ command: { type: 'seek', positionMs: -1 } }],
    [{ command: { type: 'seek', positionMs: 1.5 } }],
    [{ command: { type: 'volume', percent: 101 } }],
    [{ command: { type: 'repeat', mode: 'forever' } }],
    [{ command: { type: 'transfer', deviceId: '../../evil', play: true } }],
    [{ command: { type: 'pause', extra: 1 } }],
    [{ command: { type: 'pause' }, extra: 1 }],
    [{}],
  ])('refuses %j without calling Spotify', async (body) => {
    const t = testbed();
    expect((await t.post(body)).status).toBe(422);
    expect(calls()).toEqual([]);
  });

  it.each([
    ['not Premium', 403, 'PREMIUM_REQUIRED', 403, 'premium_required'],
    ['no device', 404, 'NO_ACTIVE_DEVICE', 409, 'no_active_device'],
    ['refused', 403, 'UNKNOWN', 409, 'not_allowed'],
  ])('%s', async (_name, upstream, reason, status, musicReason) => {
    const t = testbed([{ match: `${PLAYER}/play`, method: 'PUT', respond: { status: upstream, json: upstreamError(upstream, reason) } }]);
    const res = await t.post<ErrorBody>({ command: { type: 'play' } });
    expect(res.status).toBe(status);
    expect(res.body.error.details?.reason).toBe(musicReason);
    expect(JSON.stringify(res.body)).not.toContain('script');
  });

  it('a command makes the next status read fresh, even a refused one', async () => {
    const t = testbed([playing, { match: `${PLAYER}/pause`, method: 'PUT', respond: { status: 204 } }, { match: `${PLAYER}/next`, method: 'POST', respond: { status: 403, json: upstreamError(403) } }]);
    await t.get('/api/music/status');
    await t.post({ command: { type: 'pause' } });
    await t.get('/api/music/status');
    expect(playerCalls()).toHaveLength(2);
    await t.post({ command: { type: 'next' } });
    await t.get('/api/music/status');
    expect(playerCalls()).toHaveLength(3);
  });
});

describe('music: rate limits', () => {
  const limited: FakeFetchRoute = { match: PLAYER, method: 'GET', respond: { status: 429, headers: { 'Retry-After': '20' }, json: upstreamError(429) } };

  it('passes on the wait, and sends nothing until it is over', async () => {
    const t = testbed([limited]);
    const first = await t.get<ErrorBody>('/api/music/status');
    expect(first.status).toBe(429);
    expect(first.res.headers.get('retry-after')).toBe('20');
    expect(first.body.error.details?.retryAfterSeconds).toBe(20);

    const second = await t.get<ErrorBody>('/api/music/status');
    expect(second.status).toBe(429);
    expect(Number(second.res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(second.body.error.details?.retryAfterSeconds).toBeLessThanOrEqual(20);
    expect((await t.post({ command: { type: 'pause' } })).status).toBe(429);
    expect((await t.get('/api/music/devices')).status).toBe(429);
    expect(calls()).toHaveLength(1);
    expect(ctx.health.get(musicHealthKey('a1'))).toMatchObject({ status: 'failing', lastCode: 'rate_limited' });
  });
});

describe('music: service', () => {
  const PLAYBACK: MusicPlayback = {
    isPlaying: true,
    positionMs: 10_000,
    item: { kind: 'track', title: TITLE, artists: [], album: null, durationMs: 60_000, artworkUrl: null, url: null },
    device: null,
    shuffle: false,
    repeat: 'off',
    allowed: { pause: true, resume: true, next: true, previous: true, seek: true, shuffle: true, repeat: true },
  };

  function service(provider: Partial<MusicProvider>) {
    const clock = { now: 1_000_000 };
    ctx = createTestContext({ accounts: [ACCOUNT] });
    const memo = createMemoryCache({ now: () => clock.now });
    const fake: MusicProvider = {
      displayName: 'Testify',
      features: { seek: true, volume: true, shuffle: true, repeat: true, devices: true },
      playback: async () => PLAYBACK,
      devices: async () => [],
      send: async () => {},
      ...provider,
    };
    return { clock, music: createMusicService({ ...ctx, memo }, { providers: { spotify: fake }, now: () => clock.now }) };
  }

  it('moves the position on by the age of the shared answer, up to the end of the item', async () => {
    const { clock, music } = service({});
    expect((await music.status({})).playback?.positionMs).toBe(10_000);
    clock.now += 2_000;
    expect((await music.status({})).playback?.positionMs).toBe(12_000);
    let reads = 0;
    const late = service({
      playback: async () => {
        reads += 1;
        return { ...PLAYBACK, positionMs: 59_000 };
      },
    });
    await late.music.status({});
    late.clock.now += 2_500;
    expect((await late.music.status({})).playback?.positionMs).toBe(60_000);
    expect(reads).toBe(1);
  });

  it('leaves a paused position alone', async () => {
    const { clock, music } = service({ playback: async () => ({ ...PLAYBACK, isPlaying: false }) });
    await music.status({});
    clock.now += 2_000;
    expect((await music.status({})).playback?.positionMs).toBe(10_000);
  });

  it('reads again once the shared answer has expired', async () => {
    let reads = 0;
    const { clock, music } = service({
      playback: async () => {
        reads += 1;
        return PLAYBACK;
      },
    });
    await music.status({});
    clock.now += MUSIC_STATUS_TTL_MS - 1;
    await music.status({});
    expect(reads).toBe(1);
    clock.now += 2;
    await music.status({});
    expect(reads).toBe(2);
  });

  it('a read already under way cannot bring back the state from before a command', async () => {
    let finish: (value: MusicPlayback) => void = () => {};
    let reads = 0;
    const { music } = service({
      playback: () => {
        reads += 1;
        return reads === 1 ? new Promise((resolve) => (finish = resolve)) : Promise.resolve({ ...PLAYBACK, isPlaying: false });
      },
    });
    const before = music.status({});
    await music.command({ command: { type: 'pause' } });
    expect((await music.status({})).playback?.isPlaying).toBe(false);
    finish(PLAYBACK);
    await before;
    expect((await music.status({})).playback?.isPlaying).toBe(false);
  });

  it('ends the cooldown when the wait is over', async () => {
    let limited = true;
    const { clock, music } = service({
      playback: async () => {
        if (limited) throw new ProviderHttpError(429, 'rate_limited', { message: 'slow down', accountId: 'a1', providerReason: null, retryAfterSeconds: 10 });
        return PLAYBACK;
      },
    });
    await expect(music.status({})).rejects.toMatchObject({ code: 'rate_limited' });
    limited = false;
    clock.now += 9_000;
    await expect(music.status({})).rejects.toMatchObject({ code: 'rate_limited', details: { retryAfterSeconds: 1 } });
    clock.now += 1_000;
    await expect(music.status({})).resolves.toMatchObject({ playback: { isPlaying: true } });
  });

  it('waits 30 s when a 429 does not say how long', async () => {
    const { clock, music } = service({
      send: async () => {
        throw new ProviderHttpError(429, 'rate_limited', { message: 'slow down', accountId: 'a1', providerReason: null });
      },
    });
    await expect(music.command({ command: { type: 'pause' } })).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(music.status({})).rejects.toMatchObject({ details: { retryAfterSeconds: 30 } });
    clock.now += 30_000;
    await expect(music.status({})).resolves.toBeDefined();
  });

  it('refuses what a provider cannot do, and lists no devices for one without them', async () => {
    const sent: unknown[] = [];
    const { music } = service({
      features: { seek: false, volume: false, shuffle: false, repeat: false, devices: false },
      send: async (_id, command) => void sent.push(command),
      devices: async () => {
        throw new Error('never asked');
      },
    });
    await expect(music.devices({})).resolves.toEqual([]);
    for (const command of [
      { type: 'seek', positionMs: 1 },
      { type: 'volume', percent: 1 },
      { type: 'shuffle', on: true },
      { type: 'repeat', mode: 'off' },
      { type: 'transfer', deviceId: 'x', play: true },
    ] as const) {
      await expect(music.command({ command })).rejects.toBeInstanceOf(HttpError);
    }
    expect(sent).toEqual([]);
    await music.command({ command: { type: 'pause' } });
    expect(sent).toEqual([{ type: 'pause' }]);
  });

  it('an answer about what is playing says nothing about the connection', async () => {
    const { music } = service({
      send: async () => {
        throw new ProviderHttpError(409, 'conflict', { message: 'no device', accountId: 'a1', providerReason: 'NO_ACTIVE_DEVICE', details: { reason: 'no_active_device' } });
      },
    });
    await music.status({});
    await expect(music.command({ command: { type: 'play' } })).rejects.toMatchObject({ code: 'conflict' });
    expect(ctx.health.get(musicHealthKey('a1'))).toMatchObject({ status: 'ok' });
  });
});
