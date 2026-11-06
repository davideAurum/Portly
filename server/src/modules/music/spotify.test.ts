import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MusicCommand } from '@portly/shared';
import { HttpError, ProviderUnauthorizedError } from '../../lib/errors.ts';
import { ProviderHttpError } from '../../lib/provider-errors.ts';
import { TITLE, upstreamDevice, upstreamEpisode, upstreamError, upstreamState, upstreamTrack } from './__fixtures__/spotify.ts';
import { spotifyFailure } from './providers/spotify.ts';
import { commandCall, mapAllowed, mapDevice, mapDevices, mapItem, mapPlayback, pickArtwork } from './providers/spotify-mapping.ts';

describe('spotify: mapping', () => {
  it('is copied byte for byte into the in-browser backend', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(import.meta.dirname, p), 'utf8');
    expect(read('../../../../web/src/static/providers/spotifyMapping.ts')).toBe(read('providers/spotify-mapping.ts'));
  });

  it('lists the devices that can be picked, and none from a body that is no list', () => {
    expect(mapDevices({ devices: [upstreamDevice(), upstreamDevice({ id: null })] }).map((d) => d.id)).toEqual(['device-desk-01']);
    expect(mapDevices({ nope: true })).toEqual([]);
    expect(mapDevices(null)).toEqual([]);
  });

  it('maps a playing track', () => {
    expect(mapPlayback(upstreamState())).toEqual({
      isPlaying: true,
      positionMs: 30_000,
      item: {
        kind: 'track',
        title: TITLE,
        artists: ['The Paper Lanterns', 'Ada Example'],
        album: 'Tide Tables',
        durationMs: 200_000,
        artworkUrl: 'https://i.scdn.co/image/medium',
        url: 'https://open.spotify.com/track/abc123',
      },
      device: { id: 'device-desk-01', name: 'Desk PC', type: 'computer', active: true, restricted: false, volumePercent: 40 },
      shuffle: false,
      repeat: 'off',
      allowed: { pause: true, resume: false, next: true, previous: true, seek: true, shuffle: true, repeat: true },
    });
  });

  it('maps an episode: the show stands in for the artists, its own image first', () => {
    expect(mapItem(upstreamEpisode())).toEqual({
      kind: 'episode',
      title: 'Episode 12: Lighthouses',
      artists: ['Coastal Notes'],
      album: null,
      durationMs: 1_800_000,
      artworkUrl: 'https://i.scdn.co/image/episode',
      url: 'https://open.spotify.com/episode/ep1',
    });
    expect(mapItem(upstreamEpisode({ images: undefined }))?.artworkUrl).toBe('https://i.scdn.co/image/show');
  });

  it('keeps the state when no item can be shown (an advert, a private session)', () => {
    const playback = mapPlayback(upstreamState({ item: null, currently_playing_type: 'ad' }));
    expect(playback?.item).toBeNull();
    expect(playback?.isPlaying).toBe(true);
  });

  it('one missing or odd field never turns a playing state into nothing playing', () => {
    const { device: _device, actions: _actions, ...withoutOptionalParts } = upstreamState();
    expect(mapPlayback(withoutOptionalParts)).toMatchObject({ isPlaying: true, item: { title: TITLE }, device: null });
    expect(mapPlayback(upstreamState({ shuffle_state: 'yes', repeat_state: 7 }))).toMatchObject({ isPlaying: true, shuffle: false, repeat: 'off', item: { title: TITLE } });
    expect(mapPlayback(upstreamState({ device: 'odd', actions: 'odd' }))).toMatchObject({ isPlaying: true, device: null });
  });

  it('reads repeat states and falls back to off', () => {
    expect(mapPlayback(upstreamState({ repeat_state: 'context' }))?.repeat).toBe('context');
    expect(mapPlayback(upstreamState({ repeat_state: 'track' }))?.repeat).toBe('track');
    expect(mapPlayback(upstreamState({ repeat_state: 'nonsense' }))?.repeat).toBe('off');
  });

  it('survives an answer that is not a playback state', () => {
    expect(mapPlayback('nope')).toBeNull();
    expect(mapPlayback({})).toMatchObject({ isPlaying: false, positionMs: 0, item: null, device: null, repeat: 'off' });
    expect(mapItem({ name: 5 })).toBeNull();
    expect(mapItem({ type: 'track' })).toBeNull();
    expect(mapDevice('nope')).toBeNull();
  });

  describe('hostile content', () => {
    it('takes cover art only from the one host the CSP allows', () => {
      expect(pickArtwork([{ url: 'https://evil.example/x.png', width: 640 }])).toBeNull();
      expect(pickArtwork([{ url: 'http://i.scdn.co/image/plain', width: 640 }])).toBeNull();
      expect(pickArtwork([{ url: 'https://i.scdn.co.evil.example/x', width: 640 }])).toBeNull();
      expect(pickArtwork([{ url: 'javascript:alert(1)', width: 640 }])).toBeNull();
      expect(pickArtwork([{ url: `https://i.scdn.co/${'x'.repeat(600)}`, width: 640 }])).toBeNull();
      expect(pickArtwork(null)).toBeNull();
    });

    it('prefers the smallest image of at least 300 px, else the largest', () => {
      const image = (width: number) => ({ url: `https://i.scdn.co/${width}`, width });
      expect(pickArtwork([image(640), image(300), image(64)])).toBe('https://i.scdn.co/300');
      expect(pickArtwork([image(64), image(120)])).toBe('https://i.scdn.co/120');
      expect(pickArtwork([{ url: 'https://i.scdn.co/unsized' }])).toBe('https://i.scdn.co/unsized');
    });

    it('links only to Spotify’s own site', () => {
      const urlOf = (spotify: unknown) => mapItem(upstreamTrack({ external_urls: { spotify } }))?.url;
      expect(urlOf('https://open.spotify.com/track/1')).toBe('https://open.spotify.com/track/1');
      expect(urlOf('https://evil.example/track/1')).toBeNull();
      expect(urlOf('https://open.spotify.com.evil.example/x')).toBeNull();
      expect(urlOf('javascript:alert(1)')).toBeNull();
      expect(urlOf(undefined)).toBeNull();
    });

    it('cleans text: control characters go, length is capped, an empty title is no item', () => {
      expect(mapItem(upstreamTrack({ name: 'Line\nbreak\u0000here' }))?.title).toBe('Line break here');
      expect(mapItem(upstreamTrack({ name: 'x'.repeat(5000) }))?.title).toHaveLength(300);
      expect(mapItem(upstreamTrack({ name: '  \n ' }))).toBeNull();
      expect(mapItem(upstreamTrack({ artists: Array.from({ length: 40 }, (_, i) => ({ name: `Artist ${i}` })) }))?.artists).toHaveLength(12);
      expect(mapItem(upstreamTrack({ artists: [{ name: ' ' }, { name: 'Ada' }, { name: null }] }))?.artists).toEqual(['Ada']);
    });

    it('clamps numbers', () => {
      expect(mapDevice(upstreamDevice({ volume_percent: 900 }))?.volumePercent).toBe(100);
      expect(mapDevice(upstreamDevice({ volume_percent: -5 }))?.volumePercent).toBe(0);
      expect(mapPlayback(upstreamState({ progress_ms: -10 }))?.positionMs).toBe(0);
      expect(mapPlayback(upstreamState({ progress_ms: 'soon' }))?.positionMs).toBe(0);
    });
  });

  describe('devices', () => {
    it.each([
      ['Computer', 'computer'],
      ['Smartphone', 'phone'],
      ['Tablet', 'phone'],
      ['Speaker', 'speaker'],
      ['CastAudio', 'speaker'],
      ['TV', 'tv'],
      ['GameConsole', 'tv'],
      ['Toaster', 'other'],
    ])('%s is a %s', (type, expected) => {
      expect(mapDevice(upstreamDevice({ type }))?.type).toBe(expected);
    });

    it('has no volume when the device says it has none', () => {
      expect(mapDevice(upstreamDevice({ supports_volume: false }))?.volumePercent).toBeNull();
      expect(mapDevice(upstreamDevice({ volume_percent: null }))?.volumePercent).toBeNull();
    });

    it('keeps a device without a usable id, marked as such', () => {
      expect(mapDevice(upstreamDevice({ id: null }))?.id).toBeNull();
      expect(mapDevice(upstreamDevice({ id: 'has spaces/and?more' }))?.id).toBeNull();
      expect(mapDevice(upstreamDevice({ name: '' }))?.name).toBe('Unnamed device');
    });
  });

  describe('allowed actions', () => {
    it('reads `actions.disallows` as answers show it, and the flags as the reference shows them', () => {
      expect(mapAllowed({ disallows: { skipping_next: true, seeking: true } }, false)).toMatchObject({ next: false, seek: false, previous: true });
      expect(mapAllowed({ skipping_prev: true, pausing: true }, false)).toMatchObject({ previous: false, pause: false, next: true });
      expect(mapAllowed({ disallows: { skipping_next: false } }, false).next).toBe(true);
    });

    it('allows everything when Spotify says nothing', () => {
      expect(Object.values(mapAllowed(undefined, false)).every(Boolean)).toBe(true);
      expect(Object.values(mapAllowed('nonsense', false)).every(Boolean)).toBe(true);
    });

    it('refuses repeat when either repeat mode is refused', () => {
      expect(mapAllowed({ disallows: { toggling_repeat_track: true } }, false).repeat).toBe(false);
      expect(mapAllowed({ disallows: { toggling_repeat_context: true } }, false).repeat).toBe(false);
    });

    it('allows nothing on a restricted device', () => {
      expect(Object.values(mapAllowed({}, true)).some(Boolean)).toBe(false);
      expect(mapPlayback(upstreamState({ device: upstreamDevice({ is_restricted: true }), actions: {} }))?.allowed.pause).toBe(false);
    });
  });
});

