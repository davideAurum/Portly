/**
 * GitHub GraphQL client for the status board (§8 GitHub): `Authorization: Bearer <token>`, a
 * single POST to `https://api.github.com/graphql`, fixed vendor endpoint → safe-fetch policy
 * `provider`. The query and the reading of its answer live in `@portly/shared` (github.ts), which
 * the in-browser backend uses too.
 *
 * Failures map to the §7a error codes:
 * - 401, or 403 without rate-limit signs → 409 `not_configured`, details `{reason: 'token_rejected'}`
 *   — or, while checking a new token, 422 `validation_failed`
 * - a token that may not read what the query asks → 409 `not_configured`, details
 *   `{reason: 'insufficient_scope', permissions}` — or 422 while checking a new token
 * - rate limited (a 429, a 403 with GitHub's signs, or a 200 with `errors`) → 429 `rate_limited`,
 *   details `{retryAfterSeconds}`, and a cooldown during which nothing is sent
 * - 5xx and others → 502 `provider_error`
 * - timeouts → 504 `upstream_timeout`, network errors → 502 `provider_error` (safe-fetch)
 * GitHub's error text is never reflected to the client. A 2xx that can't be read is a
 * `provider_error`.
 */
import {
  GITHUB_GRAPHQL_URL,
  GITHUB_NO_REPOS_MESSAGE,
  collectGitHubBoard,
  gitHubBoardRequest,
  gitHubPermissionsMessage,
  gitHubRetryAfterSeconds,
  isGitHubRateLimit,
  readGitHubBoardPage,
  type ErrorCode,
  type GitHubBoard,
  type GitHubBoardVariables,
  type GitHubPageResult,
} from '@portly/shared';
import { HttpError } from '../../lib/errors.ts';
import type { Logger } from '../../lib/logger.ts';
import { SIZE_CAPS, type SafeFetch } from '../../security/safe-fetch.ts';

/** GitHub stops a query after 10 s; a little more leaves room for the answer to arrive. */
export const REQUEST_TIMEOUT_MS = 15_000;

export type UpstreamPurpose = 'validate' | 'repos';

/** 429 from GitHub (or our cooldown): the route layer copies `retryAfterSeconds` into `Retry-After`. */
export class GitHubRateLimitError extends HttpError {
  override name = 'GitHubRateLimitError';
  readonly retryAfterSeconds: number;
  /** GitHub's status when it answered; null when our cooldown refused the request (nothing was sent). */
  readonly httpStatus: number | null;
  constructor(retryAfterSeconds: number, httpStatus: number | null = null) {
    super(429, 'rate_limited', `GitHub is limiting requests. Try again in ${retryAfterSeconds} s.`, { retryAfterSeconds });
    this.retryAfterSeconds = retryAfterSeconds;
    this.httpStatus = httpStatus;
  }
}

/** A failed GitHub answer: the API error the route sends, plus GitHub's own status for diagnostics. */
export class GitHubUpstreamError extends HttpError {
  override name = 'GitHubUpstreamError';
  /** GitHub's HTTP status (logged as `upstreamStatus`). */
  readonly httpStatus: number;
  constructor(httpStatus: number, status: number, code: ErrorCode, message: string, details?: unknown) {
    super(status, code, message, details);
    this.httpStatus = httpStatus;
  }
}

export function notConnected(): HttpError {
  return new HttpError(409, 'not_configured', 'GitHub repositories are not connected. Connect them in Settings → Accounts.', { reason: 'no_token' });
}

function unreadable(httpStatus: number): GitHubUpstreamError {
  return new GitHubUpstreamError(httpStatus, 502, 'provider_error', 'GitHub returned an unexpected response.');
}

