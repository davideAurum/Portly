/**
 * Leveled logger (ARCHITECTURE §3, §17) → `logs/server.log` (JSON Lines, rotated at 10 MB, 5 kept),
 * the console, and in-memory rings that Settings → Diagnostics reads through {@link LogHub}.
 *
 * Every call builds one record: the log context (`log-context.ts`), child bindings and call fields
 * are merged (call > bindings > context); `rid`, `src`, `area`, `ring`, `repeatKey`/`repeatSig`
 * (and a browser event's `tEvent`) are lifted out of the fields; caller keys that clash with record
 * keys are renamed `f_<key>`; fields pass through `scrubFields` and the message through `scrub`,
 * plus this PC's home directory → `~`. Rings capture every record whatever the level; the level
 * (boot level, or debug while verbose is on for one of the record's tags) gates file and console,
 * where browser events (`src: 'client'`) need warn+ unless verbose covers them.
 *
 * Rules enforced here / by callers:
 * - never log request or response bodies or other content (titles, subjects, search text …);
 * - URLs are logged as hosts (request paths without query strings, see {@link pathForLog});
 * - errors log through {@link errorFields}: allowlisted keys, scrubbed message, frame-only stacks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOG_LEVEL_ORDER,
  LOG_SOURCES,
  REASON_TOKEN,
  scrub,
  scrubFields,
  type LogLevel,
  type LogRecord,
  type LogSource,
} from '@homebase/shared';
import { getLogContext, outsideLogContext } from './log-context.ts';

export { SCRUB_PATTERNS, scrub } from '@homebase/shared';
export type { LogLevel, LogSource } from '@homebase/shared';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Logger that adds `bindings` to every line (e.g. `{module: 'calendar'}`). */
  child(bindings: LogFields): Logger;
}

/** A record as the rings and `GET /api/diagnostics/logs` return it (`LogRecordSchema`). */
export type LogRecordOut = LogRecord;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

const homePatterns = new Map<string, RegExp | null>();

/** Literal occurrences of `home` (`\`, `\\` and `/` spellings, any case); null for a root-like home. */
function homePattern(home: string): RegExp | null {
  let re = homePatterns.get(home);
  if (re !== undefined) return re;
  const parts = home.replace(/[\\/]+$/, '').split(/[\\/]+/);
  const usable = parts.length >= 2 && parts.join('/').length >= 4 && parts[parts.length - 1] !== '';
  re = usable
    ? new RegExp(
        `(?:${[...new Set([parts.join('\\'), parts.join('\\\\'), parts.join('/')])].map(escapeRegExp).join('|')})(?=[\\\\/"'\\s,;:)\\]}]|$)`,
        'gi',
      )
    : null;
  homePatterns.set(home, re);
  return re;
}

function defaultHome(): string {
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

/**
 * Replaces this PC's home directory (`os.homedir()`, in its `\`, `\\` and `/` spellings) with `~`
 * — server-only complement of `maskUserPaths` for homes outside `C:\Users`.
 */
export function maskHomeDir(text: string, home: string = defaultHome()): string {
  const re = homePattern(home);
  return re === null ? text : text.replace(re, '~');
}

/**
 * Free text → safe to log on this server: the home directory first (the generic user-path rule may
 * rewrite part of a home outside `C:\Users`, and the literal home would then no longer match), then
 * the scrub patterns and user paths.
 */
export function scrubText(text: string): string {
  return scrub(maskHomeDir(text));
}

const MAX_HOME_DEPTH = 8;

/** A stand-in for `err` with the home directory masked in what `scrubFields` reads of an error (name, message, code). */
function maskedError(err: Error): Error {
  try {
    const copy = new Error(maskHomeDir(String(err.message))) as Error & { code?: unknown };
    copy.name = maskHomeDir(String(err.name));
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') copy.code = maskHomeDir(code);
    else if (typeof code === 'number') copy.code = code;
    return copy;
  } catch {
    return err;
  }
}

/** Objects `scrubFields` converts by their type, whose output holds no path: passed through as they are. */
function passedThrough(v: object): boolean {
  try {
    return v instanceof Date || v instanceof ArrayBuffer || ArrayBuffer.isView(v) || typeof (v as { toJSON?: unknown }).toJSON === 'function';
  } catch {
    return true;
  }
}

/**
 * Applies {@link maskHomeDir} to every key and string of a value, as a copy `scrubFields` reads the
 * same way: arrays and sets → arrays, maps → objects of their entries, an error → a stand-in with
 * its name, message and code masked, any other object (plain or of a class) → an object of its own
 * enumerable keys (null prototype unless plain, so a `__proto__` key stays data). Dates, binary data
 * and objects with `toJSON` are passed through (`scrubFields` converts them by type), a cycle
 * becomes `'[Circular]'`, and values deeper than {@link MAX_HOME_DEPTH} levels are passed through
 * (`scrubFields` cuts them anyway).
 */
export function maskHomeDeep(value: unknown): unknown {
  const ancestors = new Set<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return maskHomeDir(v);
    if (v === null || typeof v !== 'object' || depth > MAX_HOME_DEPTH) return v;
    if (v instanceof Error) return maskedError(v);
    if (passedThrough(v)) return v;
    if (ancestors.has(v)) return '[Circular]';
    ancestors.add(v);
    try {
      if (Array.isArray(v) || v instanceof Set) return [...(v as Iterable<unknown>)].map((item) => walk(item, depth + 1));
      const plain = Object.getPrototypeOf(v) === Object.prototype;
      const out = Object.create(plain ? Object.prototype : null) as Record<string, unknown>;
      const put = (k: string, item: unknown): void => {
        Object.defineProperty(out, maskHomeDir(k), { value: walk(item, depth + 1), enumerable: true, writable: true, configurable: true });
      };
      if (v instanceof Map) {
        for (const [k, item] of v) put(String(k), item);
        return out;
      }
      for (const k of Object.keys(v)) {
        let item: unknown;
        try {
          item = (v as Record<string, unknown>)[k];
        } catch {
          item = '[unreadable]';
        }
        put(k, item);
      }
      return out;
    } catch {
      return v;
    } finally {
      ancestors.delete(v);
    }
  };
  return walk(value, 0);
}

