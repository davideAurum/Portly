/**
 * Microsoft sign-in for the static backend: the browser itself is the OAuth client (a
 * *single-page application* registration, PKCE S256, no secret, personal accounts through the
 * `/consumers` authority). Ports of server/src/modules/accounts/oauth/microsoft.ts (endpoints,
 * id_token rules, scope → capability mapping), token-endpoint.ts (request + failure
 * classification) and id-token.ts (claim decoding), with the browser differences:
 *
 * - the scopes leave out `Mail.ReadWrite` (mail is not part of the static build);
 * - Microsoft only redeems a code or refresh token from a browser origin for a redirect URI
 *   registered as "Single-page application", and such refresh tokens stop working 24 hours after
 *   the interactive sign-in ({@link SPA_SESSION_MS}; `refresh_token_expires_in` when present);
 * - `prompt=none` builds the automatic re-sign-in that renews that session without a click.
 *
 * Only the registered OAuth `error` code of a refusal is ever looked at; `error_description`,
 * tokens and request parameters are never logged or shown. A failed token request is a `provider`
 * event (`diagnostics.ts`): status and that `error` code (else the failure's class), nothing else.
 */
import { MICROSOFT_CONSUMER_TENANT_ID, type Capability } from '@homebase/shared';
import { z } from 'zod';
import { encodeBase64 } from '../lib/base64.ts';
import { classifyFetchError, fetchTextCapped, UpstreamPayloadTooLargeError } from '../lib/fetch.ts';
import { toBase64Url } from '../lib/ids.ts';
import { errorName, hostOf, recordProviderFailure, stopwatch } from './diagnostics.ts';

export const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/consumers';
export const MICROSOFT_AUTHORIZE_ENDPOINT = `${MICROSOFT_AUTHORITY}/oauth2/v2.0/authorize`;
export const MICROSOFT_TOKEN_ENDPOINT = `${MICROSOFT_AUTHORITY}/oauth2/v2.0/token`;
export const MICROSOFT_ISSUER = `https://login.microsoftonline.com/${MICROSOFT_CONSUMER_TENANT_ID}/v2.0`;

/** The static build's scopes: the server's minus `Mail.ReadWrite`. */
export const MICROSOFT_STATIC_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Calendars.ReadWrite'] as const;

export const MICROSOFT_DISPLAY_NAME = 'Microsoft';
export const MICROSOFT_DEFAULT_LABEL = 'Outlook.com account';

export const CLIENT_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a single-page app's sign-in lasts when Microsoft does not say (`refresh_token_expires_in`). */
export const SPA_SESSION_MS = 24 * 60 * 60 * 1000;

export const TOKEN_TIMEOUT_MS = 15_000;
export const TOKEN_RESPONSE_MAX_BYTES = 256 * 1024;
const MIN_LIFETIME_SEC = 60;
const MAX_LIFETIME_SEC = 24 * 60 * 60;
const DEFAULT_LIFETIME_SEC = 60 * 60;

// ---------------------------------------------------------------------------
// PKCE and the authorization request
// ---------------------------------------------------------------------------

/** `BASE64URL(SHA256(verifier))` (RFC 7636 S256). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(encodeBase64(new Uint8Array(digest)));
}

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  /** Automatic re-sign-in: no UI at Microsoft; `login_required` comes back when it needs one. */
  silent?: boolean;
  /** Account to sign in as (its email), for the automatic re-sign-in. */
  loginHint?: string | null;
}

export function authorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(MICROSOFT_AUTHORIZE_ENDPOINT);
  const params: Record<string, string> = {
    client_id: input.clientId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    response_mode: 'query',
    scope: MICROSOFT_STATIC_SCOPES.join(' '),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  };
  if (input.silent) params.prompt = 'none';
  if (input.loginHint) params.login_hint = input.loginHint;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

// ---------------------------------------------------------------------------
// Token endpoint (port of token-endpoint.ts)
// ---------------------------------------------------------------------------

