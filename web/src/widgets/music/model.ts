/** The music widget's pure logic (§10.8 Music): no React, no network. */
import type { MusicCommand, MusicItem, MusicPlayback, MusicRepeatMode, MusicStatus, PhonePlayback } from '@portly/shared';

/** The widget's height decides its layout. */
export type MusicTier = 'compact' | 'normal' | 'large';

export function musicTier(height: number): MusicTier {
  if (height <= 3) return 'compact';
  return height >= 6 ? 'large' : 'normal';
}

/** `3:07`, or `1:02:07` from an hour up. */
export function formatTime(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** Where playback is now, moved on from the last answer while playing, at the speed it plays. */
export function livePosition(positionMs: number, isPlaying: boolean, receivedAt: number, now: number, durationMs: number, speed = 1): number {
  const moved = isPlaying ? positionMs + Math.max(0, now - receivedAt) * speed : positionMs;
  return Math.min(moved, Math.max(durationMs, 0));
}

/**
 * Whether the widget shows the phone rather than the music service (design 6): whichever is playing,
 * and if both are, the one that started last. If neither is, the phone: its pause lasts 15 minutes,
 * and a paused Spotify session can sit there for hours. Spotify gives no start time, so its item's
 * is worked out from the position. That makes a new song count as starting, and a resumed one not.
 */
export function phoneIsShown(phone: PhonePlayback, provider: MusicPlayback | null, providerReceivedAt: number): boolean {
  if (provider === null) return true;
  const phonePlaying = phone.state === 'playing';
  if (phonePlaying !== provider.isPlaying) return phonePlaying;
  return !phonePlaying || Date.parse(phone.startedAt) >= providerReceivedAt - provider.positionMs;
}

/** The phone's episode in the shape the player's parts take. A report carries no art and no link. */
export function phoneItem(phone: PhonePlayback): MusicItem {
  return { kind: 'episode', title: phone.title, artists: phone.show === null ? [] : [phone.show], album: null, durationMs: phone.durationMs ?? 0, artworkUrl: null, url: null };
}

/**
 * The status with its position brought up to `now`. An optimistic update restarts the clock the bar
 * counts from (`dataUpdatedAt`), so without this every press would throw the bar back to the last poll.
 */
export function withLivePosition(status: MusicStatus, receivedAt: number, now: number): MusicStatus {
  const { playback } = status;
  if (playback === null || playback.item === null) return status;
  const positionMs = livePosition(playback.positionMs, playback.isPlaying, receivedAt, now, playback.item.durationMs);
  return positionMs === playback.positionMs ? status : { ...status, playback: { ...playback, positionMs } };
}

/** The next repeat mode, in the order Spotify's own apps cycle through them. */
export function nextRepeatMode(mode: MusicRepeatMode): MusicRepeatMode {
  if (mode === 'off') return 'context';
  return mode === 'context' ? 'track' : 'off';
}

export function repeatLabel(mode: MusicRepeatMode): string {
  if (mode === 'off') return 'Repeat is off';
  return mode === 'context' ? 'Repeating all' : 'Repeating this track';
}

export function artistLine(item: MusicItem): string {
  return item.artists.join(', ');
}

/** The status as it should look once `command` has taken effect (optimistic update, §10.7 #8). */
export function applyCommand(status: MusicStatus, command: MusicCommand): MusicStatus {
  const { playback } = status;
  if (playback === null) return status;
  const changed = (patch: Partial<typeof playback>): MusicStatus => ({ ...status, playback: { ...playback, ...patch } });
  switch (command.type) {
    case 'play':
      return changed({ isPlaying: true });
    case 'pause':
      return changed({ isPlaying: false });
    case 'seek':
      return changed({ positionMs: command.positionMs });
    case 'volume':
      return playback.device === null ? status : changed({ device: { ...playback.device, volumePercent: command.percent } });
    case 'shuffle':
      return changed({ shuffle: command.on });
    case 'repeat':
      return changed({ repeat: command.mode });
    // Skipping and moving to another device: only the provider knows what comes next.
    case 'next':
    case 'previous':
    case 'transfer':
      return status;
  }
}
