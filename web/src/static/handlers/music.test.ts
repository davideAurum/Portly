/**
 * Static backend: the Music routes, with the browser calling Spotify. Port of
 * server/src/modules/music/music.test.ts: same routes and shapes as the server, the short cache,
 * rate limits and the refused commands the widget treats on its own. What the answers mean is the
 * shared mapping, tested on the server (server/src/modules/music/spotify.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MusicDevice, MusicStatus } from '@portly/shared';
import { getClientEvents } from '../../diagnostics/clientLog.ts';
import { finishSignIn } from '../oauthRedirect.ts';
import { createFakeFetch, failingFetch, type FakeFetch, type FakeFetchRoute } from '../providers/__fixtures__/fakeFetch.ts';
import { PLAYER, SPOTIFY_CLIENT_ID, TITLE, playerDevice, playerError, playerState, profileRoute, spotifyGrant, spotifyProfile, tokenRoute } from '../providers/__fixtures__/spotify.ts';
import { SPOTIFY_DEFAULT_RETRY_AFTER_S } from '../providers/spotifyClient.ts';
import { getAccountTokens, getAccounts } from '../slices.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import * as accounts from './accounts.ts';
import * as music from './music.ts';
import { MUSIC_DEVICES_TTL_MS, MUSIC_STATUS_TTL_MS } from './music.ts';

type ErrorBody = { error: { code: string; message: string; details?: { reason?: string; retryAfterSeconds?: number }; accountId?: string } };

const APP_URL = 'https://portly.example.github.io/';
const STATUS = '/api/music/status';
const DEVICES = '/api/music/devices';
const COMMAND = '/api/music/command';
const STATE_URL = /\/v1\/me\/player\?additional_types=/;
const DEVICES_URL = /\/v1\/me\/player\/devices$/;

let t: TestBackend;
let fake: FakeFetch;

afterEach(() => {
  vi.unstubAllGlobals();
  t?.close();
});

const stateRoute = (respond: FakeFetchRoute['respond'], times?: number): FakeFetchRoute => ({ match: STATE_URL, method: 'GET', respond, ...(times === undefined ? {} : { times }) });
const playerCalls = () => fake.calls.filter((call) => call.url.startsWith(PLAYER));
const events = () => getClientEvents().map((entry) => entry.event);

/** A backend with one connected Spotify account (one more with `second`); returns its id. */
async function setup(options: { connect?: boolean } = {}): Promise<string> {
  fake = createFakeFetch([]);
  vi.stubGlobal('fetch', fake.fetch);
  t = await createTestBackend([accounts, music], { appUrl: APP_URL, startAt: 1_700_000_000_000 });
  expect((await t.json('PUT', '/api/oauth-clients/spotify', { clientId: SPOTIFY_CLIENT_ID })).status).toBe(200);
  if (options.connect === false) return '';
  return connect();
}

async function connect(profile = spotifyProfile()): Promise<string> {
  fake.add(tokenRoute(spotifyGrant(), 1));
  fake.add(profileRoute(profile, 1));
  const { body } = await t.json<{ authorizeUrl: string }>('POST', '/api/oauth/spotify/start', {});
  const url = new URL(APP_URL);
  url.searchParams.set('code', 'auth-code');
  url.searchParams.set('state', new URL(body.authorizeUrl).searchParams.get('state')!);
  await finishSignIn(t.ctx, url.href);
  return getAccounts(t.ctx).at(-1)!.id;
}

