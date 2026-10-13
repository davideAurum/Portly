/**
 * This browser's diagnostic events (ARCHITECTURE §17; Settings → Diagnostics, "This browser"):
 * API failures, hybrid-mode transitions, in-browser backend and provider failures, widget errors
 * and uncaught app errors, recorded with {@link recordClientEvent} next to the console lines they
 * explain. When this page load's backend is the Homebase server, `upload.ts` sends them there
 * ({@link pendingUpload} → `POST /api/diagnostics/client-events` → {@link markUploaded}, inside
 * {@link withUploadLock} so that two tabs never send the same stored events); the diagnostic
 * report adds them either way.
 *
 * - **Ring**: the last 300 events, mirrored to localStorage under `homebase:diagnostics:events`
 *   (in the Pages build `homebase:diagnostics:events:<base>`: every project site of a
 *   `<user>.github.io` origin shares that storage), so the events that explain a reload or a lost
 *   connection survive it. The mirror is this browser's: every write merges into what is stored
 *   (another tab's events are kept), it stays under 256 KB, and entries older than 7 days are
 *   dropped whenever it is read. When the origin's quota is full (the query cache shares it), a
 *   write stores the newest half of the ring, a quarter, … (this page load keeps all of it).
 *   **Debug events are never persisted**: this page load keeps its last 100 in memory, beside the
 *   ring (they never push a stored event out of it).
 * - **Privacy** (§17): each category keeps only its allowlisted fields ({@link CLIENT_EVENT_FIELDS},
 *   anything else is dropped); the message and every value go through the shared scrubbers
 *   (`scrub`, `scrubFields`): no secrets, no content, URLs reduced to their host, user paths
 *   masked. API paths lose their query string, stack frames keep their file names only.
 * - **Never throws**, and every storage access is guarded: storage may be missing (the static
 *   project's tests run under Node), blocked, or too full for even one event — the ring then lives
 *   in memory for the rest of the page load (Clear still removes the stored mirror, and stores
 *   again after it). Whatever is read back is validated (`ClientEventSchema`), since another tab,
 *   build or program may have written it.
 *
 * Each event carries a session id (random per page load) and `page = {build, backend, version}`.
 */
import {
  CLIENT_EVENT_CATEGORIES,
  ClientEventSchema,
  LOG_LEVELS,
  scrub,
  scrubFields,
  type ClientEvent,
  type ClientEventCategory,
  type LogLevel,
} from '@homebase/shared';
import { STATIC_BUILD, getCapabilities } from '../capabilities.ts';

/** One recorded event. */
export interface ClientLogEntry {
  /** Local id (`<session>-<n>`), unique in this browser; never uploaded. */
  readonly id: string;
  /** The server accepted it (a 2xx answer to the upload). */
  readonly uploaded: boolean;
  /** What is uploaded: valid against `ClientEventSchema`. */
  readonly event: ClientEvent;
}

/** Fields a caller passes; only the category's allowlisted keys are kept. */
export type ClientEventFields = Readonly<Record<string, unknown>>;

export const CLIENT_LOG_SIZE = 300;
/** This page load's debug events kept in memory, beside the ring. */
export const CLIENT_LOG_DEBUG_SIZE = 100;
/** Upper bound of the stored mirror, in characters of its JSON. */
export const CLIENT_LOG_MAX_CHARS = 256 * 1024;
export const CLIENT_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Most events in one upload (`ClientEventsRequestSchema`). */
export const CLIENT_EVENT_UPLOAD_BATCH = 100;

/** localStorage key of this build's mirror (Pages build: under its base path). */
export function clientEventsStorageKey(pagesBuild: boolean = STATIC_BUILD, base: string = import.meta.env.BASE_URL): string {
  return pagesBuild ? `homebase:diagnostics:events:${base}` : 'homebase:diagnostics:events';
}

/**
 * The fields each category keeps (§17); every other key is dropped. `repeats` (how many
 * identical events one stands for, when the caller collapses repeats) is allowed in every category.
 */
export const CLIENT_EVENT_FIELDS: Readonly<Record<ClientEventCategory, readonly string[]>> = Object.freeze({
  api: Object.freeze(['method', 'route', 'path', 'status', 'code', 'ms', 'rid', 'transport', 'errName', 'errMessage', 'repeats']),
  widget: Object.freeze(['accountId', 'code', 'status', 'widget', 'repeats']),
  provider: Object.freeze(['provider', 'host', 'status', 'code', 'errName', 'ms', 'repeats']),
  hybrid: Object.freeze(['from', 'to', 'reason', 'kind', 'httpStatus', 'ms', 'timedOut', 'errName', 'permission', 'target', 'attempt', 'graceMs', 'repeats']),
  backend: Object.freeze(['errName', 'attempt', 'op', 'repeats']),
  app: Object.freeze(['errName', 'errMessage', 'source', 'stack', 'repeats']),
});

