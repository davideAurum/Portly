/**
 * API client: every call goes to the same origin with `X-Portly: 1` (§4.2) and JSON bodies —
 * in the Pages build to this page load's backend instead (`localServer/transport.ts`).
 * Non-2xx responses throw {@link ApiError} carrying the server's `{code, message, details?, accountId?}`
 * and the id the server logged the request under (`X-Request-Id`). {@link apiResponse} is the same
 * request for callers that read the response themselves (headers, a Blob).
 *
 * Diagnostics (ARCHITECTURE §17): failed and slow requests become this browser's `api` events
 * (`recordClientEvent`) — no answer (`network_error`) and 5xx → warn, any other refusal (4xx) →
 * info, an answer after more than 5 s → info — with `transport` saying which backend answered. The
 * same `method route status code` within 60 s is one event, then one more with `repeats` when the
 * window closes (so a long outage or a polling refusal does not fill the ring). An event carries
 * `rid` only when the server answered with one (it logged that request itself, so the event is
 * never uploaded); `/api/diagnostics/*` is never recorded (the Diagnostics page and the event upload
 * would only report themselves), and neither is a request its caller cancelled or one a page
 * switching backend no longer sends (hybrid mode: its `hybrid` events say why). The repeat
 * collapsing is shared: {@link recordCollapsedClientEvent} (provider failures, uncaught errors).
 */
import {
  ApiErrorBodySchema,
  ERROR_CODES,
  ERROR_STATUS,
  REQUEST_ID_HEADER,
  REQUEST_ID_REGEX,
  type ClientEventCategory,
  type ErrorCode,
  type LogLevel,
} from '@portly/shared';
import { getCapabilities } from '../capabilities.ts';
import { clientSessionId, recordClientEvent, type ClientEventFields } from '../diagnostics/clientLog.ts';

/** `network_error` is client-side only: the server could not be reached. */
export type ApiErrorCode = ErrorCode | 'network_error';

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;
  readonly accountId: string | undefined;
  /** The id the server logged this request under (`X-Request-Id`), when it answered with one. */
  readonly requestId: string | undefined;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown, accountId?: string, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.accountId = accountId;
    this.requestId = requestId;
  }
}

export function isApiError(err: unknown, code?: ApiErrorCode): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code);
}

export interface ApiRequestOptions {
  method?: string;
  /** JSON-encoded unless it is FormData (multipart uploads/imports). */
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

function codeForStatus(status: number): ErrorCode {
  const match = ERROR_CODES.find((code) => ERROR_STATUS[code] === status);
  return match ?? (status >= 500 ? 'internal' : 'bad_request');
}

/** The response's `X-Request-Id`, when it is one the server makes. */
function requestIdOf(res: Response): string | undefined {
  const value = res.headers.get(REQUEST_ID_HEADER);
  return value !== null && REQUEST_ID_REGEX.test(value) ? value : undefined;
}

async function toApiError(res: Response): Promise<ApiError> {
  const requestId = requestIdOf(res);
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Non-JSON error body (e.g. a proxy error page).
  }
  const body = ApiErrorBodySchema.safeParse(parsed);
  if (body.success) {
    const { code, message, details, accountId } = body.data.error;
    return new ApiError(res.status, code, message, details, accountId, requestId);
  }
  return new ApiError(res.status, codeForStatus(res.status), `Request failed (${res.status})`, undefined, undefined, requestId);
}

/**
 * Builds an API path, `encodeURIComponent`-ing every interpolated value:
 * apiPath`/api/bookmarks/${id}/move`.
 */
export function apiPath(strings: TemplateStringsArray, ...values: (string | number)[]): string {
  return strings.reduce((out, part, i) => out + part + (i < values.length ? encodeURIComponent(String(values[i])) : ''), '');
}

// ---------------------------------------------------------------------------
// Diagnostic events
// ---------------------------------------------------------------------------

