/**
 * Health tracker (ARCHITECTURE §17): the latest outcome of every synced subject — accounts,
 * calendar lists, calendars, ICS feeds, mailboxes, Todoist, feeds, weather, search suggestions and
 * jobs (keys: `account:<id>`, `calendar:<id>`, `feed:<hash>`, `job:<name>` …) — kept in
 * memory, persisted to `diag_health` / `diag_outcomes` (migration 003, machine-local) and logged
 * as transitions. It is the only source of failure, recovery and reminder lines for synced
 * subjects: modules record outcomes (failures through {@link outcomeFromError}) and log debug
 * detail only.
 *
 * Transition lines (call field `area: subject.area`, plus `key` and `accountId`):
 * - ok/unknown → failing, or a failure with another code/status: `<severity> '<area> failing'`
 *   (warn by default; jobs pass error, dependent subjects info);
 * - failing → failing (same code/status): `debug '<area> still failing'`, and at most every 6 h
 *   `info '<area> still failing'` (also the first record after a restart that matches the
 *   persisted failure — a restart is not a new failure);
 * - failing/degraded → ok: `info '<area> recovered' {downForMs, failures}`; ok → ok: debug;
 * - degraded (ok but partial): like failing, at info.
 *
 * Content rules (enforced by {@link HealthRecorder.record}): `message` is Portly-authored text
 * (scrubbed, ≤ 300); `code` must be a machine token (`REASON_TOKEN`) and every detail string a
 * machine token, a hostname or a parameter-free media type (≤ 64 characters) — anything else is
 * dropped and the dropped names debug-logged. Times a `Date` cannot hold are dropped too.
 *
 * Never throws. Memory and the log line are updated synchronously; database writes are queued
 * and flushed in a microtask, in one transaction, after the caller's own transaction (re-queued
 * with `setImmediate` while one is open). `diag_health` is written on every transition and
 * otherwise at most once a minute per key; `diag_outcomes` gets a row per transition and per
 * failure, identical consecutive failures collapsing into the latest row (`count`, `last_at`).
 * `close()` flushes everything and stops writing (later records update memory only).
 */
import { DIAGNOSTIC_AREAS, HEALTH_CODES, REASON_TOKEN } from '@portly/shared';
import type { Db } from '../db/open.ts';
import { HttpError } from './errors.ts';
import { outsideLogContext } from './log-context.ts';
import { errorFields, scrubText, type LogFields, type Logger } from './logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthSubject {
  key: string;
  area: string;
  accountId?: string | null;
  /** Only for subjects with no other lookup (feed/ICS host, provider name, job name). */
  label?: string | null;
  /** Job-driven subjects: 3 × the job interval (stale past it); on-demand subjects: null. */
  expectEveryMs?: number | null;
}

export type DetailValue = number | boolean | string;

export interface Outcome {
  ok: boolean;
  /** Ok but partial (storage limit, truncated listing). */
  degraded?: boolean;
  /** A HEALTH_CODES value (or another machine token); must match REASON_TOKEN, else dropped. */
  code?: string;
  /** Upstream HTTP status. */
  status?: number;
  /** Portly-authored text only (content rules below); scrubbed, ≤ 300 characters. */
  message?: string;
  ms?: number;
  /** Numbers, booleans, and strings ≤ 64 characters that are machine tokens, hostnames or media types; anything else is dropped. */
  detail?: Record<string, DetailValue>;
  /** The subject this one fails because of, e.g. `account:<id>`. */
  causeKey?: string | null;
  /** Epoch ms of the next attempt (backoff, Retry-After). */
  nextAttemptAt?: number | null;
  /** Level of the first-failure line (default warn; dependent subjects info, jobs error). */
  severity?: 'info' | 'warn' | 'error';
}

export type HealthStatusValue = 'ok' | 'degraded' | 'failing' | 'unknown';
export type OutcomeStatus = Exclude<HealthStatusValue, 'unknown'>;

/** Skipped work (`touch`): the subject was not checked this time, for this reason. */
export const HEALTH_SKIP_REASONS = ['backoff', 'vault_locked', 'missing_url', 'disabled', 'account_unavailable'] as const;
export type HealthSkipReason = (typeof HEALTH_SKIP_REASONS)[number];

/** A subject's state; times are epoch ms (the diagnostics module converts to `HealthEntry`). */
export interface HealthState {
  key: string;
  area: string;
  label: string | null;
  accountId: string | null;
  status: HealthStatusValue;
  lastOkAt: number | null;
  lastFailAt: number | null;
  /** Start of the current failing (or degraded) period. */
  failingSince: number | null;
  lastCheckedAt: number | null;
  expectEveryMs: number | null;
  consecutiveFailures: number;
  /** Code, upstream status and message of the latest failure or degraded outcome (kept after recovery). */
  lastCode: string | null;
  lastStatus: number | null;
  lastMessage: string | null;
  lastMs: number | null;
  detail: Record<string, DetailValue> | null;
  causeKey: string | null;
  nextAttemptAt: number | null;
  updatedAt: number;
}

/** One `diag_outcomes` row (epoch ms). */
export interface OutcomeRowState {
  id: number;
  key: string;
  at: number;
  /** Last occurrence of a collapsed run of identical failures. */
  lastAt: number;
  count: number;
  ok: boolean;
  status: OutcomeStatus;
  code: string | null;
  httpStatus: number | null;
  message: string | null;
  ms: number | null;
  detail: Record<string, DetailValue> | null;
}

export interface HealthRecorder {
  record(subject: HealthSubject, outcome: Outcome): void;
  /** Skipped work: updates `lastCheckedAt` and `detail.skipped` without a transition. */
  touch(subject: HealthSubject, info: { skipped: HealthSkipReason; nextAttemptAt?: number | null }): void;
  get(key: string): HealthState | null;
  /** Sorted by key. */
  list(filter?: { area?: string; accountId?: string }): HealthState[];
  /** Newest first (default 50, at most 500). */
  history(key: string, limit?: number): OutcomeRowState[];
  /** An exact key, or every key starting with a prefix that ends in `:` (`calendar:`). */
  forget(keyOrPrefix: string): void;
  /** `account:`, `mail:` and `calendar-list:` of the account and every subject recorded with its id. */
  forgetAccount(accountId: string): void;
  /** Retention: outcomes > 30 days or beyond the newest 5 000; subjects not updated for 30 days (feed/suggest: 7). */
  purge(now?: number): void;
  /** Writes queued changes now. */
  flush(): void;
  /** Flushes and stops writing (shutdown, before `db.close()`): later records update memory only; flush() and purge() do nothing. */
  close(): void;
}

