/**
 * GitHub GraphQL client of the static backend, a port of server/src/modules/github/client.ts onto
 * the browser's `fetch`: `Authorization: Bearer <token>`, one POST to `api.github.com/graphql`,
 * `redirect: 'error'`, `credentials: 'omit'`, no browser cache. GitHub allows CORS from any origin
 * (checked 2026-11-04: `Authorization` and `Content-Type` pass the preflight, and it exposes
 * `Retry-After` and the `X-RateLimit-*` headers). The query and the reading of its answer live in
 * `@portly/shared` (github.ts).
 *
 * Failures map to the §7a error codes exactly like the server's. `reauth_required` is never
 * produced: there is no vault in the browser-only build.
 *
 * Every failed request is also a `provider` event (`diagnostics.ts`): status and reason code,
 * never a repository name or the token. A token refused while it is being checked is info.
 */
import {
  GITHUB_GRAPHQL_URL,
  GITHUB_HOST,
  GITHUB_NO_REPOS_MESSAGE,
  collectGitHubBoard,
  gitHubBoardRequest,
  gitHubPermissionsMessage,
  gitHubRetryAfterSeconds,
  isGitHubRateLimit,
  readGitHubBoardPage,
  type GitHubBoard,
  type GitHubBoardVariables,
  type GitHubPageResult,
} from '@portly/shared';
import { fetchTextCapped, upstreamFailure, type FetchedText, type FetchLike } from '../lib/fetch.ts';
import { StaticApiError } from '../respond.ts';
import { errorName, recordProviderFailure, statusFailureCode, stopwatch, transportFailureCode } from './diagnostics.ts';

/** GitHub stops a query after 10 s; a little more leaves room for the answer to arrive. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Largest answer accepted from GitHub (the server's `SIZE_CAPS.json`). */
export const REQUEST_MAX_BYTES = 5 * 1024 * 1024;

export type UpstreamPurpose = 'validate' | 'repos';

/** 429 from GitHub (or our cooldown); the response carries `Retry-After` like the server's. */
export class GitHubRateLimitError extends StaticApiError {
  override name = 'GitHubRateLimitError';
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('rate_limited', `GitHub is limiting requests. Try again in ${retryAfterSeconds} s.`, { retryAfterSeconds });
    this.retryAfterSeconds = retryAfterSeconds;
  }

  override toResponse(): Response {
    const res = super.toResponse();
    res.headers.set('Retry-After', String(this.retryAfterSeconds));
    return res;
  }
}

export function notConnected(): StaticApiError {
  return new StaticApiError('not_configured', 'GitHub repositories are not connected. Connect them in Settings → Accounts.', { reason: 'no_token' });
}

function unreadable(): StaticApiError {
  return new StaticApiError('provider_error', 'GitHub returned an unexpected response.');
}

function failureFor(status: number, purpose: UpstreamPurpose): StaticApiError {
  if (status === 401 || status === 403) {
    if (purpose === 'validate') {
      return new StaticApiError('validation_failed', 'GitHub rejected this token. Check that you copied all of it, and that it has not expired.', { reason: 'token_rejected' });
    }
    return new StaticApiError('not_configured', 'GitHub rejected the saved token. Paste a new one under GitHub repositories in Settings → Accounts.', { reason: 'token_rejected' });
  }
  if (status >= 500) return new StaticApiError('provider_error', `GitHub is having problems (HTTP ${status}). Try again shortly.`);
  return new StaticApiError('provider_error', `GitHub returned an unexpected response (HTTP ${status}).`);
}

function permissionsFailure(permissions: readonly string[], purpose: UpstreamPurpose): StaticApiError {
  const details = { reason: 'insufficient_scope', permissions };
  return new StaticApiError(purpose === 'validate' ? 'validation_failed' : 'not_configured', gitHubPermissionsMessage(permissions), details);
}

export interface GitHubStatusClientDeps {
  /** Transport override for tests (default `globalThis.fetch`, read at call time). */
  fetch?: FetchLike;
  /** Clock (epoch ms) for the cooldown; the handler passes `ctx.now`. */
  now?: () => number;
}

