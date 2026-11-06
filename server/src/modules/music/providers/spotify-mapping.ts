/**
 * Spotify's player API → the shared music contracts (§8 Spotify). Pure: no network, no server or
 * browser imports, so web/src/static/providers/spotifyMapping.ts is a byte-identical copy (a test
 * checks). Callers bring the transport and turn a {@link SpotifyRefusal} into their own API error:
 * `spotify.ts` beside this file on the server, `spotifyClient.ts` beside the copy in the browser.
 *
 * - `GET /me/player?additional_types=track,episode`: 204 (or an empty 200) means nothing is active.
 * - Commands answer 2xx with an empty body; Spotify does not promise the order or the instant they
 *   take effect, so nobody reads back straight after one.
 * - Errors are `{error: {status, message, reason}}`. Only `reason` is read, and only when it looks
 *   like a token; `message` is never shown. The reference does not list the answers for "no active
 *   device" or "not Premium", so both the reason and the status are used, and anything else a
 *   command is refused with counts as `not_allowed`. These mappings are not yet confirmed against
 *   a real account (docs/ROADMAP.md, "Checks never run for real").
 * - Everything from Spotify is hostile input (§4.4): text is cut and cleaned, cover art must come
 *   from {@link SPOTIFY_ARTWORK_ORIGIN} (the only host the page's CSP allows, the sports logo rule)
 *   and links from {@link SPOTIFY_LINK_ORIGIN}. An unusable item is dropped, not an error.
 */
import type { ErrorCode, MusicAllowedActions, MusicCommand, MusicDevice, MusicDeviceType, MusicErrorReason, MusicFeatures, MusicItem, MusicPlayback, MusicRepeatMode } from '@portly/shared';
import { z } from 'zod';

export const SPOTIFY_API = 'https://api.spotify.com/v1';
export const SPOTIFY_ARTWORK_ORIGIN = 'https://i.scdn.co/';
export const SPOTIFY_LINK_ORIGIN = 'https://open.spotify.com/';
export const SPOTIFY_NAME = 'Spotify';
export const SPOTIFY_FEATURES: MusicFeatures = Object.freeze({ seek: true, volume: true, shuffle: true, repeat: true, devices: true });
/** A status poll must not hang a widget for long: the next poll asks again. */
export const SPOTIFY_CALL_TIMEOUT_MS = 8_000;

const MAX_TEXT = 300;
const MAX_ARTISTS = 12;
const MAX_DEVICES = 50;
/** Spotify's art comes in 640, 300 and 64 px: 300 stays sharp at the widget's largest size. */
const PREFERRED_ART_PX = 300;

const REASON_TOKEN = /^[A-Z][A-Z0-9_]{0,63}$/;

const ImageSchema = z.looseObject({ url: z.string(), width: z.number().nullish() });
const ImagesSchema = z.array(ImageSchema);

const ItemSchema = z.looseObject({
  type: z.string().nullish(),
  name: z.string().nullish(),
  duration_ms: z.number().nullish(),
  artists: z.array(z.looseObject({ name: z.string().nullish() })).nullish(),
  album: z.looseObject({ name: z.string().nullish(), images: ImagesSchema.nullish() }).nullish(),
  show: z.looseObject({ name: z.string().nullish(), images: ImagesSchema.nullish() }).nullish(),
  images: ImagesSchema.nullish(),
  external_urls: z.looseObject({ spotify: z.string().nullish() }).nullish(),
});

const DeviceSchema = z.looseObject({
  id: z.string().nullish(),
  is_active: z.boolean().nullish(),
  is_restricted: z.boolean().nullish(),
  name: z.string().nullish(),
  type: z.string().nullish(),
  volume_percent: z.number().nullish(),
  supports_volume: z.boolean().nullish(),
});

/**
 * Every field may be missing or odd: one bad field must not turn a playing state into "nothing is
 * playing", so each falls back on its own (`mapDevice` and `mapItem` judge theirs).
 */
const PlaybackSchema = z.looseObject({
  device: z.unknown().optional(),
  repeat_state: z.string().nullish().catch(null),
  shuffle_state: z.boolean().nullish().catch(null),
  progress_ms: z.number().nullish().catch(null),
  is_playing: z.boolean().nullish().catch(null),
  item: z.unknown().optional(),
  actions: z.unknown().optional(),
});

const DevicesSchema = z.looseObject({ devices: z.array(z.unknown()) });

/** Printable text, cut to length; null when nothing is left. */
function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT);
  return text === '' ? null : text;
}