const LEVELS: ReadonlySet<string> = new Set(LOG_LEVELS);
const CATEGORIES: ReadonlySet<string> = new Set(CLIENT_EVENT_CATEGORIES);
const STORAGE_VERSION = 1;
const MAX_MESSAGE = 200;
/** `ClientEventSchema`: field strings ≤ 300 characters, arrays ≤ 10 items. */
const MAX_FIELD_STRING = 300;
const MAX_FIELD_ARRAY = 10;
/** An API event's error message: 5xx and network failures only, ≤ 200 characters. */
const MAX_API_ERROR_MESSAGE = 200;
const MAX_STACK_FRAMES = 5;
/** Input read before scrubbing (whatever lies past it is cut by the caps anyway). */
const MAX_INPUT = 4 * MAX_FIELD_STRING;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** `ClientEventSchema` refuses control, line-separator and bidi-override characters in `msg`. */
const MESSAGE_UNSAFE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;
/**
 * A URL inside free text: scheme (matched from the start of its run of scheme characters, so the
 * scan stays linear), authority, rest. Error messages can quote request URLs (queries, tokens).
 */
const TEXT_URL = /(?<![a-z0-9+.-])([a-z0-9+.-]+:\/\/)([^\s/?#"'<>()\\]*)[^\s"'<>()\\]*/gi;
/** A URL inside a stack frame (`at f (https://host/assets/index-1a2b.js:1:2)`, `f@https://…`). */
const FRAME_URL = /(?<![a-z0-9+.-])[a-z0-9+.-]+:\/\/[^\s()]+/gi;
/**
 * A Firefox or Safari frame: `fn@scheme://…:line:col` (`fn` may be empty, `async*fn` or
 * `global code`; `blob:` URLs too) or `fn@[native code]`. A header line (`Name: message`, which may
 * quote an address) never matches.
 */
const AT_FRAME = /^[^@:]*@(?:(?:blob:)?[a-z][a-z0-9+.-]*:\/\/.*:\d+|\[native code\])$/i;

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

type ClientPrimitive = string | number | boolean | null;
type ClientFieldValue = ClientPrimitive | ClientPrimitive[];

/** Cuts `text` to at most `max` characters, ending with `…` when cut. */
function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Every URL in `text` reduced to `scheme://host/…` (no user info, path, query or fragment). */
function withoutUrls(text: string): string {
  return text.replace(TEXT_URL, (_match, scheme: string, authority: string) => `${scheme}${authority.slice(authority.lastIndexOf('@') + 1)}/…`);
}

/** One line without URLs: whitespace becomes a space, other unsafe characters `\uXXXX` (as the server's log lines). */
function sanitizeMessage(msg: unknown): string {
  const input = typeof msg === 'string' ? msg : String(msg ?? '');
  const text = scrub(withoutUrls(input.slice(0, 4 * MAX_MESSAGE)))
    .replace(MESSAGE_UNSAFE, (ch) => (ch === '\t' || ch === '\n' || ch === '\r' ? ' ' : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`))
    .trim();
  return text === '' ? '(no message)' : cap(text, MAX_MESSAGE);
}

/** Strips the query string and fragment (search terms, feed URLs, tokens) from an API path. */
function withoutQuery(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

/** `scheme://host/…/file.js:1:2`: a frame's URL keeps its host and file name, never a query or fragment. */
function frameUrl(url: string): string {
  const position = /(?::\d+){1,2}$/.exec(url)?.[0] ?? '';
  const bare = url.slice(0, url.length - position.length);
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)/i.exec(bare);
  if (match === null) return url;
  const host = (match[2] ?? '').slice((match[2] ?? '').lastIndexOf('@') + 1);
  const file = (match[3] ?? '').split('/').pop() ?? '';
  return `${match[1]}${host}/${file === '' ? '' : `…/${file}`}${position}`;
}

/**
 * The first 5 frames of a stack (a string or a list of lines): V8 `at …` lines, else the
 * `fn@url:line:col` lines of Firefox and Safari. Never the header line (it repeats the message).
 */
function stackFrames(value: unknown): string[] {
  const raw: unknown[] = typeof value === 'string' ? value.slice(0, 50 * MAX_INPUT).split(/\r?\n/) : Array.isArray(value) ? value : [];
  const lines = raw
    .filter((line): line is string => typeof line === 'string')
    .map((line) => line.slice(0, MAX_INPUT).trim())
    .filter((line) => line !== '');
  const v8 = lines.filter((line) => /^at\s/.test(line));
  // A Chromium error made by native code (`TypeError: Failed to fetch`) may have a header only.
  const frames = v8.length > 0 ? v8 : lines.filter((line) => AT_FRAME.test(line));
  return frames.slice(0, MAX_STACK_FRAMES).map((frame) => frame.replace(FRAME_URL, frameUrl));
}

function clientPrimitive(value: unknown, max: number): ClientPrimitive | undefined {
  if (typeof value === 'string') return cap(value, max);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
}

/** A scrubbed value as `ClientEventSchema` takes it: a primitive or ≤ 10 of them (objects are dropped). */
function clientValue(value: unknown, max: number): ClientFieldValue | undefined {
  if (!Array.isArray(value)) return clientPrimitive(value, max);
  return value.slice(0, MAX_FIELD_ARRAY).map((item) => clientPrimitive(item, max) ?? null);
}

/** Free text never keeps a URL past its host. */
function withoutUrlsIn(value: unknown): unknown {
  return typeof value === 'string' ? withoutUrls(value.slice(0, MAX_INPUT)) : value;
}

/** The category's allowlisted fields of `fields`, scrubbed and shaped for `ClientEventSchema`. */
function sanitizeFields(cat: ClientEventCategory, fields: unknown): Record<string, ClientFieldValue> {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return {};
  const source = fields as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of CLIENT_EVENT_FIELDS[cat]) {
    if (!Object.hasOwn(source, key)) continue;
    let value: unknown;
    try {
      value = source[key];
    } catch {
      continue;
    }
    if (value === undefined) continue;
    // Stack frames get their own treatment below (they keep file names).
    picked[key] = key === 'stack' ? value : Array.isArray(value) ? value.slice(0, MAX_FIELD_ARRAY).map(withoutUrlsIn) : withoutUrlsIn(value);
  }
  if (cat === 'api') {
    for (const key of ['path', 'route']) {
      const value = picked[key];
      if (typeof value === 'string') picked[key] = withoutQuery(value);
    }
    // An answered 1xx–4xx keeps its code only: its message is not needed to tell what went wrong.
    const status = picked.status;
    if (typeof status === 'number' && status > 0 && status < 500) delete picked.errMessage;
  }
  if (cat === 'app' && picked.stack !== undefined) {
    const frames = stackFrames(picked.stack);
    if (frames.length > 0) picked.stack = frames;
    else delete picked.stack;
  }
  const scrubbed = scrubFields(picked, { maxString: MAX_FIELD_STRING });
  const out: Record<string, ClientFieldValue> = {};
  if (scrubbed === null || typeof scrubbed !== 'object') return out;
  for (const [key, value] of Object.entries(scrubbed)) {
    const max = cat === 'api' && key === 'errMessage' ? MAX_API_ERROR_MESSAGE : MAX_FIELD_STRING;
    const shaped = clientValue(value, max);
    if (shaped !== undefined) out[key] = shaped;
  }
  return out;
}

function freezeEvent(event: ClientEvent): ClientEvent {
  for (const value of Object.values(event.fields)) if (Array.isArray(value)) Object.freeze(value);
  Object.freeze(event.fields);
  Object.freeze(event.page);
  return Object.freeze(event);
}

// ---------------------------------------------------------------------------
// Page load: session and page info
// ---------------------------------------------------------------------------

/** 12 random bytes as base64url (16 characters). */
function newSessionId(): string {
  let bytes: Uint8Array;
  try {
    bytes = crypto.getRandomValues(new Uint8Array(12));
  } catch {
    bytes = Uint8Array.from({ length: 12 }, () => Math.floor(Math.random() * 256));
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** This page load: its build (server build or Pages site), its backend and the app version. */
export function clientPageInfo(): ClientEvent['page'] {
  const caps = getCapabilities();
  return { build: caps.pagesBuild ? 'pages' : 'server', backend: caps.backend, version: cap(__APP_VERSION__, 40) };
}

/** Whether an event is ever uploaded: recorded on the server backend, and not an API event the server answered (and logged under its `rid`). */
export function isUploadable(event: ClientEvent): boolean {
  if (event.page.backend !== 'server') return false;
  const rid = event.fields.rid;
  return !(event.cat === 'api' && typeof rid === 'string' && rid !== '');
}

// ---------------------------------------------------------------------------
// Storage mirror
// ---------------------------------------------------------------------------

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface ClientLogState {
  session: string;
  seq: number;
  key: string;
  /** null once storage failed (or there is none): the ring lives in memory until a Clear succeeds. */
  storage: StorageLike | null;
  /**
   * The ring: what the mirror held at the last read, or what the last write stored (validated,
   * oldest first, no debug events; when storage was full, only the newest of these reached it).
   */
  stored: readonly ClientLogEntry[];
  /** The string last read or written; `stored` is re-parsed only when another tab changed it. */
  storedRaw: string | null;
  /** This page load's last 100 debug events (never persisted). */
  local: ClientLogEntry[];
  /** `stored` + `local` by time, newest last (≤ 300 + 100): what {@link getClientEvents} returns. */
  view: readonly ClientLogEntry[];
  stopStorageListener: (() => void) | null;
}

let state: ClientLogState | null = null;
const listeners = new Set<() => void>();
const NO_EVENTS: readonly ClientLogEntry[] = Object.freeze([]);

function browserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function eventTime(entry: ClientLogEntry): number {
  const time = Date.parse(entry.event.t);
  return Number.isFinite(time) ? time : 0;
}

function isFresh(entry: ClientLogEntry, now: number): boolean {
  return now - eventTime(entry) <= CLIENT_LOG_MAX_AGE_MS;
}

/** A stored entry, validated; null when it is not one this module writes (or a debug event). */
function readEntry(value: unknown): ClientLogEntry | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !ENTRY_ID.test(raw.id) || typeof raw.uploaded !== 'boolean') return null;
  const event = ClientEventSchema.safeParse(raw.event);
  if (!event.success || event.data.level === 'debug') return null;
  return Object.freeze({ id: raw.id, uploaded: raw.uploaded, event: freezeEvent(event.data) });
}

function parseStored(raw: string | null, now: number): ClientLogEntry[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (value === null || typeof value !== 'object' || (value as { v?: unknown }).v !== STORAGE_VERSION) return [];
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const out: ClientLogEntry[] = [];
  for (const item of entries.slice(-CLIENT_LOG_SIZE)) {
    const entry = readEntry(item);
    if (entry === null || seen.has(entry.id) || !isFresh(entry, now)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

/** The mirror as stored now (another tab may have written it since). */
function readStored(s: ClientLogState): readonly ClientLogEntry[] {
  if (s.storage === null) return s.stored;
  let raw: string | null;
  try {
    raw = s.storage.getItem(s.key);
  } catch {
    s.storage = null;
    return s.stored;
  }
  if (raw !== s.storedRaw) {
    s.stored = parseStored(raw, Date.now());
    s.storedRaw = raw;
  }
  return s.stored;
}

/** Each (immutable) entry's JSON, so a write serializes only the new ones. */
const entryJson = new WeakMap<ClientLogEntry, string>();

function toJson(entry: ClientLogEntry): string {
  let json = entryJson.get(entry);
  if (json === undefined) {
    json = JSON.stringify(entry);
    entryJson.set(entry, json);
  }
  return json;
}

/** The newest fresh entries that fit the ring and the size budget, oldest first, with each one's JSON. */
function trimStored(entries: readonly ClientLogEntry[], now: number): { entries: ClientLogEntry[]; json: string[] } {
  const kept: string[] = [];
  const out: ClientLogEntry[] = [];
  let size = `{"v":${STORAGE_VERSION},"entries":[]}`.length;
  for (let i = entries.length - 1; i >= 0 && out.length < CLIENT_LOG_SIZE; i--) {
    const entry = entries[i]!;
    if (entry.event.level === 'debug' || !isFresh(entry, now)) continue;
    const json = toJson(entry);
    if (size + json.length + 1 > CLIENT_LOG_MAX_CHARS) break;
    size += json.length + 1;
    kept.push(json);
    out.push(entry);
  }
  kept.reverse();
  out.reverse();
  return { entries: out, json: kept };
}

function writeStored(s: ClientLogState, entries: readonly ClientLogEntry[]): void {
  const trimmed = trimStored(entries, Date.now());
  s.stored = trimmed.entries;
  if (s.storage === null) return;
  // Full (the query cache shares the origin's quota): store the newest half, a quarter, … — so
  // the newest events, and the marks of uploaded ones, still survive a reload.
  for (let count = trimmed.json.length; ; count = Math.floor(count / 2)) {
    const json = `{"v":${STORAGE_VERSION},"entries":[${trimmed.json.slice(trimmed.json.length - count).join(',')}]}`;
    try {
      s.storage.setItem(s.key, json);
      s.storedRaw = json;
      return;
    } catch {
      if (count <= 1) break;
    }
  }
  // Not even one event fits, or writing is blocked: the ring lives in memory until a Clear succeeds.
  s.storage = null;
}

/** By time; within a millisecond by page load, then in recording order. */
function compareEntries(a: ClientLogEntry, b: ClientLogEntry): number {
  const byTime = eventTime(a) - eventTime(b);
  if (byTime !== 0) return byTime;
  if (a.event.session !== b.event.session) return a.event.session < b.event.session ? -1 : 1;
  return Number(a.id.slice(a.id.lastIndexOf('-') + 1)) - Number(b.id.slice(b.id.lastIndexOf('-') + 1)) || 0;
}

/** The ring and this page load's debug events, each within its own bound (a debug burst never hides a stored event). */
function rebuildView(s: ClientLogState): void {
  const merged = [...s.stored, ...s.local];
  merged.sort(compareEntries);
  s.view = Object.freeze(merged);
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A broken subscriber must not stop the others (or the caller that recorded the event).
    }
  }
}

/** Re-reads the mirror; true when another tab changed it. */
function refresh(s: ClientLogState): boolean {
  const before = s.stored;
  readStored(s);
  if (s.stored === before) return false;
  rebuildView(s);
  return true;
}

function ensureState(): ClientLogState {
  if (state !== null) return state;
  const storage = browserStorage();
  const s: ClientLogState = {
    session: newSessionId(),
    seq: 0,
    key: clientEventsStorageKey(),
    storage,
    stored: [],
    storedRaw: null,
    local: [],
    view: Object.freeze([]),
    stopStorageListener: null,
  };
  state = s;
  readStored(s);
  rebuildView(s);
  if (typeof window !== 'undefined') {
    // Another tab recorded, marked or cleared events: follow it (a null key: all storage was cleared).
    const onStorage = (event: StorageEvent) => {
      if (state !== s || (event.key !== null && event.key !== s.key)) return;
      // Removed: another tab cleared the events (or all storage was cleared) — this tab's too.
      const cleared = (event.key === null || event.newValue === null) && s.local.length > 0;
      if (cleared) s.local = [];
      const changed = refresh(s);
      if (cleared && !changed) rebuildView(s);
      if (changed || cleared) notify();
    };
    window.addEventListener('storage', onStorage);
    s.stopStorageListener = () => window.removeEventListener('storage', onStorage);
  }
  return s;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Records an event: `msg` is a fixed developer string (scrubbed, one line, ≤ 200 characters),
 * `fields` keeps the category's allowlisted keys only (scrubbed). Returns the entry, or null when
 * it could not be recorded (never throws).
 */
export function recordClientEvent(level: LogLevel, cat: ClientEventCategory, msg: string, fields?: ClientEventFields): ClientLogEntry | null {
  try {
    if (!LEVELS.has(level) || !CATEGORIES.has(cat)) return null;
    const s = ensureState();
    const candidate = {
      t: new Date().toISOString(),
      level,
      cat,
      msg: sanitizeMessage(msg),
      fields: sanitizeFields(cat, fields),
      session: s.session,
      page: clientPageInfo(),
    };
    let parsed = ClientEventSchema.safeParse(candidate);
    if (!parsed.success) parsed = ClientEventSchema.safeParse({ ...candidate, fields: {} });
    if (!parsed.success) return null;
    s.seq += 1;
    const entry: ClientLogEntry = Object.freeze({ id: `${s.session}-${s.seq}`, uploaded: false, event: freezeEvent(parsed.data) });
    if (level === 'debug') {
      s.local.push(entry);
      if (s.local.length > CLIENT_LOG_DEBUG_SIZE) s.local.splice(0, s.local.length - CLIENT_LOG_DEBUG_SIZE);
    } else {
      writeStored(s, [...readStored(s), entry]);
    }
    rebuildView(s);
    notify();
    return entry;
  } catch {
    return null;
  }
}

/** Every recorded event of this browser (this page load's debug events included), oldest first; the same array until something changes. */
export function getClientEvents(): readonly ClientLogEntry[] {
  try {
    return ensureState().view;
  } catch {
    return NO_EVENTS;
  }
}

/** Calls `listener` after every change (this tab's or another's); returns the unsubscribe function. */
export function subscribeClientEvents(listener: () => void): () => void {
  try {
    ensureState();
  } catch {
    // Subscribing still works; there is just nothing to follow in another tab.
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forgets every event, in this tab and in storage (other tabs follow). */
export function clearClientEvents(): void {
  try {
    const s = ensureState();
    s.local = [];
    s.stored = [];
    s.storedRaw = null;
    // Also after a write gave storage up (full): removing still works and frees the space, so the
    // cleared events do not come back with the next page load, and the ring is stored again.
    const storage = s.storage ?? browserStorage();
    try {
      storage?.removeItem(s.key);
      s.storage = storage;
    } catch {
      s.storage = null;
    }
    rebuildView(s);
    notify();
  } catch {
    // Nothing to clear.
  }
}

/** Marks events as accepted by the server (after a 2xx answer to their upload). */
export function markUploaded(ids: Iterable<string>): void {
  try {
    const wanted = new Set(ids);
    if (wanted.size === 0) return;
    const s = ensureState();
    /** `entries` with the wanted ones marked, or null when none of them changed. */
    const mark = (entries: readonly ClientLogEntry[]): ClientLogEntry[] | null => {
      let changed = false;
      const out = entries.map((entry) => {
        if (entry.uploaded || !wanted.has(entry.id)) return entry;
        changed = true;
        return Object.freeze({ ...entry, uploaded: true });
      });
      return changed ? out : null;
    };
    const local = mark(s.local);
    if (local !== null) s.local = local;
    const stored = mark(readStored(s));
    if (stored !== null) writeStored(s, stored);
    if (local !== null || stored !== null) {
      rebuildView(s);
      notify();
    }
  } catch {
    // The next upload sends them again; the server collapses repeats.
  }
}

/**
 * The events to upload next, oldest first (≤ `limit`): not uploaded yet, recorded on the server
 * backend, not API events the server answered ({@link isUploadable}), and debug events only when
 * `includeDebug` (the server accepts them while verbose logging covers `client`). Upload
 * `entry.event` (never the entry itself: the server's schema is strict) and pass the ids to
 * {@link markUploaded} after a 2xx. The stored ones include other tabs' events (and those of
 * earlier page loads), so call it inside {@link withUploadLock}.
 */
export function pendingUpload(includeDebug: boolean, limit: number = CLIENT_EVENT_UPLOAD_BATCH): ClientLogEntry[] {
  try {
    const s = ensureState();
    // Another tab may have uploaded (and marked) some of them meanwhile.
    if (refresh(s)) notify();
    const out: ClientLogEntry[] = [];
    for (const entry of s.view) {
      if (out.length >= limit) break;
      if (entry.uploaded || (!includeDebug && entry.event.level === 'debug') || !isUploadable(entry.event)) continue;
      out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Runs one upload ({@link pendingUpload} → POST → {@link markUploaded}) holding this browser's
 * upload lock (Web Locks, one per stored mirror), so two tabs never send the same stored events:
 * resolves false without calling `upload` while another tab holds it (its marks are read on the
 * next try), true once `upload` has run; rejects when `upload` does. Where Web Locks are missing
 * or refused (an older browser, a sandboxed frame) it just runs `upload`.
 */
export async function withUploadLock(upload: () => Promise<void>): Promise<boolean> {
  let locks: LockManager | undefined;
  try {
    locks = typeof navigator === 'undefined' ? undefined : (navigator.locks as LockManager | undefined);
  } catch {
    locks = undefined;
  }
  if (typeof locks?.request === 'function') {
    let started = false;
    try {
      return await locks.request(`${clientEventsStorageKey()}:upload`, { ifAvailable: true }, async (lock) => {
        if (lock === null) return false;
        started = true;
        await upload();
        return true;
      });
    } catch (err) {
      if (started) throw err;
      // The lock manager refused the request (an opaque origin): upload without it.
    }
  }
  await upload();
  return true;
}

/** This page load's session id (random, `[A-Za-z0-9_-]{16}`). */
export function clientSessionId(): string {
  return ensureState().session;
}

/**
 * Tests only (the vitest setup files call it after every test): forgets every event, subscriber
 * and the stored mirror; the next use starts a new session.
 */
export function resetClientLogForTests(): void {
  const s = state;
  state = null;
  listeners.clear();
  if (s === null) return;
  s.stopStorageListener?.();
  try {
    browserStorage()?.removeItem(s.key);
  } catch {
    // Nothing stored.
  }
}