describe('music: status', () => {
  it('answers what the server answers, calling Spotify from the page with the account’s token', async () => {
    const id = await setup();
    fake.add(stateRoute({ json: playerState() }));
    const { status, body } = await t.json<MusicStatus>('GET', STATUS);
    expect(status).toBe(200);
    expect(body).toEqual({
      accountId: id,
      provider: 'spotify',
      features: { seek: true, volume: true, shuffle: true, repeat: true, devices: true },
      playback: {
        isPlaying: true,
        positionMs: 30_000,
        item: { kind: 'track', title: TITLE, artists: ['The Paper Lanterns'], album: 'Tide Tables', durationMs: 200_000, artworkUrl: 'https://i.scdn.co/image/medium', url: 'https://open.spotify.com/track/abc123' },
        device: { id: 'device-desk-01', name: 'Desk PC', type: 'computer', active: true, restricted: false, volumePercent: 40 },
        shuffle: false,
        repeat: 'off',
        allowed: { pause: true, resume: false, next: true, previous: true, seek: true, shuffle: true, repeat: true },
      },
    });
    const [call] = playerCalls();
    expect(call).toMatchObject({ method: 'GET', url: `${PLAYER}?additional_types=track%2Cepisode` });
    expect(call!.headers.get('authorization')).toBe('Bearer AT1');
    expect(call!.init).toMatchObject({ credentials: 'omit', redirect: 'error' });
  });

  it('nothing active is no error (204)', async () => {
    await setup();
    fake.add(stateRoute({ status: 204 }));
    expect((await t.json<MusicStatus>('GET', STATUS)).body.playback).toBeNull();
  });

  it('says when no music service is connected, or music is switched off', async () => {
    await setup({ connect: false });
    const none = await t.json<ErrorBody>('GET', STATUS);
    expect(none.status).toBe(409);
    expect(none.body.error).toMatchObject({ code: 'not_configured', details: { reason: 'no_account' } });

    const id = await connect();
    await t.json('PATCH', `/api/accounts/${id}`, { enabledCapabilities: [] });
    expect((await t.json<ErrorBody>('GET', STATUS)).body.error.details?.reason).toBe('no_account');
    expect((await t.json<ErrorBody>('GET', DEVICES)).body.error.details?.reason).toBe('no_account');
    expect((await t.json<ErrorBody>('POST', COMMAND, { command: { type: 'pause' } })).body.error.details?.reason).toBe('no_account');
    expect(playerCalls()).toEqual([]);
  });

  it('uses the named account, and the first one when a saved account is gone', async () => {
    const first = await setup();
    const second = await connect(spotifyProfile({ account_id: 'acct-second', display_name: 'Second' }));
    fake.add(stateRoute({ status: 204 }));
    expect((await t.json<MusicStatus>('GET', `${STATUS}?accountId=${second}`)).body.accountId).toBe(second);
    expect((await t.json<MusicStatus>('GET', `${STATUS}?accountId=00000000-0000-4000-8000-0000000000ff`)).body.accountId).toBe(first);
  });

  it('serves one answer for a few seconds, with the position moved on', async () => {
    await setup();
    fake.add(stateRoute({ json: playerState() }));
    await t.json('GET', STATUS);
    t.tick(MUSIC_STATUS_TTL_MS - 1000);
    expect((await t.json<MusicStatus>('GET', STATUS)).body.playback?.positionMs).toBe(30_000 + MUSIC_STATUS_TTL_MS - 1000);
    expect(playerCalls()).toHaveLength(1);
    t.tick(1000);
    await t.json('GET', STATUS);
    expect(playerCalls()).toHaveLength(2);
  });

  it('concurrent requests share one call to Spotify', async () => {
    await setup();
    fake.add(stateRoute({ json: playerState() }));
    await Promise.all([t.json('GET', STATUS), t.json('GET', STATUS), t.json('GET', STATUS)]);
    expect(playerCalls()).toHaveLength(1);
  });

  it('never moves the position past the end, or while paused', async () => {
    await setup();
    fake.add(stateRoute({ json: playerState({ progress_ms: 199_000 }) }, 1));
    await t.json('GET', STATUS);
    t.tick(MUSIC_STATUS_TTL_MS - 1);
    expect((await t.json<MusicStatus>('GET', STATUS)).body.playback?.positionMs).toBe(200_000);

    t.tick(1);
    fake.add(stateRoute({ json: playerState({ is_playing: false }) }, 1));
    await t.json('GET', STATUS);
    t.tick(MUSIC_STATUS_TTL_MS - 1);
    expect((await t.json<MusicStatus>('GET', STATUS)).body.playback?.positionMs).toBe(30_000);
  });

  it('an unreadable answer is an error, never "nothing is playing"', async () => {
    await setup();
    fake.add(stateRoute({ text: 'not json' }));
    const res = await t.json<ErrorBody>('GET', STATUS);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('provider_error');
    expect(events().at(-1)?.fields).toMatchObject({ provider: 'spotify', host: 'api.spotify.com', status: 200, code: 'parse_error' });
  });

  it('a read refused with 403 stops the widget’s polling and says why', async () => {
    await setup();
    fake.add(stateRoute(playerError(403)));
    const res = await t.json<ErrorBody>('GET', STATUS);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden', details: { reason: 'access_denied' } });
    expect(res.body.error.message).not.toContain('script');
  });

  it('no answer at all is a provider error and an event with no address, token or title', async () => {
    await setup();
    vi.stubGlobal('fetch', failingFetch);
    const res = await t.json<ErrorBody>('GET', STATUS);
    expect(res.status).toBe(502);
    const text = JSON.stringify(events());
    expect(events().at(-1)?.fields).toMatchObject({ provider: 'spotify', host: 'api.spotify.com', status: null, code: 'network' });
    expect(text).not.toContain('/v1/me/player');
    expect(text).not.toContain('AT1');
  });
});