export interface HealthRecorderOptions {
  db: Db;
  log: Logger;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** A key's row is rewritten at most this often between transitions. */
export const PERSIST_INTERVAL_MS = 60 * 1000;
/** `info '<area> still failing'` at most this often per key. */
export const REMINDER_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const OUTCOME_RETENTION_MS = 30 * DAY_MS;
export const MAX_OUTCOME_ROWS = 5000;
export const HEALTH_RETENTION_MS = 30 * DAY_MS;
/** Subjects that come and go with what the user browses (feeds, suggestion providers). */
export const SHORT_LIVED_RETENTION_MS = 7 * DAY_MS;
const SHORT_LIVED_PREFIXES = ['feed:', 'suggest:'] as const;
const WARN_INTERVAL_MS = 60 * 1000;

const MAX_MESSAGE = 300;
const MAX_DETAIL_STRING = 64;
const MAX_DETAIL_KEYS = 20;
const MAX_KEY = 600;
const MAX_LABEL = 253;
const DEFAULT_HISTORY = 50;
const MAX_HISTORY = 500;
/** The largest epoch ms a `Date` holds. */
const MAX_EPOCH_MS = 8.64e15;

const KEY_RE = /^[^\p{Cc}\u2028\u2029]+$/u;
const AREA_RE = /^[a-z0-9_.:-]{1,32}$/;
const ACCOUNT_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const DETAIL_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/** `host`, `host:port`, `[v6]`, `[v6]:port`. */
const HOSTNAME_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
/** A media type without parameters (`text/html`, `application/rss+xml`), registered top-level types only. */
const MEDIA_TYPE_RE = /^(?:application|audio|font|image|message|model|multipart|text|video)\/[A-Za-z0-9][A-Za-z0-9.+_-]{0,47}$/i;
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu;

const HEALTH_CODE_SET: ReadonlySet<string> = new Set(HEALTH_CODES);
const AREA_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_AREAS);
const SKIP_SET: ReadonlySet<string> = new Set(HEALTH_SKIP_REASONS);

// ---------------------------------------------------------------------------
// Validation (content rules, §17)
// ---------------------------------------------------------------------------

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * An epoch-ms time a `Date` can hold (|ms| ≤ 8.64e15, so `toISOString()` cannot throw, and below
 * 2^53, so node:sqlite reads the INTEGER column back), else null.
 */
function timestamp(value: unknown): number | null {
  const ms = finite(value);
  return ms !== null && Math.abs(ms) <= MAX_EPOCH_MS ? ms : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validKey(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_KEY && KEY_RE.test(value) ? value : null;
}

function isHostname(value: string): boolean {
  return value.length <= MAX_LABEL && HOSTNAME_RE.test(value);
}

/** A detail string: ≤ 64 characters, a machine token, a hostname or a media type (feeds' `contentType`). */
function isSafeDetailString(value: string): boolean {
  return value.length <= MAX_DETAIL_STRING && (REASON_TOKEN.test(value) || isHostname(value) || MEDIA_TYPE_RE.test(value));
}

/** Scrubbed, masked, single-line, ≤ 300 characters; null for empty text. */
function cleanMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = cap(scrubText(value.slice(0, MAX_MESSAGE * 8)).replace(CONTROL_CHARS, ' ').trim(), MAX_MESSAGE);
  return text === '' ? null : text;
}

/** Detail kept by the content rules; names of dropped entries are pushed to `dropped`. */
function cleanDetail(value: unknown, dropped: string[]): Record<string, DetailValue> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, DetailValue> = {};
  let kept = 0;
  for (const [k, v] of Object.entries(value)) {
    const name = `detail.${cap(k, 40)}`;
    if (!DETAIL_KEY_RE.test(k) || kept >= MAX_DETAIL_KEYS) {
      dropped.push(name);
      continue;
    }
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && isSafeDetailString(v))) {
      out[k] = v;
      kept++;
    } else if (v !== undefined && v !== null) {
      dropped.push(name);
    }
  }
  return kept > 0 ? out : null;
}

interface CleanSubject {
  key: string;
  area: string;
  /** undefined = keep what the subject had. */
  accountId: string | null | undefined;
  label: string | null | undefined;
  expectEveryMs: number | null | undefined;
}

function cleanSubject(subject: HealthSubject, dropped: string[]): CleanSubject | null {
  if (!isRecord(subject)) return null;
  const key = validKey(subject.key);
  if (key === null) return null;
  const rawArea = typeof subject.area === 'string' ? subject.area.trim().toLowerCase() : '';
  const area = AREA_RE.test(rawArea) ? rawArea : 'server';
  if (area !== rawArea) dropped.push('area');

  let accountId: string | null | undefined;
  if (subject.accountId === undefined || subject.accountId === null) accountId = subject.accountId;
  else if (typeof subject.accountId === 'string' && ACCOUNT_ID_RE.test(subject.accountId)) accountId = subject.accountId;
  else {
    accountId = null;
    dropped.push('accountId');
  }

  let label: string | null | undefined;
  if (subject.label === undefined || subject.label === null) label = subject.label;
  else if (typeof subject.label === 'string' && (isHostname(subject.label) || REASON_TOKEN.test(subject.label))) label = subject.label;
  else {
    label = null;
    dropped.push('label');
  }

  let expectEveryMs: number | null | undefined;
  if (subject.expectEveryMs === undefined || subject.expectEveryMs === null) expectEveryMs = subject.expectEveryMs;
  else {
    const ms = finite(subject.expectEveryMs);
    // Above 2^53 an INTEGER column could not be read back (node:sqlite refuses such values).
    expectEveryMs = ms !== null && ms > 0 && ms <= Number.MAX_SAFE_INTEGER ? Math.round(ms) : null;
    if (expectEveryMs === null) dropped.push('expectEveryMs');
  }
  return { key, area, accountId, label, expectEveryMs };
}

interface CleanOutcome {
  status: OutcomeStatus;
  code: string | null;
  httpStatus: number | null;
  message: string | null;
  ms: number | null;
  detail: Record<string, DetailValue> | null;
  causeKey: string | null;
  nextAttemptAt: number | null;
  severity: 'info' | 'warn' | 'error';
}