export interface TokenSet {
  accessToken: string;
  /** Lifetime in seconds (clamped to 60 s … 24 h; 1 h when absent). */
  expiresInSec: number;
  refreshToken: string | null;
  /** Remaining lifetime of the refresh token in seconds, when Microsoft says. */
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
export async function requestToken(params: Record<string, string>): Promise<TokenEndpointResult> {
  const elapsed = stopwatch();
  const result = await requestTokenOnce(params);
  if (result.ok) return result;
  const code = result.error !== undefined && OAUTH_ERROR_CODE.test(result.error) ? result.error : result.failure;
  recordProviderFailure('microsoft', hostOf(MICROSOFT_TOKEN_ENDPOINT), { status: result.status, code, errName: result.errName ?? null, ms: elapsed() });
  return { ok: false, failure: result.failure, status: result.status };
}

async function requestTokenOnce(params: Record<string, string>): Promise<TokenAttempt> {
  let status: number;
  let text: string;
  try {
    const res = await fetchTextCapped(
      MICROSOFT_TOKEN_ENDPOINT,
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

// ---------------------------------------------------------------------------
// id_token (port of id-token.ts and the Microsoft identity rules)
// ---------------------------------------------------------------------------

const MAX_ID_TOKEN_LENGTH = 16 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Allowed clock skew when checking `exp`. */
export const ID_TOKEN_CLOCK_SKEW_MS = 5 * 60 * 1000;

function base64UrlToText(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Payload claims of a compact JWS, or null. The token comes straight from Microsoft's token
 * endpoint over TLS (never from the page's URL), so the signature is not verified (OIDC Core
 * §3.1.3.7 item 6); issuer, audience, expiry and tenant are still checked by {@link microsoftIdentity}.
 */
export function decodeJwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_ID_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload] = parts;
  if (!header || !payload || !BASE64URL.test(header) || !BASE64URL.test(payload)) return null;
  try {
    const data: unknown = JSON.parse(base64UrlToText(payload));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

function audienceMatches(aud: unknown, clientId: string): boolean {
  if (typeof aud === 'string') return aud === clientId;
  return Array.isArray(aud) && aud.length > 0 && aud.every((a) => typeof a === 'string') && aud.includes(clientId);
}

function notExpired(exp: unknown, nowMs: number): boolean {
  return typeof exp === 'number' && Number.isFinite(exp) && exp * 1000 + ID_TOKEN_CLOCK_SKEW_MS > nowMs;
}

function stringClaim(value: unknown, max = 320): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

export interface OAuthIdentity {
  subject: string;
  email: string | null;
}

export type IdentityResult = { ok: true; identity: OAuthIdentity } | { ok: false; reason: string };

/** Personal accounts only: consumer tenant, Microsoft's issuer, our audience, not expired; subject = `oid`. */
export function microsoftIdentity(claims: Record<string, unknown>, clientId: string, nowMs: number): IdentityResult {
  if (claims.tid !== MICROSOFT_CONSUMER_TENANT_ID) return { ok: false, reason: 'tenant' };
  if (claims.iss !== MICROSOFT_ISSUER) return { ok: false, reason: 'issuer' };
  if (!audienceMatches(claims.aud, clientId)) return { ok: false, reason: 'audience' };
  if (!notExpired(claims.exp, nowMs)) return { ok: false, reason: 'expired' };
  const subject = stringClaim(claims.oid, 255);
  if (subject === null) return { ok: false, reason: 'subject' };
  const email = stringClaim(claims.email) ?? stringClaim(claims.preferred_username);
  return { ok: true, identity: { subject, email } };
}

// ---------------------------------------------------------------------------
// Scopes → capabilities
// ---------------------------------------------------------------------------

/** Graph scopes come back short (`Calendars.ReadWrite`) or resource-qualified; compare by name, case-insensitively. */
export function normalizeMicrosoftScope(scope: string): string {
  const lower = scope.toLowerCase();
  const slash = lower.lastIndexOf('/');
  return slash === -1 ? lower : lower.slice(slash + 1);
}

function normalizeAll(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map(normalizeMicrosoftScope).filter((s) => s.length > 0))].sort();
}

/** Granted scopes from the token response; an absent `scope` means the requested ones. */
export function grantedScopes(scope: string | undefined): string[] {
  return typeof scope === 'string' ? normalizeAll(scope.split(/\s+/)) : normalizeAll(MICROSOFT_STATIC_SCOPES);
}

/** The static build only offers the calendar. */
export function capabilitiesOf(granted: readonly string[]): Capability[] {
  return granted.includes('calendars.readwrite') ? ['calendar'] : [];
}
