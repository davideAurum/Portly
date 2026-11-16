/**
 * Music module of the static backend (port of server/src/modules/music): the browser is the remote
 * control, calling Spotify itself with the account's token (`providers/spotifyClient.ts`). Same
 * routes and shapes as the server, so the widget cannot tell them apart:
 *
 * - `GET /api/music/status?accountId=` → `MusicStatus`
 * - `GET /api/music/devices?accountId=` → `MusicDevice[]`
 * - `POST /api/music/command {accountId?, command}` → 204
 * - `GET /api/music/phone` → `null`: a phone reports to a Portly server, and there is none behind this
 *
 * - **Per page, not shared.** The server's cache serves every tab; here each tab keeps its own, for
 *   {@link MUSIC_STATUS_TTL_MS}, which is what several Music widgets on one page share. Only a
 *   visible tab polls (TanStack stops a refetch interval in a hidden one), so this costs little.
 * - **Rate limits.** A 429 starts a cooldown for this page in which nothing is sent: the widget gets
 *   429 with `retryAfterSeconds` and waits that long.
 * - **Memory only.** Titles and artists stay in this cache and leave with the page: not in
 *   IndexedDB, not in a diagnostic event.
 * - **Health.** Failures are this browser's `provider` events (ARCHITECTURE §17).
 */
import { MusicCommandRequestSchema, MusicQuerySchema, type MusicDevice, type MusicPlayback, type MusicStatus } from '@portly/shared';
import type { StaticContext } from '../context.ts';
import { createMemoryCache, type MemoryCache } from '../lib/cache.ts';
import { parseJsonBody, parseQuery } from '../lib/validate.ts';
import { SpotifyHttpError, spotifyDevices, spotifyPlayback, spotifySend } from '../providers/spotifyClient.ts';
import { SPOTIFY_FEATURES, SPOTIFY_MESSAGES } from '../providers/spotifyMapping.ts';
import { StaticApiError, json, noContent } from '../respond.ts';
import type { StaticRouter } from '../router.ts';
import type { StoredAccount } from '../slices.ts';
import { musicAccounts } from './accounts.ts';

/** How long one upstream answer serves this page. Shorter than the widget's poll. */
export const MUSIC_STATUS_TTL_MS = 3_000;
export const MUSIC_DEVICES_TTL_MS = 5_000;

const CACHE_PREFIX = 'music:';

interface Snapshot {
  playback: MusicPlayback | null;
  /** Epoch ms of the upstream answer. */
  at: number;
}

interface PageState {
  cache: MemoryCache;
  /** Bumped by a command, so a read already on its way cannot bring back the state from before it. */
  generations: Map<string, number>;
  /** Epoch ms until which nothing is sent to the provider for this account. */
  cooldowns: Map<string, number>;
}

const pages = new WeakMap<StaticContext, PageState>();

function pageState(ctx: StaticContext): PageState {
  let state = pages.get(ctx);
  if (!state) {
    state = { cache: createMemoryCache({ now: ctx.now }), generations: new Map(), cooldowns: new Map() };
    pages.set(ctx, state);
  }
  return state;
}

function generation(page: PageState, accountId: string): number {
  return page.generations.get(accountId) ?? 0;
}

function invalidate(page: PageState, accountId: string): void {
  page.generations.set(accountId, generation(page, accountId) + 1);
  page.cache.delPrefix(`${CACHE_PREFIX}${accountId}:`);
}

/**
 * The named account, else the first with music switched on; 409 `no_account` when there is none.
 * A widget's saved account can be gone (removed and added again, a layout from another PC): the
 * widget then uses what is connected rather than say nothing is.
 */
function select(ctx: StaticContext, accountId: string | undefined): StoredAccount {
  const candidates = musicAccounts(ctx);
  const account = candidates.find((a) => a.id === accountId) ?? candidates[0];
  if (!account) throw new StaticApiError('not_configured', 'Connect a music service in Settings → Accounts', { reason: 'no_account' });
  return account;
}

