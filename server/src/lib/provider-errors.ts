/**
 * Provider error vocabulary shared by the REST providers (Google Calendar, Microsoft Graph, Gmail):
 * {@link ProviderHttpError} (a mapped provider status that keeps the provider's reason codes and
 * `Retry-After` for logs and health, never for clients), the reason extraction from Google/Graph
 * error bodies ({@link providerErrorReasons}), the 403 classification ({@link classifyDenial}) and
 * small helpers for rate limits ({@link hasRateLimitReason}, {@link parseRetryAfter}).
 *
 * Moved here from `modules/calendar/providers/http.ts` (which re-exports them) so the mail module
 * and the health tracker (`outcomeFromError`) share one classification.
 */
import type { ErrorCode } from '@portly/shared';
import { HttpError } from './errors.ts';

/**
 * Why a provider answered 403 (rate limits are mapped to 429 before this):
 * - `api_disabled`: the API is not enabled for the OAuth client's Google Cloud project
 *   (`accessNotConfigured` / `SERVICE_DISABLED`) — every call fails until it is enabled;
 * - `insufficient_scope`: the token lacks a scope the call needs (`insufficientPermissions` /
 *   `ACCESS_TOKEN_SCOPE_INSUFFICIENT`) — the user has to reconnect and allow it;
 * - `denied`: anything else (no access to this calendar or event).
 */
export type ProviderDenial = 'api_disabled' | 'insufficient_scope' | 'denied';

export interface ProviderHttpErrorOptions {
  message: string;
  accountId: string;
  providerReason: string | null;
  denial?: ProviderDenial;
  /** Seconds from the provider's `Retry-After` (see {@link parseRetryAfter}); default null. */
  retryAfterSeconds?: number | null;
  /** The provider's own HTTP status when it differs from ours (e.g. 400 behind a 502); default null. */
  upstreamStatus?: number | null;
}

/** A mapped provider error status, with the provider's reason codes for logs (never sent to clients). */
export class ProviderHttpError extends HttpError {
  override name = 'ProviderHttpError';
  /** Provider reason codes, e.g. `PERMISSION_DENIED accessNotConfigured SERVICE_DISABLED`; null when none. */
  readonly providerReason: string | null;
  /** Classification of a 403; null for other statuses. */
  readonly denial: ProviderDenial | null;
  /** Seconds the provider asked us to wait (429 / throttled 403); null when it did not say. */
  readonly retryAfterSeconds: number | null;
  /** The provider's HTTP status (`errorFields` reports it as `upstreamStatus`); null when not kept. */
  readonly httpStatus: number | null;

  constructor(status: number, code: ErrorCode, options: ProviderHttpErrorOptions) {
    super(status, code, { message: options.message, accountId: options.accountId });
    this.providerReason = options.providerReason;
    this.denial = options.denial ?? null;
    this.retryAfterSeconds = finiteOrNull(options.retryAfterSeconds);
    this.httpStatus = finiteOrNull(options.upstreamStatus);
  }
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Reason codes look like `accessNotConfigured` or `SERVICE_DISABLED`; anything else is not kept. */
const REASON_TOKEN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_REASONS = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Google/Graph error reasons: Google's `error.status`, `error.errors[].reason` and
 * `error.details[].reason` (ErrorInfo), Graph's `error.code`. Only identifier-like tokens are
 * kept (deduplicated, at most {@link MAX_REASONS}); never shown to users.
 */
export function providerErrorReasons(data: unknown): string[] {
  if (!isRecord(data) || !isRecord(data.error)) return [];
  const e = data.error;
  const candidates: unknown[] = [e.status, e.code];
  for (const list of [e.errors, e.details]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) if (isRecord(item)) candidates.push(item.reason);
  }
  const reasons: string[] = [];
  for (const c of candidates) {
    if (typeof c === 'string' && REASON_TOKEN.test(c) && !reasons.includes(c)) reasons.push(c);
    if (reasons.length === MAX_REASONS) break;
  }
  return reasons;
}

const RATE_LIMIT_REASONS = /rateLimit|quota|ApplicationThrottled|TooManyRequests/i;
const API_DISABLED_REASONS = /^(accessNotConfigured|SERVICE_DISABLED)$/;
const INSUFFICIENT_SCOPE_REASONS = /^(insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient_scope)$/;

/** True when a 403's reasons mean "slow down" (`rateLimitExceeded`, `quotaExceeded`, Graph throttling …). */
export function hasRateLimitReason(reasons: readonly string[]): boolean {
  return reasons.some((r) => RATE_LIMIT_REASONS.test(r));
}

export function classifyDenial(reasons: readonly string[]): ProviderDenial {
  if (reasons.some((r) => API_DISABLED_REASONS.test(r))) return 'api_disabled';
  if (reasons.some((r) => INSUFFICIENT_SCOPE_REASONS.test(r))) return 'insufficient_scope';
  return 'denied';
}

/** Longest wait taken from a `Retry-After` header (a day). */
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

/**
 * `Retry-After` (delta seconds or an HTTP date) → whole seconds from `now` (≥ 0, ≤ a day); null
 * when absent or unreadable.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) return Math.min(Number(text), MAX_RETRY_AFTER_SECONDS);
  // An HTTP date names its weekday/month and zone (`Sun, 11 Oct 2026 12:00:30 GMT`); bare numbers are not dates.
  if (!/[A-Za-z]/.test(text)) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(0, Math.ceil((at - now) / 1000)), MAX_RETRY_AFTER_SECONDS);
}
