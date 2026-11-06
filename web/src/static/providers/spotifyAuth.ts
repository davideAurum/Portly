/**
 * Spotify sign-in for the static backend: the browser itself is the OAuth client (authorization
 * code with PKCE, no secret). A port of server/src/modules/accounts/oauth/spotify.ts, whose comment
 * lists Spotify's differences from the other providers. In the browser:
 *
 * - the redirect URI is the site's own address, an `https` one, which Spotify takes as it is (only
 *   the server needs a loopback IP literal). One Spotify app can list both;
 * - there is no `prompt=none`: a sign-in that has ended is a click on Reconnect, about twice a year
 *   ({@link SPOTIFY_SESSION_MS});
 * - `GET /me` goes from the page, so the Pages CSP has `api.spotify.com` and `accounts.spotify.com`
 *   in `connect-src`, and a request that gets no answer is a `provider` event like any other.
 *
 * The profile's fields are hostile input like everything from Spotify (§4.4); the access token is
 * sent to Spotify alone and never logged.
 */
import type { Capability } from '@portly/shared';
import { z } from 'zod';
import { fetchTextCapped } from '../lib/fetch.ts';
import { errorName, hostOf, recordProviderFailure, statusFailureCode, stopwatch, transportFailureCode } from './diagnostics.ts';
import { requestTokenFrom, type TokenEndpointResult } from './oauthToken.ts';

export const SPOTIFY_AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_PROFILE_ENDPOINT = 'https://api.spotify.com/v1/me';

/** Read what is playing and on which device, and control it. Nothing else of the account. */
export const SPOTIFY_SCOPES = Object.freeze(['user-read-playback-state', 'user-modify-playback-state'] as const);

export const SPOTIFY_DISPLAY_NAME = 'Spotify';
export const SPOTIFY_DEFAULT_LABEL = 'Spotify account';
export const SPOTIFY_CLIENT_ID_REGEX = /^[0-9a-f]{32}$/i;

/** Refresh tokens last six months whatever happens: a refresh does not extend them. */
export const SPOTIFY_SESSION_MS = 183 * 24 * 60 * 60 * 1000;

const PROFILE_TIMEOUT_MS = 10_000;
const PROFILE_MAX_BYTES = 256 * 1024;
/** Longest display name kept as the account's label. */
const MAX_LABEL = 100;

const ProfileSchema = z.looseObject({
  id: z.string().min(1).max(255),
  account_id: z.string().min(1).max(255).nullish(),
  display_name: z.string().nullish(),
});

export interface SpotifyAuthorizeInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export function spotifyAuthorizeUrl(input: SpotifyAuthorizeInput): string {
  const url = new URL(SPOTIFY_AUTHORIZE_ENDPOINT);
  const params: Record<string, string> = {
    client_id: input.clientId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    scope: SPOTIFY_SCOPES.join(' '),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

export function requestSpotifyToken(params: Record<string, string>): Promise<TokenEndpointResult> {
  return requestTokenFrom('spotify', SPOTIFY_TOKEN_ENDPOINT, params);
}

export type SpotifyIdentity = { ok: true; subject: string; label: string | null } | { ok: false; reason: 'not_allowed' | 'unreachable' | 'refused' | 'unreadable' };

/**
 * Who signed in: `account_id`, which Spotify says to prefer for linking accounts, else `id`. A 403
 * means the developer app's owner has no Premium or this account is not on the app's user list.
 */
export async function fetchSpotifyIdentity(accessToken: string): Promise<SpotifyIdentity> {
  const host = hostOf(SPOTIFY_PROFILE_ENDPOINT);
  const elapsed = stopwatch();
  let res: { status: number; text: string };
  try {
    res = await fetchTextCapped(
      SPOTIFY_PROFILE_ENDPOINT,
      { redirect: 'error', credentials: 'omit', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
      { timeoutMs: PROFILE_TIMEOUT_MS, maxBytes: PROFILE_MAX_BYTES },
    );
  } catch (err) {
    recordProviderFailure('spotify', host, { code: transportFailureCode(err) ?? 'aborted', errName: errorName(err), ms: elapsed() });
    return { ok: false, reason: 'unreachable' };
  }
  if (res.status < 200 || res.status >= 300) {
    recordProviderFailure('spotify', host, { status: res.status, code: res.status === 403 ? 'not_allowed' : statusFailureCode(res.status), ms: elapsed() });
    return { ok: false, reason: res.status === 403 ? 'not_allowed' : 'refused' };
  }
  let data: unknown;
  try {
    data = JSON.parse(res.text);
  } catch {
    data = null;
  }
  const profile = ProfileSchema.safeParse(data);
  if (!profile.success) {
    recordProviderFailure('spotify', host, { status: res.status, code: 'parse_error', ms: elapsed() });
    return { ok: false, reason: 'unreadable' };
  }
  const name = profile.data.display_name?.trim().slice(0, MAX_LABEL) ?? '';
  return { ok: true, subject: profile.data.account_id ?? profile.data.id, label: name === '' ? null : name };
}

/** The scopes in a token answer, sorted and without repeats; null when it names none. */
export function spotifyGrantedScopes(scope: string | undefined): string[] | null {
  if (typeof scope !== 'string') return null;
  return [...new Set(scope.split(/\s+/).filter((s) => s.length > 0))].sort();
}

/** Reading without controlling is not a player: music needs both. */
export function spotifyCapabilities(granted: readonly string[]): Capability[] {
  return SPOTIFY_SCOPES.every((scope) => granted.includes(scope)) ? ['music'] : [];
}