describe('spotify: commands', () => {
  it.each<[MusicCommand, string, string, Record<string, string> | undefined, unknown]>([
    [{ type: 'play' }, 'PUT', '/me/player/play', undefined, undefined],
    [{ type: 'pause' }, 'PUT', '/me/player/pause', undefined, undefined],
    [{ type: 'next' }, 'POST', '/me/player/next', undefined, undefined],
    [{ type: 'previous' }, 'POST', '/me/player/previous', undefined, undefined],
    [{ type: 'seek', positionMs: 42_000 }, 'PUT', '/me/player/seek', { position_ms: '42000' }, undefined],
    [{ type: 'volume', percent: 35 }, 'PUT', '/me/player/volume', { volume_percent: '35' }, undefined],
    [{ type: 'shuffle', on: true }, 'PUT', '/me/player/shuffle', { state: 'true' }, undefined],
    [{ type: 'repeat', mode: 'context' }, 'PUT', '/me/player/repeat', { state: 'context' }, undefined],
    [{ type: 'transfer', deviceId: 'dev-1', play: true }, 'PUT', '/me/player', undefined, { device_ids: ['dev-1'], play: true }],
  ])('%j', (command, method, path, query, body) => {
    const call = commandCall(command);
    expect(call).toMatchObject({ method, path, kind: 'command', purpose: `spotify.player.${command.type}` });
    expect(call.query).toEqual(query);
    expect(call.body).toEqual(body);
  });
});