function whole(value: number | null | undefined, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function linkOf(url: string | null | undefined): string | null {
  return typeof url === 'string' && url.startsWith(SPOTIFY_LINK_ORIGIN) && url.length <= 512 ? url : null;
}

/** The image closest above the preferred size (else the largest), from Spotify's art host only. */
export function pickArtwork(images: readonly { url: string; width?: number | null | undefined }[] | null | undefined): string | null {
  const usable = (images ?? []).filter((image) => image.url.startsWith(SPOTIFY_ARTWORK_ORIGIN) && image.url.length <= 512);
  const bySize = [...usable].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (bySize.find((image) => (image.width ?? 0) >= PREFERRED_ART_PX) ?? bySize.at(-1))?.url ?? null;
}

export function mapItem(raw: unknown): MusicItem | null {
  const parsed = ItemSchema.safeParse(raw);
  if (!parsed.success) return null;
  const item = parsed.data;
  const title = cleanText(item.name);
  if (title === null) return null;
  const durationMs = whole(item.duration_ms, 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const url = linkOf(item.external_urls?.spotify);
  if (item.type === 'episode') {
    const show = cleanText(item.show?.name);
    return {
      kind: 'episode',
      title,
      artists: show === null ? [] : [show],
      album: null,
      durationMs,
      artworkUrl: pickArtwork(item.images ?? item.show?.images),
      url,
    };
  }
  return {
    kind: 'track',
    title,
    artists: (item.artists ?? []).flatMap((a) => cleanText(a.name) ?? []).slice(0, MAX_ARTISTS),
    album: cleanText(item.album?.name),
    durationMs,
    artworkUrl: pickArtwork(item.album?.images),
    url,
  };
}

const DEVICE_TYPES: Readonly<Record<string, MusicDeviceType>> = Object.freeze({
  computer: 'computer',
  smartphone: 'phone',
  tablet: 'phone',
  speaker: 'speaker',
  avr: 'speaker',
  audiodongle: 'speaker',
  castaudio: 'speaker',
  automobile: 'speaker',
  tv: 'tv',
  stb: 'tv',
  castvideo: 'tv',
  gameconsole: 'tv',
});

export function mapDevice(raw: unknown): MusicDevice | null {
  const parsed = DeviceSchema.safeParse(raw);
  if (!parsed.success) return null;
  const device = parsed.data;
  const id = typeof device.id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(device.id) ? device.id : null;
  return {
    id,
    name: cleanText(device.name) ?? 'Unnamed device',
    type: DEVICE_TYPES[device.type?.toLowerCase() ?? ''] ?? 'other',
    active: device.is_active === true,
    restricted: device.is_restricted === true,
    // `supports_volume` is newer than `volume_percent`: only a stated false rules the volume out.
    volumePercent: device.supports_volume === false ? null : whole(device.volume_percent, 0, 100),
  };
}

/** Maps `GET /me/player/devices`: the devices that can be picked, none when the body is not a list. */
export function mapDevices(data: unknown): MusicDevice[] {
  const parsed = DevicesSchema.safeParse(data);
  if (!parsed.success) return [];
  return parsed.data.devices
    .flatMap((raw) => mapDevice(raw) ?? [])
    .filter((device) => device.id !== null)
    .slice(0, MAX_DEVICES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `actions.disallows` as answers show it, or the flags directly under `actions` as the reference
 * shows them. `true` means not allowed, in both.
 */
export function mapAllowed(actions: unknown, restricted: boolean): MusicAllowedActions {
  const outer = isRecord(actions) ? actions : {};
  const flags = isRecord(outer.disallows) ? outer.disallows : outer;
  const allowed = (...names: string[]): boolean => !restricted && !names.some((name) => flags[name] === true);
  return {
    pause: allowed('pausing'),
    resume: allowed('resuming'),
    next: allowed('skipping_next'),
    previous: allowed('skipping_prev'),
    seek: allowed('seeking'),
    shuffle: allowed('toggling_shuffle'),
    repeat: allowed('toggling_repeat_context', 'toggling_repeat_track'),
  };
}

function repeatMode(value: string | null | undefined): MusicRepeatMode {
  return value === 'context' || value === 'track' ? value : 'off';
}

/** Maps `GET /me/player`; null when the body is no playback state at all. */
export function mapPlayback(raw: unknown): MusicPlayback | null {
  const parsed = PlaybackSchema.safeParse(raw);
  if (!parsed.success) return null;
  const state = parsed.data;
  const device = mapDevice(state.device);
  return {
    isPlaying: state.is_playing === true,
    positionMs: whole(state.progress_ms, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    item: mapItem(state.item),
    device,
    shuffle: state.shuffle_state === true,
    repeat: repeatMode(state.repeat_state),
    allowed: mapAllowed(state.actions, device?.restricted === true),
  };
}

export interface SpotifyCall {
  method: 'GET' | 'PUT' | 'POST';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  kind: 'read' | 'command';
  /** A 404 means the named device is gone, not that nothing is active. */
  namesDevice?: boolean;
  purpose: string;
}

export const PLAYBACK_CALL: SpotifyCall = Object.freeze({
  method: 'GET',
  path: '/me/player',
  query: { additional_types: 'track,episode' },
  kind: 'read',
  purpose: 'spotify.player.state',
});

export const DEVICES_CALL: SpotifyCall = Object.freeze({ method: 'GET', path: '/me/player/devices', kind: 'read', purpose: 'spotify.player.devices' });

/** The request of a command. */
export function commandCall(command: MusicCommand): SpotifyCall {
  const call = (method: SpotifyCall['method'], path: string, rest: Partial<SpotifyCall> = {}): SpotifyCall => ({
    method,
    path: `/me/player${path}`,
    kind: 'command',
    purpose: `spotify.player.${command.type}`,
    ...rest,
  });
  switch (command.type) {
    case 'play':
      return call('PUT', '/play');
    case 'pause':
      return call('PUT', '/pause');
    case 'next':
      return call('POST', '/next');
    case 'previous':
      return call('POST', '/previous');
    case 'seek':
      return call('PUT', '/seek', { query: { position_ms: String(command.positionMs) } });
    case 'volume':
      return call('PUT', '/volume', { query: { volume_percent: String(command.percent) } });
    case 'shuffle':
      return call('PUT', '/shuffle', { query: { state: String(command.on) } });
    case 'repeat':
      return call('PUT', '/repeat', { query: { state: command.mode } });
    case 'transfer':
      return call('PUT', '', { body: { device_ids: [command.deviceId], play: command.play }, namesDevice: true });
  }
}

/** The address of a call. */
export function spotifyUrl(call: Pick<SpotifyCall, 'path' | 'query'>): URL {
  const url = new URL(`${SPOTIFY_API}${call.path}`);
  for (const [name, value] of Object.entries(call.query ?? {})) url.searchParams.set(name, value);
  return url;
}

/** An answer's body; an empty one is null (commands, and "nothing is active"). */
export function parseSpotifyBody(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function spotifyReason(data: unknown): string | null {
  const error = isRecord(data) ? data.error : undefined;
  const reason = isRecord(error) ? error.reason : undefined;
  return typeof reason === 'string' && REASON_TOKEN.test(reason) ? reason : null;
}

export const SPOTIFY_MESSAGES = Object.freeze({
  rateLimited: `${SPOTIFY_NAME} is rate limiting requests; Portly will try again shortly`,
  premium: `${SPOTIFY_NAME} only lets Premium accounts control playback`,
  accessDenied: `${SPOTIFY_NAME} refused access. The Spotify app’s owner needs Premium, and this account must be on the app’s user list`,
  noDevice: `Nothing is active on your devices. Pick one, or open ${SPOTIFY_NAME} on it first`,
  deviceGone: 'That device is no longer available',
  notAllowed: `${SPOTIFY_NAME} refused that for what is playing right now`,
  timeout: `${SPOTIFY_NAME} did not respond in time`,
  tokenRejected: `${SPOTIFY_NAME} rejected the access token`,
  unreachable: `Could not reach ${SPOTIFY_NAME}`,
  unreadable: `${SPOTIFY_NAME} returned an unreadable response`,
});

/** What a refused call means (§7a): the caller makes it its own API error. 401 goes to the token retry first. */
export interface SpotifyRefusal {
  code: ErrorCode;
  message: string;
  /** Answers the widget treats on its own (`details.reason`). */
  reason?: MusicErrorReason;
  /** Spotify's own reason, when it looks like a token. */
  providerReason: string | null;
}

export function spotifyRefusal(status: number, data: unknown, call: Pick<SpotifyCall, 'kind' | 'namesDevice'>): SpotifyRefusal {
  const providerReason = spotifyReason(data);
  const refuse = (code: ErrorCode, message: string, reason?: MusicErrorReason): SpotifyRefusal => ({ code, message, providerReason, ...(reason === undefined ? {} : { reason }) });
  if (status === 429) return refuse('rate_limited', SPOTIFY_MESSAGES.rateLimited);
  if (providerReason === 'PREMIUM_REQUIRED') return refuse('forbidden', SPOTIFY_MESSAGES.premium, 'premium_required');
  if (providerReason === 'NO_ACTIVE_DEVICE') return refuse('conflict', SPOTIFY_MESSAGES.noDevice, 'no_active_device');
  if (status === 404) {
    if (call.namesDevice === true) return refuse('not_found', SPOTIFY_MESSAGES.deviceGone, 'device_unavailable');
    if (call.kind === 'command') return refuse('conflict', SPOTIFY_MESSAGES.noDevice, 'no_active_device');
  }
  if (status === 403) {
    return call.kind === 'command' ? refuse('conflict', SPOTIFY_MESSAGES.notAllowed, 'not_allowed') : refuse('forbidden', SPOTIFY_MESSAGES.accessDenied, 'access_denied');
  }
  if (status === 504 || status === 408) return refuse('upstream_timeout', SPOTIFY_MESSAGES.timeout);
  return refuse('provider_error', `${SPOTIFY_NAME} returned an error (${status})`);
}
