/**
 * Google OAuth (§4.7, §8): *Web application* client (the client secret is required at the token
 * endpoint), PKCE S256, offline access with forced consent so a refresh token is always issued,
 * incremental grants (`include_granted_scopes`: a sign-in for one more service keeps the ones
 * already granted). Partial grants are read from the token response's `scope`.
 */
import type { Capability } from '@portly/shared';
import { audienceMatches, notExpired, stringClaim } from './id-token.ts';
import type { OAuthProviderSpec } from './types.ts';

export const GOOGLE_SCOPE_CALENDAR_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
export const GOOGLE_SCOPE_CALENDAR_LIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
export const GOOGLE_SCOPE_GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

/** Identity scopes, asked for on every sign-in. */
export const GOOGLE_BASE_SCOPES = ['openid', 'email', 'profile'] as const;

/** The scopes of each service. */
export const GOOGLE_CAPABILITY_SCOPES = Object.freeze({
  calendar: [GOOGLE_SCOPE_CALENDAR_EVENTS, GOOGLE_SCOPE_CALENDAR_LIST],
  mail: [GOOGLE_SCOPE_GMAIL_MODIFY],
} as const satisfies Record<Capability, readonly string[]>);

/** Every scope (all services): what a sign-in asks for when it names no services. */
export const GOOGLE_SCOPES = [...GOOGLE_BASE_SCOPES, ...GOOGLE_CAPABILITY_SCOPES.calendar, ...GOOGLE_CAPABILITY_SCOPES.mail] as const;

export const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const GOOGLE_CLIENT_ID = /^[A-Za-z0-9-]{1,200}\.apps\.googleusercontent\.com$/;

export const google: OAuthProviderSpec = Object.freeze<OAuthProviderSpec>({
  provider: 'google',
  displayName: 'Google',
  defaultLabel: 'Google account',
  authorizeEndpoint: GOOGLE_AUTHORIZE_ENDPOINT,
  tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
  revokeEndpoint: GOOGLE_REVOKE_ENDPOINT,
  scopes: GOOGLE_SCOPES,
  baseScopes: GOOGLE_BASE_SCOPES,
  capabilityScopes: GOOGLE_CAPABILITY_SCOPES,
  usesClientSecret: true,

  isValidClientId(clientId: string): boolean {
    return GOOGLE_CLIENT_ID.test(clientId);
  },

  authorizeParams({ clientId, redirectUri, state, codeChallenge, scopes }) {
    return {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    };
  },

  tokenParams(client): Record<string, string> {
    return client.clientSecret === null ? {} : { client_secret: client.clientSecret };
  },

  identity(claims, clientId, nowMs) {
    if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) return { ok: false, reason: 'issuer' };
    if (!audienceMatches(claims.aud, clientId)) return { ok: false, reason: 'audience' };
    if (!notExpired(claims.exp, nowMs)) return { ok: false, reason: 'expired' };
    const subject = stringClaim(claims.sub, 255);
    if (subject === null) return { ok: false, reason: 'subject' };
    const email = claims.email_verified === false ? null : stringClaim(claims.email);
    return { ok: true, identity: { subject, email } };
  },

  grantedScopes(scope) {
    if (typeof scope !== 'string') return null;
    return [...new Set(scope.split(/\s+/).filter((s) => s.length > 0))].sort();
  },

  capabilities(granted) {
    const caps: Capability[] = [];
    if (granted.includes(GOOGLE_SCOPE_CALENDAR_EVENTS)) caps.push('calendar');
    if (granted.includes(GOOGLE_SCOPE_GMAIL_MODIFY)) caps.push('mail');
    return caps;
  },
});
