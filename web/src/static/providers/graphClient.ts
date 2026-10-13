/**
 * Microsoft Graph calendar client for the static backend: the browser calls Graph itself with the
 * account's access token from the Outlook.com sign-in (handlers/accounts.ts). A port of
 * server/src/modules/calendar/providers/microsoft.ts (listings, writes) and providers/http.ts
 * (`providerCall`'s error mapping) onto the browser's `fetch`:
 *
 * - `GET /me/calendars` and `/me/calendars/{id}/calendarView?startDateTime&endDateTime&$top=500`,
 *   paged via `@odata.nextLink` (at most {@link MAX_PAGES}; a partial listing is refused, since a
 *   sync deletes whatever a listing does not return), with
 *   `Prefer: outlook.timezone="UTC", outlook.body-content-type="text"`;
 * - create `POST /me/calendars/{id}/events`, `PATCH|DELETE /me/events/{id}` (occurrence ids edit
 *   single instances; a delete of an event already gone counts as done).
 *
 * A 401 refreshes the token once (unless another caller already did) and retries; a second 401
 * means the account must be reconnected (`409 reauth_required`, the server's `withToken`). Other
 * failures map like the server: 429 (or a 403 with a throttling reason) → `rate_limited`, 403 →
 * `forbidden`, 404/410 → `not_found`, 409/412 → `conflict`, 400/422 → `provider_error` "rejected
 * the request", timeouts → `upstream_timeout`, network/CORS → `provider_error`. Graph's own error
 * text is never shown; only its `error.code` decides, and a failed request becomes a `provider`
 * event (status and reason code, never the URL, ids, token or event text). `Retry-After` is used
 * when the browser can read it.
 */
import type { ErrorCode, EventInput, EventUpdate } from '@portly/shared';
import { getAccessToken, rejectFreshToken } from '../handlers/accounts.ts';
import type { StaticContext } from '../context.ts';
import type { CalendarRow, EventRecord, EventRow, RemoteCalendar } from '../lib/calendarRecords.ts';
import { isoUtc, type SyncWindow } from '../lib/calendarTime.ts';
import { fetchTextCapped, upstreamFailure } from '../lib/fetch.ts';
import { StaticApiError } from '../respond.ts';
import { errorName, hostOf, recordProviderFailure, statusFailureCode, stopwatch, transportFailureCode } from './diagnostics.ts';
import {
  GRAPH_API,
  GRAPH_EVENT_SELECT,
  GRAPH_ORIGIN,
  GRAPH_PREFER,
  GRAPH_PROVIDER_NAME,
  graphEventBody,
  isRecord,
  mapGraphCalendar,
  mapGraphEvent,
  str,
} from './graphCalendar.ts';

export const GRAPH_HOST = hostOf(GRAPH_ORIGIN);
export const GRAPH_TIMEOUT_MS = 20_000;
/** Cap for one write or calendar-list answer (the server's JSON default). */
export const GRAPH_MAX_BYTES = 5 * 1024 * 1024;
/** Cap for one page of an event listing (a busy calendar's page can pass the default). */
export const LISTING_MAX_BYTES = 16 * 1024 * 1024;
/** Maximum pages followed for one listing (defensive: 50 × 500 events per calendar). */
export const MAX_PAGES = 50;
const MAX_RETRY_AFTER_S = 24 * 60 * 60;

const NAME = GRAPH_PROVIDER_NAME;
const RATE_LIMIT_REASONS = /rateLimit|quota|ApplicationThrottled|TooManyRequests/i;
const REASON_TOKEN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** A refused Graph request: the API error, plus what the sync needs for its backoff. */
export class GraphHttpError extends StaticApiError {
  override name = 'GraphHttpError';
  /** Graph's HTTP status. */
  readonly upstreamStatus: number;
  /** `Retry-After` in seconds, when the browser could read it. */
  readonly retryAfterSeconds: number | null;

  constructor(code: ErrorCode, message: string, accountId: string, upstreamStatus: number, retryAfterSeconds: number | null, details?: unknown) {
    super(code, message, details, accountId);
    this.upstreamStatus = upstreamStatus;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** `Retry-After` (delta seconds or an HTTP date) → whole seconds (≥ 0, ≤ a day); null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  const text = value?.trim();
  if (!text) return null;
  let seconds: number;
  if (/^\d+$/.test(text)) seconds = Number(text);
  else {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    seconds = Math.ceil((at - now) / 1000);
  }
  return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER_S) : null;
}

