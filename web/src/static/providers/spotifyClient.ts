/**
 * Spotify's player API from the browser, with the account's token from its sign-in
 * (handlers/accounts.ts). What the calls and answers mean is `spotifyMapping.ts`, the server's own
 * mapping byte for byte; this file is the transport, in the shape of `graphClient.ts`:
 *
 * - a 401 refreshes the token once (unless another caller already did) and retries; a second 401
 *   means the account must be reconnected (`409 reauth_required`, the server's `withToken`);
 * - a failed request is a `provider` event: status and reason code, never the URL, a device, a
 *   token or what is playing. Answers about what is playing right now (no active device, a command
 *   refused for this item, a device gone) say nothing about the connection and are not recorded;
 * - `Retry-After` is used when the browser can read it, which depends on Spotify exposing the
 *   header across origins. When it cannot, a 429 waits {@link SPOTIFY_DEFAULT_RETRY_AFTER_S}.
 */
import type { MusicCommand, MusicDevice, MusicPlayback } from '@portly/shared';
import { getAccessToken, rejectFreshToken } from '../handlers/accounts.ts';
import type { StaticContext } from '../context.ts';
import { fetchTextCapped, upstreamFailure } from '../lib/fetch.ts';
import { StaticApiError } from '../respond.ts';
import { errorName, hostOf, recordProviderFailure, statusFailureCode, stopwatch, transportFailureCode } from './diagnostics.ts';
import { parseRetryAfter } from './graphClient.ts';
import {
  DEVICES_CALL,
  PLAYBACK_CALL,
  SPOTIFY_API,
  SPOTIFY_CALL_TIMEOUT_MS,
  SPOTIFY_MESSAGES,
  SPOTIFY_NAME,
  commandCall,
  mapDevices,
  mapPlayback,
  parseSpotifyBody,
  spotifyRefusal,
  spotifyUrl,
  type SpotifyCall,
  type SpotifyRefusal,
} from './spotifyMapping.ts';

export const SPOTIFY_HOST = hostOf(SPOTIFY_API);
/** Cap for one answer (the server's JSON default). */
export const SPOTIFY_MAX_BYTES = 5 * 1024 * 1024;
/** How long to wait after a 429 when the browser cannot read how long Spotify asked for. */
export const SPOTIFY_DEFAULT_RETRY_AFTER_S = 30;

/** A refused call; a 429 also says how long nothing should be sent. */
export class SpotifyHttpError extends StaticApiError {
  override name = 'SpotifyHttpError';
  readonly retryAfterSeconds: number | null;

  constructor(refusal: SpotifyRefusal, accountId: string, retryAfterSeconds: number | null) {
    const details = { ...(refusal.reason === undefined ? {} : { reason: refusal.reason }), ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }) };
    super(refusal.code, refusal.message, details, accountId);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface Attempt {
  status: number;
  headers: Headers;
  text: string;
  ms: number;
}

async function send(accountId: string, call: SpotifyCall, token: string): Promise<Attempt> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  let body: string | undefined;
  if (call.body !== undefined) {
    body = JSON.stringify(call.body);
    headers['Content-Type'] = 'application/json';
  }
  const elapsed = stopwatch();
  try {
    const res = await fetchTextCapped(
      spotifyUrl(call),
      { method: call.method, headers, body, redirect: 'error', credentials: 'omit' },
      { timeoutMs: SPOTIFY_CALL_TIMEOUT_MS, maxBytes: SPOTIFY_MAX_BYTES },
    );
    return { status: res.status, headers: res.headers, text: res.text, ms: elapsed() };
  } catch (err) {
    const code = transportFailureCode(err);
    if (code !== null) recordProviderFailure('spotify', SPOTIFY_HOST, { code, errName: errorName(err), ms: elapsed() });
    const failure = upstreamFailure(err, SPOTIFY_NAME);
    throw new StaticApiError(failure.code, failure.message, failure.details, accountId);
  }
}

/** The event's reason code of a refusal: Spotify's own reason where it gave one. */
function refusalCode(refusal: SpotifyRefusal, status: number): string {
  return refusal.providerReason ?? statusFailureCode(status);
}

/** Refusals about what is playing right now, not about the connection. */
function aboutThePlayer(refusal: SpotifyRefusal): boolean {
  return refusal.reason === 'no_active_device' || refusal.reason === 'not_allowed' || refusal.reason === 'device_unavailable';
}

function refused(ctx: StaticContext, accountId: string, call: SpotifyCall, attempt: Attempt, data: unknown): SpotifyHttpError {
  const refusal = spotifyRefusal(attempt.status, data, call);
  if (!aboutThePlayer(refusal)) recordProviderFailure('spotify', SPOTIFY_HOST, { status: attempt.status, code: refusalCode(refusal, attempt.status), ms: attempt.ms });
  const retryAfter = refusal.code === 'rate_limited' ? (parseRetryAfter(attempt.headers.get('retry-after'), ctx.now()) ?? SPOTIFY_DEFAULT_RETRY_AFTER_S) : null;
  return new SpotifyHttpError(refusal, accountId, retryAfter);
}

/** One call with the account's token (one refresh-and-retry on 401); resolves with the parsed body. */
async function request(ctx: StaticContext, accountId: string, call: SpotifyCall): Promise<unknown> {
  const token = await getAccessToken(ctx, accountId);
  let attempt = await send(accountId, call, token);
  if (attempt.status === 401) {
    const fresh = await getAccessToken(ctx, accountId, { rejected: token });
    attempt = await send(accountId, call, fresh);
    if (attempt.status === 401) {
      recordProviderFailure('spotify', SPOTIFY_HOST, { status: 401, code: 'token_rejected' });
      throw await rejectFreshToken(ctx, accountId);
    }
  }
  const parsed = parseSpotifyBody(attempt.text);
  if (attempt.status < 200 || attempt.status >= 300) throw refused(ctx, accountId, call, attempt, parsed.ok ? parsed.value : null);
  if (parsed.ok) return parsed.value;
  // A command's answer is not read: only a read depends on the body.
  if (call.kind === 'command') return null;
  recordProviderFailure('spotify', SPOTIFY_HOST, { status: attempt.status, code: 'parse_error', ms: attempt.ms });
  throw new StaticApiError('provider_error', SPOTIFY_MESSAGES.unreadable, { reason: 'parse_error' }, accountId);
}

export async function spotifyPlayback(ctx: StaticContext, accountId: string): Promise<MusicPlayback | null> {
  const data = await request(ctx, accountId, PLAYBACK_CALL);
  return data === null ? null : mapPlayback(data);
}

export async function spotifyDevices(ctx: StaticContext, accountId: string): Promise<MusicDevice[]> {
  return mapDevices(await request(ctx, accountId, DEVICES_CALL));
}

export async function spotifySend(ctx: StaticContext, accountId: string, command: MusicCommand): Promise<void> {
  await request(ctx, accountId, commandCall(command));
}