export interface GitHubStatusClient {
  /** The account's repositories with their status, or throws a mapped StaticApiError. */
  board(token: string, signal?: AbortSignal | null): Promise<GitHubBoard>;
  /** Asks for one repository, so a token that can't read the board is refused before it is stored. */
  checkToken(token: string, signal?: AbortSignal | null): Promise<void>;
  /** Clears the rate-limit cooldown (the token changed). */
  resetCooldown(): void;
  /** Epoch ms until which requests are refused locally (0 = none). */
  cooldownUntil(): number;
}

export function createGitHubStatusClient(deps: GitHubStatusClientDeps = {}): GitHubStatusClient {
  const now = deps.now ?? Date.now;
  let blockedUntil = 0;

  const coolDown = (seconds: number, status: number, ms: number): GitHubRateLimitError => {
    blockedUntil = now() + seconds * 1000;
    recordProviderFailure('github', GITHUB_HOST, { status, code: 'rate_limited', ms });
    return new GitHubRateLimitError(seconds);
  };

  const fetchPage = async (token: string, variables: GitHubBoardVariables, purpose: UpstreamPurpose, signal?: AbortSignal | null): Promise<GitHubPageResult> => {
    const remainingMs = blockedUntil - now();
    if (remainingMs > 0) throw new GitHubRateLimitError(Math.ceil(remainingMs / 1000));

    const elapsed = stopwatch();
    let res: FetchedText;
    try {
      res = await fetchTextCapped(
        GITHUB_GRAPHQL_URL,
        {
          method: 'POST',
          headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: gitHubBoardRequest(variables),
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
        },
        { timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: REQUEST_MAX_BYTES, signal, fetch: deps.fetch },
      );
    } catch (err) {
      const code = transportFailureCode(err);
      if (code !== null) recordProviderFailure('github', GITHUB_HOST, { code, errName: errorName(err), ms: elapsed() });
      throw upstreamFailure(err, GITHUB_HOST);
    }

    if (isGitHubRateLimit(res.status, res.headers, res.text)) throw coolDown(gitHubRetryAfterSeconds(res.headers, now()), res.status, elapsed());
    if (res.status < 200 || res.status >= 300) {
      const rejected = res.status === 401 || res.status === 403;
      const code = rejected ? 'token_rejected' : statusFailureCode(res.status);
      recordProviderFailure('github', GITHUB_HOST, { status: res.status, code, ms: elapsed() }, rejected && purpose === 'validate' ? 'info' : 'warn');
      throw failureFor(res.status, purpose);
    }
    let answer: unknown;
    try {
      answer = JSON.parse(res.text);
    } catch {
      recordProviderFailure('github', GITHUB_HOST, { status: res.status, code: 'parse_error', ms: elapsed() });
      throw unreadable();
    }
    const result = readGitHubBoardPage(answer);
    if (!result.ok) {
      if (result.reason === 'rate_limited') throw coolDown(gitHubRetryAfterSeconds(res.headers, now()), res.status, elapsed());
      const code = result.reason === 'permissions' ? 'insufficient_scope' : 'parse_error';
      recordProviderFailure('github', GITHUB_HOST, { status: res.status, code, ms: elapsed() }, purpose === 'validate' ? 'info' : 'warn');
    }
    return result;
  };

  return {
    async board(token, signal) {
      const result = await collectGitHubBoard((variables) => fetchPage(token, variables, 'repos', signal));
      if (result.ok) return result.board;
      if (result.reason === 'permissions') throw permissionsFailure(result.permissions, 'repos');
      throw unreadable();
    },
    async checkToken(token, signal) {
      const result = await fetchPage(token, { first: 1, after: null }, 'validate', signal);
      if (result.ok) {
        if (result.page.total === 0) throw new StaticApiError('validation_failed', GITHUB_NO_REPOS_MESSAGE, { reason: 'insufficient_scope' });
        return;
      }
      if (result.reason === 'permissions') throw permissionsFailure(result.permissions, 'validate');
      throw unreadable();
    },
    resetCooldown: () => {
      blockedUntil = 0;
    },
    cooldownUntil: () => blockedUntil,
  };
}