function cleanOutcome(outcome: Outcome, dropped: string[]): CleanOutcome {
  const o: Partial<Outcome> = isRecord(outcome) ? outcome : { ok: false };
  const status: OutcomeStatus = o.ok !== true ? 'failing' : o.degraded === true ? 'degraded' : 'ok';

  let code: string | null = null;
  if (typeof o.code === 'string' && REASON_TOKEN.test(o.code)) code = o.code;
  else if (o.code !== undefined && o.code !== null) dropped.push('code');

  let httpStatus: number | null = null;
  const s = finite(o.status);
  if (s !== null && Number.isInteger(s) && s >= 100 && s <= 599) httpStatus = s;
  else if (o.status !== undefined && o.status !== null) dropped.push('status');

  const message = cleanMessage(o.message);
  const ms = finite(o.ms);
  const causeKey = o.causeKey === undefined || o.causeKey === null ? null : validKey(o.causeKey);
  if (causeKey === null && o.causeKey !== undefined && o.causeKey !== null) dropped.push('causeKey');
  const nextAttemptAt = timestamp(o.nextAttemptAt);
  if (nextAttemptAt === null && o.nextAttemptAt !== undefined && o.nextAttemptAt !== null) dropped.push('nextAttemptAt');
  const severity = o.severity === 'info' || o.severity === 'error' ? o.severity : 'warn';
  return {
    status,
    code,
    httpStatus,
    message,
    ms: ms === null ? null : Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(ms))),
    detail: cleanDetail(o.detail, dropped),
    causeKey,
    nextAttemptAt,
    severity,
  };
}

// ---------------------------------------------------------------------------
// outcomeFromError
// ---------------------------------------------------------------------------

const DENIALS: ReadonlySet<string> = new Set(['api_disabled', 'insufficient_scope', 'denied']);

/**
 * TLS failures: Node's TLS/SSL error codes and its X509 certificate-verification codes — besides the
 * `CERT_*` ones, e.g. `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (an HTTPS-inspecting proxy's CA), `INVALID_CA`,
 * `ERROR_IN_CERT_NOT_AFTER_FIELD`, `CRL_HAS_EXPIRED`.
 */
const TLS_CODE =
  /^(?:ERR_TLS_|ERR_SSL_|CERT_|CRL_|ERROR_IN_(?:CERT|CRL)_|UNABLE_TO_(?:GET|VERIFY|DECRYPT|DECODE)_|SELF_SIGNED_|DEPTH_ZERO_)|^(?:INVALID_CA|INVALID_PURPOSE|PATH_LENGTH_EXCEEDED|HOSTNAME_MISMATCH)$/;

/** Transport error codes (the error's own or one of its causes) → health code. */
function transportCode(code: string): string | null {
  if (TLS_CODE.test(code)) return 'tls';
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME':
      return 'dns';
    case 'ECONNREFUSED':
      return 'refused';
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
    case 'EPIPE':
    case 'ECONNABORTED':
      return 'reset';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return 'timeout';
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
    case 'ENETDOWN':
      return 'network';
    case 'EPORTLY_NOT_LAN':
      return 'not_lan';
    case 'EPORTLY_BLOCKED':
      return 'blocked';
    default:
      return null;
  }
}

/** String codes of `err` and its causes (≤ 5 links), deepest first. */
function chainCodes(err: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < 6 && isRecord(current) && !seen.has(current); depth++) {
    seen.add(current);
    if (typeof current.code === 'string') codes.push(current.code);
    current = current.cause;
  }
  return codes.reverse();
}

function firstTransportCode(err: unknown): string | null {
  for (const code of chainCodes(err)) {
    const mapped = transportCode(code);
    if (mapped !== null) return mapped;
  }
  return null;
}

/** SafeFetchError `reason`, refined by the transport codes of its cause chain. */
function safeFetchCode(reason: unknown, err: unknown): string {
  const transport = firstTransportCode(err);
  switch (reason) {
    case 'timeout':
      return 'timeout';
    case 'blocked':
      return transport === 'not_lan' ? 'not_lan' : 'blocked';
    case 'too_large':
      return 'too_large';
    case 'invalid_json':
      return 'parse_error';
    case 'network':
      return transport ?? 'network';
    default:
      // `redirect`, `bad_url` (health codes too), or a newer reason: our own machine tokens.
      return typeof reason === 'string' && REASON_TOKEN.test(reason) ? reason : (transport ?? 'network');
  }
}

/** Upstream HTTP status → health code (null below 400). */
function upstreamCode(status: number | null): string | null {
  if (status === null || status < 400) return null;
  if (status === 404 || status === 410) return 'not_found';
  if (status === 429) return 'rate_limited';
  return status < 500 ? 'http_4xx' : 'http_5xx';
}

/** HttpError (and ImapOpError) API code → health code; null when it says nothing about the subject. */
function apiCode(code: unknown, upstream: number | null): string | null {
  switch (code) {
    case 'reauth_required':
      return 'reauth_required';
    case 'rate_limited':
      return 'rate_limited';
    case 'upstream_timeout':
      return 'timeout';
    case 'not_configured':
      return 'not_configured';
    case 'not_found':
      return 'not_found';
    case 'payload_too_large':
      return 'too_large';
    case 'forbidden':
      return upstream === 401 ? 'auth_failed' : 'denied';
    case 'provider_error':
      return upstreamCode(upstream);
    default:
      return null;
  }
}

/** Errors that are not HttpErrors but name their failure. */
function namedCode(name: string | null, err: Record<string, unknown>, upstream: number | null): string | null {
  switch (name) {
    case 'NotAFeedError':
      return 'not_a_feed';
    case 'XmlError':
    case 'SyntaxError':
      return 'parse_error';
    case 'DavParseError':
      return err.reason === 'limit' ? 'too_large' : err.reason === 'timeout' ? 'timeout' : 'parse_error';
    case 'ExpandError':
      return err.reason === 'limit' ? 'too_large' : err.reason === 'timeout' ? 'timeout' : err.reason === 'invalid' ? 'parse_error' : 'worker_failed';
    case 'SuggestUpstreamError':
      return upstreamCode(upstream);
    case 'ImapAuthError':
      return 'auth_failed';
    case 'TimeoutError':
      return 'timeout';
    default:
      return null;
  }
}

/** Errors whose message is Portly-authored (built from host + status), so it may be shown and stored. */
function hasOwnMessage(err: unknown, name: string | null): boolean {
  return err instanceof HttpError || name === 'ExpandError' || name === 'DavParseError';
}

