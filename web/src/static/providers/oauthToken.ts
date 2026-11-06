/**
 * The token request of the browser's own sign-ins (Microsoft, Spotify), a port of
 * server/src/modules/accounts/oauth/token-endpoint.ts, and PKCE. Every provider here is a public
 * client: the browser holds no secret.
 *
 * Only the registered OAuth `error` code of a refusal is ever looked at; `error_description`,
 * tokens and request parameters are never logged or shown. A failed token request is a `provider`
 * event (`diagnostics.ts`): status and that `error` code (else the failure's class), nothing else.
 */
import { z } from 'zod';
import { encodeBase64 } from '../lib/base64.ts';
import { classifyFetchError, fetchTextCapped, UpstreamPayloadTooLargeError } from '../lib/fetch.ts';
import { toBase64Url } from '../lib/ids.ts';
import { errorName, hostOf, recordProviderFailure, stopwatch, type ProviderName } from './diagnostics.ts';

export const TOKEN_TIMEOUT_MS = 15_000;
export const TOKEN_RESPONSE_MAX_BYTES = 256 * 1024;
const MIN_LIFETIME_SEC = 60;
const MAX_LIFETIME_SEC = 24 * 60 * 60;
const DEFAULT_LIFETIME_SEC = 60 * 60;

/** `BASE64URL(SHA256(verifier))` (RFC 7636 S256). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(encodeBase64(new Uint8Array(digest)));
}

export interface TokenSet {
  accessToken: string;
  /** Lifetime in seconds (clamped to 60 s … 24 h; 1 h when absent). */
  expiresInSec: number;
  refreshToken: string | null;
  /** Remaining lifetime of the refresh token in seconds, when the provider says. */
  refreshExpiresInSec: number | null;
  scope: string | undefined;
  idToken: string | null;
}

/** See server/src/modules/accounts/oauth/token-endpoint.ts for the meaning of each failure. */
export type TokenFailure = 'invalid_grant' | 'client_rejected' | 'rejected' | 'rate_limited' | 'server_error' | 'bad_response' | 'timeout' | 'unreachable';

export type TokenEndpointResult = { ok: true; tokens: TokenSet } | { ok: false; failure: TokenFailure; status: number | null };

const TokenString = z.string().min(1).max(16 * 1024);
const Seconds = z.union([z.number(), z.string().regex(/^\d{1,9}$/).transform(Number)]);

const TokenResponseSchema = z.object({
  access_token: TokenString,
  token_type: z.string().max(64).optional(),
  expires_in: Seconds.optional(),
  refresh_token: TokenString.optional(),
  refresh_token_expires_in: Seconds.optional(),
  scope: z.string().max(8192).optional(),
  id_token: TokenString.optional(),
});

const ErrorResponseSchema = z.object({ error: z.string().max(200) });

const DEAD_GRANT_ERRORS = new Set(['invalid_grant', 'interaction_required', 'consent_required', 'login_required']);
const CLIENT_ERRORS = new Set(['invalid_client', 'unauthorized_client']);

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

export function classifyTokenFailure(status: number, error: string | undefined): TokenFailure {
  if (status === 400 || status === 401) {
    if (error !== undefined && DEAD_GRANT_ERRORS.has(error)) return 'invalid_grant';
    if (error !== undefined && CLIENT_ERRORS.has(error)) return 'client_rejected';
  }
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'rejected';
  return 'bad_response';
}

/** An OAuth `error` code as registered (RFC 6749 section 5.2 and extensions: lowercase with underscores). */
const OAUTH_ERROR_CODE = /^[a-z_]{1,64}$/;

/** A failed attempt also says what the event needs: the OAuth `error` code, the error's name. */
type TokenAttempt = { ok: true; tokens: TokenSet } | { ok: false; failure: TokenFailure; status: number | null; error?: string; errName?: string };

/** POSTs a form-encoded token request and classifies the response. Never throws for HTTP or transport failures. */
export async function requestTokenFrom(provider: ProviderName, endpoint: string, params: Record<string, string>): Promise<TokenEndpointResult> {
  const elapsed = stopwatch();
  const result = await requestTokenOnce(endpoint, params);
  if (result.ok) return result;
  const code = result.error !== undefined && OAUTH_ERROR_CODE.test(result.error) ? result.error : result.failure;
  recordProviderFailure(provider, hostOf(endpoint), { status: result.status, code, errName: result.errName ?? null, ms: elapsed() });
  return { ok: false, failure: result.failure, status: result.status };
}

async function requestTokenOnce(endpoint: string, params: Record<string, string>): Promise<TokenAttempt> {
  let status: number;
  let text: string;
  try {
    const res = await fetchTextCapped(
      endpoint,
      {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(params).toString(),
      },
      { timeoutMs: TOKEN_TIMEOUT_MS, maxBytes: TOKEN_RESPONSE_MAX_BYTES },
    );
    status = res.status;
    text = res.text;
  } catch (err) {
    if (err instanceof UpstreamPayloadTooLargeError) return { ok: false, failure: 'bad_response', status: null, errName: errorName(err) };
    const kind = classifyFetchError(err);
    if (kind === 'aborted') throw err;
    return { ok: false, failure: kind === 'timeout' ? 'timeout' : 'unreachable', status: null, errName: errorName(err) };
  }

  const json = parseJson(text);
  if (status >= 200 && status < 300) {
    const parsed = TokenResponseSchema.safeParse(json);
    if (!parsed.success || (parsed.data.token_type !== undefined && parsed.data.token_type.toLowerCase() !== 'bearer')) {
      return { ok: false, failure: 'bad_response', status };
    }
    const data = parsed.data;
    const refreshExpires = data.refresh_token_expires_in;
    return {
      ok: true,
      tokens: {
        accessToken: data.access_token,
        expiresInSec: clampLifetime(data.expires_in),
        refreshToken: data.refresh_token ?? null,
        refreshExpiresInSec: refreshExpires !== undefined && Number.isFinite(refreshExpires) && refreshExpires > 0 ? Math.floor(refreshExpires) : null,
        scope: data.scope,
        idToken: data.id_token ?? null,
      },
    };
  }
  const error = ErrorResponseSchema.safeParse(json).data?.error;
  return { ok: false, failure: classifyTokenFailure(status, error), status, error };
}
