/**
 * JSON calls to fixed vendor endpoints (Google Calendar, Microsoft Graph) through safe-fetch's
 * `provider` policy, with §7a error mapping: 401 → ProviderUnauthorizedError (AccountService
 * refreshes once and retries), 429 → rate_limited, 403 → forbidden (classified, see
 * {@link ProviderDenial}), 5xx/other → provider_error, timeouts → upstream_timeout (from
 * safe-fetch). Provider response text is never reflected to the client; the provider's error
 * reason codes, its HTTP status and its `Retry-After` are kept on {@link ProviderHttpError} for logs
 * and health only (`outcomeFromError`: `nextAttemptAt`, `http_4xx`/`http_5xx`/`not_found`).
 */
import type { ErrorCode } from '@portly/shared';
import { HttpError, ProviderUnauthorizedError } from '../../../lib/errors.ts';
import {
  ProviderHttpError,
  classifyDenial,
  hasRateLimitReason,
  parseRetryAfter,
  providerErrorReasons,
  type ProviderDenial,
} from '../../../lib/provider-errors.ts';
import type { SafeFetch } from '../../../security/safe-fetch.ts';

export interface ProviderCallOptions {
  method?: string;
  token: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Display name for messages ("Google", "Outlook.com"). */
  provider: string;
  /** What the call is for (`gcal.events.list`, `graph.calendarView` …), logged with the host by safe-fetch. */
  purpose?: string;
  accountId: string;
  /** Statuses returned as `{status, data}` instead of throwing (e.g. 404/410 on delete). */
  allowStatuses?: readonly number[];
  timeoutMs?: number;
  /** Decoded-size cap (default safe-fetch's JSON cap, 5 MB); listings pass {@link LISTING_MAX_BYTES}. */
  maxBytes?: number;
}

/** Cap for one page of a provider listing (a busy calendar's page can pass the 5 MB JSON default). */
export const LISTING_MAX_BYTES = 16 * 1024 * 1024;

export interface ProviderResponse {
  status: number;
  data: unknown;
}

// ProviderHttpError, providerErrorReasons and classifyDenial live in lib/provider-errors.ts (shared
// with the mail module and the health tracker); re-exported so calendar code keeps importing them here.
export { ProviderHttpError, classifyDenial, providerErrorReasons } from '../../../lib/provider-errors.ts';
export type { ProviderDenial } from '../../../lib/provider-errors.ts';

/** User-facing message for a 403; reads never talk about "changes". */
function denialMessage(name: string, denial: ProviderDenial, method: string): string {
  switch (denial) {
    case 'api_disabled':
      return `The ${name} API is not enabled for the Google Cloud project of your OAuth client; enable it in the Google Cloud console, then sync again`;
    case 'insufficient_scope':
      return `${name} access was not granted to Portly; reconnect the account and allow calendar access`;
    case 'denied':
      return method === 'GET' ? `${name} denied Portly access to this calendar` : `${name} does not allow this change`;
  }
}

export async function providerCall(fetch: SafeFetch, url: string, options: ProviderCallOptions): Promise<ProviderResponse> {
  const headers: Record<string, string> = { Authorization: `Bearer ${options.token}`, ...options.headers };
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }
  const method = options.method ?? 'GET';
  const res = await fetch(url, {
    method,
    headers,
    body,
    policy: 'provider',
    as: 'json',
    redirect: 'error',
    timeoutMs: options.timeoutMs ?? 20_000,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
  });
  const { status } = res;
  if ((status >= 200 && status < 300) || options.allowStatuses?.includes(status)) return { status, data: res.data };

  const name = options.provider;
  const accountId = options.accountId;
  if (status === 401) throw new ProviderUnauthorizedError(`${name} rejected the access token`);
  const reasons = providerErrorReasons(res.data);
  const providerReason = reasons.length > 0 ? reasons.join(' ') : null;
  const retryAfterSeconds = parseRetryAfter(res.headers.get('retry-after'));
  const fail = (httpStatus: number, code: ErrorCode, message: string, denial?: ProviderDenial) =>
    new ProviderHttpError(httpStatus, code, { message, accountId, providerReason, denial, retryAfterSeconds, upstreamStatus: status });
  if (status === 429 || (status === 403 && hasRateLimitReason(reasons))) {
    throw fail(429, 'rate_limited', `${name} is rate limiting requests; try again shortly`);
  }
  if (status === 403) {
    const denial = classifyDenial(reasons);
    throw fail(403, 'forbidden', denialMessage(name, denial, method), denial);
  }
  if (status === 404 || status === 410) throw fail(404, 'not_found', `${name} could not find this item`);
  if (status === 409 || status === 412) throw fail(409, 'conflict', `The item was changed in ${name}; refresh and try again`);
  if (status === 400 || status === 422) throw fail(502, 'provider_error', `${name} rejected the request`);
  throw fail(502, 'provider_error', `${name} returned an error (${status})`);
}

/** Plain object check for provider payloads. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Maximum pages followed for one listing (defensive: 2,500 × 50 events per calendar). */
export const MAX_PAGES = 50;

/**
 * The item array of a list response (`items` for Google, `value` for Graph). A response without
 * it is an error, never an empty list: sync deletes whatever a listing does not return. The
 * `details.reason` is the health code (for `outcomeFromError`) of listing failures that carry no upstream status.
 */
export function listItems(data: unknown, key: 'items' | 'value', account: { id: string }): unknown[] {
  const items = isRecord(data) ? data[key] : undefined;
  if (!Array.isArray(items)) {
    throw new HttpError(502, 'provider_error', {
      message: 'The provider returned an unexpected response',
      accountId: account.id,
      details: { reason: 'parse_error' },
    });
  }
  return items;
}

/** More pages than {@link MAX_PAGES}: a partial listing is refused (sync would delete the rest). */
export function incompleteListing(account: { id: string }): HttpError {
  return new HttpError(502, 'provider_error', {
    message: 'The provider returned more pages than Portly reads',
    accountId: account.id,
    details: { reason: 'too_large' },
  });
}