/**
 * Characters `JSON.stringify` leaves raw that could mislead a reader of a log line or of the
 * Diagnostics page: C0 controls other than TAB/LF/CR (JSON escapes them in the file, but they are
 * raw again once a browser parses the API's answer), DEL and C1 controls, line/paragraph separators
 * and bidi controls.
 */
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function escapeChar(ch: string): string {
  return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/** Writes {@link UNSAFE_TEXT} characters as `\uXXXX` (idempotent: the output has none left). */
export function escapeUnsafe(text: string): string {
  return text.replace(UNSAFE_TEXT, escapeChar);
}

/** `scrubFields` output (plain JSON data) with the home directory masked and unsafe characters escaped in every key and string. */
function finishDeep(value: unknown): unknown {
  if (typeof value === 'string') return escapeUnsafe(maskHomeDir(value));
  if (Array.isArray(value)) return value.map(finishDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[escapeUnsafe(maskHomeDir(k))] = finishDeep(v);
    return out;
  }
  return value;
}

/**
 * Any value → safe to log on this server: the home directory masked first (see {@link scrubText}),
 * then `scrubFields`, then the home directory again (messages of the errors `scrubFields`
 * summarises) and {@link UNSAFE_TEXT} characters escaped in every key and string. Record fields go
 * through it, and so does what the diagnostics module reads back from files or puts in the report.
 */
export function scrubValue(value: unknown): unknown {
  return finishDeep(scrubFields(maskHomeDeep(value)));
}

// C0/C1 controls except TAB, line/paragraph separators and bidi controls: written as `\uXXXX`.
const MESSAGE_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const MAX_MESSAGE = 500;

function cleanMessage(message: unknown): string {
  const text = typeof message === 'string' ? message : String(message);
  const scrubbed = scrubText(text.length > MAX_MESSAGE * 8 ? text.slice(0, MAX_MESSAGE * 8) : text);
  return cap(scrubbed.replace(MESSAGE_CONTROL, escapeChar), MAX_MESSAGE);
}

/** Strips the query string (and fragment) from a URL or path for logging. */
export function pathForLog(urlOrPath: string): string {
  const cut = urlOrPath.search(/[?#]/);
  return cut === -1 ? urlOrPath : urlOrPath.slice(0, cut);
}

// ---------------------------------------------------------------------------
// errorFields
// ---------------------------------------------------------------------------

const MAX_ERROR_MESSAGE = 300;
const MAX_STACK_FRAMES = 15;
const MAX_FRAME = 300;
const MAX_CAUSES = 3;
const STACK_FRAME = /^\s+at /;
const HOST_VALUE = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.?|\[[0-9A-Fa-f:.]+\]|[0-9A-Fa-f:.]+)$/;
const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Errors whose `reason` is one of our own machine codes. */
const REASON_ERRORS = new Set(['SafeFetchError', 'DavParseError', 'ExpandError']);
const HOSTNAME_ERRORS = new Set(['NotPrivateAddressError', 'BlockedAddressError']);

type ErrorLike = Record<string, unknown> & { name: string; message: string };

function isErrorLike(value: unknown): value is ErrorLike {
  if (value instanceof Error) return true;
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && typeof v.message === 'string';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function reasonToken(value: unknown): string | null {
  return typeof value === 'string' && REASON_TOKEN.test(value) ? value : null;
}

function codeValue(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return reasonToken(value);
}

/** Scrubbed message ≤ 300 characters (huge messages are cut before the regex work). */
function errorMessage(text: string): string {
  return cap(scrubText(text.length > MAX_ERROR_MESSAGE * 8 ? text.slice(0, MAX_ERROR_MESSAGE * 8) : text), MAX_ERROR_MESSAGE);
}

/** Frame lines of `stack` (never the `Name: message` header, even when the message spans lines). */
function stackFrames(err: ErrorLike): string | null {
  const stack = err.stack;
  if (typeof stack !== 'string') return null;
  let body = stack;
  const at = err.message === '' ? -1 : stack.indexOf(err.message);
  if (at !== -1) body = stack.slice(at + err.message.length);
  const frames = body
    .split(/\r?\n/)
    .filter((line) => STACK_FRAME.test(line))
    .slice(0, MAX_STACK_FRAMES)
    .map((line) => cap(scrubText(line.trim()), MAX_FRAME));
  return frames.length > 0 ? frames.join('\n') : null;
}

/**
 * Loggable summary of an error, discriminated by `err.name`; keys only when present:
 * `errName`, `errMessage` (scrubbed, ≤ 300), `errCode`, `errStatus` (our own status: HttpError and
 * subclasses, ImapOpError), `upstreamStatus` (DavHttpError `httpStatus`, SuggestUpstreamError
 * `status`, `details.status`/`details.upstreamStatus`), `errReason` (SafeFetchError/DavParseError/
 * ExpandError `reason`, ProviderHttpError `denial`, a token `details.reason`), `providerReason`,
 * `host`, `accountId`, `retryAfterSeconds`, `cause` (≤ 3 links, `TypeError <- Error[ECONNREFUSED]`)
 * with `causeCode` (deepest code), `sqliteCode`/`sqliteError` (node:sqlite), and with
 * `{stack: true}` the first 15 frame lines (never the header line, which repeats the message).
 * Callers spread it before their own fields.
 */
export function errorFields(err: unknown, opts: { stack?: boolean } = {}): LogFields {
  if (!isErrorLike(err)) return { errName: typeof err, errMessage: errorMessage(String(err)) };
  const name = err.name;
  const fields: LogFields = {
    errName: cap(scrubText(name), 100),
    errMessage: errorMessage(String(err.message)),
  };
  const code = err.code;
  if (typeof code === 'string') fields.errCode = cap(scrubText(code), 100);
  else if (typeof code === 'number') fields.errCode = code;

  const details = asRecord(err.details);
  const status = finiteNumber(err.status);
  if (status !== null) {
    if (name === 'SuggestUpstreamError') fields.upstreamStatus = status;
    else fields.errStatus = status;
  }
  if (fields.upstreamStatus === undefined) {
    const upstream = finiteNumber(err.httpStatus) ?? finiteNumber(details?.upstreamStatus) ?? finiteNumber(details?.status);
    if (upstream !== null) fields.upstreamStatus = upstream;
  }

  const reason =
    (REASON_ERRORS.has(name) ? reasonToken(err.reason) : null) ??
    (name === 'ProviderHttpError' ? reasonToken(err.denial) : null) ??
    reasonToken(details?.reason);
  if (reason !== null) fields.errReason = reason;
  if (typeof err.providerReason === 'string') {
    const tokens = err.providerReason.split(/\s+/).filter((t) => REASON_TOKEN.test(t));
    if (tokens.length > 0) fields.providerReason = cap(tokens.join(' '), 300);
  }

  const host = name === 'SafeFetchError' ? err.host : HOSTNAME_ERRORS.has(name) ? err.hostname : undefined;
  if (typeof host === 'string' && host.length <= 253 && HOST_VALUE.test(host)) fields.host = host;
  if (typeof err.accountId === 'string' && ACCOUNT_ID.test(err.accountId)) fields.accountId = err.accountId;
  const retryAfter = finiteNumber(err.retryAfterSeconds) ?? finiteNumber(details?.retryAfterSeconds);
  if (retryAfter !== null) fields.retryAfterSeconds = retryAfter;

  const chain: string[] = [];
  let causeCode: string | number | null = null;
  let cause: unknown = err.cause;
  const seen = new Set<unknown>([err]);
  while (isErrorLike(cause) && chain.length < MAX_CAUSES && !seen.has(cause)) {
    seen.add(cause);
    const c = codeValue(cause.code);
    chain.push(`${cap(scrubText(cause.name), 60)}${c === null ? '' : `[${c}]`}`);
    if (c !== null) causeCode = c;
    cause = cause.cause;
  }
  if (chain.length > 0) fields.cause = chain.join(' <- ');
  if (causeCode !== null) fields.causeCode = causeCode;

  const sqliteCode = finiteNumber(err.errcode);
  if (sqliteCode !== null) fields.sqliteCode = sqliteCode;
  if (typeof err.errstr === 'string') fields.sqliteError = cap(scrubText(err.errstr), 200);

  if (opts.stack) {
    const frames = stackFrames(err);
    if (frames !== null) fields.stack = frames;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Console text
// ---------------------------------------------------------------------------

/** JSON of console fields with every string scrubbed and its unsafe characters escaped (never scrub over serialized JSON). */
function consoleJson(fields: LogFields): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(fields, (_key, value: unknown) => {
      if (typeof value === 'string') return escapeUnsafe(scrubText(value));
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Error) return errorFields(value);
      if (value !== null && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
  } catch {
    return '"[unserializable fields]"';
  }
}

function lineText(level: LogLevel, text: string, json: string | null, at: Date): string {
  const body = json === null ? text : `${text} ${json}`;
  return `${at.toISOString()} ${level.toUpperCase().padEnd(5)} ${body.replace(/\r?\n/g, '\\n')}`;
}

/** Console line: `<ISO> <LEVEL> <message> {fields}` with the message and every field string scrubbed. */
export function formatLine(level: LogLevel, message: string, fields: LogFields | undefined, now = new Date()): string {
  const hasFields = fields !== undefined && Object.keys(fields).length > 0;
  return lineText(level, escapeUnsafe(scrubText(message)), hasFields ? consoleJson(fields) : null, now);
}

// ---------------------------------------------------------------------------
// Hub API
// ---------------------------------------------------------------------------

export interface LoggerOptions {
  level?: LogLevel;
  /** Log file path (JSON Lines); rotated to `.1`…`.<keep>` when it exceeds `maxBytes`. */
  file?: string;
  /** Also write text lines to stdout/stderr (default true; false for the supervised server). */
  console?: boolean;
  /** Default 10 MB. */
  maxBytes?: number;
  /** Rotated files kept (default 5). */
  keep?: number;
  now?: () => number;
  /** Ring sizes: info+ server records (5 000), debug records per area (400), browser events (1 000). */
  mainSize?: number;
  flightPerArea?: number;
  clientSize?: number;
}

export interface LogQuery {
  /** Records with `seq > after`. */
  after?: number;
  /** Epoch ms window: `since ≤ t < before`. */
  since?: number;
  before?: number;
  /** Minimum level (default debug). */
  level?: LogLevel;
  /** Matches any tag. */
  area?: string;
  src?: LogSource;
  rid?: string;
  /** `fields[k] === v` (numbers compared as text); `rid`/`area`/`src` compare the record's own value. */
  fieldEquals?: Record<string, string>;
  /** Case-insensitive substring of the message or the JSON of the fields. */
  q?: string;
  /** Newest `limit` matches (default 500, at most 5 000). */
  limit?: number;
}

export interface LogLevelInfo {
  level: LogLevel;
  verbose: boolean;
  /** Epoch ms; null = until turned off. */
  until: number | null;
  areas: string[] | null;
  bootLevel: LogLevel;
}

export interface LogHub {
  /** Current level; ends an expired verbose period first. */
  levelState(): LogLevelInfo;
  /** Verbose (debug) logging until `until` (epoch ms; null = until turned off), for `areas` (null = all); null turns it off. */
  setVerbose(state: { until: number | null; areas: string[] | null } | null): void;
  /** Records in memory, oldest first; `lastSeq` is the newest seq written (for `after=` polling). */
  query(q: LogQuery): { records: LogRecordOut[]; lastSeq: number; truncated: boolean };
  /** Warn/error records since `sinceMs` (server = server + supervisor) and the distinct warning keys among them. */
  counts(sinceMs: number): { server: { warn: number; error: number }; client: { warn: number; error: number }; warnKeys: number };
  /** Last record written inside a job run (scheduler watchdog). */
  lastRecordFor(run: string): { msg: string; t: number; area: string } | null;
  readonly file: string | null;
  /** Records in memory. */
  readonly size: number;
}

export interface RootLogger extends Logger, LogHub {
  /** Closes the log file and stops the repeat sweep. Further lines go to the console and rings only. */
  close(): void;
}

// ---------------------------------------------------------------------------
// File sink
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_KEEP = 5;
/** After a rotation that could not move the live file: no new attempt for this long (the file grows past maxBytes meanwhile). */
const ROTATE_RETRY_MS = 5_000;

class FileSink {
  #fd: number | null = null;
  #size = 0;
  /** Epoch ms before which no rotation is attempted (set when one fails). */
  #rotateRetryAt = 0;
  readonly #file: string;
  readonly #maxBytes: number;
  readonly #keep: number;
  readonly #now: () => number;

  constructor(file: string, maxBytes: number, keep: number, now: () => number) {
    this.#file = file;
    this.#maxBytes = maxBytes;
    this.#keep = keep;
    this.#now = now;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#open();
  }

  #open(): void {
    this.#fd = fs.openSync(this.#file, 'a');
    this.#size = fs.fstatSync(this.#fd).size;
  }

  #reopen(): void {
    this.close();
    try {
      this.#open();
    } catch {
      this.#fd = null;
    }
  }

  /**
   * Shifts `.<keep-1>` → `.<keep>` … live → `.1`. Best-effort: on Windows a rename onto a file a
   * reader holds open fails (EPERM). The shift stops at the first failure (the next rename would
   * overwrite the name still taken), the live file stays put and grows, and no new attempt is made
   * for {@link ROTATE_RETRY_MS} (not one per line while the reader keeps the file open).
   */
  #rotate(): void {
    this.close();
    for (let i = this.#keep; i >= 1; i--) {
      const from = i === 1 ? this.#file : `${this.#file}.${i - 1}`;
      try {
        if (fs.existsSync(from)) fs.renameSync(from, `${this.#file}.${i}`);
      } catch {
        this.#rotateRetryAt = this.#now() + ROTATE_RETRY_MS;
        break;
      }
    }
    this.#reopen();
  }

  write(line: string): void {
    if (this.#fd === null) return;
    const data = `${line}\n`;
    const bytes = Buffer.byteLength(data);
    if (this.#size > 0 && this.#size + bytes > this.#maxBytes && this.#now() >= this.#rotateRetryAt) {
      // Another process may have rotated the file under us: our descriptor then points at `.1`.
      let onDisk: number | null = null;
      try {
        onDisk = fs.statSync(this.#file).size;
      } catch {
        onDisk = null;
      }
      if (onDisk === null || onDisk < this.#size) this.#reopen();
      if (this.#size > 0 && this.#size + bytes > this.#maxBytes) this.#rotate();
    }
    if (this.#fd === null) return;
    try {
      fs.writeSync(this.#fd, data);
      this.#size += bytes;
    } catch {
      // Never let logging crash the server.
    }
  }

  close(): void {
    if (this.#fd !== null) {
      try {
        fs.closeSync(this.#fd);
      } catch {
        // ignore
      }
      this.#fd = null;
    }
  }
}

/** One JSON Lines record: `{t, lvl, msg, src?, area, tags, rid?, tEvent?, ...fields}`. */
function jsonLine(rec: LogRecordOut): string {
  const line: Record<string, unknown> = { t: rec.t, lvl: rec.level, msg: rec.msg };
  if (rec.src !== 'server') line.src = rec.src;
  line.area = rec.area;
  line.tags = rec.tags;
  if (rec.rid !== null) line.rid = rec.rid;
  if (rec.tEvent !== null) line.tEvent = rec.tEvent;
  // Own keys only: `in` would also skip fields named like Object.prototype members (`toString`).
  for (const [k, v] of Object.entries(rec.fields)) if (!Object.hasOwn(line, k)) line[k] = v;
  return JSON.stringify(line);
}

// ---------------------------------------------------------------------------
// Rings
// ---------------------------------------------------------------------------

class Ring<T> {
  readonly #items: (T | undefined)[];
  #start = 0;
  #length = 0;

  constructor(capacity: number) {
    this.#items = new Array<T | undefined>(Math.max(1, Math.floor(capacity)));
  }

  get length(): number {
    return this.#length;
  }

  push(item: T): void {
    const capacity = this.#items.length;
    if (this.#length < capacity) {
      this.#items[(this.#start + this.#length) % capacity] = item;
      this.#length++;
    } else {
      this.#items[this.#start] = item;
      this.#start = (this.#start + 1) % capacity;
    }
  }

  *[Symbol.iterator](): IterableIterator<T> {
    const capacity = this.#items.length;
    for (let i = 0; i < this.#length; i++) yield this.#items[(this.#start + i) % capacity] as T;
  }
}

interface RingEntry {
  rec: LogRecordOut;
  /** Epoch ms of `rec.t`. */
  ms: number;
  /** Repeat key, or `<area> <msg>`: distinct warnings for `counts().warnKeys`. */
  warnKey: string;
  /** A `repeated` summary of warnings or errors: how many it stands for, at which level. */
  stands?: { level: 'warn' | 'error'; count: number };
}

/** Warn and error: the levels whose collapsed repeats still count as warnings and errors. */
function isWarnLevel(level: unknown): level is 'warn' | 'error' {
  return level === 'warn' || level === 'error';
}

/**
 * The level a record is filtered by: its own, or for the repeats of a warning or error (written at
 * debug) and for the `repeated` summary of their window (info), the level they repeat (`repeatOf`).
 * The log viewer's Warnings filter and the Copy summary thus still see a warning that keeps coming.
 */
export function levelForFilter(level: LogLevel, fields: Readonly<Record<string, unknown>>): LogLevel {
  const of = fields.repeatOf;
  return isWarnLevel(of) && LOG_LEVEL_ORDER[of] > LOG_LEVEL_ORDER[level] ? of : level;
}

// ---------------------------------------------------------------------------
// Record building
// ---------------------------------------------------------------------------

const AREA_ALIASES: Readonly<Record<string, string>> = {
  oauth: 'accounts',
  pairings: 'pairing',
  icons: 'core',
  uploads: 'core',
  profiles: 'core',
  export: 'core',
  import: 'core',
  about: 'core',
  'health-route': 'core',
};
const AREA_VALUE = /^[a-z0-9_.:-]{1,32}$/;
/** Caller keys that would clash with record keys in the JSON Lines file. */
const RESERVED_KEYS = ['t', 'tEvent', 'level', 'lvl', 'msg', 'seq', 'tags'] as const;
/** Keys lifted out of the fields (they become record properties or steer the logger). */
const LIFTED_KEYS = new Set(['rid', 'src', 'area', 'ring', 'repeatKey', 'repeatSig', 'quiet']);
const REPEAT_WINDOW_MS = 30 * 60 * 1000;
const MAX_REPEAT_KEYS = 1000;
const REPEAT_SWEEP_MS = 60 * 60 * 1000;
const MAX_RUNS = 200;
const MAX_FLIGHT_AREAS = 64;
const MAX_QUERY_LIMIT = 5000;

function normalizeArea(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const area = value.trim().toLowerCase();
  if (!AREA_VALUE.test(area)) return null;
  return AREA_ALIASES[area] ?? area;
}

function asSource(value: unknown): LogSource | null {
  return typeof value === 'string' && (LOG_SOURCES as readonly string[]).includes(value) ? (value as LogSource) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** ISO string of an epoch-ms number or a parseable date string; null otherwise. */
function isoOrNull(value: unknown): string | null {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}

/**
 * Caller-supplied fields as a null-prototype snapshot of their own enumerable keys: a throwing
 * getter becomes `'[unreadable]'` instead of losing the record, and a `__proto__` key stays data.
 */
function readFields(fields: unknown): LogFields {
  const out = Object.create(null) as LogFields;
  if (fields === null || typeof fields !== 'object') return out;
  for (const k of Object.keys(fields)) {
    try {
      out[k] = (fields as LogFields)[k];
    } catch {
      out[k] = '[unreadable]';
    }
  }
  return out;
}

/** A repeat key's open window; the first record's level, ring flag, source, message and code shape its summary. */
interface RepeatWindow {
  sig: string;
  start: number;
  /** Epoch ms of the last repeat counted. */
  last: number;
  count: number;
  area: string;
  level: LogLevel;
  ring: boolean;
  src: LogSource;
  /** The first record's message and `code` field (as written). */
  msg: string;
  code: string | null;
}

function buildLogger(options: LoggerOptions, captured: LogRecordOut[] | null, sweep: boolean): RootLogger {
  const now = options.now ?? Date.now;
  const bootLevel: LogLevel = options.level !== undefined && options.level in LOG_LEVEL_ORDER ? options.level : 'info';
  const toConsole = options.console ?? true;
  // Captured once: a later console redirect or stdout patch never loops back into the logger.
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);

  let sink: FileSink | null = null;
  if (options.file) {
    try {
      sink = new FileSink(options.file, options.maxBytes ?? DEFAULT_MAX_BYTES, options.keep ?? DEFAULT_KEEP, now);
    } catch (err) {
      writeErr(`${formatLine('warn', 'log file unavailable; logging to console only', errorFields(err))}\n`);
    }
  }
  const filePath = sink !== null && options.file ? options.file : null;

  let seq = 0;
  let verbose: { until: number | null; areas: string[] | null } | null = null;
  let reverting = false;
  const main = new Ring<RingEntry>(options.mainSize ?? 5000);
  const flightPerArea = options.flightPerArea ?? 400;
  const flight = new Map<string, Ring<RingEntry>>();
  const client = new Ring<RingEntry>(options.clientSize ?? 1000);
  const runs = new Map<string, { msg: string; t: number; area: string }>();
  const repeats = new Map<string, RepeatWindow>();

  /** Verbose is on for one of `tags` (all areas, or a listed one). */
  const verboseCovers = (tags: readonly string[]): boolean => {
    if (verbose === null) return false;
    const areas = verbose.areas;
    return areas === null || tags.some((tag) => areas.includes(tag));
  };

  /** File/console threshold: debug while verbose covers the record; browser events need warn+ otherwise (§17). */
  const sinkLevel = (src: LogSource, tags: readonly string[]): LogLevel => {
    if (verboseCovers(tags)) return 'debug';
    return src === 'client' && LOG_LEVEL_ORDER[bootLevel] < LOG_LEVEL_ORDER.warn ? 'warn' : bootLevel;
  };

  /** Ends a timed verbose period once `until` has passed (state first, then one line outside any context). */
  const expire = (): void => {
    if (verbose === null || verbose.until === null || reverting || now() < verbose.until) return;
    verbose = null;
    reverting = true;
    try {
      outsideLogContext(() => emit('info', 'verbose logging ended', { area: 'diagnostics', reason: 'expired' }, {}));
    } finally {
      reverting = false;
    }
  };

  const enabled = (level: LogLevel, src: LogSource, tags: readonly string[]): boolean => {
    expire();
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[sinkLevel(src, tags)];
  };

  /**
   * `repeated` summary of a closed window, shaped by its first record: info (debug for a debug
   * window, whose records nobody missed), the same ring flag and source (browser windows land in the
   * client ring and pass the browser file rule), outside any context. A window of warnings or errors
   * also names what it repeats — `repeatOf` (the level), `repeatMsg` and the first record's `code` —
   * so the summary counts with that warning (`counts()`, a Warnings filter, the Copy summary).
   */
  const emitRepeated = (key: string, window: RepeatWindow): void => {
    const fields: LogFields = {
      area: window.area,
      src: window.src,
      ring: window.ring,
      repeatKey: key,
      count: window.count,
      since: new Date(window.start).toISOString(),
    };
    const level = window.level;
    if (isWarnLevel(level)) {
      fields.repeatOf = level;
      fields.repeatMsg = window.msg;
      if (window.code !== null) fields.code = window.code;
    }
    outsideLogContext(() =>
      emit(level === 'debug' ? 'debug' : 'info', 'repeated', fields, {}, true, isWarnLevel(level) ? { level, count: window.count } : null),
    );
  };

  /**
   * Repeat suppression: `{suppressed, count, since}` for this call; closes (and reports) a finished
   * window. A window belongs to one signature, source and level: a record at a higher level (a slow
   * request of a debug-level key) starts a new window and is written; a lower one is written as is,
   * uncounted.
   */
  const noteRepeat = (
    key: string,
    next: Omit<RepeatWindow, 'start' | 'last' | 'count'>,
    t: number,
  ): { suppressed: boolean; count: number; since: number } => {
    let window = repeats.get(key);
    if (
      window !== undefined &&
      (window.sig !== next.sig ||
        window.src !== next.src ||
        LOG_LEVEL_ORDER[next.level] > LOG_LEVEL_ORDER[window.level] ||
        t - window.start >= REPEAT_WINDOW_MS)
    ) {
      repeats.delete(key);
      if (window.count > 0) emitRepeated(key, window);
      window = undefined;
    }
    if (window === undefined) {
      repeats.set(key, { ...next, start: t, last: t, count: 0 });
      if (repeats.size > MAX_REPEAT_KEYS) {
        const [oldestKey, oldest] = repeats.entries().next().value as [string, RepeatWindow];
        repeats.delete(oldestKey);
        if (oldest.count > 0) emitRepeated(oldestKey, oldest);
      }
      return { suppressed: false, count: 0, since: t };
    }
    if (LOG_LEVEL_ORDER[next.level] < LOG_LEVEL_ORDER[window.level]) return { suppressed: false, count: 0, since: window.start };
    window.count++;
    window.last = t;
    repeats.delete(key);
    repeats.set(key, window);
    return { suppressed: true, count: window.count, since: window.start };
  };

  const sweepRepeats = (): void => {
    try {
      const t = now();
      for (const [key, window] of repeats) {
        if (t - window.start < REPEAT_WINDOW_MS) continue;
        repeats.delete(key);
        if (window.count > 0) emitRepeated(key, window);
      }
    } catch {
      // Never let logging crash the server.
    }
  };
  const sweepTimer = sweep ? outsideLogContext(() => setInterval(sweepRepeats, REPEAT_SWEEP_MS)) : null;
  sweepTimer?.unref();

  const capture = (entry: RingEntry): void => {
    const rec = entry.rec;
    if (rec.src === 'client') {
      client.push(entry);
    } else if (rec.level === 'debug') {
      let ring = flight.get(rec.area);
      if (ring === undefined) {
        ring = new Ring<RingEntry>(flightPerArea);
        if (flight.size >= MAX_FLIGHT_AREAS) {
          const stalest = flight.keys().next().value;
          if (stalest !== undefined) flight.delete(stalest);
        }
      } else {
        flight.delete(rec.area);
      }
      flight.set(rec.area, ring);
      ring.push(entry);
    } else {
      main.push(entry);
    }
  };

  const emitUnsafe = (
    level: LogLevel,
    message: string,
    call: LogFields,
    bindings: LogFields,
    internal: boolean,
    stands: RingEntry['stands'] | null,
  ): void => {
    expire();
    const ctx = getLogContext();

    // Lifted keys.
    const src = asSource(call.src) ?? asSource(bindings.src) ?? 'server';
    const rid = nonEmptyString(call.rid) ?? nonEmptyString(bindings.rid) ?? nonEmptyString(ctx?.rid) ?? null;
    // A browser event belongs to `client` unless the call names an area (whichever module relays it).
    const candidates =
      src === 'client' ? [call.area, 'client'] : [call.area, bindings.area, bindings.module, ctx?.area, bindings.component];
    const area = candidates.map(normalizeArea).find((a) => a !== null) ?? 'server';
    const tagCandidates = [area, normalizeArea(ctx?.area), normalizeArea(bindings.module), normalizeArea(bindings.component)];
    if (src === 'client') tagCandidates.push('client');
    const tags = [...new Set(tagCandidates.filter((tag): tag is string => tag !== null))];
    const tEvent = src === 'client' ? isoOrNull(call.tEvent) : null;
    const rawRepeatKey = nonEmptyString(call.repeatKey);
    // A summary's key (internal) names the window it closes; it opens none.
    const repeatKey = internal || rawRepeatKey === null ? null : cap(rawRepeatKey, 300);
    const repeatSig = typeof call.repeatSig === 'string' ? call.repeatSig : '';
    const quietDebug = ctx?.quiet === true;
    const ringFor = (lvl: LogLevel): boolean => (call.ring === false ? false : call.ring === true ? true : !(quietDebug && lvl === 'debug'));

    // Merge: call > bindings > context (null prototype: a `__proto__` field stays a field, then is dropped by scrubFields).
    const merged = Object.create(null) as LogFields;
    if (ctx !== undefined) {
      for (const [k, v] of Object.entries(ctx)) if (v !== undefined && !LIFTED_KEYS.has(k)) merged[k] = v;
    }
    for (const [k, v] of Object.entries(bindings)) if (!LIFTED_KEYS.has(k)) merged[k] = v;
    for (const [k, v] of Object.entries(call)) {
      if (LIFTED_KEYS.has(k) && !(internal && k === 'repeatKey')) continue;
      if (k === 'tEvent' && src === 'client') continue;
      merged[k] = v;
    }
    for (const k of RESERVED_KEYS) {
      if (Object.hasOwn(merged, k)) {
        merged[`f_${k}`] = merged[k];
        delete merged[k];
      }
    }
    for (const [k, v] of Object.entries(merged)) {
      try {
        if (isErrorLike(v)) merged[k] = errorFields(v);
      } catch {
        merged[k] = '[unreadable]';
      }
    }

    const t = now();
    const fields = scrubValue(merged) as LogFields;
    const msg = cleanMessage(message);
    let finalLevel = level;
    if (repeatKey !== null) {
      const code = typeof fields.code === 'string' ? fields.code : null;
      const repeat = noteRepeat(repeatKey, { sig: repeatSig, level, ring: ringFor(level), src, area, msg, code }, t);
      if (repeat.suppressed) {
        finalLevel = 'debug';
        fields.repeats = repeat.count;
        // A repeated warning or error stays one for filters and counts (`levelForFilter`); its
        // window's start ties it to the window's `repeated` summary.
        if (isWarnLevel(level)) {
          fields.repeatOf = level;
          fields.repeatSince = new Date(repeat.since).toISOString();
        }
      }
    }

    const rec: LogRecordOut = {
      seq: ++seq,
      t: new Date(t).toISOString(),
      tEvent,
      level: finalLevel,
      msg,
      src,
      area,
      tags,
      rid,
      fields,
    };

    const run = nonEmptyString(ctx?.run);
    if (run !== null) {
      runs.delete(run);
      runs.set(run, { msg: rec.msg, t, area });
      if (runs.size > MAX_RUNS) {
        const oldest = runs.keys().next().value;
        if (oldest !== undefined) runs.delete(oldest);
      }
    }

    if (ringFor(finalLevel)) {
      const summaryKey = stands !== null ? rawRepeatKey : null;
      const entry: RingEntry = { rec, ms: t, warnKey: repeatKey ?? summaryKey ?? `${area} ${rec.msg}` };
      if (stands !== null) entry.stands = stands;
      capture(entry);
    }

    if (!enabled(finalLevel, src, tags)) return;
    captured?.push(rec);
    sink?.write(jsonLine(rec));
    if (toConsole) {
      const consoleFields: LogFields = rid === null ? fields : { rid, ...fields };
      const line = lineText(finalLevel, rec.msg, Object.keys(consoleFields).length > 0 ? JSON.stringify(consoleFields) : null, new Date(t));
      (finalLevel === 'error' || finalLevel === 'warn' ? writeErr : writeOut)(`${line}\n`);
    }
  };

  function emit(
    level: LogLevel,
    message: string,
    call: LogFields | undefined,
    bindings: LogFields,
    internal = false,
    stands: RingEntry['stands'] | null = null,
  ): void {
    try {
      emitUnsafe(level, message, readFields(call), bindings, internal, stands);
    } catch {
      // Never let logging crash the server.
    }
  }

  const levelState = (): LogLevelInfo => {
    expire();
    return {
      level: verbose !== null ? 'debug' : bootLevel,
      verbose: verbose !== null,
      until: verbose?.until ?? null,
      areas: verbose?.areas ? [...verbose.areas] : null,
      bootLevel,
    };
  };

  const setVerbose = (state: { until: number | null; areas: string[] | null } | null): void => {
    if (state === null) {
      verbose = null;
    } else {
      // Only `null` means every area: a list whose names all fail normalization matches nothing.
      const areas = Array.isArray(state.areas) ? [...new Set(state.areas.map(normalizeArea).filter((a): a is string => a !== null))] : null;
      verbose = {
        until: typeof state.until === 'number' && Number.isFinite(state.until) ? state.until : null,
        areas,
      };
    }
    const current = verbose;
    emit(
      'info',
      'log level changed',
      {
        area: 'diagnostics',
        verbose: current !== null,
        until: current === null || current.until === null ? null : new Date(current.until).toISOString(),
        areas: current?.areas ?? null,
      },
      {},
    );
  };

  function* entries(): Generator<RingEntry> {
    yield* main;
    for (const ring of flight.values()) yield* ring;
    yield* client;
  }

  const query = (q: LogQuery): { records: LogRecordOut[]; lastSeq: number; truncated: boolean } => {
    const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.floor(q.limit ?? 500)));
    const minLevel = LOG_LEVEL_ORDER[q.level ?? 'debug'];
    const area = q.area === undefined ? null : (normalizeArea(q.area) ?? q.area);
    const needle = q.q ? q.q.toLowerCase() : null;
    const equals = Object.entries(q.fieldEquals ?? {});
    const matches: RingEntry[] = [];
    for (const entry of entries()) {
      const rec = entry.rec;
      if (q.after !== undefined && rec.seq <= q.after) continue;
      if (q.since !== undefined && entry.ms < q.since) continue;
      if (q.before !== undefined && entry.ms >= q.before) continue;
      if (LOG_LEVEL_ORDER[levelForFilter(rec.level, rec.fields)] < minLevel) continue;
      if (area !== null && !rec.tags.includes(area)) continue;
      if (q.src !== undefined && rec.src !== q.src) continue;
      if (q.rid !== undefined && rec.rid !== q.rid) continue;
      const fieldsMatch = equals.every(([k, v]) => {
        const actual = k === 'rid' || k === 'area' || k === 'src' ? rec[k] : rec.fields[k];
        return actual === v || (typeof actual === 'number' && String(actual) === v);
      });
      if (!fieldsMatch) continue;
      if (needle !== null && !rec.msg.toLowerCase().includes(needle) && !JSON.stringify(rec.fields).toLowerCase().includes(needle)) {
        continue;
      }
      matches.push(entry);
    }
    matches.sort((a, b) => a.rec.seq - b.rec.seq);
    return { records: matches.slice(-limit).map((e) => e.rec), lastSeq: seq, truncated: matches.length > limit };
  };

  /**
   * Warnings and errors written since `sinceMs`, with their collapsed repeats: a closed window counts
   * through its `repeated` summary, a window still open (repeated since `sinceMs`) through its count.
   */
  const counts = (sinceMs: number): ReturnType<LogHub['counts']> => {
    const out = { server: { warn: 0, error: 0 }, client: { warn: 0, error: 0 }, warnKeys: 0 };
    const keys = new Set<string>();
    const tally = (ring: Ring<RingEntry>, bucket: { warn: number; error: number }): void => {
      for (const entry of ring) {
        if (entry.ms < sinceMs) continue;
        const level = entry.rec.level;
        if (isWarnLevel(level)) {
          bucket[level]++;
          keys.add(entry.warnKey);
        } else if (entry.stands !== undefined) {
          bucket[entry.stands.level] += entry.stands.count;
          keys.add(entry.warnKey);
        }
      }
    };
    tally(main, out.server);
    tally(client, out.client);
    for (const [key, window] of repeats) {
      if (window.count === 0 || !window.ring || window.last < sinceMs || !isWarnLevel(window.level)) continue;
      (window.src === 'client' ? out.client : out.server)[window.level] += window.count;
      keys.add(key);
    }
    out.warnKeys = keys.size;
    return out;
  };

  const lastRecordFor = (run: string): { msg: string; t: number; area: string } | null => {
    const last = runs.get(run);
    return last === undefined ? null : { ...last };
  };

  // Children carry the hub too, so code handed `log.child(…)` (the scheduler) can read it.
  const make = (bindings: LogFields): Logger & LogHub => ({
    debug: (m, f) => emit('debug', m, f, bindings),
    info: (m, f) => emit('info', m, f, bindings),
    warn: (m, f) => emit('warn', m, f, bindings),
    error: (m, f) => emit('error', m, f, bindings),
    child: (more) => make({ ...bindings, ...readFields(more) }),
    levelState,
    setVerbose,
    query,
    counts,
    lastRecordFor,
    get file() {
      return sink !== null ? filePath : null;
    },
    get size() {
      let n = main.length + client.length;
      for (const ring of flight.values()) n += ring.length;
      return n;
    },
  });

  return Object.assign(make({}), {
    close: (): void => {
      if (sweepTimer !== null) clearInterval(sweepTimer);
      sink?.close();
      sink = null;
    },
  });
}

/** True for loggers made by {@link createLogger}/{@link createTestLogger} (and their children). */
export function isLogHub(value: unknown): value is Logger & LogHub {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<Record<keyof LogHub, unknown>>;
  return typeof v.query === 'function' && typeof v.lastRecordFor === 'function' && typeof v.levelState === 'function';
}

/** The process logger: JSON Lines file, console text, memory rings, verbose switch. */
export function createLogger(options: LoggerOptions = {}): RootLogger {
  return buildLogger(options, null, true);
}

/**
 * Logger for tests: no file, no console and no sweep timer (repeat windows still close lazily);
 * `lines()` returns the records that passed the level (what the file would contain), while the
 * rings and `query()` behave as in production.
 */
export function createTestLogger(level: LogLevel = 'debug'): RootLogger & { lines(): LogRecordOut[] } {
  const captured: LogRecordOut[] = [];
  return Object.assign(buildLogger({ level, console: false }, captured, false), { lines: () => [...captured] });
}

/** Logger that discards everything (tests). */
export function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  return logger;
}

export interface CapturedLine {
  level: LogLevel;
  message: string;
  fields: LogFields | undefined;
}

/** Logger that records lines in memory (tests asserting on log output). */
export function createMemoryLogger(): Logger & { lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const make = (bindings: LogFields): Logger => {
    const rec =
      (level: LogLevel) =>
      (message: string, fields?: LogFields): void => {
        lines.push({ level, message, fields: Object.keys(bindings).length ? { ...bindings, ...fields } : fields });
      };
    return {
      debug: rec('debug'),
      info: rec('info'),
      warn: rec('warn'),
      error: rec('error'),
      child: (more) => make({ ...bindings, ...more }),
    };
  };
  return Object.assign(make({}), { lines });
}
