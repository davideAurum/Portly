/**
 * The GitHub token for launch pad sync through gists (docs/design/launchpad-sync-gist.md), kept
 * like the Todoist token (`todoistToken.ts`): in the `gist-sync` slice, stored as typed (the
 * browser-only build has no vault), never exported and never returned (only `{configured}`).
 *
 * Which tokens: a fine-grained personal access token with only the account permission **Gists:
 * Read and write**, or a classic token with only the `gist` scope. A classic token with any other
 * scope is refused: the token sits unencrypted on an origin every Pages site of the account shares
 * (ARCHITECTURE §4.1), so it should be able to do nothing but gists. A fine-grained token's
 * permissions can't be read back, so it is only checked to work.
 */
import type { StaticContext } from '../context.ts';
import { fetchTextCapped, upstreamFailure, type FetchLike } from '../lib/fetch.ts';
import { StaticApiError } from '../respond.ts';
import { SLICE, getGistSync } from '../slices.ts';
import { GITHUB_API, createGistStore, githubHeaders, type GistIds, type GistStore } from './githubGist.ts';

/** Fine-grained (`github_pat_`), classic (`ghp_`) and pre-2021 classic (40 hex) personal access tokens. */
export const GIST_TOKEN_PATTERN = /^(?:github_pat_[A-Za-z0-9_]{20,255}|ghp_[A-Za-z0-9]{30,255}|[0-9a-f]{40})$/;
const VALIDATE_TIMEOUT_MS = 10_000;
const VALIDATE_MAX_BYTES = 256 * 1024;

export function isClassicToken(token: string): boolean {
  return !token.startsWith('github_pat_');
}

/** Trims, drops a pasted `Bearer `/`token ` prefix and checks the shape; throws 422 on nonsense. */
export function normalizeGistToken(raw: string): string {
  const token = raw.trim().replace(/^(?:bearer|token)\s+/i, '');
  if (!GIST_TOKEN_PATTERN.test(token)) {
    throw new StaticApiError(
      'validation_failed',
      "That doesn't look like a GitHub personal access token. It starts with github_pat_ (fine-grained) or ghp_ (classic) and has no spaces.",
      [{ path: 'token', message: 'Invalid token format', code: 'invalid_format' }],
    );
  }
  return token;
}

function rejected(message: string): StaticApiError {
  return new StaticApiError('validation_failed', message, { reason: 'token_rejected' });
}

/**
 * Checks a new token with GitHub before it is saved: `GET /gists?per_page=1` must work, and a
 * classic token must have the `gist` scope and nothing else (`X-OAuth-Scopes`, which GitHub lets a
 * page read).
 */
export async function validateGistToken(token: string, options: { signal?: AbortSignal | null; fetch?: FetchLike } = {}): Promise<void> {
  let res;
  try {
    res = await fetchTextCapped(
      `${GITHUB_API}/gists?per_page=1`,
      {
        method: 'GET',
        headers: githubHeaders(token),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      },
      { timeoutMs: VALIDATE_TIMEOUT_MS, maxBytes: VALIDATE_MAX_BYTES, signal: options.signal, fetch: options.fetch },
    );
  } catch (err) {
    throw upstreamFailure(err, 'api.github.com');
  }
  if (res.status === 401) throw rejected('GitHub rejected this token. Check that you copied all of it and that it has not expired.');
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after') || res.status === 429) {
      throw new StaticApiError('rate_limited', 'GitHub is limiting requests. Try again in a few minutes.');
    }
    throw rejected('GitHub refused this token for gists. Give it the Gists permission (fine-grained) or the gist scope (classic).');
  }
  if (res.status !== 200) throw new StaticApiError('provider_error', `GitHub returned an unexpected response (HTTP ${res.status}).`);
  if (isClassicToken(token)) {
    const scopes = (res.headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (!scopes.includes('gist')) throw rejected('This classic token lacks the gist scope. Create one with only the gist scope.');
    const extra = scopes.filter((s) => s !== 'gist');
    if (extra.length > 0) {
      throw rejected(`This token can do more than Portly needs (${extra.join(', ')}). Create one with only the gist scope, since it is kept unencrypted in this browser.`);
    }
  }
}

export function hasGistToken(ctx: StaticContext): boolean {
  const { token } = getGistSync(ctx);
  return typeof token === 'string' && token !== '';
}

/**
 * Replaces the token and persists the slice; a different token forgets the gist ids (they may
 * belong to another account). On a storage failure the previous slice is put back, with the
 * generation still moving forward, and the error propagates (as for the Todoist token).
 */
async function writeToken(ctx: StaticContext, token: string | null): Promise<void> {
  const previous = { ...getGistSync(ctx) };
  const generation = previous.generation + 1;
  const sameToken = token !== null && token === previous.token;
  ctx.state.set(SLICE.gistSync, {
    token,
    generation,
    mainGistId: sameToken ? previous.mainGistId : null,
    iconsGistId: sameToken ? previous.iconsGistId : null,
  });
  try {
    await ctx.state.commit(SLICE.gistSync);
  } catch (err) {
    ctx.state.set(SLICE.gistSync, { ...previous, generation: generation + 1 });
    throw err;
  }
}

export function storeGistToken(ctx: StaticContext, token: string): Promise<void> {
  return writeToken(ctx, token);
}

/** Removes the token and the remembered gist ids. The gists stay on GitHub. */
export function clearGistToken(ctx: StaticContext): Promise<void> {
  return writeToken(ctx, null);
}

/**
 * A gist store for the saved token, or null without one. Gist ids it finds or creates are saved in
 * the slice, unless the token changed meanwhile.
 */
export function openGistStore(ctx: StaticContext, options: { fetch?: FetchLike } = {}): GistStore | null {
  const slice = getGistSync(ctx);
  const token = slice.token;
  if (token === null || token === '') return null;
  const generation = slice.generation;
  return createGistStore({
    token,
    ids: { main: slice.mainGistId, icons: slice.iconsGistId },
    fetch: options.fetch,
    now: ctx.now,
    onIdsChange: async (ids: GistIds) => {
      const current = getGistSync(ctx);
      if (current.generation !== generation) return;
      ctx.state.set(SLICE.gistSync, { ...current, mainGistId: ids.main, iconsGistId: ids.icons });
      await ctx.state.commit(SLICE.gistSync);
    },
  });
}
