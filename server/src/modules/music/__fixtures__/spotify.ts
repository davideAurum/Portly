/**
 * Spotify Web API answers as the reference documents them, with invented content. The shapes of
 * error bodies for "no device" and "not Premium" come from Spotify's general error format: they
 * have not been seen from a real account yet (docs/ROADMAP.md, "Checks never run for real").
 */
export const API = 'https://api.spotify.com/v1';
export const TITLE = 'Harbor Lights at Dawn';

export const upstreamDevice = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'device-desk-01',
  is_active: true,
  is_private_session: false,
  is_restricted: false,
  name: 'Desk PC',
  type: 'Computer',
  volume_percent: 40,
  supports_volume: true,
  ...patch,
});

export const upstreamTrack = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'track',
  name: TITLE,
  duration_ms: 200_000,
  artists: [{ name: 'The Paper Lanterns' }, { name: 'Ada Example' }],
  album: {
    name: 'Tide Tables',
    images: [
      { url: 'https://i.scdn.co/image/large', width: 640, height: 640 },
      { url: 'https://i.scdn.co/image/medium', width: 300, height: 300 },
      { url: 'https://i.scdn.co/image/small', width: 64, height: 64 },
    ],
  },
  external_urls: { spotify: 'https://open.spotify.com/track/abc123' },
  ...patch,
});

export const upstreamEpisode = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'episode',
  name: 'Episode 12: Lighthouses',
  duration_ms: 1_800_000,
  images: [{ url: 'https://i.scdn.co/image/episode', width: 300, height: 300 }],
  show: { name: 'Coastal Notes', images: [{ url: 'https://i.scdn.co/image/show', width: 300, height: 300 }] },
  external_urls: { spotify: 'https://open.spotify.com/episode/ep1' },
  ...patch,
});

export const upstreamState = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  device: upstreamDevice(),
  repeat_state: 'off',
  shuffle_state: false,
  timestamp: 1_790_000_000_000,
  progress_ms: 30_000,
  is_playing: true,
  currently_playing_type: 'track',
  item: upstreamTrack(),
  actions: { disallows: { resuming: true } },
  ...patch,
});

export const upstreamError = (status: number, reason?: string): Record<string, unknown> => ({
  error: { status, message: '<script>alert(1)</script> Player command failed', ...(reason === undefined ? {} : { reason }) },
});