const DETAIL_FROM_ERROR = ['errCode', 'causeCode', 'errReason', 'providerReason', 'upstreamStatus', 'host', 'retryAfterSeconds'] as const;

/** `PERMISSION_DENIED accessNotConfigured SERVICE_DISABLED` → `PERMISSION_DENIED:accessNotConfigured:SERVICE_DISABLED` (whole tokens, ≤ 64). */
function joinReasons(text: string): string | null {
  let out = '';
  for (const token of text.split(/\s+/)) {
    if (!REASON_TOKEN.test(token)) continue;
    const next = out === '' ? token : `${out}:${token}`;
    if (next.length > MAX_DETAIL_STRING) break;
    out = next;
  }
  return out === '' ? null : out;
}

/**
 * Failure outcome of a thrown value. `code`: ProviderHttpError `denial` → a `details.reason` that is
 * a health code → SafeFetchError `reason` refined by its cause chain (TLS, DNS, refused, reset,
 * timeout, not_lan) → VaultLockedError `vault_locked` → the HttpError code (`reauth_required`,
 * `rate_limited`, `timeout`, `not_configured`, `not_found`, provider errors by upstream status) →
 * named errors (feeds, DAV, expand, suggestions, IMAP auth) → transport codes → `internal`.
 * `status` = upstream status; `message` = the HttpError's own (Portly) message, else the error
 * name; `detail` = the loggable error fields; `nextAttemptAt` from `retryAfterSeconds`. `extra`
 * overrides (its `detail` is merged).
 */
export function outcomeFromError(err: unknown, extra: Partial<Outcome> = {}): Outcome {
  let fields: LogFields = {};
  try {
    fields = errorFields(err);
  } catch {
    fields = {};
  }
  const e: Record<string, unknown> = isRecord(err) ? err : {};
  const name = typeof fields.errName === 'string' ? fields.errName : null;
  const upstream = finite(fields.upstreamStatus);
  const details = isRecord(e.details) ? e.details : null;

  let code: string | null = null;
  if (name === 'ProviderHttpError' && typeof e.denial === 'string' && DENIALS.has(e.denial)) code = e.denial;
  if (code === null && typeof details?.reason === 'string' && HEALTH_CODE_SET.has(details.reason)) code = details.reason;
  if (code === null && name === 'SafeFetchError') code = safeFetchCode(e.reason, err);
  if (code === null && name === 'VaultLockedError') code = 'vault_locked';
  if (code === null && (err instanceof HttpError || name === 'ImapOpError')) code = apiCode(e.code, upstream);
  if (code === null) code = namedCode(name, e, upstream);
  if (code === null) code = firstTransportCode(err);
  if (code === null) code = 'internal';

  const message = hasOwnMessage(err, name) && typeof fields.errMessage === 'string' ? fields.errMessage : (name ?? 'Error');

  const detail: Record<string, DetailValue> = {};
  for (const k of DETAIL_FROM_ERROR) {
    const v = fields[k];
    if (k === 'providerReason' && typeof v === 'string') {
      const joined = joinReasons(v);
      if (joined !== null) detail[k] = joined;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      detail[k] = v;
    } else if (typeof v === 'string' && isSafeDetailString(v)) {
      detail[k] = v;
    }
  }

  const out: Outcome = { ok: false, code, message };
  if (upstream !== null) out.status = upstream;
  if (Object.keys(detail).length > 0) out.detail = detail;
  const retryAfter = finite(fields.retryAfterSeconds);
  if (retryAfter !== null && retryAfter >= 0) out.nextAttemptAt = Date.now() + retryAfter * 1000;

  const merged: Outcome = { ...out, ...extra };
  if (out.detail !== undefined && extra.detail !== undefined) merged.detail = { ...out.detail, ...extra.detail };
  return merged;
}

// ---------------------------------------------------------------------------
// Key → context field ("Show related log lines", §17)
// ---------------------------------------------------------------------------

/**
 * The log-context field that the unit of work behind a health key sets, so the log viewer can
 * show its lines: `account:`/`mail:`/`calendar-list:<id>` → `accountId`; `calendar:`/`ics:<id>` →
 * `calendarId`; `feed:<hash>` → `feed`; `job:<name>` → `job`; `todoist`, `weather`,
 * `suggest:<provider>` (and unknown keys) → an area.
 */
