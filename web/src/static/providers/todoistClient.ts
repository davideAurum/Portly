/**
 * Todoist unified API v1 client for the static backend — a port of server/src/modules/todoist/client.ts
 * onto the browser's `fetch`: `Authorization: Bearer <token>`, base `https://api.todoist.com/api/v1`,
 * `redirect: 'error'`, a 10 s deadline per request and bodies read as text and parsed here.
 * Todoist allows CORS from any origin and echoes `Origin` on every response (error responses
 * included), so the browser calls it directly. Two browser differences from the server: no
 * `User-Agent` (a forbidden request header) and `Retry-After` is not readable cross-origin
 * (Todoist exposes only `Date`), so a 429's cooldown comes from the body's `error_extra.retry_after`
 * or the 60 s default.
 *
 * Upstream failures map to the §7a error codes exactly like the server:
 * - 401/403        → 409 `not_configured`, details `{reason: 'token_rejected'}` (the stored token no
 *                    longer works; the user pastes a new one) — or, while validating a new token,
 *                    422 `validation_failed`
 * - 429            → 429 `rate_limited`, details `{retryAfterSeconds}` and a `Retry-After` header;
 *                    starts a local cooldown during which no request is sent
 * - 400            → 422 `validation_failed` (e.g. a filter Todoist cannot parse)
 * - 404            → 404 `not_found`
 * - 5xx and others → 502 `provider_error`
 * - timeouts       → 504 `upstream_timeout`, network/CORS errors → 502 `provider_error`
 * Upstream error text is never reflected to the client. A 2xx that is not JSON is a
 * `provider_error`; an empty 2xx body (close/reopen answer `{}` or nothing) is `null`.
 * `reauth_required` is never produced: there is no vault in the browser-only build.
 *
 * Every failed request is also a `provider` event (`diagnostics.ts`): status and reason code
 * (`token_rejected`, `rate_limited`, `not_found`, `http_4xx`, `http_5xx`, `parse_error`, `timeout`,
 * `network`) — never the path's ids, the filter, the task text or the token. Refusals caused by
 * what the user typed (a bad filter, a token being validated, a task already gone) are info.
 */
import { fetchTextCapped, upstreamFailure, type FetchLike } from '../lib/fetch.ts';
import { StaticApiError } from '../respond.ts';
import { errorName, recordProviderFailure, statusFailureCode, stopwatch, transportFailureCode } from './diagnostics.ts';
import { UpstreamPageSchema } from './todoistMapping.ts';

export const TODOIST_API_BASE = 'https://api.todoist.com/api/v1';
export const TODOIST_HOST = 'api.todoist.com';
/** v1 list endpoints return at most 200 items per page. */
export const PAGE_LIMIT = 200;
export const REQUEST_TIMEOUT_MS = 10_000;
/** Largest body accepted from Todoist (the server's `SIZE_CAPS.json`). */
export const REQUEST_MAX_BYTES = 5 * 1024 * 1024;
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
  /** The API client's signal; its abort is rethrown as-is (never mapped to an API error). */
  signal?: AbortSignal | null;
}

/** 429 from Todoist (or our cooldown); the response carries `Retry-After` like the server's. */
export class TodoistRateLimitError extends StaticApiError {
  override name = 'TodoistRateLimitError';
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('rate_limited', `Todoist is rate limiting requests. Try again in ${retryAfterSeconds} s.`, { retryAfterSeconds });
    this.retryAfterSeconds = retryAfterSeconds;
  }

  override toResponse(): Response {
    const res = super.toResponse();
    res.headers.set('Retry-After', String(this.retryAfterSeconds));
    return res;
  }
}

export function tokenRejected(): StaticApiError {
  return new StaticApiError('not_configured', 'Todoist rejected the saved API token. Paste a new one under Todoist in Settings → Accounts.', {
    reason: 'token_rejected',
  });
}

