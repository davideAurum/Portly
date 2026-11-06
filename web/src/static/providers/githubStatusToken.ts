/**
 * The GitHub status board's token in the static backend (§4.1, §4.6): the `github-status-token`
 * slice (never exported, never returned by the API, only `{configured}`), stored as typed, since
 * the browser-only build has no vault. Port of server/src/modules/github/token.ts with the slice in
 * place of the vault. It is not the launch pad sync token (`githubSync.ts`), which reaches one
 * repository and may write to it.
 */
import { cleanGitHubToken, gitHubTokenProblem } from '@portly/shared';
import type { StaticContext } from '../context.ts';
import { StaticApiError } from '../respond.ts';
import { SLICE, getGitHubStatusToken } from '../slices.ts';
import { notConnected } from './githubStatusClient.ts';

/** Trims, drops a pasted prefix and checks the shape; throws 422 on anything else. */
export function normalizeToken(raw: string): string {
  const token = cleanGitHubToken(raw);
  const problem = gitHubTokenProblem(token);
  if (problem !== null) throw new StaticApiError('validation_failed', problem, [{ path: 'token', message: 'Invalid token format', code: 'invalid_format' }]);
  return token;
}

/** The stored token, or 409 `not_configured` (`{reason: 'no_token'}`) when none is saved. */
export function requireToken(ctx: StaticContext): string {
  const { token } = getGitHubStatusToken(ctx);
  if (typeof token !== 'string' || token === '') throw notConnected();
  return token;
}

export function hasToken(ctx: StaticContext): boolean {
  const { token } = getGitHubStatusToken(ctx);
  return typeof token === 'string' && token !== '';
}

/**
 * Replaces the token, bumps the generation and persists the slice. When storage refuses the write
 * the token this page had is put back (it is what a reload would load) and the error propagates,
 * so the page never believes in a token that is gone after a reload.
 */
async function writeToken(ctx: StaticContext, token: string | null): Promise<void> {
  const previous = getGitHubStatusToken(ctx);
  const generation = previous.generation + 1;
  ctx.state.set(SLICE.githubStatusToken, { token, generation });
  try {
    await ctx.state.commit(SLICE.githubStatusToken);
  } catch (err) {
    ctx.state.set(SLICE.githubStatusToken, { token: previous.token, generation: generation + 1 });
    throw err;
  }
}

/** Stores a checked token and bumps the generation so caches keyed by it start afresh. */
export function storeToken(ctx: StaticContext, token: string): Promise<void> {
  return writeToken(ctx, token);
}

/** Removes the token (keeping the generation counter so an old cached board is never reused). */
export function clearToken(ctx: StaticContext): Promise<void> {
  return writeToken(ctx, null);
}