function failureFor(status: number, purpose: UpstreamPurpose): GitHubUpstreamError {
  if (status === 401 || status === 403) {
    if (purpose === 'validate') {
      return new GitHubUpstreamError(status, 422, 'validation_failed', 'GitHub rejected this token. Check that you copied all of it, and that it has not expired.', {
        reason: 'token_rejected',
      });
    }
    return new GitHubUpstreamError(status, 409, 'not_configured', 'GitHub rejected the saved token. Paste a new one under GitHub repositories in Settings → Accounts.', {
      reason: 'token_rejected',
    });
  }
  if (status >= 500) return new GitHubUpstreamError(status, 502, 'provider_error', `GitHub is having problems (HTTP ${status}). Try again shortly.`);
  return new GitHubUpstreamError(status, 502, 'provider_error', `GitHub returned an unexpected response (HTTP ${status}).`);
}

function permissionsFailure(permissions: readonly string[], purpose: UpstreamPurpose): GitHubUpstreamError {
  const details = { reason: 'insufficient_scope', permissions };
  const message = gitHubPermissionsMessage(permissions);
  return purpose === 'validate' ? new GitHubUpstreamError(200, 422, 'validation_failed', message, details) : new GitHubUpstreamError(200, 409, 'not_configured', message, details);
}

export interface GitHubClientDeps {
  fetch: SafeFetch;
  log: Logger;
  now?: () => number;
}

export interface GitHubClient {
  /** The account's repositories with their status, or throws a mapped HttpError. */
  board(token: string): Promise<GitHubBoard>;
  /** Asks for one repository, so a token that can't read the board is refused before it is stored. */
  checkToken(token: string): Promise<void>;
  /** Clears the rate-limit cooldown (the token changed). */
  resetCooldown(): void;
  /** Epoch ms until which requests are refused locally (0 = none). */
  cooldownUntil(): number;
}

export function createGitHubClient(deps: GitHubClientDeps): GitHubClient {
  const now = deps.now ?? Date.now;
  let blockedUntil = 0;

  const coolDown = (seconds: number, httpStatus: number): GitHubRateLimitError => {
    blockedUntil = now() + seconds * 1000;
    // The `github` health record (failing, rate_limited, next attempt) is the visible line.
    deps.log.debug('github rate limited', { retryAfterSeconds: seconds });
    return new GitHubRateLimitError(seconds, httpStatus);
  };

  const fetchPage = async (token: string, variables: GitHubBoardVariables, purpose: UpstreamPurpose): Promise<GitHubPageResult> => {
    const remainingMs = blockedUntil - now();
    if (remainingMs > 0) throw new GitHubRateLimitError(Math.ceil(remainingMs / 1000));

    const res = await deps.fetch(GITHUB_GRAPHQL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: gitHubBoardRequest(variables),
      policy: 'provider',
      as: 'text',
      maxBytes: SIZE_CAPS.json,
      timeoutMs: REQUEST_TIMEOUT_MS,
      redirect: 'error',
      purpose: `github.${purpose}`,
    });

    if (isGitHubRateLimit(res.status, res.headers, res.data)) throw coolDown(gitHubRetryAfterSeconds(res.headers, now()), res.status);
    if (res.status < 200 || res.status >= 300) throw failureFor(res.status, purpose);
    let answer: unknown;
    try {
      answer = JSON.parse(res.data);
    } catch {
      throw unreadable(res.status);
    }
    const result = readGitHubBoardPage(answer);
    if (!result.ok && result.reason === 'rate_limited') throw coolDown(gitHubRetryAfterSeconds(res.headers, now()), res.status);
    return result;
  };

  return {
    async board(token) {
      const result = await collectGitHubBoard((variables) => fetchPage(token, variables, 'repos'));
      if (result.ok) return result.board;
      if (result.reason === 'permissions') throw permissionsFailure(result.permissions, 'repos');
      throw unreadable(200);
    },
    async checkToken(token) {
      const result = await fetchPage(token, { first: 1, after: null }, 'validate');
      if (result.ok) {
        if (result.page.total === 0) throw new GitHubUpstreamError(200, 422, 'validation_failed', GITHUB_NO_REPOS_MESSAGE, { reason: 'insufficient_scope' });
        return;
      }
      if (result.reason === 'permissions') throw permissionsFailure(result.permissions, 'validate');
      throw unreadable(200);
    },
    resetCooldown: () => {
      blockedUntil = 0;
    },
    cooldownUntil: () => blockedUntil,
  };
}
