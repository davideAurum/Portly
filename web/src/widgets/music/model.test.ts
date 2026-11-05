import { describe, expect, it } from 'vitest';
import type { MusicStatus } from '@portly/shared';
import { MUSIC_IDLE_REFETCH_MS, MUSIC_PLAYING_REFETCH_MS, isMusicBlocked, musicErrorReason, musicRefetchMs } from '../../api/music.ts';
import { ApiError } from '../../api/client.ts';
import { applyCommand, artistLine, formatTime, livePosition, musicTier, nextRepeatMode, repeatLabel, withLivePosition } from './model.ts';

const ITEM = { kind: 'track', title: 'A', artists: ['One', 'Two'], album: null, durationMs: 200_000, artworkUrl: null, url: null } as const;
const DEVICE = { id: 'd1', name: 'Desk', type: 'computer', active: true, restricted: false, volumePercent: 40 } as const;
const ALLOWED = { pause: true, resume: true, next: true, previous: true, seek: true, shuffle: true, repeat: true };
const STATUS: MusicStatus = {
  accountId: 'a1',
  provider: 'spotify',
  features: { seek: true, volume: true, shuffle: true, repeat: true, devices: true },
  playback: { isPlaying: true, positionMs: 10_000, item: { ...ITEM, artists: [...ITEM.artists] }, device: { ...DEVICE }, shuffle: false, repeat: 'off', allowed: ALLOWED },
};

describe('music model', () => {
  it('picks a layout by height', () => {
    expect([2, 3, 4, 5, 6, 9].map(musicTier)).toEqual(['compact', 'compact', 'normal', 'normal', 'large', 'large']);
  });

  it('formats times', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(9_400)).toBe('0:09');
    expect(formatTime(187_000)).toBe('3:07');
    expect(formatTime(3_727_000)).toBe('1:02:07');
    expect(formatTime(-5)).toBe('0:00');
  });

  it('moves a playing position on, up to the end of the item', () => {
    expect(livePosition(10_000, true, 1_000, 3_500, 200_000)).toBe(12_500);
    expect(livePosition(10_000, false, 1_000, 3_500, 200_000)).toBe(10_000);
    expect(livePosition(199_000, true, 1_000, 9_000, 200_000)).toBe(200_000);
    expect(livePosition(10_000, true, 5_000, 1_000, 200_000)).toBe(10_000);
  });

  it('brings a status up to now, so an optimistic update cannot throw the bar back', () => {
    expect(withLivePosition(STATUS, 1_000, 4_000).playback?.positionMs).toBe(13_000);
    const paused: MusicStatus = { ...STATUS, playback: { ...STATUS.playback!, isPlaying: false } };
    expect(withLivePosition(paused, 1_000, 4_000)).toBe(paused);
    const idle: MusicStatus = { ...STATUS, playback: null };
    expect(withLivePosition(idle, 1_000, 4_000)).toBe(idle);
    const noItem: MusicStatus = { ...STATUS, playback: { ...STATUS.playback!, item: null } };
    expect(withLivePosition(noItem, 1_000, 4_000)).toBe(noItem);
  });

  it('cycles repeat modes', () => {
    expect(nextRepeatMode('off')).toBe('context');
    expect(nextRepeatMode('context')).toBe('track');
    expect(nextRepeatMode('track')).toBe('off');
    expect(repeatLabel('track')).toBe('Repeating this track');
  });

  it('joins artists', () => {
    expect(artistLine(STATUS.playback!.item!)).toBe('One, Two');
  });

  describe('optimistic updates', () => {
    it.each([
      [{ type: 'pause' } as const, { isPlaying: false }],
      [{ type: 'seek', positionMs: 5_000 } as const, { positionMs: 5_000 }],
      [{ type: 'shuffle', on: true } as const, { shuffle: true }],
      [{ type: 'repeat', mode: 'track' } as const, { repeat: 'track' }],
    ])('%j', (command, expected) => {
      expect(applyCommand(STATUS, command).playback).toMatchObject(expected);
    });

    it('play turns a paused state on, and volume changes the device', () => {
      const paused: MusicStatus = { ...STATUS, playback: { ...STATUS.playback!, isPlaying: false } };
      expect(applyCommand(paused, { type: 'play' }).playback?.isPlaying).toBe(true);
      expect(applyCommand(STATUS, { type: 'volume', percent: 75 }).playback?.device?.volumePercent).toBe(75);
    });

    it('guesses nothing about what comes next', () => {
      for (const command of [{ type: 'next' }, { type: 'previous' }, { type: 'transfer', deviceId: 'x', play: true }] as const) {
        expect(applyCommand(STATUS, command)).toBe(STATUS);
      }
    });

    it('leaves nothing-playing alone, and a volume without a device', () => {
      const idle: MusicStatus = { ...STATUS, playback: null };
      expect(applyCommand(idle, { type: 'play' })).toBe(idle);
      const noDevice: MusicStatus = { ...STATUS, playback: { ...STATUS.playback!, device: null } };
      expect(applyCommand(noDevice, { type: 'volume', percent: 10 })).toBe(noDevice);
    });

    it('does not change the status it was given (the rollback needs it)', () => {
      const before = JSON.stringify(STATUS);
      applyCommand(STATUS, { type: 'volume', percent: 1 });
      expect(JSON.stringify(STATUS)).toBe(before);
    });
  });
});

