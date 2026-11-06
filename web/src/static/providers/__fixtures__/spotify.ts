/**
 * Spotify fixtures for static-backend tests: token answers, the profile and player answers as the
 * reference documents them, with invented content (the static counterpart of
 * server/src/modules/music/__fixtures__/spotify.ts). All credentials here are fake test values. The
 * error bodies for "no device" and "not Premium" have not been seen from a real account yet
 * (docs/ROADMAP.md, "Checks never run for real").
 */
import { SPOTIFY_PROFILE_ENDPOINT, SPOTIFY_TOKEN_ENDPOINT } from '../spotifyAuth.ts';
import type { FakeFetchRoute, FakeResponseSpec } from './fakeFetch.ts';

export const SPOTIFY_CLIENT_ID = '0123456789abcdef0123456789abcdef';
export const SPOTIFY_GRANT_SCOPE = 'user-read-playback-state user-modify-playback-state';
export const SPOTIFY_SUBJECT = 'acct-harbor-listener';
export const PLAYER = 'https://api.spotify.com/v1/me/player';
export const TITLE = 'Harbor Lights at Dawn';

export function spotifyGrant(fields: Record<string, unknown> = {}): FakeResponseSpec {
  return { status: 200, json: { token_type: 'Bearer', expires_in: 3600, access_token: 'AT1', refresh_token: 'RT1', scope: SPOTIFY_GRANT_SCOPE, ...fields } };
}

export function spotifyProfile(fields: Record<string, unknown> = {}): FakeResponseSpec {
  return { status: 200, json: { id: 'harbor-listener', account_id: SPOTIFY_SUBJECT, display_name: 'Harbor Listener', ...fields } };
}

export const tokenRoute = (respond: FakeFetchRoute['respond'], times?: number): FakeFetchRoute => ({
  match: SPOTIFY_TOKEN_ENDPOINT,
  method: 'POST',
  respond,
  ...(times === undefined ? {} : { times }),
});

export const profileRoute = (respond: FakeFetchRoute['respond'], times?: number): FakeFetchRoute => ({
  match: /api\.spotify\.com\/v1\/me$/,
  method: 'GET',
  respond,
  ...(times === undefined ? {} : { times }),
});

export const playerDevice = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'device-desk-01',
  is_active: true,
  is_restricted: false,
  name: 'Desk PC',
  type: 'Computer',
  volume_percent: 40,
  supports_volume: true,
  ...patch,
});

export const playerState = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  device: playerDevice(),
  repeat_state: 'off',
  shuffle_state: false,
  progress_ms: 30_000,
  is_playing: true,
  item: {
    type: 'track',
    name: TITLE,
    duration_ms: 200_000,
    artists: [{ name: 'The Paper Lanterns' }],
    album: { name: 'Tide Tables', images: [{ url: 'https://i.scdn.co/image/medium', width: 300, height: 300 }] },
    external_urls: { spotify: 'https://open.spotify.com/track/abc123' },
  },
  actions: { disallows: { resuming: true } },
  ...patch,
});

export const playerError = (status: number, reason?: string, headers: Record<string, string> = {}): FakeResponseSpec => ({
  status,
  headers,
  json: { error: { status, message: '<script>alert(1)</script> Player command failed', ...(reason === undefined ? {} : { reason }) } },
});

export { SPOTIFY_PROFILE_ENDPOINT, SPOTIFY_TOKEN_ENDPOINT };