describe('music: the token', () => {
  it('a refused token is refreshed once and the call retried', async () => {
    const id = await setup();
    fake.add(stateRoute(playerError(401), 1));
    fake.add(tokenRoute(spotifyGrant({ access_token: 'AT2', refresh_token: 'RT2' }), 1));
    fake.add(stateRoute({ json: playerState() }));
    expect((await t.json<MusicStatus>('GET', STATUS)).status).toBe(200);
    expect(playerCalls().map((call) => call.headers.get('authorization'))).toEqual(['Bearer AT1', 'Bearer AT2']);
    expect(getAccountTokens(t.ctx)[id]?.refreshToken).toBe('RT2');
  });

  it('a fresh token refused as well means reconnecting', async () => {
    const id = await setup();
    fake.add(stateRoute(playerError(401)));
    fake.add(tokenRoute(spotifyGrant({ access_token: 'AT2' }), 1));
    const res = await t.json<ErrorBody>('GET', STATUS);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'reauth_required', accountId: id });
    expect(getAccounts(t.ctx)[0]?.status).toBe('reauth');
    expect(events().at(-1)?.fields).toMatchObject({ provider: 'spotify', status: 401, code: 'token_rejected' });
  });
});

describe('music: rate limits', () => {
  it('a 429 waits as long as Spotify asks, sending nothing meanwhile', async () => {
    await setup();
    fake.add(stateRoute(playerError(429, undefined, { 'Retry-After': '12' }), 1));
    const limited = await t.json<ErrorBody>('GET', STATUS);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatchObject({ code: 'rate_limited', details: { retryAfterSeconds: 12 } });

    t.tick(4000);
    const waiting = await t.json<ErrorBody>('GET', STATUS);
    expect(waiting.status).toBe(429);
    expect(waiting.body.error.details?.retryAfterSeconds).toBe(8);
    expect((await t.json<ErrorBody>('GET', DEVICES)).status).toBe(429);
    expect((await t.json<ErrorBody>('POST', COMMAND, { command: { type: 'pause' } })).status).toBe(429);
    expect(playerCalls()).toHaveLength(1);

    t.tick(8000);
    fake.add(stateRoute({ status: 204 }));
    expect((await t.json('GET', STATUS)).status).toBe(200);
  });

  it('waits a default time when the browser cannot read Retry-After', async () => {
    await setup();
    fake.add(stateRoute(playerError(429), 1));
    expect((await t.json<ErrorBody>('GET', STATUS)).body.error.details?.retryAfterSeconds).toBe(SPOTIFY_DEFAULT_RETRY_AFTER_S);
    t.tick(SPOTIFY_DEFAULT_RETRY_AFTER_S * 1000 - 1000);
    expect((await t.json<ErrorBody>('GET', STATUS)).body.error.details?.retryAfterSeconds).toBe(1);
    expect(playerCalls()).toHaveLength(1);
  });
});

describe('music: devices', () => {
  it('lists the devices that can be picked, for a few seconds', async () => {
    await setup();
    fake.add({ match: DEVICES_URL, method: 'GET', respond: { json: { devices: [playerDevice(), playerDevice({ id: 'kitchen', name: 'Kitchen', is_active: false, type: 'Speaker' }), playerDevice({ id: null })] } } });
    const res = await t.json<MusicDevice[]>('GET', DEVICES);
    expect(res.body.map((device) => [device.id, device.type, device.active])).toEqual([
      ['device-desk-01', 'computer', true],
      ['kitchen', 'speaker', false],
    ]);
    await t.json('GET', DEVICES);
    expect(playerCalls()).toHaveLength(1);
    t.tick(MUSIC_DEVICES_TTL_MS);
    await t.json('GET', DEVICES);
    expect(playerCalls()).toHaveLength(2);
  });
});

