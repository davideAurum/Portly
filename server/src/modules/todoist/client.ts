/**
 * Todoist unified API v1 client (§8 Todoist): `Authorization: Bearer <token>`, base
 * `https://api.todoist.com/api/v1`, fixed vendor endpoint → safe-fetch policy `provider`.
 *
 * Upstream failures map to the §7a error codes:
 * - 401/403        → 409 `not_configured`, details `{reason: 'token_rejected'}` (the stored token no
 *                    longer works; the user pastes a new one) — or, while validating a new token,
 *                    422 `validation_failed`
 * - 429            → 429 `rate_limited`, details `{retryAfterSeconds}`; `Retry-After` (header, or
 *                    `error_extra.retry_after`) starts a cooldown during which no request is sent
 * - 400            → 422 `validation_failed` (e.g. a filter Todoist cannot parse)
 * - 404            → 404 `not_found`
 * - 5xx and others → 502 `provider_error`
 * - timeouts       → 504 `upstream_timeout`, network errors → 502 `provider_error` (safe-fetch)
 * Upstream error text is never reflected to the client. Bodies are read as text and parsed here,
 * so a non-JSON error page (CDN 429, plain-text 401, HTML 5xx) still maps by its status; a 2xx
 * that is not JSON is a `provider_error`.
 *
 * Diagnostics (§17): a failed answer is a {@link TodoistUpstreamError} (or a
 * {@link TodoistRateLimitError}) carrying Todoist's status as `httpStatus` — logged as
 * `upstreamStatus` and turned into a health code by `outcomeFromError` — and Todoist's
 * `error_tag` when it is a machine token. Requests pass `purpose: 'todoist.<purpose>'` to safe-fetch.
 */
import { REASON_TOKEN, type ErrorCode } from '@portly/shared';
import { HttpError } from '../../lib/errors.ts';
import type { Logger } from '../../lib/logger.ts';
import { SIZE_CAPS, type SafeFetch } from '../../security/safe-fetch.ts';
import { UpstreamPageSchema } from './mapping.ts';

export const TODOIST_API_BASE = 'https://api.todoist.com/api/v1';
export const TODOIST_HOST = 'api.todoist.com';
/** v1 list endpoints return at most 200 items per page. */
export const PAGE_LIMIT = 200;
export const REQUEST_TIMEOUT_MS = 10_000;
/** Cooldown when a 429 carries no usable Retry-After. */
export const DEFAULT_RETRY_AFTER_S = 60;
export const MAX_RETRY_AFTER_S = 15 * 60;

export type UpstreamPurpose = 'validate' | 'filter' | 'quick-add' | 'update' | 'task' | 'list';

