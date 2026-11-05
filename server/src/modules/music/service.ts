/**
 * Music service (§7 Music, §10.8 Music): picks the account and its provider, keeps the polling cheap
 * and honest with the provider's rate limits, and records the connection's health.
 *
 * - **Shared status.** Every tab polls while it is visible, so the status is cached in memory for
 *   {@link MUSIC_STATUS_TTL_MS} and concurrent requests share one upstream call: ten tabs cost what
 *   one does. The position is moved on by the age of the cached answer. A command drops the cache
 *   through a generation in the key, so a request already on its way cannot bring back the state
 *   from before the command.
 * - **Rate limits.** A 429 starts a per-account cooldown (the provider's `Retry-After`) in which
 *   nothing is sent: the browser gets 429 with `Retry-After`, and the widget waits that long.
 * - **Memory only.** Titles and artists stay in `ctx.memo` (never the SQLite cache) and in no log.
 * - **Health** (§17, key `music:<accountId>`, on demand): a status read records the connection.
 *   Answers about what is playing (`no_active_device`, a refused command) say nothing about the
 *   connection and are not recorded; an account that needs reconnecting is `account_unavailable`,
 *   caused by `account:<id>`.
 */
import { isMusicProvider, type Account, type MusicCommand, type MusicCommandRequest, type MusicDevice, type MusicPlayback, type MusicProviderKind, type MusicQuery, type MusicStatus } from '@portly/shared';
import type { AppContext } from '../../context.ts';
import { HttpError } from '../../lib/errors.ts';
import { outcomeFromError, type HealthSubject, type Outcome } from '../../lib/health.ts';
import { withLogContext } from '../../lib/log-context.ts';
import { ProviderHttpError } from '../../lib/provider-errors.ts';
import { SafeFetchError } from '../../security/safe-fetch.ts';
import { createSpotifyProvider } from './providers/spotify.ts';
import type { MusicProvider } from './providers/types.ts';

/** How long one upstream status answer serves every tab. Shorter than the widget's poll. */
export const MUSIC_STATUS_TTL_MS = 3_000;
export const MUSIC_DEVICES_TTL_MS = 5_000;
/** Cooldown when a 429 does not say how long. */
export const MUSIC_DEFAULT_RETRY_AFTER_S = 30;

const MEMO_PREFIX = 'music:';

export function musicHealthKey(accountId: string): string {
  return `music:${accountId}`;
}

export interface MusicServiceOptions {
  /** Provider overrides (tests). */
  providers?: Partial<Record<MusicProviderKind, MusicProvider>>;
  now?: () => number;
}

export interface MusicService {
  status(query: MusicQuery): Promise<MusicStatus>;
  devices(query: MusicQuery): Promise<MusicDevice[]>;
  command(request: MusicCommandRequest): Promise<void>;
}

interface Snapshot {
  playback: MusicPlayback | null;
  /** Epoch ms of the upstream answer. */
  at: number;
}

type Selected = { account: Account; provider: MusicProvider };

function noAccount(): HttpError {
  return new HttpError(409, 'not_configured', { message: 'Connect a music service in Settings → Accounts', details: { reason: 'no_account' } });
}

/** The account's own subject says why: it waits for that (mail's rule, §17). */
function accountUnusable(err: unknown): boolean {
  return err instanceof HttpError && (err.code === 'reauth_required' || err.code === 'not_configured');
}

