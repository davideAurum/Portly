/**
 * Microsoft sign-in for the static backend: the browser itself is the OAuth client (a
 * *single-page application* registration, PKCE S256, no secret, personal accounts through the
 * `/consumers` authority). Ports of server/src/modules/accounts/oauth/microsoft.ts (endpoints,
 * id_token rules, scope → capability mapping) and id-token.ts (claim decoding), with the browser
 * differences:
 *
 * - the services are the calendar and launch pad sync (`Files.ReadWrite.AppFolder`); mail is not
 *   part of the static build, so the scopes leave out `Mail.ReadWrite`; like the server, a sign-in
 *   asks for the scopes of the services picked
 *   ({@link scopesFor}) and a refresh only for services the account's last sign-in asked for
 *   (Microsoft's reported grants list more, see {@link capabilitiesOf});
 * - Microsoft only redeems a code or refresh token from a browser origin for a redirect URI
 *   registered as "Single-page application", and such refresh tokens stop working 24 hours after
 *   the interactive sign-in ({@link SPA_SESSION_MS}; `refresh_token_expires_in` when present);
 * - `prompt=none` builds the automatic re-sign-in that renews that session without a click.
 *
 * The token request itself is `oauthToken.ts`, shared with Spotify's sign-in.
 */
import { CAPABILITIES, MICROSOFT_CONSUMER_TENANT_ID, type Capability } from '@portly/shared';
import { requestTokenFrom, type TokenEndpointResult } from './oauthToken.ts';

export { TOKEN_RESPONSE_MAX_BYTES, TOKEN_TIMEOUT_MS, classifyTokenFailure, pkceChallenge } from './oauthToken.ts';
export type { TokenEndpointResult, TokenFailure, TokenSet } from './oauthToken.ts';

export const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/consumers';
export const MICROSOFT_AUTHORIZE_ENDPOINT = `${MICROSOFT_AUTHORITY}/oauth2/v2.0/authorize`;
export const MICROSOFT_TOKEN_ENDPOINT = `${MICROSOFT_AUTHORITY}/oauth2/v2.0/token`;
export const MICROSOFT_ISSUER = `https://login.microsoftonline.com/${MICROSOFT_CONSUMER_TENANT_ID}/v2.0`;

/** Identity, offline access and the profile: asked for on every sign-in (the server's base scopes). */
export const MICROSOFT_STATIC_BASE_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read'] as const;

/**
 * The Graph scopes of each service the static build offers: the server's calendar (no mail), and
 * launch pad sync, which reaches the app's own folder in OneDrive and nothing else.
 */
export const MICROSOFT_STATIC_CAPABILITY_SCOPES: Readonly<Partial<Record<Capability, readonly string[]>>> = Object.freeze({
  calendar: ['Calendars.ReadWrite'],
  launchpadSync: ['Files.ReadWrite.AppFolder'],
});

/** The services a static-build sign-in can ask for. */
export const MICROSOFT_STATIC_CAPABILITIES: readonly Capability[] = Object.freeze(
  CAPABILITIES.filter((c) => MICROSOFT_STATIC_CAPABILITY_SCOPES[c] !== undefined),
);

/**
 * What a sign-in that names no services asks for: the calendar. Launch pad sync is only ever asked
 * for when it was picked, so a connection without it never asks for the OneDrive permission.
 */
export const MICROSOFT_STATIC_DEFAULT_CAPABILITIES: readonly Capability[] = Object.freeze(['calendar']);

/** The scopes for these services: the base scopes, then each offered service's, in capability order. */
export function scopesFor(capabilities: readonly Capability[]): string[] {
  const scopes: string[] = [...MICROSOFT_STATIC_BASE_SCOPES];
  for (const capability of CAPABILITIES) {
    if (!capabilities.includes(capability)) continue;
    for (const scope of MICROSOFT_STATIC_CAPABILITY_SCOPES[capability] ?? []) if (!scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

/** Every scope the static build may ask for: the server's minus `Mail.ReadWrite`, plus the app folder. */
export const MICROSOFT_STATIC_SCOPES: readonly string[] = Object.freeze(scopesFor(MICROSOFT_STATIC_CAPABILITIES));

export const MICROSOFT_DISPLAY_NAME = 'Microsoft';
export const MICROSOFT_DEFAULT_LABEL = 'Outlook.com account';

export const CLIENT_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a single-page app's sign-in lasts when Microsoft does not say (`refresh_token_expires_in`). */
export const SPA_SESSION_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// PKCE and the authorization request
// ---------------------------------------------------------------------------

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  /** The scopes to ask for ({@link scopesFor} of the services picked). */
  scopes: readonly string[];
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
    scope: input.scopes.join(' '),
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
// Token endpoint
// ---------------------------------------------------------------------------

export function requestToken(params: Record<string, string>): Promise<TokenEndpointResult> {
  return requestTokenFrom('microsoft', MICROSOFT_TOKEN_ENDPOINT, params);
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

/** Scopes normalized ({@link normalizeMicrosoftScope}), deduplicated and sorted: how an account stores them. */
export function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map(normalizeMicrosoftScope).filter((s) => s.length > 0))].sort();
}

/** Granted scopes from the token response; an absent `scope` means the requested ones. */
export function grantedScopes(scope: string | undefined, requested: readonly string[] = MICROSOFT_STATIC_SCOPES): string[] {
  return typeof scope === 'string' ? normalizeScopes(scope.split(/\s+/)) : normalizeScopes(requested);
}

/**
 * The offered services whose scopes are all in `scopes` (normalized). Pass the scopes a sign-in both
 * asked for and was granted, never the grant alone: Microsoft's `scope` lists every permission the
 * account ever granted the registration, also ones this sign-in did not ask for, and a refresh that
 * asks for those fails with `invalid_grant`.
 */
export function capabilitiesOf(scopes: readonly string[]): Capability[] {
  return MICROSOFT_STATIC_CAPABILITIES.filter((c) => (MICROSOFT_STATIC_CAPABILITY_SCOPES[c] ?? []).every((scope) => scopes.includes(normalizeMicrosoftScope(scope))));
}