/** An answer slower than this is worth an event even when it succeeded. */
export const SLOW_REQUEST_MS = 5_000;
/** Identical events within this window are one, plus one with `repeats` when it closes. */
export const CLIENT_EVENT_REPEAT_WINDOW_MS = 60_000;
/** Open repeat windows kept at most (the oldest closes first). */
const MAX_REPEAT_WINDOWS = 100;
/** The Diagnostics page's own requests and the event upload. */
const DIAGNOSTICS_PATH = /^\/api\/diagnostics(?:[/?#]|$)/;

function clock(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/** Which backend answers this page load's API calls. */
function transportName(): 'server' | 'pages-server' | 'pages-browser' {
  const caps = getCapabilities();
  if (!caps.pagesBuild) return 'server';
  return caps.backend === 'server' ? 'pages-server' : 'pages-browser';
}

/** A path segment that names one thing (an id, an encoded value), not a route word. */
function isIdSegment(segment: string): boolean {
  return /[%@\d]/.test(segment) || segment.length > 32;
}

/**
 * The path without its query, id-like segments as `:id` — what groups repeats of one request
 * (the server logs the real route pattern under the request's `rid`).
 */
export function apiRouteOf(path: string): string {
  const bare = path.split(/[?#]/, 1)[0] ?? '';
  return bare
    .split('/')
    .map((segment) => (segment !== '' && isIdSegment(segment) ? ':id' : segment))
    .join('/');
}

function nameOf(err: unknown): string | undefined {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  return typeof name === 'string' ? name : undefined;
}

function messageOf(err: unknown): string | undefined {
  const message = typeof err === 'object' && err !== null ? (err as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message : undefined;
}

interface RepeatWindow {
  cat: ClientEventCategory;
  level: LogLevel;
  msg: string;
  fields: ClientEventFields;
  /** Events suppressed since the window opened. */
  count: number;
  /** Closes the window (armed by the first repeat). */
  timer: ReturnType<typeof setTimeout> | null;
  until: number;
}

const repeatWindows = new Map<string, RepeatWindow>();
/** The event log's session the windows belong to (a new one — tests reset it — starts afresh). */
let repeatSession: string | null = null;

function closeWindow(key: string, window: RepeatWindow): void {
  if (window.timer !== null) clearTimeout(window.timer);
  if (repeatWindows.get(key) === window) repeatWindows.delete(key);
  if (window.count > 0) recordClientEvent(window.level, window.cat, window.msg, { ...window.fields, repeats: window.count });
}

/**
 * Records a diagnostic event unless one with the same `cat` and `key` was recorded in the last
 * minute: then it is only counted, and when that window closes one more event (the latest one's
 * fields) says how many with `repeats`. For events that can come in bursts — API failures here,
 * provider failures and uncaught errors elsewhere. Never throws.
 */
export function recordCollapsedClientEvent(cat: ClientEventCategory, key: string, level: LogLevel, msg: string, fields: ClientEventFields): void {
  try {
    const session = clientSessionId();
    if (session !== repeatSession) {
      for (const window of repeatWindows.values()) if (window.timer !== null) clearTimeout(window.timer);
      repeatWindows.clear();
      repeatSession = session;
    }
    const id = `${cat} ${key}`;
    const now = Date.now();
    const open = repeatWindows.get(id);
    if (open !== undefined && now < open.until) {
      open.count += 1;
      open.level = level;
      open.msg = msg;
      open.fields = fields;
      open.timer ??= setTimeout(() => closeWindow(id, open), open.until - now);
      return;
    }
    if (open !== undefined) closeWindow(id, open);
    const oldest = repeatWindows.entries().next();
    if (repeatWindows.size >= MAX_REPEAT_WINDOWS && !oldest.done) closeWindow(oldest.value[0], oldest.value[1]);
    repeatWindows.set(id, { cat, level, msg, fields, count: 0, timer: null, until: now + CLIENT_EVENT_REPEAT_WINDOW_MS });
    recordClientEvent(level, cat, msg, fields);
  } catch {
    // Diagnostics never disturb the caller.
  }
}

interface RequestFacts {
  method: string;
  path: string;
  ms: number;
}

/** The fields every `api` event of a request has. */
function baseFields(facts: RequestFacts): { method: string; route: string; path: string; ms: number; transport: string } {
  return { method: facts.method, route: apiRouteOf(facts.path), path: facts.path, ms: Math.round(facts.ms), transport: transportName() };
}

/** No answer: the backend could not be reached. */
function noteNoAnswer(facts: RequestFacts, err: unknown): void {
  if (DIAGNOSTICS_PATH.test(facts.path)) return;
  const fields = { ...baseFields(facts), status: 0, code: 'network_error', errName: nameOf(err), errMessage: messageOf(err) };
  recordCollapsedClientEvent('api', `${facts.method} ${fields.route} 0 network_error`, 'warn', 'API request got no answer', fields);
}

/** A refusal or a failure the backend answered. */
function noteRefusal(facts: RequestFacts, error: ApiError): void {
  if (DIAGNOSTICS_PATH.test(facts.path)) return;
  const server = error.status >= 500;
  const fields = { ...baseFields(facts), status: error.status, code: error.code, rid: error.requestId, errMessage: error.message };
  recordCollapsedClientEvent('api', `${facts.method} ${fields.route} ${error.status} ${error.code}`, server ? 'warn' : 'info', server ? 'API request failed' : 'API request refused', fields);
}

function noteSlow(facts: RequestFacts, res: Response): void {
  if (facts.ms <= SLOW_REQUEST_MS || DIAGNOSTICS_PATH.test(facts.path)) return;
  const fields = { ...baseFields(facts), status: res.status, rid: requestIdOf(res) };
  recordCollapsedClientEvent('api', `slow ${facts.method} ${fields.route}`, 'info', 'API request slow', fields);
}

/** The caller cancelled (not a timeout of its own): nothing went wrong. */
function cancelled(err: unknown, signal: AbortSignal | undefined): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return signal?.aborted === true && nameOf(signal.reason) !== 'TimeoutError';
}

/**
 * A server-backend page switching to the browser fails its requests on purpose
 * (`localServer/controller.ts` `ServerModeEndedError`, matched by name to keep it out of the
 * server build): no failure of its own, and a polling page would record one every minute.
 */
function switchingBackend(err: unknown): boolean {
  return nameOf(err) === 'ServerModeEndedError';
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * The request {@link api} sends, for callers that read the response themselves: the same headers
 * and backend, the same errors (`ApiError` from the error body, `network_error`, aborts rethrown
 * unchanged) and the same diagnostic events, but a 2xx Response is returned unread.
 */
export async function apiResponse(path: string, options: ApiRequestOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('X-Portly', '1');
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');

  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set('Content-Type', 'application/json');
  }

  const method = options.method ?? (body === undefined ? 'GET' : 'POST');
  const init: RequestInit = {
    method,
    headers,
    body,
    signal: options.signal,
    credentials: 'same-origin',
    cache: 'no-store',
  };

  const started = clock();
  const facts = (): RequestFacts => ({ method: method.toUpperCase(), path, ms: clock() - started });
  let res: Response;
  try {
    // Pages build: this page load's backend answers with a real Response — the in-browser backend,
    // or the Portly server on this PC in hybrid mode (`localServer/transport.ts`) — so everything
    // below (error bodies, 204, JSON parsing) is shared with the server build. The dynamic import
    // keeps both out of the server build's bundle.
    res = __PORTLY_STATIC__ ? await (await import('../localServer/transport.ts')).pagesFetch(path, init) : await fetch(path, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (!cancelled(err, options.signal) && !switchingBackend(err)) noteNoAnswer(facts(), err);
    throw new ApiError(0, 'network_error', 'Portly is not reachable');
  }

  if (!res.ok) {
    const error = await toApiError(res);
    noteRefusal(facts(), error);
    throw error;
  }
  noteSlow(facts(), res);
  return res;
}

export async function api<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const res = await apiResponse(path, options);
  if (res.status === 204 || res.status === 205) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return (await res.text()) as T;
  return (await res.json()) as T;
}

type Opts = Omit<ApiRequestOptions, 'method' | 'body'>;

export const apiGet = <T>(path: string, opts?: Opts): Promise<T> => api<T>(path, { ...opts, method: 'GET' });
export const apiPost = <T>(path: string, body?: unknown, opts?: Opts): Promise<T> => api<T>(path, { ...opts, method: 'POST', body });
export const apiPut = <T>(path: string, body?: unknown, opts?: Opts): Promise<T> => api<T>(path, { ...opts, method: 'PUT', body });
export const apiPatch = <T>(path: string, body?: unknown, opts?: Opts): Promise<T> => api<T>(path, { ...opts, method: 'PATCH', body });
export const apiDelete = <T = void>(path: string, opts?: Opts): Promise<T> => api<T>(path, { ...opts, method: 'DELETE' });