/** Graph's `error.code` (identifier-like only). */
function graphReason(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.error)) return null;
  const code = data.error.code;
  return typeof code === 'string' && REASON_TOKEN.test(code) ? code : null;
}

/** The parse_error answer for a response Portly cannot read (never an empty listing). */
function unexpected(accountId: string): StaticApiError {
  return new StaticApiError('provider_error', 'The provider returned an unexpected response', { reason: 'parse_error' }, accountId);
}

function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export interface GraphCallOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Statuses returned as `{status, data}` instead of throwing (404 on delete). */
  allowStatuses?: readonly number[];
  maxBytes?: number;
}

export interface GraphResponse {
  status: number;
  data: unknown;
}

interface Attempt {
  status: number;
  headers: Headers;
  data: unknown;
}

async function send(ctx: StaticContext, accountId: string, url: string, token: string, options: GraphCallOptions): Promise<Attempt> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: GRAPH_PREFER };
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }
  const elapsed = stopwatch();
  let res: { status: number; headers: Headers; text: string };
  try {
    res = await fetchTextCapped(
      url,
      { method: options.method ?? 'GET', headers, body, redirect: 'error', credentials: 'omit' },
      { timeoutMs: GRAPH_TIMEOUT_MS, maxBytes: options.maxBytes ?? GRAPH_MAX_BYTES },
    );
  } catch (err) {
    const code = transportFailureCode(err);
    if (code !== null) recordProviderFailure('microsoft', GRAPH_HOST, { code, errName: errorName(err), ms: elapsed() });
    const failure = upstreamFailure(err, NAME);
    throw new StaticApiError(failure.code, failure.message, failure.details, accountId);
  }
  const parsed = parseJsonText(res.text);
  const success = res.status >= 200 && res.status < 300;
  const ok = success || options.allowStatuses?.includes(res.status) === true;
  if (success && !parsed.ok) {
    recordProviderFailure('microsoft', GRAPH_HOST, { status: res.status, code: 'parse_error', ms: elapsed() });
    throw unexpected(accountId);
  }
  if (!ok && res.status !== 401) {
    const reason = parsed.ok ? graphReason(parsed.value) : null;
    recordProviderFailure('microsoft', GRAPH_HOST, { status: res.status, code: reason ?? statusFailureCode(res.status), ms: elapsed() });
  }
  return { status: res.status, headers: res.headers, data: parsed.ok ? parsed.value : null };
}

/** The API error for a refused (non-401) answer. */
function failure(ctx: StaticContext, accountId: string, method: string, attempt: Attempt): GraphHttpError {
  const { status } = attempt;
  const reason = graphReason(attempt.data);
  const retryAfter = parseRetryAfter(attempt.headers.get('retry-after'), ctx.now());
  const fail = (code: ErrorCode, message: string) => new GraphHttpError(code, message, accountId, status, retryAfter);
  if (status === 429 || (status === 403 && reason !== null && RATE_LIMIT_REASONS.test(reason))) {
    return fail('rate_limited', `${NAME} is rate limiting requests; try again shortly`);
  }
  if (status === 403) return fail('forbidden', method === 'GET' ? `${NAME} denied Portly access to this calendar` : `${NAME} does not allow this change`);
  if (status === 404 || status === 410) return fail('not_found', `${NAME} could not find this item`);
  if (status === 409 || status === 412) return fail('conflict', `The item was changed in ${NAME}; refresh and try again`);
  if (status === 400 || status === 422) return fail('provider_error', `${NAME} rejected the request`);
  return fail('provider_error', `${NAME} returned an error (${status})`);
}

/** One Graph request with the account's token (one refresh-and-retry on 401). */
export async function graphCall(ctx: StaticContext, accountId: string, url: string, options: GraphCallOptions = {}): Promise<GraphResponse> {
  if (!url.startsWith(`${GRAPH_ORIGIN}/`)) throw new StaticApiError('provider_error', `${NAME} returned an unexpected link`, undefined, accountId);
  const method = options.method ?? 'GET';
  const token = await getAccessToken(ctx, accountId);
  let attempt = await send(ctx, accountId, url, token, options);
  if (attempt.status === 401) {
    // Graph refused the token: refresh it (unless another caller already did) and retry once.
    const fresh = await getAccessToken(ctx, accountId, { rejected: token });
    attempt = await send(ctx, accountId, url, fresh, options);
    if (attempt.status === 401) {
      recordProviderFailure('microsoft', GRAPH_HOST, { status: 401, code: 'token_rejected' });
      throw await rejectFreshToken(ctx, accountId);
    }
  }
  const { status } = attempt;
  if ((status >= 200 && status < 300) || options.allowStatuses?.includes(status)) return { status, data: attempt.data };
  throw failure(ctx, accountId, method, attempt);
}

