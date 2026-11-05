/**
 * Music API client (§7 Music). The status is polled while the widget is visible (TanStack stops a
 * refetch interval in a hidden tab), and commands are optimistic (§10.7 #8): the widget changes at
 * once, and a refused command puts it back and says why.
 *
 * What is playing is the user's listening history: its queries are never written to the persisted
 * cache (`meta.persist`), so a new tab starts from the server, not from localStorage.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MUSIC_ERROR_REASONS, type MusicCommand, type MusicDevice, type MusicErrorReason, type MusicStatus } from '@portly/shared';
import { applyCommand, withLivePosition } from '../widgets/music/model.ts';
import { toastError } from '../ui/toast.ts';
import { apiGet, apiPost, isApiError } from './client.ts';
import { qk } from './keys.ts';

/** How often the status is asked for while something plays (the bar moves by itself in between). */
export const MUSIC_PLAYING_REFETCH_MS = 5_000;
/** Paused or nothing playing: long enough to stay quiet, short enough to notice a change. */
export const MUSIC_IDLE_REFETCH_MS = 15_000;
/** Spotify applies a command a moment after accepting it: reading sooner shows the old state. */
export const MUSIC_SETTLE_MS = 800;
export const MUSIC_DEVICES_REFETCH_MS = 15_000;

const SHORTEST_REFETCH_MS = 1_000;
/** Asks just after the item ends, to show the next one without waiting for the next poll. */
const AFTER_ITEM_END_MS = 500;

function pathWith(path: string, accountId: string | null): string {
  return accountId === null ? path : `${path}?${new URLSearchParams({ accountId }).toString()}`;
}

/** The `details.reason` of a music error, when it is one the widget treats on its own. */
export function musicErrorReason(error: unknown): MusicErrorReason | null {
  if (!isApiError(error)) return null;
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  return (MUSIC_ERROR_REASONS as readonly unknown[]).includes(reason) ? (reason as MusicErrorReason) : null;
}

/** Errors a poll cannot fix: asking again only repeats them. */
export function isMusicBlocked(error: unknown): boolean {
  return isApiError(error, 'not_configured') || isApiError(error, 'reauth_required') || isApiError(error, 'forbidden');
}

/** Milliseconds to the next status poll, or false to stop polling. */
export function musicRefetchMs(status: MusicStatus | undefined, error: unknown): number | false {
  if (isMusicBlocked(error)) return false;
  if (isApiError(error, 'rate_limited')) {
    const seconds = (error.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
    return typeof seconds === 'number' ? Math.max(seconds * 1000, MUSIC_IDLE_REFETCH_MS) : MUSIC_IDLE_REFETCH_MS;
  }
  const playback = status?.playback;
  if (!playback?.isPlaying) return MUSIC_IDLE_REFETCH_MS;
  const left = playback.item === null ? MUSIC_PLAYING_REFETCH_MS : playback.item.durationMs - playback.positionMs + AFTER_ITEM_END_MS;
  return Math.max(SHORTEST_REFETCH_MS, Math.min(MUSIC_PLAYING_REFETCH_MS, left));
}

export function useMusicStatus(accountId: string | null) {
  return useQuery({
    queryKey: qk.music.status(accountId),
    queryFn: ({ signal }) => apiGet<MusicStatus>(pathWith('/api/music/status', accountId), { signal }),
    staleTime: 2_000,
    refetchInterval: (query) => musicRefetchMs(query.state.data, query.state.error),
    meta: { persist: false },
  });
}

/** The devices that can play. Only asked for while `enabled` (the picker is open, or nothing plays). */
export function useMusicDevices(accountId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: qk.music.devices(accountId),
    queryFn: ({ signal }) => apiGet<MusicDevice[]>(pathWith('/api/music/devices', accountId), { signal }),
    enabled,
    staleTime: 2_000,
    refetchInterval: enabled ? MUSIC_DEVICES_REFETCH_MS : false,
    meta: { persist: false },
  });
}

export function useMusicCommand(accountId: string | null) {
  const client = useQueryClient();
  const key = qk.music.status(accountId);
  return useMutation({
    mutationFn: (command: MusicCommand) => apiPost<void>('/api/music/command', { ...(accountId === null ? {} : { accountId }), command }),
    onMutate: async (command) => {
      await client.cancelQueries({ queryKey: key });
      const state = client.getQueryState<MusicStatus>(key);
      // Restoring this after a refusal restarts the bar's clock too, so it must be up to date as well.
      const previous = state?.data === undefined ? undefined : withLivePosition(state.data, state.dataUpdatedAt, Date.now());
      if (previous) client.setQueryData<MusicStatus>(key, applyCommand(previous, command));
      return { previous };
    },
    onError: (error, _command, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
      toastError(error, 'That did not work. Try again.');
    },
    onSettled: () => {
      setTimeout(() => void client.invalidateQueries({ queryKey: qk.music.all() }), MUSIC_SETTLE_MS);
    },
  });
}