export interface TodoistRequest {
  method?: 'GET' | 'POST';
  /** Path below the API base, e.g. `/tasks/filter`. Interpolated ids must already be encoded. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  purpose: UpstreamPurpose;
}

/** 429 from Todoist (or our cooldown): the route layer copies `retryAfterSeconds` into `Retry-After`. */
export class TodoistRateLimitError extends HttpError {
  override name = 'TodoistRateLimitError';
  readonly retryAfterSeconds: number;
  /** 429 when Todoist answered it; null when our cooldown refused the request (nothing was sent). */
  readonly httpStatus: number | null;
  constructor(retryAfterSeconds: number, httpStatus: number | null = null) {
    super(429, 'rate_limited', `Todoist is rate limiting requests. Try again in ${retryAfterSeconds} s.`, { retryAfterSeconds });
    this.retryAfterSeconds = retryAfterSeconds;
    this.httpStatus = httpStatus;
  }
}

/**
 * A failed Todoist answer: the API error the route sends, plus Todoist's own status and
 * `error_tag` for diagnostics (never sent to the browser). A 2xx `httpStatus` means the answer
 * could not be read.
 */
export class TodoistUpstreamError extends HttpError {
  override name = 'TodoistUpstreamError';
  /** Todoist's HTTP status (logged as `upstreamStatus`). */
  readonly httpStatus: number;
  /** Todoist's `error_tag` (e.g. `AUTH_INVALID_TOKEN`) when it is a machine token. */
  readonly errorTag: string | null;
  constructor(httpStatus: number, errorTag: string | null, status: number, code: ErrorCode, message: string, details?: unknown) {
    super(status, code, message, details);
    this.httpStatus = httpStatus;
    this.errorTag = errorTag;
  }
}

/** Todoist answered 2xx with something we cannot read (not JSON, or not the documented shape). */
export function unexpectedResponse(httpStatus = 200): TodoistUpstreamError {
  return new TodoistUpstreamError(httpStatus, null, 502, 'provider_error', 'Todoist returned an unexpected response.');
}

export function tokenRejected(): HttpError {
  return new HttpError(409, 'not_configured', 'Todoist rejected the saved API token. Paste a new one in Settings → Todoist.', {
    reason: 'token_rejected',
  });
}

export function notConnected(): HttpError {
  return new HttpError(409, 'not_configured', 'Todoist is not connected. Add your API token in Settings → Todoist.', {
    reason: 'no_token',
  });
}

/** Seconds from a `Retry-After` header (delta-seconds or HTTP-date) or Todoist's `error_extra.retry_after`. */
export function parseRetryAfter(header: string | null, body: unknown, now: number): number {
  let seconds: number | null = null;
  const value = header?.trim();
  if (value) {
    if (/^\d+$/.test(value)) seconds = Number(value);
    else {
      const at = Date.parse(value);
      if (!Number.isNaN(at)) seconds = Math.ceil((at - now) / 1000);
    }
  }
  if (seconds === null && body !== null && typeof body === 'object') {
    const extra = (body as { error_extra?: unknown }).error_extra;
    const retry = extra !== null && typeof extra === 'object' ? (extra as { retry_after?: unknown }).retry_after : undefined;
    if (typeof retry === 'number' && Number.isFinite(retry)) seconds = Math.ceil(retry);
  }
  if (seconds === null || !Number.isFinite(seconds)) seconds = DEFAULT_RETRY_AFTER_S;
  return Math.min(MAX_RETRY_AFTER_S, Math.max(1, seconds));
}

/** JSON body of an upstream answer; an empty body is `null`. */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Todoist's machine `error_tag` from an error body (`{error, error_code, error_tag, http_code}`), or null. */
function errorTagOf(body: unknown): string | null {
  const tag = body !== null && typeof body === 'object' ? (body as { error_tag?: unknown }).error_tag : undefined;
  return typeof tag === 'string' && REASON_TOKEN.test(tag) ? tag : null;
}

function failureFor(status: number, purpose: UpstreamPurpose, errorTag: string | null): TodoistUpstreamError {
  const fail = (apiStatus: number, code: ErrorCode, message: string, details?: unknown): TodoistUpstreamError =>
    new TodoistUpstreamError(status, errorTag, apiStatus, code, message, details);
  if (status === 401 || status === 403) {
    if (purpose === 'validate') {
      return fail(
        422,
        'validation_failed',
        'Todoist rejected this token. Copy the API token again from Todoist → Settings → Integrations → Developer.',
        { reason: 'token_rejected' },
      );
    }
    const rejected = tokenRejected();
    return fail(rejected.status, rejected.code, rejected.message, rejected.details);
  }
  if (status === 400) {
    if (purpose === 'filter') return fail(422, 'validation_failed', 'Todoist could not understand this filter. Check its syntax.', { reason: 'invalid_filter' });
    if (purpose === 'quick-add') return fail(422, 'validation_failed', 'Todoist could not add this task.');
    return fail(422, 'validation_failed', 'Todoist rejected the request.');
  }
  if (status === 404) {
    return fail(404, 'not_found', purpose === 'list' || purpose === 'filter' ? 'Not found in Todoist.' : 'This task no longer exists in Todoist.');
  }
  if (status >= 500) return fail(502, 'provider_error', `Todoist is having problems (HTTP ${status}). Try again shortly.`);
  return fail(502, 'provider_error', `Todoist returned an unexpected response (HTTP ${status}).`);
}

export interface TodoistClientDeps {
  fetch: SafeFetch;
  log: Logger;
  now?: () => number;
}

export interface TodoistClient {
  /** One request; resolves with the parsed JSON (null for empty bodies) or throws a mapped HttpError. */
  request(token: string, req: TodoistRequest): Promise<unknown>;
  /** Follows `next_cursor` until it is null, `maxItems` are collected or `maxPages` were read. */
  paged(token: string, req: TodoistRequest & { maxItems: number }): Promise<{ items: unknown[]; truncated: boolean }>;
  /** Clears the rate-limit cooldown (the token changed). */
  resetCooldown(): void;
  /** Epoch ms until which requests are refused locally (0 = none). */
  cooldownUntil(): number;
}

export function createTodoistClient(deps: TodoistClientDeps): TodoistClient {
  const now = deps.now ?? Date.now;
  let blockedUntil = 0;

  const request = async (token: string, req: TodoistRequest): Promise<unknown> => {
    const remainingMs = blockedUntil - now();
    if (remainingMs > 0) throw new TodoistRateLimitError(Math.ceil(remainingMs / 1000));

    const url = new URL(`${TODOIST_API_BASE}${req.path}`);
    for (const [name, value] of Object.entries(req.query ?? {})) if (value !== undefined) url.searchParams.set(name, value);

    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    let body: string | undefined;
    if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      headers['Content-Type'] = 'application/json';
    }

    // Read the body as text and parse it here: error answers from Todoist's edge (a CDN 429 page,
    // a plain-text 401, an HTML 5xx) are not JSON, and must still map by their status.
    const res = await deps.fetch(url, {
      method: req.method ?? 'GET',
      headers,
      body,
      policy: 'provider',
      as: 'text',
      maxBytes: SIZE_CAPS.json,
      timeoutMs: REQUEST_TIMEOUT_MS,
      redirect: 'error',
      purpose: `todoist.${req.purpose}`,
    });

    if (res.status >= 200 && res.status < 300) {
      const parsed = parseJson(res.data);
      if (!parsed.ok) throw unexpectedResponse(res.status);
      return parsed.value;
    }
    const errorBody = parseJson(res.data);
    const errorValue = errorBody.ok ? errorBody.value : null;
    if (res.status === 429) {
      const seconds = parseRetryAfter(res.headers.get('retry-after'), errorValue, now());
      blockedUntil = now() + seconds * 1000;
      // The `todoist` health record (failing, rate_limited, next attempt) is the visible line.
      deps.log.debug('todoist rate limited', { retryAfterSeconds: seconds, errorTag: errorTagOf(errorValue) });
      throw new TodoistRateLimitError(seconds, res.status);
    }
    throw failureFor(res.status, req.purpose, errorTagOf(errorValue));
  };

  const paged: TodoistClient['paged'] = async (token, req) => {
    const items: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    const maxPages = Math.ceil(req.maxItems / PAGE_LIMIT) + 1;
    for (let page = 0; page < maxPages; page++) {
      const data = await request(token, { ...req, query: { ...req.query, limit: String(PAGE_LIMIT), cursor } });
      const parsed = UpstreamPageSchema.safeParse(data);
      if (!parsed.success) throw unexpectedResponse();
      items.push(...parsed.data.results);
      if (items.length >= req.maxItems) {
        const truncated = items.length > req.maxItems || Boolean(parsed.data.next_cursor);
        return { items: items.slice(0, req.maxItems), truncated };
      }
      const next = parsed.data.next_cursor ?? null;
      if (next === null || next === '' || seen.has(next)) return { items, truncated: false };
      seen.add(next);
      cursor = next;
    }
    return { items: items.slice(0, req.maxItems), truncated: true };
  };

  return {
    request,
    paged,
    resetCooldown: () => {
      blockedUntil = 0;
    },
    cooldownUntil: () => blockedUntil,
  };
}
