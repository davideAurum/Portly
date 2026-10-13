/**
 * Shared plumbing for the REST mail providers (Gmail, Graph): authorized JSON calls through
 * `AccountService.withToken` + `safeFetch('provider')` (each with an outbound `purpose`, e.g.
 * `gmail.list`, `graph.mail.move`), and provider status → §7a error mapping. Provider response
 * text is never reflected to the client; the provider's reason codes, status and `Retry-After`
 * are kept on {@link ProviderHttpError} for logs and health only (lib/provider-errors.ts).
 */
import type { ErrorCode } from '@portly/shared';
import type { AccountService } from '../../../context.ts';
import { HttpError, ProviderUnauthorizedError } from '../../../lib/errors.ts';
import {
  ProviderHttpError,
  classifyDenial,
  hasRateLimitReason,
  parseRetryAfter,
  providerErrorReasons,
  type ProviderDenial,
} from '../../../lib/provider-errors.ts';
import { SIZE_CAPS, SafeFetchError, type SafeFetch } from '../../../security/safe-fetch.ts';
import type { StageReporter } from './types.ts';

export const PROVIDER_CALL_TIMEOUT_MS = 10_000;

export interface RestDeps {
  fetch: SafeFetch;
  accounts: AccountService;
}

export interface RestCall {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
  /** What the call is for: a 404 on an action means the message is gone; on a list it is a provider problem. */
  kind: 'list' | 'action';
  /**
   * Outbound purpose logged by safe-fetch with the host (`gmail.labels`, `graph.mail.move` …);
   * its last segment is the stage reported while the request runs.
   */
  purpose: string;
  signal: AbortSignal;
  /** Gets `token` while the access token is obtained, then the request's stage (see {@link RestCall.purpose}). */
  onStage?: StageReporter | undefined;
}

/** User-facing text for a 403 (rate-limit reasons are mapped to 429 before this). */
function denialMessage(providerName: string, denial: ProviderDenial): string {
  switch (denial) {
    case 'api_disabled':
      return `The ${providerName} API is not enabled in your Google Cloud project; enable it under APIs & Services › Library, then retry`;
    case 'insufficient_scope':
      return `${providerName} access was not granted; reconnect the account and allow ${providerName} access`;
    case 'denied':
      return `${providerName} refused access to this mailbox`;
  }
}

/**
 * Throws the §7a error for a non-2xx provider response (401 → ProviderUnauthorizedError for
 * withToken). Everything else is a {@link ProviderHttpError} carrying the provider's reason codes
 * (Google `error.errors[].reason`/`details[].reason`/`status`, Graph `error.code`), the 403
 * {@link ProviderDenial}, `Retry-After` and the provider status, so `outcomeFromError` reports
 * `rate_limited` (with `nextAttemptAt`), `api_disabled`, `insufficient_scope`, `denied`,
 * `not_found`, `timeout` or `http_4xx`/`http_5xx`. Statuses and messages seen by clients are
 * unchanged: 429 `rate_limited`, 404 `not_found` (actions), 502 `provider_error` (403s with an
 * explanation, other failures), 504 `upstream_timeout`.
 */
