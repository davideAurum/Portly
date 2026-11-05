/**
 * Spotify OAuth (§4.7, §8 Spotify): authorization code with PKCE as a public client, so no client
 * secret. Spotify has no OpenID Connect: there is no `id_token`, so the identity comes from
 * `GET /me` with the new access token ({@link spotify}'s `fetchIdentity`). The stable subject is
 * `account_id`, which Spotify says to prefer for linking accounts, else `id`.
 *
 * Differences from the other providers:
 * - the redirect URI must be a loopback IP literal: Spotify refuses `localhost` (`config.ts`);
 * - a refresh may or may not return a new refresh token (the service handles both), and refresh
 *   tokens last six months whatever happens, so an account needs `reauth` about twice a year;
 * - there is no token revocation endpoint: removing the account forgets the tokens, and the user
 *   can withdraw access on their Spotify account page;
 * - a developer app works only while its owner has Premium, and only for the accounts on its user
 *   list, so `GET /me` can answer 403 right after a sign-in that looked fine (`not_allowed`).
 */
import type { Capability } from '@portly/shared';
import { z } from 'zod';
import { errorFields } from '../../../lib/logger.ts';
import { SIZE_CAPS } from '../../../security/safe-fetch.ts';
import type { OAuthProviderSpec } from './types.ts';

export const SPOTIFY_AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_PROFILE_ENDPOINT = 'https://api.spotify.com/v1/me';

/** Read what is playing and on which device, and control it. Nothing else of the account. */
export const SPOTIFY_SCOPE_READ_PLAYBACK = 'user-read-playback-state';
export const SPOTIFY_SCOPE_MODIFY_PLAYBACK = 'user-modify-playback-state';

export const SPOTIFY_CAPABILITY_SCOPES = Object.freeze({
  music: [SPOTIFY_SCOPE_READ_PLAYBACK, SPOTIFY_SCOPE_MODIFY_PLAYBACK],
} as const satisfies Partial<Record<Capability, readonly string[]>>);

export const SPOTIFY_SCOPES = [...SPOTIFY_CAPABILITY_SCOPES.music] as const;

const SPOTIFY_CLIENT_ID = /^[0-9a-f]{32}$/i;
const PROFILE_TIMEOUT_MS = 10_000;
/** Longest display name kept as the account's label. */
const MAX_LABEL = 100;

const ProfileSchema = z.looseObject({
  id: z.string().min(1).max(255),
  account_id: z.string().min(1).max(255).nullish(),
  display_name: z.string().nullish(),
});

export const spotify: OAuthProviderSpec = Object.freeze<OAuthProviderSpec>({
  provider: 'spotify',
  displayName: 'Spotify',
  defaultLabel: 'Spotify account',
  authorizeEndpoint: SPOTIFY_AUTHORIZE_ENDPOINT,
  tokenEndpoint: SPOTIFY_TOKEN_ENDPOINT,
  revokeEndpoint: null,
  scopes: SPOTIFY_SCOPES,
  baseScopes: [],
  capabilityScopes: SPOTIFY_CAPABILITY_SCOPES,
  usesClientSecret: false,
  clientIdHint: 'Spotify client IDs are 32 letters and digits, from the app’s Settings page.',

  isValidClientId(clientId: string): boolean {
    return SPOTIFY_CLIENT_ID.test(clientId);
  },

  authorizeParams({ clientId, redirectUri, state, codeChallenge, scopes }) {
    return {
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    };
  },

  // Public client: `client_id` is already in the request; Spotify wants no scope at the token endpoint.
  tokenParams() {
    return {};
  },

  // Never called: `fetchIdentity` answers for this provider.
  identity() {
    return { ok: false, reason: 'no_id_token' };
  },

  async fetchIdentity(accessToken, fetch, log) {
    let res;
    try {
      res = await fetch(SPOTIFY_PROFILE_ENDPOINT, {
        policy: 'provider',
        purpose: 'oauth.identity',
        as: 'text',
        maxBytes: SIZE_CAPS.json,
        timeoutMs: PROFILE_TIMEOUT_MS,
        redirect: 'error',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
    } catch (err) {
      log.warn('oauth profile request failed', { provider: 'spotify', ...errorFields(err) });
      return { ok: false, reason: 'profile_unreachable' };
    }
    // The developer app's owner has no Premium, or this account is not on the app's user list.
    if (res.status === 403) return { ok: false, reason: 'not_allowed' };
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: `profile_http_${res.status}` };
    let data: unknown;
    try {
      data = JSON.parse(res.data);
    } catch {
      return { ok: false, reason: 'profile_unreadable' };
    }
    const profile = ProfileSchema.safeParse(data);
    if (!profile.success) return { ok: false, reason: 'profile_unreadable' };
    const name = profile.data.display_name?.trim().slice(0, MAX_LABEL) ?? '';
    return {
      ok: true,
      identity: { subject: profile.data.account_id ?? profile.data.id, email: null, label: name === '' ? null : name },
    };
  },

  grantedScopes(scope) {
    if (typeof scope !== 'string') return null;
    return [...new Set(scope.split(/\s+/).filter((s) => s.length > 0))].sort();
  },

  // Reading without controlling is not a player: music needs both.
  capabilities(granted) {
    return SPOTIFY_SCOPES.every((scope) => granted.includes(scope)) ? ['music'] : [];
  },
});
