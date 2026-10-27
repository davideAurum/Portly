/**
 * Microsoft OAuth for personal accounts (§4.7, §8): the `/consumers` authority is hard-coded,
 * the app is a *public client* (Mobile and desktop platform) — PKCE only, no client secret —
 * and the id_token must come from the consumer tenant. Refresh tokens rotate; the service
 * persists each rotation.
 *
 * Incremental consent: a sign-in asks for the services picked (a reconnect: the account's granted
 * services plus the new ones), and the token endpoint is sent the same scopes. A refresh asks for
 * the scopes of the account's granted services only: Microsoft refuses a refresh for more than
 * was consented to.
 */
import { MICROSOFT_CONSUMER_TENANT_ID, type Capability } from '@portly/shared';
import { audienceMatches, notExpired, stringClaim } from './id-token.ts';
import type { OAuthProviderSpec } from './types.ts';

export const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/consumers';
export const MICROSOFT_AUTHORIZE_ENDPOINT = `${MICROSOFT_AUTHORITY}/oauth2/v2.0/authorize`;
export const MICROSOFT_TOKEN_ENDPOINT = `${MICROSOFT_AUTHORITY}/oauth2/v2.0/token`;
export const MICROSOFT_ISSUER = `https://login.microsoftonline.com/${MICROSOFT_CONSUMER_TENANT_ID}/v2.0`;

/** Identity, offline access (a refresh token) and the profile: asked for on every sign-in. */
export const MICROSOFT_BASE_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read'] as const;

/** The Graph scopes of each service the server offers (launch pad sync is the browser-only build's). */
export const MICROSOFT_CAPABILITY_SCOPES = Object.freeze({
  calendar: ['Calendars.ReadWrite'],
  mail: ['Mail.ReadWrite'],
} as const satisfies Partial<Record<Capability, readonly string[]>>);

/** Every scope (all services): what a sign-in asks for when it names no services. */
export const MICROSOFT_SCOPES = [...MICROSOFT_BASE_SCOPES, ...MICROSOFT_CAPABILITY_SCOPES.calendar, ...MICROSOFT_CAPABILITY_SCOPES.mail] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Graph scopes come back either short (`Mail.ReadWrite`) or resource-qualified
 * (`https://graph.microsoft.com/Mail.ReadWrite`); compare them case-insensitively by name.
 */
export function normalizeMicrosoftScope(scope: string): string {
  const lower = scope.toLowerCase();
  const slash = lower.lastIndexOf('/');
  return slash === -1 ? lower : lower.slice(slash + 1);
}

function normalizeAll(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map(normalizeMicrosoftScope).filter((s) => s.length > 0))].sort();
}

export const microsoft: OAuthProviderSpec = Object.freeze<OAuthProviderSpec>({
  provider: 'microsoft',
  displayName: 'Microsoft',
  defaultLabel: 'Outlook.com account',
  authorizeEndpoint: MICROSOFT_AUTHORIZE_ENDPOINT,
  tokenEndpoint: MICROSOFT_TOKEN_ENDPOINT,
  revokeEndpoint: null,
  scopes: MICROSOFT_SCOPES,
  baseScopes: MICROSOFT_BASE_SCOPES,
  capabilityScopes: MICROSOFT_CAPABILITY_SCOPES,
  usesClientSecret: false,

  isValidClientId(clientId: string): boolean {
    return UUID.test(clientId);
  },

  authorizeParams({ clientId, redirectUri, state, codeChallenge, scopes }) {
    return {
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    };
  },

  // Public client: never a secret; the scope is repeated at the token endpoint.
  tokenParams(_client, scopes) {
    return { scope: scopes.join(' ') };
  },

  identity(claims, clientId, nowMs) {
    if (claims.tid !== MICROSOFT_CONSUMER_TENANT_ID) return { ok: false, reason: 'tenant' };
    if (claims.iss !== MICROSOFT_ISSUER) return { ok: false, reason: 'issuer' };
    if (!audienceMatches(claims.aud, clientId)) return { ok: false, reason: 'audience' };
    if (!notExpired(claims.exp, nowMs)) return { ok: false, reason: 'expired' };
    const subject = stringClaim(claims.oid, 255);
    if (subject === null) return { ok: false, reason: 'subject' };
    const email = stringClaim(claims.email) ?? stringClaim(claims.preferred_username);
    return { ok: true, identity: { subject, email } };
  },

  // Absent `scope` means the token covers the requested scopes (Microsoft identity platform docs).
  grantedScopes(scope, requested) {
    return typeof scope === 'string' ? normalizeAll(scope.split(/\s+/)) : normalizeAll(requested);
  },

  capabilities(granted) {
    const caps: Capability[] = [];
    if (granted.includes('calendars.readwrite')) caps.push('calendar');
    if (granted.includes('mail.readwrite')) caps.push('mail');
    return caps;
  },
});
