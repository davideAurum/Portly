/**
 * Token endpoint client shared by the code exchange and refreshes. Responses are classified into
 * a small set of outcomes so callers decide on status changes without ever touching (or logging)
 * provider-supplied text: only the registered OAuth `error` code is logged, never
 * `error_description`, tokens or request parameters.
 *
 * Outbound purposes: `oauth.token` (code exchange) and `oauth.refresh`. A refused or failed
 * refresh is logged at debug only: the caller records it on the account's health subject (the
 * single source of failure lines, §17); a failed code exchange has no subject and warns.
 */
import { z } from 'zod';
import { errorFields, type Logger } from '../../../lib/logger.ts';
import { parseRetryAfter } from '../../../lib/provider-errors.ts';
import { SafeFetchError, type SafeFetch } from '../../../security/safe-fetch.ts';
import type { OAuthProviderSpec } from './types.ts';

export interface TokenSet {
  accessToken: string;
  /** Lifetime in seconds (clamped to 60 s … 24 h; 1 h when absent). */
  expiresInSec: number;
  /** Present on the code exchange and whenever the provider rotates it. */
  refreshToken: string | null;
  /** Raw `scope` value (space-separated), if returned. */
  scope: string | undefined;
  idToken: string | null;
}

/**
 * - `invalid_grant`   the grant is dead (expired/revoked refresh token, consent withdrawn) → reauth
 * - `client_rejected` the client id/secret was refused (`invalid_client`, `unauthorized_client`)
 * - `rejected`        any other 4xx refusal
 * - `rate_limited`    429
 * - `server_error`    5xx
 * - `bad_response`    2xx that is not a usable token response, or an unreadable body
 * - `timeout` / `unreachable` transport failures
 */
export type TokenFailure =
  | 'invalid_grant'
  | 'client_rejected'
  | 'rejected'
  | 'rate_limited'
  | 'server_error'
  | 'bad_response'
  | 'timeout'
  | 'unreachable';

export interface TokenEndpointFailure {
  ok: false;
  failure: TokenFailure;
  /** HTTP status (null for transport failures). */
  status: number | null;
  /** The registered OAuth `error` code (`invalid_grant`, `consent_required` …), when one was returned. */
  error: string | null;
  /** `Retry-After` of a refusal, in seconds. */
  retryAfterSeconds: number | null;
  /** The transport error behind `timeout` / `unreachable` (for its cause chain; never shown). */
  cause?: unknown;
}

export type TokenEndpointResult = { ok: true; tokens: TokenSet } | TokenEndpointFailure;

export const TOKEN_RESPONSE_MAX_BYTES = 256 * 1024;
const MIN_LIFETIME_SEC = 60;
const MAX_LIFETIME_SEC = 24 * 60 * 60;
const DEFAULT_LIFETIME_SEC = 60 * 60;

const TokenString = z.string().min(1).max(16 * 1024);

const TokenResponseSchema = z.object({
  access_token: TokenString,
  token_type: z.string().max(64).optional(),
  expires_in: z.union([z.number(), z.string().regex(/^\d{1,9}$/).transform(Number)]).optional(),
  refresh_token: TokenString.optional(),
  scope: z.string().max(8192).optional(),
  id_token: TokenString.optional(),
});

const ErrorResponseSchema = z.object({ error: z.string().max(200) });

const DEAD_GRANT_ERRORS = new Set(['invalid_grant', 'interaction_required', 'consent_required', 'login_required']);
const CLIENT_ERRORS = new Set(['invalid_client', 'unauthorized_client']);
/** Registered OAuth error codes are short snake_case words — safe to log. */
const LOGGABLE_ERROR_CODE = /^[a-z_]{1,64}$/;

function clampLifetime(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_LIFETIME_SEC;
  return Math.min(Math.max(Math.floor(value), MIN_LIFETIME_SEC), MAX_LIFETIME_SEC);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function classify(status: number, error: string | undefined): TokenFailure {
  if (status === 400 || status === 401) {
    if (error !== undefined && DEAD_GRANT_ERRORS.has(error)) return 'invalid_grant';
    if (error !== undefined && CLIENT_ERRORS.has(error)) return 'client_rejected';
  }
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'rejected';
  return 'bad_response';
}

function transportFailure(err: SafeFetchError): TokenFailure {
  if (err.reason === 'timeout') return 'timeout';
  if (err.reason === 'network' || err.reason === 'blocked' || err.reason === 'bad_url') return 'unreachable';
  return 'bad_response';
}

export interface TokenRequest {
  fetch: SafeFetch;
  log: Logger;
  spec: OAuthProviderSpec;
  /** `authorization_code` or `refresh_token` (for logging only; the grant is in `params`). */
  grant: 'authorization_code' | 'refresh_token';
  params: Record<string, string>;
}

/** POSTs a form-encoded token request and classifies the response. Never throws for HTTP/transport failures. */
export async function requestToken(req: TokenRequest): Promise<TokenEndpointResult> {
  const { fetch, log, spec, grant } = req;
  // A refresh failure becomes the account's health outcome (its failure line); keep the detail at debug.
  const level = grant === 'refresh_token' ? 'debug' : 'warn';
  let status: number;
  let text: string;
  let headers: Headers;
  try {
    const res = await fetch(spec.tokenEndpoint, {
      method: 'POST',
      policy: 'provider',
      purpose: grant === 'refresh_token' ? 'oauth.refresh' : 'oauth.token',
      as: 'text',
      maxBytes: TOKEN_RESPONSE_MAX_BYTES,
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(req.params).toString(),
    });
    status = res.status;
    text = res.data;
    headers = res.headers;
  } catch (err) {
    const failure = err instanceof SafeFetchError ? transportFailure(err) : 'unreachable';
    log[level]('oauth token request failed', { ...errorFields(err), provider: spec.provider, grant, failure });
    return { ok: false, failure, status: null, error: null, retryAfterSeconds: null, cause: err };
  }

  const json = parseJson(text);
  if (status >= 200 && status < 300) {
    const parsed = TokenResponseSchema.safeParse(json);
    if (!parsed.success || (parsed.data.token_type !== undefined && parsed.data.token_type.toLowerCase() !== 'bearer')) {
      log[level]('oauth token response unusable', { provider: spec.provider, grant, status });
      return { ok: false, failure: 'bad_response', status, error: null, retryAfterSeconds: null };
    }
    const data = parsed.data;
    return {
      ok: true,
      tokens: {
        accessToken: data.access_token,
        expiresInSec: clampLifetime(data.expires_in),
        refreshToken: data.refresh_token ?? null,
        scope: data.scope,
        idToken: data.id_token ?? null,
      },
    };
  }

  const error = ErrorResponseSchema.safeParse(json).data?.error;
  const failure = classify(status, error);
  const code = error !== undefined && LOGGABLE_ERROR_CODE.test(error) ? error : null;
  const retryAfterSeconds = parseRetryAfter(headers.get('retry-after'));
  log[level]('oauth token request refused', {
    provider: spec.provider,
    grant,
    status,
    failure,
    error: code ?? undefined,
    retryAfterSeconds: retryAfterSeconds ?? undefined,
  });
  return { ok: false, failure, status, error: code, retryAfterSeconds };
}
