/**
 * GitHub status board module (§7 GitHub, §8 GitHub): the account's repositories with their CI
 * result, open issues and pull requests, and latest release. Read-only: nothing here changes
 * anything on GitHub, and Portly runs no git commands.
 *
 * Routes (all declared `paired()`: the paired Pages site may use them too):
 * - `GET    /api/github/token`  → `{configured}` (the token is never returned)
 * - `PUT    /api/github/token {token}` → `{configured: true}`; the shape is checked, then GitHub is
 *                                 asked for one repository, before it is stored in the vault as
 *                                 `github:token`
 * - `DELETE /api/github/token`  → `{configured: false}`
 * - `GET    /api/github/repos`  → `GitHubBoard` (cached {@link BOARD_TTL_MS}, shared by every
 *                                 widget and tab)
 *
 * Errors: no token → 409 `not_configured`; token stored but vault locked → 409 `reauth_required`;
 * upstream failures as documented in `client.ts`. A 429 answer carries `Retry-After`.
 *
 * Diagnostics (§17, health key `github`, on demand so never stale): every call made with the
 * stored token records its outcome; a request refused by our own cooldown or a locked vault is a
 * skipped check. Saving a token GitHub accepts records ok; removing it forgets the subject. Calls
 * run in `withLogContext({area: 'github', op})`. Repository names are never logged.
 */
import type { Hono } from 'hono';
import { GitHubTokenUpdateSchema, type GitHubBoard, type GitHubTokenStatus } from '@portly/shared';
import type { AppContext, AppEnv } from '../../context.ts';
import { outcomeFromError, type HealthSubject, type Outcome } from '../../lib/health.ts';
import { withLogContext } from '../../lib/log-context.ts';
import { paired } from '../../lib/routes.ts';
import { parseBody } from '../../lib/validate.ts';
import { VaultLockedError } from '../../security/vault.ts';
import { GitHubRateLimitError, GitHubUpstreamError, createGitHubClient, type GitHubClient } from './client.ts';
import { TOKEN_SECRET_ID, normalizeToken, requireToken } from './token.ts';

export { TOKEN_SECRET_ID } from './token.ts';

export const prefixes = ['/api/github'] as const;

/** The stored token's GitHub connection (key `github`): checked on demand, so never stale. */
export const GITHUB_HEALTH: HealthSubject = { key: 'github', area: 'github', label: 'GitHub', expectEveryMs: null };

/** How long one answer serves every widget and tab, however many are open. */
export const BOARD_TTL_MS = 30 * 1000;
export const BOARD_CACHE_KEY = 'github:board';
const MEMO_PREFIX = 'github:';

export interface GitHubModuleOptions {
  /** Upstream client override (tests). */
  client?: GitHubClient;
}

export function register(app: Hono<AppEnv>, ctx: AppContext, options: GitHubModuleOptions = {}): void {
  const log = ctx.log.child({ module: 'github' });
  const client = options.client ?? createGitHubClient({ fetch: ctx.fetch, log });

  // Bumped whenever the token changes: a board cached (or in flight) for the previous token lives
  // under another key, so a request racing a token change can't serve or cache it.
  let tokenGeneration = 0;
  const forgetCachedData = () => {
    tokenGeneration += 1;
    ctx.memo.delPrefix(MEMO_PREFIX);
    client.resetCooldown();
  };

  // A 429 (from GitHub or our cooldown) tells the browser when to try again.
  app.use('/api/github/*', async (c, next) => {
    await next();
    const err = c.error;
    if (err instanceof GitHubRateLimitError) c.header('Retry-After', String(err.retryAfterSeconds));
  });

  /** The stored token; a locked vault is a skipped check of the `github` subject. */
  const storedToken = (): string => {
    try {
      return requireToken(ctx.vault);
    } catch (err) {
      if (err instanceof VaultLockedError) ctx.health.touch(GITHUB_HEALTH, { skipped: 'vault_locked' });
      throw err;
    }
  };

  const recordFailure = (err: unknown, ms: number): void => {
    if (err instanceof GitHubRateLimitError && err.httpStatus === null) {
      // Refused by our own cooldown: nothing was sent.
      ctx.health.touch(GITHUB_HEALTH, { skipped: 'backoff', nextAttemptAt: client.cooldownUntil() || null });
      return;
    }
    const extra: Partial<Outcome> = { ms };
    if (err instanceof GitHubRateLimitError) extra.nextAttemptAt = client.cooldownUntil() || null;
    if (err instanceof GitHubUpstreamError && err.httpStatus < 300 && err.code === 'provider_error') extra.code = 'parse_error';
    ctx.health.record(GITHUB_HEALTH, outcomeFromError(err, extra));
  };

  app.get('/api/github/token', paired(), (c) => {
    const body: GitHubTokenStatus = { configured: ctx.vault.has(TOKEN_SECRET_ID) };
    return c.json(body);
  });

  app.put('/api/github/token', paired(), async (c) => {
    const { token: raw } = await parseBody(c, GitHubTokenUpdateSchema);
    const token = normalizeToken(raw);
    if (ctx.vault.state === 'locked') throw new VaultLockedError();
    // A fresh token deserves a fresh attempt even if the old one was rate limited.
    client.resetCooldown();
    const started = Date.now();
    // A candidate token that fails says nothing about the stored one: only acceptance is recorded.
    await withLogContext({ area: 'github', op: 'validate' }, () => client.checkToken(token));
    ctx.vault.put(TOKEN_SECRET_ID, token);
    forgetCachedData();
    ctx.health.record(GITHUB_HEALTH, { ok: true, ms: Date.now() - started });
    log.info('github token saved');
    const body: GitHubTokenStatus = { configured: true };
    return c.json(body);
  });

  app.delete('/api/github/token', paired(), (c) => {
    ctx.vault.delete(TOKEN_SECRET_ID);
    forgetCachedData();
    ctx.health.forget(GITHUB_HEALTH.key);
    log.info('github token removed');
    const body: GitHubTokenStatus = { configured: false };
    return c.json(body);
  });

  app.get('/api/github/repos', paired(), async (c) => {
    const token = storedToken();
    const generation = tokenGeneration;
    const board = await ctx.memo.getOrSet<GitHubBoard>(`${BOARD_CACHE_KEY}:${generation}`, BOARD_TTL_MS, () =>
      withLogContext({ area: 'github', op: 'repos' }, async () => {
        const started = Date.now();
        try {
          const result = await client.board(token);
          if (generation === tokenGeneration) ctx.health.record(GITHUB_HEALTH, { ok: true, ms: Date.now() - started });
          return result;
        } catch (err) {
          // Not about a token that is gone by now.
          if (generation === tokenGeneration) recordFailure(err, Date.now() - started);
          throw err;
        }
      }),
    );
    return c.json(board satisfies GitHubBoard);
  });
}