describe('music polling', () => {
  const api = (status: number, code: string, details?: unknown) => new ApiError(status, code as 'conflict', 'x', details);

  it('polls often while playing, rarely otherwise', () => {
    expect(musicRefetchMs(STATUS, null)).toBe(MUSIC_PLAYING_REFETCH_MS);
    expect(musicRefetchMs({ ...STATUS, playback: null }, null)).toBe(MUSIC_IDLE_REFETCH_MS);
    expect(musicRefetchMs({ ...STATUS, playback: { ...STATUS.playback!, isPlaying: false } }, null)).toBe(MUSIC_IDLE_REFETCH_MS);
    expect(musicRefetchMs(undefined, null)).toBe(MUSIC_IDLE_REFETCH_MS);
  });

  it('asks just after the item ends, to show the next one', () => {
    const nearTheEnd: MusicStatus = { ...STATUS, playback: { ...STATUS.playback!, positionMs: 198_000 } };
    expect(musicRefetchMs(nearTheEnd, null)).toBe(2_500);
    const atTheEnd: MusicStatus = { ...STATUS, playback: { ...STATUS.playback!, positionMs: 200_000 } };
    expect(musicRefetchMs(atTheEnd, null)).toBe(1_000);
  });

  it('stops for what a poll cannot fix', () => {
    expect(musicRefetchMs(STATUS, api(409, 'not_configured'))).toBe(false);
    expect(musicRefetchMs(STATUS, api(409, 'reauth_required'))).toBe(false);
    expect(musicRefetchMs(STATUS, api(403, 'forbidden'))).toBe(false);
    expect(isMusicBlocked(api(502, 'provider_error'))).toBe(false);
  });

  it('waits out a rate limit, never faster than the idle poll', () => {
    expect(musicRefetchMs(STATUS, api(429, 'rate_limited', { retryAfterSeconds: 120 }))).toBe(120_000);
    expect(musicRefetchMs(STATUS, api(429, 'rate_limited', { retryAfterSeconds: 2 }))).toBe(MUSIC_IDLE_REFETCH_MS);
    expect(musicRefetchMs(STATUS, api(429, 'rate_limited'))).toBe(MUSIC_IDLE_REFETCH_MS);
  });

  it('keeps polling through a passing failure', () => {
    expect(musicRefetchMs(STATUS, api(502, 'provider_error'))).toBe(MUSIC_PLAYING_REFETCH_MS);
  });

  it('reads the reasons it knows, and only those', () => {
    expect(musicErrorReason(api(409, 'conflict', { reason: 'no_active_device' }))).toBe('no_active_device');
    expect(musicErrorReason(api(409, 'conflict', { reason: 'made_up' }))).toBeNull();
    expect(musicErrorReason(new Error('x'))).toBeNull();
  });
});
