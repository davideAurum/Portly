/**
 * Spotify provider (§8 Spotify): the Web API's player endpoints, as a remote control of Spotify
 * Connect devices. Scopes `user-read-playback-state` and `user-modify-playback-state`. This file is
 * the server's transport; what the calls and answers mean is `spotify-mapping.ts`, which the
 * in-browser backend shares (ARCHITECTURE §16).
 *
 * Outbound purposes: `spotify.player.state`, `spotify.player.devices`, `spotify.player.<command>`.
 */
import { ERROR_STATUS } from '@portly/shared';
import type { AccountService } from '../../../context.ts';
import { HttpError, ProviderUnauthorizedError } from '../../../lib/errors.ts';
import { ProviderHttpError, parseRetryAfter } from '../../../lib/provider-errors.ts';
import { SIZE_CAPS, SafeFetchError, type SafeFetch } from '../../../security/safe-fetch.ts';
import {
  DEVICES_CALL,
  PLAYBACK_CALL,
  SPOTIFY_CALL_TIMEOUT_MS,
  SPOTIFY_FEATURES,
  SPOTIFY_MESSAGES,
  SPOTIFY_NAME,
  commandCall,
  mapDevices,
  mapPlayback,
  parseSpotifyBody,
  spotifyRefusal,
  spotifyUrl,
  type SpotifyCall,
} from './spotify-mapping.ts';
import type { MusicProvider } from './types.ts';

export interface SpotifyDeps {
  fetch: SafeFetch;
  accounts: AccountService;
}

/** The §7a error for a refused call. 401 is `ProviderUnauthorizedError`, for `withToken`. */
export function spotifyFailure(status: number, data: unknown, accountId: string, call: Pick<SpotifyCall, 'kind' | 'namesDevice'>, retryAfter: string | null, now?: number): Error {
  if (status === 401) return new ProviderUnauthorizedError(SPOTIFY_MESSAGES.tokenRejected);
  const { code, message, reason, providerReason } = spotifyRefusal(status, data, call);
  const retryAfterSeconds = parseRetryAfter(retryAfter, now);
  return new ProviderHttpError(ERROR_STATUS[code], code, {
    message,
    accountId,
    providerReason,
    retryAfterSeconds,
    upstreamStatus: status,
    details: { ...(reason === undefined ? {} : { reason }), ...(code === 'rate_limited' ? { retryAfterSeconds } : {}) },
    ...(status === 403 && call.kind === 'read' ? { denial: 'denied' as const } : {}),
  });
}

export function createSpotifyProvider(deps: SpotifyDeps): MusicProvider {
  /** Runs an authorized call (retried once on 401 by `withToken`); resolves with the parsed body. */
  const request = (accountId: string, call: SpotifyCall): Promise<unknown> =>
    deps.accounts.withToken(accountId, async (token) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      let body: string | undefined;
      if (call.body !== undefined) {
        body = JSON.stringify(call.body);
        headers['Content-Type'] = 'application/json';
      }
      let res: { status: number; headers: Headers; data: string };
      try {
        res = await deps.fetch(spotifyUrl(call), {
          policy: 'provider',
          as: 'text',
          maxBytes: SIZE_CAPS.json,
          method: call.method,
          headers,
          ...(body === undefined ? {} : { body }),
          timeoutMs: SPOTIFY_CALL_TIMEOUT_MS,
          redirect: 'error',
          purpose: call.purpose,
        });
      } catch (err) {
        if (err instanceof SafeFetchError) {
          throw new HttpError(err.status, err.code, { message: err.code === 'upstream_timeout' ? SPOTIFY_MESSAGES.timeout : SPOTIFY_MESSAGES.unreachable, accountId, cause: err });
        }
        throw err;
      }
      const parsed = parseSpotifyBody(res.data);
      if (res.status < 200 || res.status >= 300) {
        throw spotifyFailure(res.status, parsed.ok ? parsed.value : null, accountId, call, res.headers.get('retry-after'));
      }
      if (!parsed.ok) {
        // A command's answer is not read: only a read depends on the body.
        if (call.kind === 'command') return null;
        const cause = new SafeFetchError('invalid_json', 'Invalid JSON from api.spotify.com', 'api.spotify.com');
        throw new HttpError(502, 'provider_error', { message: SPOTIFY_MESSAGES.unreadable, accountId, cause });
      }
      return parsed.value;
    });

  return {
    displayName: SPOTIFY_NAME,
    features: SPOTIFY_FEATURES,

    async playback(accountId) {
      const data = await request(accountId, PLAYBACK_CALL);
      return data === null ? null : mapPlayback(data);
    },

    async devices(accountId) {
      return mapDevices(await request(accountId, DEVICES_CALL));
    },

    async send(accountId, command) {
      await request(accountId, commandCall(command));
    },
  };
}