export function contextFieldForKey(key: string): { field: string; value: string } | { area: string } {
  const colon = key.indexOf(':');
  const prefix = colon === -1 ? key : key.slice(0, colon);
  const rest = colon === -1 ? '' : key.slice(colon + 1);
  if (rest !== '') {
    switch (prefix) {
      case 'account':
      case 'mail':
      case 'calendar-list':
        return { field: 'accountId', value: rest };
      case 'calendar':
      case 'ics':
        return { field: 'calendarId', value: rest };
      case 'feed':
        return { field: 'feed', value: rest };
      case 'job':
        return { field: 'job', value: rest };
      default:
        break;
    }
  }
  if (prefix === 'suggest') return { area: 'search' };
  if (prefix === 'feed') return { area: 'feeds' };
  return { area: AREA_SET.has(prefix) ? prefix : 'server' };
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

interface Entry extends HealthState {
  lastReminderAt: number | null;
  /** Loaded from the database and not recorded since this process started. */
  restored: boolean;
  /** When this process last queued the row (null: never). */
  persistedAt: number | null;
  /** Changed since it was last queued. */
  dirty: boolean;
}

interface NewOutcomeRow {
  key: string;
  at: number;
  ok: boolean;
  status: OutcomeStatus;
  code: string | null;
  httpStatus: number | null;
  message: string | null;
  ms: number | null;
  detail: Record<string, DetailValue> | null;
}

type Op =
  | { kind: 'upsert'; key: string }
  | { kind: 'outcome'; row: NewOutcomeRow; collapse: boolean }
  | { kind: 'forget'; key: string; prefix: boolean }
  | { kind: 'forgetAccount'; accountId: string; keys: string[] };

interface HealthRow {
  key: string;
  area: string;
  label: string | null;
  account_id: string | null;
  status: string;
  last_ok_at: number | null;
  last_fail_at: number | null;
  failing_since: number | null;
  last_checked_at: number | null;
  expect_every_ms: number | null;
  consecutive_failures: number;
  last_code: string | null;
  last_status: number | null;
  last_message: string | null;
  last_ms: number | null;
  detail: string | null;
  cause_key: string | null;
  next_attempt_at: number | null;
  last_reminder_at: number | null;
  updated_at: number;
}

interface OutcomeRowDb {
  id: number;
  key: string;
  at: number;
  last_at: number;
  count: number;
  ok: number;
  status: string;
  code: string | null;
  http_status: number | null;
  message: string | null;
  ms: number | null;
  detail: string | null;
}

const UPSERT_SQL = `INSERT INTO diag_health (key, area, label, account_id, status, last_ok_at, last_fail_at, failing_since,
  last_checked_at, expect_every_ms, consecutive_failures, last_code, last_status, last_message, last_ms, detail, cause_key,
  next_attempt_at, last_reminder_at, updated_at)
VALUES (:key, :area, :label, :account_id, :status, :last_ok_at, :last_fail_at, :failing_since, :last_checked_at,
  :expect_every_ms, :consecutive_failures, :last_code, :last_status, :last_message, :last_ms, :detail, :cause_key,
  :next_attempt_at, :last_reminder_at, :updated_at)
ON CONFLICT(key) DO UPDATE SET area = excluded.area, label = excluded.label, account_id = excluded.account_id,
  status = excluded.status, last_ok_at = excluded.last_ok_at, last_fail_at = excluded.last_fail_at,
  failing_since = excluded.failing_since, last_checked_at = excluded.last_checked_at,
  expect_every_ms = excluded.expect_every_ms, consecutive_failures = excluded.consecutive_failures,
  last_code = excluded.last_code, last_status = excluded.last_status, last_message = excluded.last_message,
  last_ms = excluded.last_ms, detail = excluded.detail, cause_key = excluded.cause_key,
  next_attempt_at = excluded.next_attempt_at, last_reminder_at = excluded.last_reminder_at, updated_at = excluded.updated_at`;

const COLLAPSE_SQL = `UPDATE diag_outcomes SET count = count + 1, last_at = :at
WHERE id = (SELECT max(id) FROM diag_outcomes WHERE key = :key)
  AND status = :status AND code IS :code AND http_status IS :http_status`;

const INSERT_OUTCOME_SQL = `INSERT INTO diag_outcomes (key, at, last_at, count, ok, status, code, http_status, message, ms, detail)
VALUES (:key, :at, :at, 1, :ok, :status, :code, :http_status, :message, :ms, :detail)`;

function detailJson(detail: Record<string, DetailValue> | null): string | null {
  return detail === null ? null : JSON.stringify(detail);
}

function parseDetail(text: unknown): Record<string, DetailValue> | null {
  if (typeof text !== 'string') return null;
  try {
    return cleanDetail(JSON.parse(text), []);
  } catch {
    return null;
  }
}

function numOrNull(value: unknown): number | null {
  if (typeof value === 'bigint') return Number(value);
  return finite(value);
}

/** A stored time column: an epoch ms a `Date` can hold, else null. */
function timeOrNull(value: unknown): number | null {
  return timestamp(typeof value === 'bigint' ? Number(value) : value);
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** ISO text of an epoch-ms time; null (never a throw) when a `Date` cannot hold it. */
function iso(ms: number | null): string | null {
  const t = timestamp(ms);
  return t === null ? null : new Date(t).toISOString();
}

function publicState(entry: Entry): HealthState {
  return {
    key: entry.key,
    area: entry.area,
    label: entry.label,
    accountId: entry.accountId,
    status: entry.status,
    lastOkAt: entry.lastOkAt,
    lastFailAt: entry.lastFailAt,
    failingSince: entry.failingSince,
    lastCheckedAt: entry.lastCheckedAt,
    expectEveryMs: entry.expectEveryMs,
    consecutiveFailures: entry.consecutiveFailures,
    lastCode: entry.lastCode,
    lastStatus: entry.lastStatus,
    lastMessage: entry.lastMessage,
    lastMs: entry.lastMs,
    detail: entry.detail === null ? null : { ...entry.detail },
    causeKey: entry.causeKey,
    nextAttemptAt: entry.nextAttemptAt,
    updatedAt: entry.updatedAt,
  };
}

function entryFromRow(row: HealthRow): Entry | null {
  const key = validKey(row.key);
  if (key === null) return null;
  const status: HealthStatusValue =
    row.status === 'ok' || row.status === 'degraded' || row.status === 'failing' ? row.status : 'unknown';
  return {
    key,
    area: typeof row.area === 'string' && AREA_RE.test(row.area) ? row.area : 'server',
    label: strOrNull(row.label),
    accountId: strOrNull(row.account_id),
    status,
    lastOkAt: timeOrNull(row.last_ok_at),
    lastFailAt: timeOrNull(row.last_fail_at),
    failingSince: timeOrNull(row.failing_since),
    lastCheckedAt: timeOrNull(row.last_checked_at),
    expectEveryMs: numOrNull(row.expect_every_ms),
    consecutiveFailures: numOrNull(row.consecutive_failures) ?? 0,
    lastCode: strOrNull(row.last_code),
    lastStatus: numOrNull(row.last_status),
    lastMessage: strOrNull(row.last_message),
    lastMs: numOrNull(row.last_ms),
    detail: parseDetail(row.detail),
    causeKey: strOrNull(row.cause_key),
    nextAttemptAt: timeOrNull(row.next_attempt_at),
    updatedAt: timeOrNull(row.updated_at) ?? 0,
    lastReminderAt: timeOrNull(row.last_reminder_at),
    restored: true,
    persistedAt: null,
    dirty: false,
  };
}

function outcomeFromRow(row: OutcomeRowDb): OutcomeRowState {
  const status: OutcomeStatus = row.status === 'ok' || row.status === 'degraded' ? row.status : 'failing';
  return {
    id: numOrNull(row.id) ?? 0,
    key: row.key,
    at: timeOrNull(row.at) ?? 0,
    lastAt: timeOrNull(row.last_at) ?? 0,
    count: numOrNull(row.count) ?? 1,
    ok: row.ok === 1,
    status,
    code: strOrNull(row.code),
    httpStatus: numOrNull(row.http_status),
    message: strOrNull(row.message),
    ms: numOrNull(row.ms),
    detail: parseDetail(row.detail),
  };
}

function isShortLived(key: string): boolean {
  return SHORT_LIVED_PREFIXES.some((p) => key.startsWith(p));
}

/** A short-lived subject nothing checked for this long is inactive (see {@link isInactiveSubject}). */
export const INACTIVE_AFTER_MS = DAY_MS;

/**
 * A feed or suggestion provider nothing has checked for {@link INACTIVE_AFTER_MS}: most likely
 * removed from its widget or no longer used, so the summary and the `status` line leave it out (a
 * removed feed would otherwise say "Failing" until the 7-day purge). It comes back with its
 * history as soon as something checks it again.
 */
export function isInactiveSubject(state: Pick<HealthState, 'key' | 'lastCheckedAt' | 'updatedAt'>, now: number): boolean {
  return isShortLived(state.key) && now - (state.lastCheckedAt ?? state.updatedAt) > INACTIVE_AFTER_MS;
}

export function createHealthRecorder(opts: HealthRecorderOptions): HealthRecorder {
  const { db, log } = opts;
  const clock = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let queue: Op[] = [];
  let scheduled = false;
  let closed = false;
  let lastWarnAt = Number.NEGATIVE_INFINITY;

  /** At most one warning a minute, outside any unit of work. */
  const warnOnce = (message: string, err: unknown): void => {
    try {
      const t = clock();
      if (t - lastWarnAt < WARN_INTERVAL_MS) return;
      lastWarnAt = t;
      outsideLogContext(() => log.warn(message, errorFields(err)));
    } catch {
      // Never let diagnostics break the caller.
    }
  };

  try {
    for (const row of db.all<HealthRow>('SELECT * FROM diag_health')) {
      const entry = entryFromRow(row);
      if (entry !== null) entries.set(entry.key, entry);
    }
  } catch (err) {
    warnOnce('health persistence failed', err);
  }

  // -- persistence ---------------------------------------------------------

  const params = (entry: Entry): Record<string, string | number | null> => ({
    key: entry.key,
    area: entry.area,
    label: entry.label,
    account_id: entry.accountId,
    status: entry.status,
    last_ok_at: entry.lastOkAt,
    last_fail_at: entry.lastFailAt,
    failing_since: entry.failingSince,
    last_checked_at: entry.lastCheckedAt,
    expect_every_ms: entry.expectEveryMs,
    consecutive_failures: entry.consecutiveFailures,
    last_code: entry.lastCode,
    last_status: entry.lastStatus,
    last_message: entry.lastMessage,
    last_ms: entry.lastMs,
    detail: detailJson(entry.detail),
    cause_key: entry.causeKey,
    next_attempt_at: entry.nextAttemptAt,
    last_reminder_at: entry.lastReminderAt,
    updated_at: entry.updatedAt,
  });

  const apply = (op: Op): void => {
    switch (op.kind) {
      case 'upsert': {
        const entry = entries.get(op.key);
        if (entry !== undefined) db.run(UPSERT_SQL, params(entry));
        return;
      }
      case 'outcome': {
        const r = op.row;
        if (op.collapse) {
          const changed = db.run(COLLAPSE_SQL, { at: r.at, key: r.key, status: r.status, code: r.code, http_status: r.httpStatus });
          if (changed.changes > 0) return;
        }
        db.run(INSERT_OUTCOME_SQL, {
          key: r.key,
          at: r.at,
          ok: r.ok ? 1 : 0,
          status: r.status,
          code: r.code,
          http_status: r.httpStatus,
          message: r.message,
          ms: r.ms,
          detail: detailJson(r.detail),
        });
        return;
      }
      case 'forget':
        if (op.prefix) {
          db.run('DELETE FROM diag_outcomes WHERE substr(key, 1, ?) = ?', [op.key.length, op.key]);
          db.run('DELETE FROM diag_health WHERE substr(key, 1, ?) = ?', [op.key.length, op.key]);
        } else {
          db.run('DELETE FROM diag_outcomes WHERE key = ?', [op.key]);
          db.run('DELETE FROM diag_health WHERE key = ?', [op.key]);
        }
        return;
      case 'forgetAccount':
        db.run('DELETE FROM diag_outcomes WHERE key IN (SELECT key FROM diag_health WHERE account_id = ?)', [op.accountId]);
        db.run('DELETE FROM diag_health WHERE account_id = ?', [op.accountId]);
        for (const key of op.keys) {
          db.run('DELETE FROM diag_outcomes WHERE key = ?', [key]);
          db.run('DELETE FROM diag_health WHERE key = ?', [key]);
        }
        return;
    }
  };

  /** Writes the queue in one transaction (a nested savepoint only when `force`d inside one). */
  const writeQueued = (): void => {
    if (queue.length === 0) return;
    const ops = queue;
    queue = [];
    try {
      db.tx(() => {
        for (const op of ops) apply(op);
      });
    } catch (err) {
      warnOnce('health persistence failed', err);
    }
  };

  const runScheduled = (): void => {
    scheduled = false;
    // close() wrote (or dropped) the queue; the database may be closed by now.
    if (closed || queue.length === 0) return;
    try {
      if (db.inTransaction) {
        // Someone else's transaction is open: write after it.
        scheduled = true;
        outsideLogContext(() => setImmediate(runScheduled));
        return;
      }
    } catch (err) {
      warnOnce('health persistence failed', err);
      queue = [];
      return;
    }
    writeQueued();
  };

  const enqueue = (op: Op): void => {
    if (closed) return;
    queue.push(op);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(runScheduled);
    }
  };

  /** Queues the entry's row on a transition, on its first write, or once the interval passed. */
  const persist = (entry: Entry, t: number, transition: boolean): void => {
    entry.dirty = true;
    if (closed) return;
    if (transition || entry.persistedAt === null || t - entry.persistedAt >= PERSIST_INTERVAL_MS) {
      entry.persistedAt = t;
      entry.dirty = false;
      enqueue({ kind: 'upsert', key: entry.key });
    }
  };

  const queueDirty = (): void => {
    for (const entry of entries.values()) {
      if (!entry.dirty) continue;
      entry.dirty = false;
      entry.persistedAt = clock();
      enqueue({ kind: 'upsert', key: entry.key });
    }
  };

  /** Writes now unless another transaction is open (then the scheduled flush writes after it). */
  const flushNow = (): void => {
    if (closed || queue.length === 0) return;
    if (db.inTransaction) {
      if (!scheduled) {
        scheduled = true;
        outsideLogContext(() => setImmediate(runScheduled));
      }
      return;
    }
    writeQueued();
  };

  // -- recording -----------------------------------------------------------

  const newEntry = (subject: CleanSubject, t: number): Entry => ({
    key: subject.key,
    area: subject.area,
    label: subject.label ?? null,
    accountId: subject.accountId ?? null,
    status: 'unknown',
    lastOkAt: null,
    lastFailAt: null,
    failingSince: null,
    lastCheckedAt: null,
    expectEveryMs: subject.expectEveryMs ?? null,
    consecutiveFailures: 0,
    lastCode: null,
    lastStatus: null,
    lastMessage: null,
    lastMs: null,
    detail: null,
    causeKey: null,
    nextAttemptAt: null,
    updatedAt: t,
    lastReminderAt: null,
    restored: false,
    persistedAt: null,
    dirty: false,
  });

  const applySubject = (entry: Entry, subject: CleanSubject): void => {
    entry.area = subject.area;
    if (subject.accountId !== undefined) entry.accountId = subject.accountId;
    if (subject.label !== undefined) entry.label = subject.label;
    if (subject.expectEveryMs !== undefined) entry.expectEveryMs = subject.expectEveryMs;
  };

  /**
   * Fields every transition line carries: the subject's key, label and account, then the given ones
   * (nulls left out). The label (a hostname or token, vetted by `cleanSubject`) is what names a feed or
   * ICS calendar in server.log, where the key is only a hash.
   */
  const lineFields = (entry: Entry, fields: Record<string, unknown>, detail: Record<string, DetailValue> | null = null): LogFields => {
    const out: LogFields = { ...(detail ?? {}) };
    for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined) out[k] = v;
    out.area = entry.area;
    out.key = entry.key;
    if (entry.label !== null) out.label = entry.label;
    if (entry.accountId !== null) out.accountId = entry.accountId;
    return out;
  };

  const say = (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields: LogFields): void => {
    log[level](message, fields);
  };

  const recordUnsafe = (subject: HealthSubject, outcome: Outcome): void => {
    const t = clock();
    const dropped: string[] = [];
    const subj = cleanSubject(subject, dropped);
    if (subj === null) {
      log.debug('health record ignored: invalid subject key', { dropped: ['key'] });
      return;
    }
    const o = cleanOutcome(outcome, dropped);
    if (dropped.length > 0) log.debug('health outcome fields dropped', { area: subj.area, key: subj.key, dropped });

    const prev = entries.get(subj.key);
    const entry = prev ?? newEntry(subj, t);
    if (prev === undefined) entries.set(entry.key, entry);
    applySubject(entry, subj);

    const before = entry.status;
    const restored = entry.restored;
    entry.restored = false;
    const sameProblem = entry.lastCode === o.code && entry.lastStatus === o.httpStatus;
    const area = entry.area;
    let transition = false;
    let row: { collapse: boolean } | null = null;

    if (o.status === 'ok') {
      if (before === 'failing' || before === 'degraded') {
        transition = true;
        say('info', `${area} recovered`, lineFields(entry, {
          downForMs: entry.failingSince === null ? null : Math.max(0, t - entry.failingSince),
          failures: entry.consecutiveFailures,
          ms: o.ms,
        }));
      } else {
        transition = before === 'unknown';
        say('debug', `${area} ok`, lineFields(entry, { ms: o.ms }, o.detail));
      }
      entry.status = 'ok';
      entry.lastOkAt = t;
      entry.failingSince = null;
      entry.consecutiveFailures = 0;
      entry.lastReminderAt = null;
      if (transition) row = { collapse: false };
    } else if (o.status === 'failing') {
      const consecutive = entry.consecutiveFailures + 1;
      const continuing = before === 'failing' && (restored ? entry.lastCode === o.code : sameProblem);
      if (!continuing) {
        transition = true;
        say(o.severity, `${area} failing`, lineFields(entry, {
          code: o.code,
          status: o.httpStatus,
          message: o.message,
          consecutive,
          causeKey: o.causeKey,
          nextAttemptAt: iso(o.nextAttemptAt),
        }, o.detail));
        if (before !== 'failing') entry.failingSince = t;
        entry.lastReminderAt = t;
        row = { collapse: false };
      } else {
        const since = entry.failingSince ?? t;
        const lastNotice = entry.lastReminderAt ?? since;
        if (restored || t - lastNotice >= REMINDER_INTERVAL_MS) {
          say('info', `${area} still failing`, lineFields(entry, { code: o.code, since: iso(since), consecutive }));
          entry.lastReminderAt = t;
        } else {
          say('debug', `${area} still failing`, lineFields(entry, { code: o.code, consecutive }));
        }
        if (entry.failingSince === null) entry.failingSince = since;
        row = { collapse: true };
      }
      entry.status = 'failing';
      entry.lastFailAt = t;
      entry.consecutiveFailures = consecutive;
      entry.lastCode = o.code;
      entry.lastStatus = o.httpStatus;
      entry.lastMessage = o.message;
    } else {
      const continuing = before === 'degraded' && (restored ? entry.lastCode === o.code : sameProblem);
      if (!continuing) {
        transition = true;
        say('info', `${area} degraded`, lineFields(entry, {
          code: o.code,
          status: o.httpStatus,
          message: o.message,
          causeKey: o.causeKey,
        }, o.detail));
        entry.failingSince = t;
        entry.lastReminderAt = t;
        row = { collapse: false };
      } else {
        const since = entry.failingSince ?? t;
        const lastNotice = entry.lastReminderAt ?? since;
        if (restored || t - lastNotice >= REMINDER_INTERVAL_MS) {
          say('info', `${area} still degraded`, lineFields(entry, { code: o.code, since: iso(since) }));
          entry.lastReminderAt = t;
        } else {
          say('debug', `${area} still degraded`, lineFields(entry, { code: o.code }));
        }
        if (entry.failingSince === null) entry.failingSince = since;
        row = { collapse: true };
      }
      entry.status = 'degraded';
      entry.lastOkAt = t;
      entry.consecutiveFailures = 0;
      entry.lastCode = o.code;
      entry.lastStatus = o.httpStatus;
      entry.lastMessage = o.message;
    }

    entry.lastCheckedAt = t;
    entry.lastMs = o.ms;
    entry.detail = o.detail;
    entry.causeKey = o.causeKey;
    entry.nextAttemptAt = o.nextAttemptAt;
    entry.updatedAt = t;

    if (row !== null && !closed) {
      enqueue({
        kind: 'outcome',
        collapse: row.collapse,
        row: {
          key: entry.key,
          at: t,
          ok: o.status !== 'failing',
          status: o.status,
          code: o.code,
          httpStatus: o.httpStatus,
          message: o.message,
          ms: o.ms,
          detail: o.detail,
        },
      });
    }
    persist(entry, t, transition);
  };

  const touchUnsafe = (subject: HealthSubject, info: { skipped: HealthSkipReason; nextAttemptAt?: number | null }): void => {
    const t = clock();
    const dropped: string[] = [];
    const subj = cleanSubject(subject, dropped);
    if (subj === null) return;
    const skipped = isRecord(info) && typeof info.skipped === 'string' && SKIP_SET.has(info.skipped) ? info.skipped : null;
    if (skipped === null) dropped.push('skipped');
    const hasNext = isRecord(info) && info.nextAttemptAt !== undefined;
    const nextAttemptAt = hasNext ? timestamp(info.nextAttemptAt) : null;
    if (hasNext && nextAttemptAt === null && info.nextAttemptAt !== null) dropped.push('nextAttemptAt');
    if (dropped.length > 0) log.debug('health outcome fields dropped', { area: subj.area, key: subj.key, dropped });

    const prev = entries.get(subj.key);
    const entry = prev ?? newEntry(subj, t);
    if (prev === undefined) entries.set(entry.key, entry);
    applySubject(entry, subj);
    entry.lastCheckedAt = t;
    if (skipped !== null) entry.detail = { ...(entry.detail ?? {}), skipped };
    if (hasNext) entry.nextAttemptAt = nextAttemptAt;
    entry.updatedAt = t;
    log.debug(`${entry.area} skipped`, lineFields(entry, { skipped, nextAttemptAt: iso(entry.nextAttemptAt) }));
    persist(entry, t, false);
  };

  const forgetUnsafe = (keyOrPrefix: string): void => {
    if (typeof keyOrPrefix !== 'string' || keyOrPrefix === '' || validKey(keyOrPrefix) === null) return;
    const prefix = keyOrPrefix.endsWith(':');
    let removed = 0;
    for (const key of [...entries.keys()]) {
      if (prefix ? key.startsWith(keyOrPrefix) : key === keyOrPrefix) {
        entries.delete(key);
        removed++;
      }
    }
    enqueue({ kind: 'forget', key: keyOrPrefix, prefix });
    log.debug('health subjects forgotten', { key: keyOrPrefix, removed });
  };

  const forgetAccountUnsafe = (accountId: string): void => {
    if (typeof accountId !== 'string' || accountId === '' || validKey(accountId) === null) return;
    const own = new Set([`account:${accountId}`, `mail:${accountId}`, `calendar-list:${accountId}`]);
    // Every removed key goes to the database by name too: a subject recorded in this tick has no
    // `diag_health` row with its account yet, but its queued outcome row is written first.
    const keys = new Set(own);
    let removed = 0;
    for (const [key, entry] of [...entries]) {
      if (own.has(key) || entry.accountId === accountId) {
        entries.delete(key);
        keys.add(key);
        removed++;
      }
    }
    enqueue({ kind: 'forgetAccount', accountId, keys: [...keys] });
    log.debug('health subjects forgotten', { accountId, removed });
  };

  const purgeUnsafe = (now: number): void => {
    // After close() nothing is written (the database may be closed).
    if (closed) return;
    queueDirty();
    flushNow();
    const outcomeCutoff = now - OUTCOME_RETENTION_MS;
    const healthCutoff = now - HEALTH_RETENTION_MS;
    const shortCutoff = now - SHORT_LIVED_RETENTION_MS;
    let outcomes = 0;
    let subjects = 0;
    db.tx(() => {
      outcomes += db.run('DELETE FROM diag_outcomes WHERE last_at < ?', [outcomeCutoff]).changes;
      outcomes += db.run(
        'DELETE FROM diag_outcomes WHERE id <= (SELECT id FROM diag_outcomes ORDER BY id DESC LIMIT 1 OFFSET ?)',
        [MAX_OUTCOME_ROWS],
      ).changes;
      subjects += db.run('DELETE FROM diag_health WHERE updated_at < ?', [healthCutoff]).changes;
      subjects += db.run(
        "DELETE FROM diag_health WHERE (substr(key, 1, 5) = 'feed:' OR substr(key, 1, 8) = 'suggest:') AND updated_at < ?",
        [shortCutoff],
      ).changes;
    });
    for (const [key, entry] of [...entries]) {
      if (entry.updatedAt < healthCutoff || (isShortLived(key) && entry.updatedAt < shortCutoff)) entries.delete(key);
    }
    log.debug('health history purged', { outcomes, subjects });
  };

  return {
    record(subject, outcome) {
      try {
        recordUnsafe(subject, outcome);
      } catch (err) {
        warnOnce('health tracker failed', err);
      }
    },
    touch(subject, info) {
      try {
        touchUnsafe(subject, info);
      } catch (err) {
        warnOnce('health tracker failed', err);
      }
    },
    get(key) {
      const entry = entries.get(key);
      return entry === undefined ? null : publicState(entry);
    },
    list(filter = {}) {
      const out: HealthState[] = [];
      for (const entry of entries.values()) {
        if (filter.area !== undefined && entry.area !== filter.area) continue;
        if (filter.accountId !== undefined && entry.accountId !== filter.accountId) continue;
        out.push(publicState(entry));
      }
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    history(key, limit = DEFAULT_HISTORY) {
      try {
        flushNow();
        const n = Math.min(MAX_HISTORY, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : DEFAULT_HISTORY)));
        return db.all<OutcomeRowDb>('SELECT * FROM diag_outcomes WHERE key = ? ORDER BY id DESC LIMIT ?', [key, n]).map(outcomeFromRow);
      } catch (err) {
        warnOnce('health persistence failed', err);
        return [];
      }
    },
    forget(keyOrPrefix) {
      try {
        forgetUnsafe(keyOrPrefix);
      } catch (err) {
        warnOnce('health tracker failed', err);
      }
    },
    forgetAccount(accountId) {
      try {
        forgetAccountUnsafe(accountId);
      } catch (err) {
        warnOnce('health tracker failed', err);
      }
    },
    purge(now = clock()) {
      try {
        purgeUnsafe(now);
      } catch (err) {
        warnOnce('health persistence failed', err);
      }
    },
    flush() {
      try {
        flushNow();
      } catch (err) {
        warnOnce('health persistence failed', err);
      }
    },
    close() {
      if (closed) return;
      try {
        queueDirty();
        // Shutdown: write even inside an open transaction (as a savepoint) rather than lose it.
        writeQueued();
      } catch (err) {
        warnOnce('health persistence failed', err);
      } finally {
        closed = true;
        queue = [];
      }
    },
  };
}