/** The item array of a list response; a response without it is an error, never an empty list. */
function listItems(data: unknown, accountId: string): unknown[] {
  const items = isRecord(data) ? data.value : undefined;
  if (!Array.isArray(items)) throw unexpected(accountId);
  return items;
}

/** More pages than {@link MAX_PAGES}: a partial listing is refused. */
function incompleteListing(accountId: string): StaticApiError {
  return new StaticApiError('provider_error', 'The provider returned more pages than Portly reads', { reason: 'too_large' }, accountId);
}

async function listPaged<T>(ctx: StaticContext, accountId: string, first: string, maxBytes: number, map: (item: unknown) => T | null): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = first;
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const { data } = await graphCall(ctx, accountId, url, { maxBytes });
    for (const item of listItems(data, accountId)) {
      const mapped = map(item);
      if (mapped !== null) out.push(mapped);
    }
    url = isRecord(data) ? str(data['@odata.nextLink']) : null;
  }
  if (url) throw incompleteListing(accountId);
  return out;
}

/** The account's calendars (`graph.calendars`). */
export function listGraphCalendars(ctx: StaticContext, accountId: string): Promise<RemoteCalendar[]> {
  return listPaged(ctx, accountId, `${GRAPH_API}/me/calendars?$top=100&$select=id,name,color,hexColor,canEdit,isDefaultCalendar`, GRAPH_MAX_BYTES, mapGraphCalendar);
}

/** Every event instance of a calendar in the window (`graph.calendarView`). */
export function listGraphEvents(
  ctx: StaticContext,
  accountId: string,
  calendar: Pick<CalendarRow, 'remote_id' | 'provider_writable'>,
  window: Pick<SyncWindow, 'fromMs' | 'toMs'>,
): Promise<EventRecord[]> {
  const params = new URLSearchParams({
    startDateTime: isoUtc(window.fromMs),
    endDateTime: isoUtc(window.toMs),
    $top: '500',
    $select: GRAPH_EVENT_SELECT,
  });
  const writable = calendar.provider_writable === 1;
  const first = `${GRAPH_API}/me/calendars/${encodeURIComponent(calendar.remote_id)}/calendarView?${params.toString()}`;
  return listPaged(ctx, accountId, first, LISTING_MAX_BYTES, (item) => mapGraphEvent(item, { writable }));
}

function mapWritten(data: unknown, calendar: Pick<CalendarRow, 'provider_writable'>, accountId: string): EventRecord {
  const mapped = mapGraphEvent(data, { writable: calendar.provider_writable === 1 });
  if (!mapped) throw new StaticApiError('provider_error', `${NAME} returned an unexpected response`, undefined, accountId);
  return mapped;
}

function eventUrl(event: Pick<EventRow, 'remote_id'>): string {
  return `${GRAPH_API}/me/events/${encodeURIComponent(event.remote_id)}`;
}

/** `graph.events.create` */
export async function createGraphEvent(ctx: StaticContext, accountId: string, calendar: CalendarRow, input: EventInput): Promise<EventRecord> {
  const url = `${GRAPH_API}/me/calendars/${encodeURIComponent(calendar.remote_id)}/events`;
  const { data } = await graphCall(ctx, accountId, url, { method: 'POST', body: graphEventBody(input) });
  return mapWritten(data, calendar, accountId);
}

/** `graph.events.update` (single instance; the event's own zone when the patch names none). */
export async function updateGraphEvent(ctx: StaticContext, accountId: string, calendar: CalendarRow, event: EventRow, patch: EventUpdate): Promise<EventRecord> {
  const body = graphEventBody({ ...patch, timezone: patch.timezone ?? event.timezone });
  const { data } = await graphCall(ctx, accountId, eventUrl(event), { method: 'PATCH', body });
  return mapWritten(data, calendar, accountId);
}

/** `graph.events.delete` (an event already gone upstream counts as deleted). */
export async function deleteGraphEvent(ctx: StaticContext, accountId: string, event: EventRow): Promise<void> {
  await graphCall(ctx, accountId, eventUrl(event), { method: 'DELETE', allowStatuses: [404] });
}