export function createMusicService(ctx: Pick<AppContext, 'accounts' | 'fetch' | 'memo' | 'health'>, options: MusicServiceOptions = {}): MusicService {
  const { accounts, memo, health } = ctx;
  const now = options.now ?? Date.now;
  const providers: Partial<Record<MusicProviderKind, MusicProvider>> = {
    spotify: createSpotifyProvider({ fetch: ctx.fetch, accounts }),
    ...options.providers,
  };

  const generations = new Map<string, number>();
  const generation = (accountId: string): number => generations.get(accountId) ?? 0;
  /** Epoch ms until which nothing is sent to the provider for this account. */
  const cooldowns = new Map<string, number>();

  const invalidate = (accountId: string): void => {
    generations.set(accountId, generation(accountId) + 1);
    memo.delPrefix(`${MEMO_PREFIX}${accountId}:`);
  };

  accounts.onChange((event) => {
    invalidate(event.accountId);
    if (event.type === 'deleted') {
      cooldowns.delete(event.accountId);
      generations.delete(event.accountId);
      health.forget(musicHealthKey(event.accountId));
    }
  });

  const subjectOf = (account: Account): HealthSubject => ({ key: musicHealthKey(account.id), area: 'music', accountId: account.id });

  /**
   * The named account, else the first with music switched on; 409 `no_account` when there is none.
   * A widget's saved account can be gone (removed and added again, a layout from another PC): the
   * widget then uses what is connected rather than say nothing is.
   */
  const select = (accountId: string | undefined): Selected => {
    const candidates = accounts.list({ capability: 'music' }).filter((a) => isMusicProvider(a.kind));
    const account = candidates.find((a) => a.id === accountId) ?? candidates[0];
    const provider = account !== undefined && isMusicProvider(account.kind) ? providers[account.kind] : undefined;
    if (account === undefined || provider === undefined) throw noAccount();
    return { account, provider };
  };

  const refuseDuringCooldown = (account: Account, provider: MusicProvider): void => {
    const until = cooldowns.get(account.id) ?? 0;
    const remainingMs = until - now();
    if (remainingMs <= 0) return;
    health.touch(subjectOf(account), { skipped: 'backoff', nextAttemptAt: until });
    const retryAfterSeconds = Math.ceil(remainingMs / 1000);
    throw new HttpError(429, 'rate_limited', {
      message: `${provider.displayName} is rate limiting requests; Portly will try again shortly`,
      accountId: account.id,
      details: { retryAfterSeconds },
    });
  };

  /** A 429 from the provider starts the cooldown; `err` is rethrown by the caller. */
  const noteRateLimit = (accountId: string, err: unknown): number | null => {
    if (!(err instanceof ProviderHttpError) || err.code !== 'rate_limited') return null;
    const until = now() + (err.retryAfterSeconds ?? MUSIC_DEFAULT_RETRY_AFTER_S) * 1000;
    cooldowns.set(accountId, Math.max(until, cooldowns.get(accountId) ?? 0));
    return until;
  };

  const failureOutcome = (err: unknown, account: Account, ms: number, nextAttemptAt: number | null): Outcome => {
    if (accountUnusable(err)) {
      return outcomeFromError(err, { code: 'account_unavailable', causeKey: `account:${account.id}`, severity: 'info', ms });
    }
    if (err instanceof HttpError && err.cause instanceof SafeFetchError) return outcomeFromError(err.cause, { message: err.message, ms });
    return outcomeFromError(err, { ms, nextAttemptAt });
  };

  /** One upstream read of the playback state. Recorded unless the account went away meanwhile. */
  const readPlayback = async ({ account, provider }: Selected): Promise<Snapshot> => {
    const startedAt = now();
    const stillThere = (): boolean => accounts.get(account.id) !== null;
    try {
      const playback = await provider.playback(account.id);
      if (stillThere()) health.record(subjectOf(account), { ok: true, ms: now() - startedAt });
      return { playback, at: now() };
    } catch (err) {
      const nextAttemptAt = noteRateLimit(account.id, err);
      if (stillThere()) health.record(subjectOf(account), failureOutcome(err, account, now() - startedAt, nextAttemptAt));
      throw err;
    }
  };

  /** Playback as of now: a playing item has moved on since the cached answer. */
  const live = (snapshot: Snapshot): MusicPlayback | null => {
    const { playback, at } = snapshot;
    if (playback === null || !playback.isPlaying) return playback;
    const moved = playback.positionMs + Math.max(0, now() - at);
    return { ...playback, positionMs: playback.item === null ? moved : Math.min(moved, playback.item.durationMs) };
  };

  const FEATURE_OF: Readonly<Partial<Record<MusicCommand['type'], keyof MusicProvider['features']>>> = Object.freeze({
    seek: 'seek',
    volume: 'volume',
    shuffle: 'shuffle',
    repeat: 'repeat',
    transfer: 'devices',
  });

  return {
    async status(query) {
      const selected = select(query.accountId);
      const { account, provider } = selected;
      return withLogContext({ area: 'music', op: 'status', accountId: account.id }, async () => {
        const key = `${MEMO_PREFIX}${account.id}:status:${generation(account.id)}`;
        const cached = memo.get<Snapshot>(key);
        if (cached === undefined) refuseDuringCooldown(account, provider);
        const snapshot = cached ?? (await memo.getOrSet(key, MUSIC_STATUS_TTL_MS, () => readPlayback(selected)));
        return { accountId: account.id, provider: account.kind as MusicProviderKind, features: provider.features, playback: live(snapshot) };
      });
    },

    async devices(query) {
      const { account, provider } = select(query.accountId);
      if (!provider.features.devices) return [];
      return withLogContext({ area: 'music', op: 'devices', accountId: account.id }, async () => {
        const key = `${MEMO_PREFIX}${account.id}:devices:${generation(account.id)}`;
        const cached = memo.get<MusicDevice[]>(key);
        if (cached !== undefined) return cached;
        refuseDuringCooldown(account, provider);
        try {
          return await memo.getOrSet(key, MUSIC_DEVICES_TTL_MS, () => provider.devices(account.id));
        } catch (err) {
          noteRateLimit(account.id, err);
          throw err;
        }
      });
    },

    async command({ accountId, command }) {
      const { account, provider } = select(accountId);
      const feature = FEATURE_OF[command.type];
      if (feature !== undefined && !provider.features[feature]) {
        throw new HttpError(422, 'validation_failed', `${provider.displayName} cannot do that`);
      }
      await withLogContext({ area: 'music', op: command.type, accountId: account.id }, async () => {
        refuseDuringCooldown(account, provider);
        try {
          await provider.send(account.id, command);
        } catch (err) {
          noteRateLimit(account.id, err);
          throw err;
        } finally {
          // A refused command may still have changed something upstream: read it fresh either way.
          invalidate(account.id);
        }
      });
    },
  };
}
