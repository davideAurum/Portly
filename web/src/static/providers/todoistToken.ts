/**
 * The Todoist API token in the static backend (§4.6): the `todoist-token` slice (never exported,
 * never returned by the API — only `{configured}`), stored as typed, since the browser-only build
 * has no vault. Port of server/src/modules/todoist/token.ts with the slice in place of the vault.
 */
import type { StaticContext } from '../context.ts';
import { StaticApiError } from '../respond.ts';
import { SLICE, getTodoistToken } from '../slices.ts';
import { notConnected } from './todoistClient.ts';

/**
 * Todoist personal API tokens are 40 hex characters; OAuth tokens are similar. The check is a
 * sanity check against paste mistakes (spaces, quotes, a URL, half a token), not a format lock-in.
 */
export const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{20,200}$/;

/** Trims, drops a pasted `Bearer ` prefix and checks the shape; throws 422 on nonsense. */
export function normalizeToken(raw: string): string {
  const token = raw.trim().replace(/^bearer\s+/i, '');
  if (!TOKEN_PATTERN.test(token)) {
    throw new StaticApiError(
      'validation_failed',
      "That doesn't look like a Todoist API token. It is a long string of letters and digits (40 characters) without spaces.",
      [{ path: 'token', message: 'Invalid token format', code: 'invalid_format' }],
    );
  }
  return token;
}

/** The stored token, or 409 `not_configured` (`{reason: 'no_token'}`) when none is saved. */
export function requireToken(ctx: StaticContext): string {
  const { token } = getTodoistToken(ctx);
  if (typeof token !== 'string' || token === '') throw notConnected();
  return token;
}

export function hasToken(ctx: StaticContext): boolean {
  const { token } = getTodoistToken(ctx);
  return typeof token === 'string' && token !== '';
}

/**
 * Replaces the token, bumps the generation and persists the slice. When storage refuses the write
 * (quota, blocked or evicted IndexedDB) the token this page had is put back — it is what a reload
 * would load — and the error propagates (500), so the page never believes in a token that is gone
 * after a reload. The generation stays monotonic (one past the
 * failed value) so a request that saw the uncommitted token can't populate a cache entry the
 * restored token would then read.
 */
async function writeToken(ctx: StaticContext, token: string | null): Promise<void> {
  const previous = getTodoistToken(ctx);
  const generation = previous.generation + 1;
  ctx.state.set(SLICE.todoistToken, { token, generation });
  try {
    await ctx.state.commit(SLICE.todoistToken);
  } catch (err) {
    ctx.state.set(SLICE.todoistToken, { token: previous.token, generation: generation + 1 });
    throw err;
  }
}

/** Stores a validated token and bumps the generation so caches keyed by it start afresh. */
export function storeToken(ctx: StaticContext, token: string): Promise<void> {
  return writeToken(ctx, token);
}

/** Removes the token (keeping the generation counter so an old cached list is never reused). */
export function clearToken(ctx: StaticContext): Promise<void> {
  return writeToken(ctx, null);
}
