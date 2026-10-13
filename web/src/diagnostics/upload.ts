/**
 * Sends this browser's diagnostic events (`clientLog.ts`) to the Homebase server when this page
 * load's backend is the server — Homebase's own page, or the Pages site in hybrid mode — so its
 * log shows them next to the requests and jobs they explain (ARCHITECTURE §17;
 * `POST /api/diagnostics/client-events`). `main.tsx` starts it once the page is up.
 *
 * - Every 15 s and whenever the tab is hidden; one upload at a time (a tick is skipped while one is
 *   on its way), each inside this browser's upload lock (`withUploadLock`: two tabs never send the
 *   same stored events). One upload = `pendingUpload(acceptDebug)` (at most 100: other tabs' and
 *   earlier page loads' events included) posted with `sentAt` under a 10 s timeout, then
 *   `markUploaded` by id — only after a 2xx, so a failed upload sends them again.
 * - Never uploaded (`isUploadable`): events recorded on the browser backend, and API events the
 *   server answered with a `rid` (it logged those requests itself).
 * - Debug events go while the server accepts them (`acceptDebug` of its last answer: verbose
 *   logging covers `client`). Until it says so, one debug event a minute goes along to ask (the
 *   server drops it when it does not want it, and it stays unsent: This browser never shows it as
 *   in the server's log).
 * - The server takes at most 120 events and 64 KB of their fields a minute from a caller (this
 *   site's pairing, or Homebase's own page) and drops the rest, so a backlog (after an outage)
 *   goes out in batches that stay under that — paced by every tab of this site together: the
 *   uploads of the last minute are recorded beside the stored events ({@link uploadPacingKey},
 *   read and written under the upload lock; this page load's own record where storage fails).
 *   When the server still drops some for that limit (its `dropped` beyond the debug events it
 *   does not want), only the events it took are marked — it takes them in order — and the rest
 *   go again once a minute has passed.
 * - A 403 (a server from before diagnostics answers the Pages site `local_only`), 404 (its own page),
 *   409, or a request refused as a whole (400, 413, or a 422 that names no event: this page is
 *   newer than the server) stops the uploads for this page load. A 422 that names events drops
 *   just those (marked: this server never takes them, and the oldest would otherwise block every
 *   later upload until it ages out); the others go at the next tick. No answer, 5xx and 429 are
 *   tried again at the next tick.
 */
import type { ClientEventsRequest, ClientEventsResponse } from '@homebase/shared';
import { ApiError } from '../api/client.ts';
import { postClientEvents } from '../api/diagnostics.ts';
import { getCapabilities } from '../capabilities.ts';
import {
  CLIENT_EVENT_UPLOAD_BATCH,
  clientEventsStorageKey,
  markUploaded,
  pendingUpload,
  withUploadLock,
  type ClientLogEntry,
} from './clientLog.ts';

export const UPLOAD_INTERVAL_MS = 15_000;
export const UPLOAD_TIMEOUT_MS = 10_000;
/** The server's per-caller limits: events a minute, and UTF-8 bytes of their serialized fields. */
export const UPLOAD_EVENTS_PER_MINUTE = 120;
export const UPLOAD_BYTES_PER_MINUTE = 64 * 1024;
/** How often a debug event goes along to ask whether the server wants them. */
export const DEBUG_ASK_INTERVAL_MS = 60_000;
const MINUTE_MS = 60_000;
/** Answers after which this page load stops uploading (a 422 only when it names no event). */
const STOP_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 409, 413, 422]);
const PACING_VERSION = 1;
/** An issue path of a 422 `validation_failed` about one event of the batch. */
const EVENT_ISSUE_PATH = /^events\.(\d+)(?:\.|$)/;

type VisibilitySource = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
type PacingStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface ClientEventUploadDeps {
  /** Default: `postClientEvents`. */
  post?: (body: ClientEventsRequest, signal?: AbortSignal) => Promise<ClientEventsResponse>;
  /** Wall clock for `sentAt` and the pacing (default `Date.now`). */
  now?: () => number;
  /** Default: `document` (null: no visibility uploads). */
  document?: VisibilitySource | null;
  /** The request's timeout signal (default `AbortSignal.timeout`, where the browser has it). */
  timeoutSignal?: (ms: number) => AbortSignal | undefined;
  /** Where the shared pacing record lives (default `localStorage`; null: this page load's only). */
  storage?: PacingStorage | null;
}