describe('spotify: errors', () => {
  const read = { kind: 'read' } as const;
  const command = { kind: 'command' } as const;
  const failure = (status: number, reason: string | undefined, call: Parameters<typeof spotifyFailure>[3], retryAfter: string | null = null) =>
    spotifyFailure(status, upstreamError(status, reason), 'a1', call, retryAfter) as ProviderHttpError;

  it('hands a 401 to withToken', () => {
    expect(failure(401, undefined, read)).toBeInstanceOf(ProviderUnauthorizedError);
  });

  it('maps a 429 with its Retry-After, for reads and commands', () => {
    const err = failure(429, undefined, read, '17');
    expect(err).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 17, httpStatus: 429 });
    expect(err.details).toEqual({ retryAfterSeconds: 17 });
    expect(failure(429, 'QUOTA_EXCEEDED', command)).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: null });
  });

  it.each([
    ['not Premium', 403, 'PREMIUM_REQUIRED', command, 403, 'forbidden', 'premium_required'],
    ['no device, by reason', 404, 'NO_ACTIVE_DEVICE', command, 409, 'conflict', 'no_active_device'],
    ['no device, by status', 404, undefined, command, 409, 'conflict', 'no_active_device'],
    ['a device that left', 404, undefined, { kind: 'command', namesDevice: true }, 404, 'not_found', 'device_unavailable'],
    ['a refused command', 403, undefined, command, 409, 'conflict', 'not_allowed'],
    ['a restriction', 403, 'UNKNOWN', command, 409, 'conflict', 'not_allowed'],
    ['refused access on a read', 403, undefined, read, 403, 'forbidden', 'access_denied'],
  ] as const)('%s', (_name, upstream, reason, call, status, code, musicReason) => {
    const err = failure(upstream, reason, call);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status, code, details: { reason: musicReason }, httpStatus: upstream, accountId: 'a1' });
  });

  it('maps the rest by status', () => {
    expect(failure(500, undefined, read)).toMatchObject({ status: 502, code: 'provider_error' });
    expect(failure(503, undefined, command)).toMatchObject({ status: 502, code: 'provider_error' });
    expect(failure(504, undefined, read)).toMatchObject({ status: 504, code: 'upstream_timeout' });
    expect(failure(400, undefined, command)).toMatchObject({ status: 502, code: 'provider_error' });
  });

  it('never repeats Spotify’s text, and keeps its reason only when it is a machine token', () => {
    const err = spotifyFailure(403, upstreamError(403, 'PREMIUM_REQUIRED'), 'a1', command, null) as ProviderHttpError;
    expect(err.message).not.toContain('script');
    expect(JSON.stringify(err.toBody())).not.toContain('script');
    expect(err.providerReason).toBe('PREMIUM_REQUIRED');
    const odd = spotifyFailure(403, { error: { reason: '<b>odd</b>' } }, 'a1', command, null) as ProviderHttpError;
    expect(odd.providerReason).toBeNull();
    expect(spotifyFailure(500, 'plain text page', 'a1', read, null)).toMatchObject({ status: 502 });
  });
});