function refuseDuringCooldown(ctx: StaticContext, page: PageState, accountId: string): void {
  const remainingMs = (page.cooldowns.get(accountId) ?? 0) - ctx.now();
  if (remainingMs <= 0) return;
  throw new StaticApiError('rate_limited', SPOTIFY_MESSAGES.rateLimited, { retryAfterSeconds: Math.ceil(remainingMs / 1000) }, accountId);
}

/** A 429 from the provider starts the cooldown; the caller rethrows `err`. */
function noteRateLimit(ctx: StaticContext, page: PageState, accountId: string, err: unknown): void {
  if (!(err instanceof SpotifyHttpError) || err.retryAfterSeconds === null) return;
  const until = ctx.now() + err.retryAfterSeconds * 1000;
  page.cooldowns.set(accountId, Math.max(until, page.cooldowns.get(accountId) ?? 0));
}

/** Runs one provider call for the account: refused during a cooldown, and a 429 starts one. */
async function guarded<T>(ctx: StaticContext, page: PageState, accountId: string, call: () => Promise<T>): Promise<T> {
  refuseDuringCooldown(ctx, page, accountId);
  try {
    return await call();
  } catch (err) {
    noteRateLimit(ctx, page, accountId, err);
    throw err;
  }
}

/** Playback as of now: a playing item has moved on since the cached answer. */
function live(ctx: StaticContext, snapshot: Snapshot): MusicPlayback | null {
  const { playback, at } = snapshot;
  if (playback === null || !playback.isPlaying) return playback;
  const moved = playback.positionMs + Math.max(0, ctx.now() - at);
  return { ...playback, positionMs: playback.item === null ? moved : Math.min(moved, playback.item.durationMs) };
}

async function status(ctx: StaticContext, accountId: string | undefined): Promise<MusicStatus> {
  const account = select(ctx, accountId);
  const page = pageState(ctx);
  const key = `${CACHE_PREFIX}${account.id}:status:${generation(page, account.id)}`;
  const snapshot =
    page.cache.get<Snapshot>(key) ??
    (await guarded(ctx, page, account.id, () =>
      page.cache.getOrSet<Snapshot>(key, MUSIC_STATUS_TTL_MS, async () => ({ playback: await spotifyPlayback(ctx, account.id), at: ctx.now() })),
    ));
  return { accountId: account.id, provider: 'spotify', features: SPOTIFY_FEATURES, playback: live(ctx, snapshot) };
}

async function devices(ctx: StaticContext, accountId: string | undefined): Promise<MusicDevice[]> {
  const account = select(ctx, accountId);
  const page = pageState(ctx);
  const key = `${CACHE_PREFIX}${account.id}:devices:${generation(page, account.id)}`;
  return page.cache.get<MusicDevice[]>(key) ?? guarded(ctx, page, account.id, () => page.cache.getOrSet(key, MUSIC_DEVICES_TTL_MS, () => spotifyDevices(ctx, account.id)));
}

export function register(router: StaticRouter): void {
  router.get('/api/music/status', async (ctx, { url }) => json(await status(ctx, parseQuery(url, MusicQuerySchema).accountId)));

  router.get('/api/music/devices', async (ctx, { url }) => json(await devices(ctx, parseQuery(url, MusicQuerySchema).accountId)));

  router.get('/api/music/phone', () => json(null));

  router.post('/api/music/command', async (ctx, { req }) => {
    const { accountId, command } = await parseJsonBody(req, MusicCommandRequestSchema);
    const account = select(ctx, accountId);
    const page = pageState(ctx);
    try {
      await guarded(ctx, page, account.id, () => spotifySend(ctx, account.id, command));
    } finally {
      // A refused command may still have changed something upstream: read it fresh either way.
      invalidate(page, account.id);
    }
    return noContent();
  });
}