export function ensureOk(
  providerName: string,
  status: number,
  data: unknown,
  accountId: string,
  kind: RestCall['kind'],
  retryAfter: string | null = null,
): void {
  if (status >= 200 && status < 300) return;
  if (status === 401) throw new ProviderUnauthorizedError(`${providerName} rejected the access token`);
  const reasons = providerErrorReasons(data);
  const fail = (httpStatus: number, code: ErrorCode, message: string, denial?: ProviderDenial): ProviderHttpError =>
    new ProviderHttpError(httpStatus, code, {
      message,
      accountId,
      providerReason: reasons.length > 0 ? reasons.join(' ') : null,
      ...(denial === undefined ? {} : { denial }),
      retryAfterSeconds: parseRetryAfter(retryAfter),
      upstreamStatus: status,
    });
  if (status === 429 || (status === 403 && hasRateLimitReason(reasons))) {
    throw fail(429, 'rate_limited', `${providerName} is rate limiting requests; try again shortly`);
  }
  if (status === 404 && kind === 'action') {
    throw fail(404, 'not_found', 'The message no longer exists; refresh the list');
  }
  if (status === 403) {
    const denial = classifyDenial(reasons);
    throw fail(502, 'provider_error', denialMessage(providerName, denial), denial);
  }
  if (status === 504 || status === 408) {
    throw fail(504, 'upstream_timeout', `${providerName} did not respond in time`);
  }
  throw fail(502, 'provider_error', `${providerName} returned an error (${status})`);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** `gmail.labels` → `labels`. */
function stageOf(purpose: string): string {
  return purpose.slice(purpose.lastIndexOf('.') + 1);
}

const failedStages = new WeakMap<object, string>();

/**
 * The stage of the {@link restCall} that threw `err` (`token`, `labels`, `folder`, `get` …), if
 * it came from one. Listings run requests in parallel (Gmail labels + list and up to 5 gets, Graph
 * folder + list), so the last stage reported may belong to a sibling still running: the failing
 * request owns the stage in logs and health.
 */
export function failedStage(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? failedStages.get(err) : undefined;
}

/**
 * Authorized JSON call (retried once with a fresh token on 401 by `withToken`). The body is read
 * as text so that non-JSON error pages (proxies, 5xx) still map by status. Transport failures
 * become an HttpError with the provider's name in the message and the {@link SafeFetchError} as
 * its `cause` (the service classifies health by it: dns, refused, tls, too_large …); an
 * unreadable 2xx body likewise carries an `invalid_json` SafeFetchError (health `parse_error`).
 * Whatever it throws is tagged with the stage it had reached ({@link failedStage}).
 */
export async function restCall(deps: RestDeps, providerName: string, accountId: string, url: string, call: RestCall): Promise<unknown> {
  let stage = 'token';
  call.onStage?.(stage);
  try {
    return await deps.accounts.withToken(accountId, async (token) => {
      stage = stageOf(call.purpose);
      call.onStage?.(stage);
      const headers: Record<string, string> = { ...call.headers, Authorization: `Bearer ${token}`, Accept: 'application/json' };
      let body: string | undefined;
      if (call.body !== undefined) {
        body = JSON.stringify(call.body);
        headers['Content-Type'] = 'application/json';
      }
      let res: { status: number; headers: Headers; data: string };
      try {
        res = await deps.fetch(url, {
          policy: 'provider',
          as: 'text',
          maxBytes: SIZE_CAPS.json,
          method: call.method ?? 'GET',
          headers,
          ...(body === undefined ? {} : { body }),
          timeoutMs: PROVIDER_CALL_TIMEOUT_MS,
          redirect: 'error',
          signal: call.signal,
          purpose: call.purpose,
        });
      } catch (err) {
        if (err instanceof SafeFetchError) {
          const message = err.code === 'upstream_timeout' ? `${providerName} did not respond in time` : `Could not reach ${providerName}`;
          throw new HttpError(err.status, err.code, { message, accountId, cause: err });
        }
        throw err;
      }
      const parsed = parseJson(res.data);
      ensureOk(providerName, res.status, parsed.ok ? parsed.value : null, accountId, call.kind, res.headers.get('retry-after'));
      if (!parsed.ok) {
        const host = new URL(url).host;
        const cause = new SafeFetchError('invalid_json', `Invalid JSON from ${host}`, host);
        throw new HttpError(502, 'provider_error', { message: `${providerName} returned an unreadable response`, accountId, cause });
      }
      return parsed.value;
    });
  } catch (err) {
    // First tag wins: an error shared by parallel calls (one token refresh) keeps the first stage.
    if (typeof err === 'object' && err !== null && !failedStages.has(err)) failedStages.set(err, stage);
    throw err;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