export interface ClientEventUpload {
  /** Uploads now unless an upload is on its way (then resolves with that one). */
  flush(): Promise<void>;
  /** Stops the timer and the visibility listener. */
  stop(): void;
  /** True once stopped (by `stop()` or by an answer that ends the uploads). */
  readonly stopped: boolean;
}

/** One upload of the last minute, as the pacing record keeps it. */
interface SentUpload {
  at: number;
  count: number;
  bytes: number;
}

/** localStorage key of the pacing record every tab of this site shares (beside the stored events). */
export function uploadPacingKey(): string {
  return `${clientEventsStorageKey()}:upload-pacing`;
}

function defaultTimeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

function defaultDocument(): VisibilitySource | null {
  return typeof document === 'undefined' ? null : document;
}

function defaultStorage(): PacingStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The thrown error is an abort of the request (not an answer). */
function isAbort(err: unknown): boolean {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** What the server counts against its byte limit: the UTF-8 size of the event's serialized fields. */
function fieldBytes(entry: ClientLogEntry): number {
  const json = JSON.stringify(entry.event.fields);
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(json).length : json.length * 3;
}

function isSentUpload(value: unknown): value is SentUpload {
  if (value === null || typeof value !== 'object') return false;
  const { at, count, bytes } = value as Record<string, unknown>;
  return [at, count, bytes].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
}

/** A stored pacing record (another tab, build or program may have written it: anything else is none). */
function parsePacing(raw: string | null): SentUpload[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (value === null || typeof value !== 'object' || (value as { v?: unknown }).v !== PACING_VERSION) return [];
  const sent = (value as { sent?: unknown }).sent;
  return Array.isArray(sent) ? sent.slice(-UPLOAD_EVENTS_PER_MINUTE).filter(isSentUpload) : [];
}

/**
 * The events of a 422 `validation_failed` (`details` = the issues, `events.<i>…` paths): this
 * server never takes them. Empty when any issue is not about one event of the batch (the request
 * as a whole is refused).
 */
function refusedIds(error: ApiError, entries: readonly ClientLogEntry[]): string[] {
  if (error.status !== 422 || error.code !== 'validation_failed' || !Array.isArray(error.details) || error.details.length === 0) return [];
  const ids = new Set<string>();
  for (const issue of error.details) {
    const path = issue !== null && typeof issue === 'object' ? (issue as { path?: unknown }).path : undefined;
    const match = typeof path === 'string' ? EVENT_ISSUE_PATH.exec(path) : null;
    const entry = match === null ? undefined : entries[Number(match[1])];
    if (entry === undefined) return [];
    ids.add(entry.id);
  }
  return [...ids];
}

/**
 * The ids a 2xx answer took: all of them but the debug events it does not want (dropped, not in its
 * log: they stay unsent here and go once it wants them), unless the server's per-minute limit
 * dropped some (`dropped` beyond those debug events) — then, of the others, the first `accepted`
 * (it takes them in order; only an event over its byte limit can be skipped for a later one).
 * `limited` says the limit was hit.
 */
function takenIds(entries: readonly ClientLogEntry[], response: ClientEventsResponse): { ids: string[]; limited: boolean } {
  const unwanted = (entry: ClientLogEntry): boolean => !response.acceptDebug && entry.event.level === 'debug';
  const wanted = entries.filter((entry) => !unwanted(entry));
  const limited = response.dropped > entries.length - wanted.length;
  return { ids: (limited ? wanted.slice(0, response.accepted) : wanted).map((entry) => entry.id), limited };
}

/** Starts uploading this browser's events (only on a page load whose backend is the server). */
export function startClientEventUpload(deps: ClientEventUploadDeps = {}): ClientEventUpload {
  const post = deps.post ?? postClientEvents;
  const now = deps.now ?? (() => Date.now());
  const doc = deps.document === undefined ? defaultDocument() : deps.document;
  const timeoutSignal = deps.timeoutSignal ?? defaultTimeoutSignal;
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const pacingKey = uploadPacingKey();

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let acceptDebug = false;
  let lastDebugAsk = Number.NEGATIVE_INFINITY;
  /** This page load's uploads of the last minute (they count even when storage refused them). */
  let ownSent: SentUpload[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  const onVisibility = (): void => {
    if (doc?.visibilityState === 'hidden') void flush();
  };

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
    doc?.removeEventListener('visibilitychange', onVisibility);
  }

  /** Every tab's uploads of the last minute (stored ones, and this page load's own). */
  function recentUploads(at: number): SentUpload[] {
    let stored: SentUpload[] = [];
    try {
      stored = parsePacing(storage?.getItem(pacingKey) ?? null);
    } catch {
      // Unreadable: this page load's own record still paces it.
    }
    const seen = new Set<string>();
    const out: SentUpload[] = [];
    for (const upload of [...stored, ...ownSent]) {
      const id = `${upload.at}|${upload.count}|${upload.bytes}`;
      if (upload.at > at || at - upload.at >= MINUTE_MS || seen.has(id)) continue;
      seen.add(id);
      out.push(upload);
    }
    return out;
  }

  function recordUpload(at: number, count: number, bytes: number): void {
    const upload = { at, count, bytes };
    const recent = recentUploads(at);
    ownSent = [...ownSent.filter((own) => at - own.at < MINUTE_MS), upload];
    try {
      storage?.setItem(pacingKey, JSON.stringify({ v: PACING_VERSION, sent: [...recent, upload] }));
    } catch {
      // Full or blocked: the other tabs pace without it (and the server drops what is too much).
    }
  }

  /** The events of the next batch, within the minute's budget (events and bytes), with their size. */
  function nextBatch(at: number): { entries: ClientLogEntry[]; bytes: number } {
    const recent = recentUploads(at);
    const budget = Math.min(CLIENT_EVENT_UPLOAD_BATCH, UPLOAD_EVENTS_PER_MINUTE - recent.reduce((sum, upload) => sum + upload.count, 0));
    const room = UPLOAD_BYTES_PER_MINUTE - recent.reduce((sum, upload) => sum + upload.bytes, 0);
    if (budget <= 0 || room <= 0) return { entries: [], bytes: 0 };
    let candidates = pendingUpload(acceptDebug, budget);
    let asking = false;
    if (candidates.length === 0 && !acceptDebug && at - lastDebugAsk >= DEBUG_ASK_INTERVAL_MS) {
      // Only debug events wait: one goes along to learn whether the server wants them now.
      candidates = pendingUpload(true, 1);
      asking = true;
    }
    const entries: ClientLogEntry[] = [];
    let bytes = 0;
    for (const entry of candidates) {
      const size = fieldBytes(entry);
      if (bytes + size > room) break;
      bytes += size;
      entries.push(entry);
    }
    if (asking && entries.length > 0) lastDebugAsk = at;
    return { entries, bytes };
  }

  async function upload(): Promise<void> {
    const at = now();
    const { entries, bytes } = nextBatch(at);
    if (entries.length === 0) return;
    const ids = entries.map((entry) => entry.id);
    let response: ClientEventsResponse;
    try {
      // The events only: the server's schema is strict (an entry's id and flag stay here).
      response = await post({ sentAt: new Date(at).toISOString(), events: entries.map((entry) => entry.event) }, timeoutSignal(UPLOAD_TIMEOUT_MS));
    } catch (err) {
      const refused = err instanceof ApiError ? refusedIds(err, entries) : [];
      if (refused.length > 0) {
        // Events this server never takes (another version's): dropped, so they block nothing.
        markUploaded(refused);
        return;
      }
      if (err instanceof ApiError || isAbort(err)) throw err;
      // A 2xx whose body is not the expected answer: the server took the events.
      recordUpload(at, entries.length, bytes);
      markUploaded(ids);
      return;
    }
    const taken = takenIds(entries, response);
    // Over the server's limit (it counts what reached it from elsewhere too): its minute is used up.
    recordUpload(at, taken.limited ? UPLOAD_EVENTS_PER_MINUTE : entries.length, bytes);
    markUploaded(taken.ids);
    acceptDebug = response.acceptDebug;
  }

  async function run(): Promise<void> {
    // Only a server backend takes them (the browser backend has nowhere to send them).
    if (getCapabilities().backend !== 'server') return stop();
    try {
      await withUploadLock(upload);
    } catch (err) {
      if (err instanceof ApiError && STOP_STATUSES.has(err.status)) stop();
      // Anything else (no answer, 5xx, 429, a timeout): the next tick sends them again.
    }
  }

  function flush(): Promise<void> {
    if (stopped) return Promise.resolve();
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  timer = setInterval(() => void flush(), UPLOAD_INTERVAL_MS);
  doc?.addEventListener('visibilitychange', onVisibility);

  return {
    flush,
    stop,
    get stopped() {
      return stopped;
    },
  };
}
