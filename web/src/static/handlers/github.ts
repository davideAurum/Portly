/**
 * GitHub status board of the static backend (port of server/src/modules/github/index.ts): the
 * browser asks api.github.com directly with the read-only token kept in the `github-status-token`
 * slice (this browser only; never exported, never returned). Not launch pad sync, whose
 * repository and token live under `/api/sync/github` (`githubSync.ts`).
 *
 * Routes:
 * - `GET    /api/github/token`  → `{configured}` (the token is never returned)
 * - `PUT    /api/github/token {token}` → `{configured: true}`; the shape is checked, then GitHub is
 *                                 asked for one repository, before it is stored
 * - `DELETE /api/github/token`  → `{configured: false}`
 * - `GET    /api/github/repos`  → `GitHubBoard` (in-memory cache {@link BOARD_TTL_MS}, keyed by the
 *                                 token generation; the shared call never takes one request's signal)
 *
 * Errors: no token → 409 `not_configured` `{reason: 'no_token'}`; upstream failures as documented
 * in providers/githubStatusClient.ts. A 429 answer carries `Retry-After`.
 */
import { GitHubTokenUpdateSchema, type GitHubBoard, type GitHubTokenStatus } from '@portly/shared';
import type { StaticContext } from '../context.ts';
import { createMemoryCache, type MemoryCache } from '../lib/cache.ts';
import { parseJsonBody } from '../lib/validate.ts';
import { createGitHubStatusClient, type GitHubStatusClient } from '../providers/githubStatusClient.ts';
import { clearToken, hasToken, normalizeToken, requireToken, storeToken } from '../providers/githubStatusToken.ts';
import { json } from '../respond.ts';
import type { StaticRouter } from '../router.ts';
import { getGitHubStatusToken } from '../slices.ts';

/** How long one answer serves every widget of this tab. */
export const BOARD_TTL_MS = 30 * 1000;
export const BOARD_CACHE_KEY = 'github:board';
const MEMO_PREFIX = 'github:';

export interface GitHubModuleState {
  client: GitHubStatusClient;
  /** Boards, keyed `github:board:<token generation>`. */
  cache: MemoryCache;
}

const states = new WeakMap<StaticContext, GitHubModuleState>();

/** The backend's client (cooldown) and board cache (one per context; exposed for tests). */
export function githubState(ctx: StaticContext): GitHubModuleState {
  let state = states.get(ctx);
  if (!state) {
    state = { client: createGitHubStatusClient({ now: ctx.now }), cache: createMemoryCache({ now: ctx.now }) };
    states.set(ctx, state);
  }
  return state;
}

/** The token changed: what was cached belongs to the old one, and so does the rate-limit cooldown. */
function forgetCachedData(ctx: StaticContext): void {
  const { client, cache } = githubState(ctx);
  cache.delPrefix(MEMO_PREFIX);
  client.resetCooldown();
}

export function register(router: StaticRouter): void {
  router.get('/api/github/token', (ctx) => {
    const body: GitHubTokenStatus = { configured: hasToken(ctx) };
    return json(body);
  });

  router.put('/api/github/token', async (ctx, { req }) => {
    const { token: raw } = await parseJsonBody(req, GitHubTokenUpdateSchema);
    const token = normalizeToken(raw);
    const { client } = githubState(ctx);
    // A fresh token deserves a fresh attempt even if the old one was rate limited.
    client.resetCooldown();
    await client.checkToken(token, req.signal);
    await storeToken(ctx, token);
    forgetCachedData(ctx);
    const body: GitHubTokenStatus = { configured: true };
    return json(body);
  });

  router.delete('/api/github/token', async (ctx) => {
    await clearToken(ctx);
    forgetCachedData(ctx);
    const body: GitHubTokenStatus = { configured: false };
    return json(body);
  });

  router.get('/api/github/repos', async (ctx) => {
    const token = requireToken(ctx);
    const { client, cache } = githubState(ctx);
    const { generation } = getGitHubStatusToken(ctx);
    // Single flight: concurrent requests share this call, so it runs without any one caller's
    // signal (under the client's own deadline), as on the server.
    const board = await cache.getOrSet<GitHubBoard>(`${BOARD_CACHE_KEY}:${generation}`, BOARD_TTL_MS, () => client.board(token));
    return json(board);
  });
}
