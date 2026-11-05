/**
 * Music contracts (§7 Music, §8 Spotify, §10.8 Music): one shape for every provider. The widget talks
 * to `/api/music/*` and never knows which service answers; a provider says what it can do through
 * {@link MusicFeatures}, and the widget hides the rest.
 *
 * Portly is a remote control: the sound plays on the user's own devices, in the provider's own
 * apps. Titles and artists are the user's listening history, so they are kept in memory only and
 * never logged (§17) or written to the browser's persisted query cache.
 */
import { z } from 'zod';
import type { AccountKind } from './accounts.ts';
import { EntityId } from './core.ts';

/** The account kinds that are music providers (each has a `MusicProvider` on the server). */
export const MUSIC_PROVIDERS = ['spotify'] as const satisfies readonly AccountKind[];
export type MusicProviderKind = (typeof MUSIC_PROVIDERS)[number];

export function isMusicProvider(kind: unknown): kind is MusicProviderKind {
  return typeof kind === 'string' && (MUSIC_PROVIDERS as readonly string[]).includes(kind);
}

export const MUSIC_DEVICE_TYPES = ['computer', 'phone', 'speaker', 'tv', 'other'] as const;
export type MusicDeviceType = (typeof MUSIC_DEVICE_TYPES)[number];

export interface MusicDevice {
  /** Null when the provider gives this device no id: it cannot be picked. */
  id: string | null;
  name: string;
  type: MusicDeviceType;
  /** Playback is on this device. */
  active: boolean;
  /** The device takes no remote commands at all. */
  restricted: boolean;
  /** 0–100; null when the device has no volume Portly can read or set. */
  volumePercent: number | null;
}

export const MUSIC_ITEM_KINDS = ['track', 'episode'] as const;
export type MusicItemKind = (typeof MUSIC_ITEM_KINDS)[number];

export interface MusicItem {
  kind: MusicItemKind;
  title: string;
  /** The artists of a track, the show of an episode. */
  artists: string[];
  /** The album of a track; null for an episode. */
  album: string | null;
  durationMs: number;
  /** Cover art, from the one image host the page's CSP allows; null shows a placeholder. */
  artworkUrl: string | null;
  /** The item on the provider's own site; null for an item that has no page (a local file). */
  url: string | null;
}

export const MUSIC_REPEAT_MODES = ['off', 'context', 'track'] as const;
export const MusicRepeatModeSchema = z.enum(MUSIC_REPEAT_MODES);
export type MusicRepeatMode = z.output<typeof MusicRepeatModeSchema>;

/** What the provider allows right now, for what is playing on this device. */
export interface MusicAllowedActions {
  pause: boolean;
  resume: boolean;
  next: boolean;
  previous: boolean;
  seek: boolean;
  shuffle: boolean;
  repeat: boolean;
}

export interface MusicPlayback {
  isPlaying: boolean;
  /** Where playback is at the moment of this answer. */
  positionMs: number;
  /** Null while no item can be shown (an advert, a private session). */
  item: MusicItem | null;
  device: MusicDevice | null;
  shuffle: boolean;
  repeat: MusicRepeatMode;
  allowed: MusicAllowedActions;
}

/** What a provider can do at all (the widget hides what its provider cannot). */
export interface MusicFeatures {
  seek: boolean;
  volume: boolean;
  shuffle: boolean;
  repeat: boolean;
  /** Listing devices and moving playback between them. */
  devices: boolean;
}

/** `GET /api/music/status[?accountId=]` */
export interface MusicStatus {
  accountId: string;
  provider: MusicProviderKind;
  features: MusicFeatures;
  /** Null when nothing is active on any device. */
  playback: MusicPlayback | null;
}

/** `?accountId=` of the read routes. Absent, or an account that is gone: the first with music switched on. */
export const MusicQuerySchema = z.object({ accountId: EntityId.optional() });
export type MusicQuery = z.output<typeof MusicQuerySchema>;

/** The longest seek accepted (a day); a provider refuses past the end of the item by itself. */
export const MUSIC_MAX_POSITION_MS = 24 * 60 * 60 * 1000;

/** Provider device ids are opaque; this only keeps them short and printable. */
export const MusicDeviceIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

export const MusicCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('play') }).strict(),
  z.object({ type: z.literal('pause') }).strict(),
  z.object({ type: z.literal('next') }).strict(),
  z.object({ type: z.literal('previous') }).strict(),
  z.object({ type: z.literal('seek'), positionMs: z.number().int().min(0).max(MUSIC_MAX_POSITION_MS) }).strict(),
  z.object({ type: z.literal('volume'), percent: z.number().int().min(0).max(100) }).strict(),
  z.object({ type: z.literal('shuffle'), on: z.boolean() }).strict(),
  z.object({ type: z.literal('repeat'), mode: MusicRepeatModeSchema }).strict(),
  z.object({ type: z.literal('transfer'), deviceId: MusicDeviceIdSchema, play: z.boolean() }).strict(),
]);
export type MusicCommand = z.output<typeof MusicCommandSchema>;

/** `POST /api/music/command {accountId?, command}` → 204 */
export const MusicCommandRequestSchema = z.object({ accountId: EntityId.optional(), command: MusicCommandSchema }).strict();
export type MusicCommandRequest = z.output<typeof MusicCommandRequestSchema>;

/**
 * `error.details.reason` of the answers the widget treats on its own:
 * - `no_account` (409 `not_configured`): no account with music switched on;
 * - `premium_required` (403 `forbidden`): the provider controls playback for paying accounts only;
 * - `access_denied` (403 `forbidden`): the provider refuses this app or account altogether;
 * - `no_active_device` (409 `conflict`): nothing to send the command to, pick a device;
 * - `device_unavailable` (404 `not_found`): the picked device is gone;
 * - `not_allowed` (409 `conflict`): the provider refused this command for what is playing.
 */
export const MUSIC_ERROR_REASONS = ['no_account', 'premium_required', 'access_denied', 'no_active_device', 'device_unavailable', 'not_allowed'] as const;
export type MusicErrorReason = (typeof MUSIC_ERROR_REASONS)[number];