export function notConnected(): StaticApiError {
  return new StaticApiError('not_configured', 'Todoist is not connected. Connect it in Settings → Accounts.', {
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
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function failureFor(status: number, purpose: UpstreamPurpose): StaticApiError {
  if (status === 401 || status === 403) {
    if (purpose === 'validate') {
      return new StaticApiError(
        'validation_failed',
        'Todoist rejected this token. Copy the API token again from Todoist → Settings → Integrations → Developer.',
        { reason: 'token_rejected' },
      );
    }
    return tokenRejected();
  }
  if (status === 400) {
    if (purpose === 'filter') return new StaticApiError('validation_failed', 'Todoist could not understand this filter. Check its syntax.', { reason: 'invalid_filter' });
    if (purpose === 'quick-add') return new StaticApiError('validation_failed', 'Todoist could not add this task.');
    return new StaticApiError('validation_failed', 'Todoist rejected the request.');
  }
  if (status === 404) {
    return new StaticApiError('not_found', purpose === 'list' || purpose === 'filter' ? 'Not found in Todoist.' : 'This task no longer exists in Todoist.');
  }
  if (status >= 500) return new StaticApiError('provider_error', `Todoist is having problems (HTTP ${status}). Try again shortly.`);
  return new StaticApiError('provider_error', `Todoist returned an unexpected response (HTTP ${status}).`);
}

/** The reason code and level of a refused request's `provider` event. */
function refusalEvent(status: number, purpose: UpstreamPurpose): { code: string; level: 'info' | 'warn' } {
  if (status === 401 || status === 403) return { code: 'token_rejected', level: purpose === 'validate' ? 'info' : 'warn' };
  if (status === 400 || status === 404) return { code: statusFailureCode(status), level: 'info' };
  return { code: statusFailureCode(status), level: 'warn' };
}

export interface TodoistClientDeps {
  /** Transport override for tests (default `globalThis.fetch`, read at call time). */
  fetch?: FetchLike;
  /** Clock (epoch ms) for the cooldown; the handler passes `ctx.now`. */
  now?: () => number;
}

export interface TodoistClient {
  /** One request; resolves with the parsed JSON (null for empty bodies) or throws a mapped StaticApiError. */
  request(token: string, req: TodoistRequest): Promise<unknown>;
  /** Follows `next_cursor` until it is null, `maxItems` are collected or `maxPages` were read. */
  paged(token: string, req: TodoistRequest & { maxItems: number }): Promise<{ items: unknown[]; truncated: boolean }>;
  /** Clears the rate-limit cooldown (the token changed). */
  resetCooldown(): void;
  /** Epoch ms until which requests are refused locally (0 = none). */
  cooldownUntil(): number;
}

export function createTodoistClient(deps: TodoistClientDeps = {}): TodoistClient {
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
    const elapsed = stopwatch();
    let res: { status: number; headers: Headers; text: string };
    try {
      res = await fetchTextCapped(
        url,
        { method: req.method ?? 'GET', headers, body, redirect: 'error', credentials: 'omit' },
        { timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: REQUEST_MAX_BYTES, signal: req.signal, fetch: deps.fetch },
      );
    } catch (err) {
      const code = transportFailureCode(err);
      if (code !== null) recordProviderFailure('todoist', TODOIST_HOST, { code, errName: errorName(err), ms: elapsed() });
      throw upstreamFailure(err, TODOIST_HOST);
    }

    if (res.status >= 200 && res.status < 300) {
      const parsed = parseJson(res.text);
      if (!parsed.ok) {
        recordProviderFailure('todoist', TODOIST_HOST, { status: res.status, code: 'parse_error', ms: elapsed() });
        throw new StaticApiError('provider_error', 'Todoist returned an unexpected response.');
      }
      return parsed.value;
    }
    const refusal = refusalEvent(res.status, req.purpose);
    recordProviderFailure('todoist', TODOIST_HOST, { status: res.status, code: refusal.code, ms: elapsed() }, refusal.level);
    if (res.status === 429) {
      const errorBody = parseJson(res.text);
      const seconds = parseRetryAfter(res.headers.get('retry-after'), errorBody.ok ? errorBody.value : null, now());
      blockedUntil = now() + seconds * 1000;
      throw new TodoistRateLimitError(seconds);
    }
    throw failureFor(res.status, req.purpose);
  };

  const paged: TodoistClient['paged'] = async (token, req) => {
    const items: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    const maxPages = Math.ceil(req.maxItems / PAGE_LIMIT) + 1;
    for (let page = 0; page < maxPages; page++) {
      const data = await request(token, { ...req, query: { ...req.query, limit: String(PAGE_LIMIT), cursor } });
      const parsed = UpstreamPageSchema.safeParse(data);
      if (!parsed.success) throw new StaticApiError('provider_error', 'Todoist returned an unexpected response.');
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