describe('music: commands', () => {
  const answered: FakeFetchRoute = { match: PLAYER, method: 'PUT', respond: { status: 204 } };

  it.each([
    [{ type: 'pause' }, 'PUT', `${PLAYER}/pause`],
    [{ type: 'play' }, 'PUT', `${PLAYER}/play`],
    [{ type: 'next' }, 'POST', `${PLAYER}/next`],
    [{ type: 'previous' }, 'POST', `${PLAYER}/previous`],
    [{ type: 'seek', positionMs: 1000 }, 'PUT', `${PLAYER}/seek?position_ms=1000`],
    [{ type: 'volume', percent: 25 }, 'PUT', `${PLAYER}/volume?volume_percent=25`],
    [{ type: 'shuffle', on: true }, 'PUT', `${PLAYER}/shuffle?state=true`],
    [{ type: 'repeat', mode: 'track' }, 'PUT', `${PLAYER}/repeat?state=track`],
  ])('sends %j', async (command, method, url) => {
    await setup();
    fake.add({ match: PLAYER, method, respond: { status: 204 } });
    expect((await t.call('POST', COMMAND, { command })).status).toBe(204);
    expect(playerCalls()).toMatchObject([{ method, url }]);
  });

  it('moves playback to a device with a JSON body', async () => {
    await setup();
    fake.add(answered);
    expect((await t.call('POST', COMMAND, { command: { type: 'transfer', deviceId: 'kitchen', play: true } })).status).toBe(204);
    const [call] = playerCalls();
    expect(call).toMatchObject({ method: 'PUT', url: PLAYER });
    expect(JSON.parse(call!.body!)).toEqual({ device_ids: ['kitchen'], play: true });
    expect(call!.headers.get('content-type')).toBe('application/json');
  });

  it('refuses a command that is no command', async () => {
    await setup();
    expect((await t.json('POST', COMMAND, { command: { type: 'explode' } })).status).toBe(422);
    expect(playerCalls()).toEqual([]);
  });

  it('reads the state fresh after a command, also after a refused one', async () => {
    await setup();
    fake.add(stateRoute({ json: playerState() }));
    fake.add({ match: `${PLAYER}/pause`, method: 'PUT', respond: { status: 204 }, times: 1 });
    await t.json('GET', STATUS);
    await t.call('POST', COMMAND, { command: { type: 'pause' } });
    await t.json('GET', STATUS);
    expect(playerCalls().filter((call) => STATE_URL.test(call.url))).toHaveLength(2);

    fake.add({ match: `${PLAYER}/pause`, method: 'PUT', respond: playerError(403), times: 1 });
    await t.call('POST', COMMAND, { command: { type: 'pause' } });
    await t.json('GET', STATUS);
    expect(playerCalls().filter((call) => STATE_URL.test(call.url))).toHaveLength(3);
  });

  it('a state read that started before a command does not outlive it', async () => {
    await setup();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.add(
      stateRoute(async () => {
        await held;
        return { json: playerState() };
      }, 1),
    );
    fake.add(answered);
    const slow = t.json('GET', STATUS);
    await vi.waitFor(() => expect(playerCalls()).toHaveLength(1));
    await t.call('POST', COMMAND, { command: { type: 'pause' } });
    release();
    await slow;
    fake.add(stateRoute({ json: playerState({ is_playing: false }) }));
    expect((await t.json<MusicStatus>('GET', STATUS)).body.playback?.isPlaying).toBe(false);
  });

  it.each([
    ['Spotify says nothing is active', playerError(404, 'NO_ACTIVE_DEVICE'), { type: 'play' }, 409, 'conflict', 'no_active_device'],
    ['a bare 404', playerError(404), { type: 'next' }, 409, 'conflict', 'no_active_device'],
    ['a refused command', playerError(403), { type: 'next' }, 409, 'conflict', 'not_allowed'],
    ['a device that left', playerError(404), { type: 'transfer', deviceId: 'gone', play: false }, 404, 'not_found', 'device_unavailable'],
  ])('%s is an answer about the player: no event', async (_name, respond, command, status, code, reason) => {
    await setup();
    fake.add({ match: PLAYER, respond });
    const res = await t.json<ErrorBody>('POST', COMMAND, { command });
    expect(res.status).toBe(status);
    expect(res.body.error).toMatchObject({ code, details: { reason } });
    expect(res.body.error.message).not.toContain('script');
    expect(events().filter((event) => (event.fields as { host?: string } | undefined)?.host === 'api.spotify.com')).toEqual([]);
  });

  it('no Premium is a lasting problem: it says so, and it is recorded', async () => {
    await setup();
    fake.add({ match: PLAYER, respond: playerError(403, 'PREMIUM_REQUIRED') });
    const res = await t.json<ErrorBody>('POST', COMMAND, { command: { type: 'play' } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden', details: { reason: 'premium_required' } });
    expect(events().at(-1)?.fields).toMatchObject({ provider: 'spotify', host: 'api.spotify.com', status: 403, code: 'PREMIUM_REQUIRED' });
  });

  it('what plays never reaches a diagnostic event', async () => {
    await setup();
    fake.add(stateRoute({ json: playerState() }));
    fake.add({ match: `${PLAYER}/next`, method: 'POST', respond: playerError(500) });
    await t.json('GET', STATUS);
    await t.json('POST', COMMAND, { command: { type: 'next' } });
    expect(events().length).toBeGreaterThan(0);
    expect(JSON.stringify(events())).not.toContain(TITLE);
  });
});
