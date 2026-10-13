/**
 * `POST /api/diagnostics/client-events` (ARCHITECTURE §17): browser events uploaded by the
 * page whose backend is this server (`web/src/diagnostics/upload.ts`), written to the log as
 * `src: 'client'` records — the client ring always, the file at warn+ unless verbose covers
 * `client` (the logger's rule).
 *
 * - Clock skew: `skewMs = receivedAt − sentAt`; each event's `tEvent = t + skewMs` (clamped to a
 *   representable time) and `late` when it happened more than 5 minutes before it arrived.
 * - Rate limit per caller (pairing id, or `local` for Homebase's own page): 120 events and 64 KB of
 *   serialized fields per minute; the excess is dropped and counted, with at most one
 *   `warn 'client events dropped'` per caller and minute (repeat-collapsed beyond that).
 * - `debug` events are kept only while verbose logging covers `client` (`acceptDebug` tells the
 *   page whether to send them); otherwise they are dropped and counted.
 * - Each event is logged in its own context (`area: 'client'`, `rid` = the event's `fields.rid`
 *   when it is a request id): `client: <msg>` with `{tEvent, client: {cat, session, page, late},
 *   cf: <fields without rid>, uploadRid}`. Browser fields stay nested under `cf`, never spread
 *   among the server's own keys.
 * - `cf.path`/`cf.route` lose their query string and fragment here too (search terms,
 *   coordinates): the page strips them, but the log does not rely on every caller doing so.
 * - Field strings and `page.version` are treated like the message: control, line/paragraph
 *   separator and bidi characters are written as `\uXXXX` (the schema refuses them in `msg` only),
 *   so an uploaded value cannot break or reorder a line of server.log or the console.
 */
import {
  REQUEST_ID_REGEX,
  type ClientEvent,
  type ClientEventsRequest,
  type ClientEventsResponse,
} from '@homebase/shared';
import { withLogContext } from '../../lib/log-context.ts';
import { pathForLog, type LogHub, type Logger } from '../../lib/logger.ts';

export const CLIENT_EVENTS_PER_MINUTE = 120;
export const CLIENT_EVENT_BYTES_PER_MINUTE = 64 * 1024;
/** An event that reaches the server later than this after it happened is marked `late`. */
export const LATE_EVENT_MS = 5 * 60 * 1000;
const WINDOW_MS = 60 * 1000;
/** Callers tracked at once (least recently seen dropped first). */
const MAX_CALLERS = 256;
/** 9999-12-31T23:59:59.999Z, the latest time with a 4-digit-year ISO form. */
const MAX_EVENT_MS = 253_402_300_799_999;

interface CallerWindow {
  start: number;
  events: number;
  bytes: number;
  warned: boolean;
}

export interface IngestOptions {
  /** `pairingId` of a Pages request, else `'local'`. */
  caller: string;
  /** The upload request's id (logged with each event as `uploadRid`). */
  uploadRid: string | null;
  now: number;
}

export interface ClientEventIntake {
  ingest(body: ClientEventsRequest, options: IngestOptions): ClientEventsResponse;
}

export interface ClientEventIntakeDeps {
  logs: LogHub;
  /** The diagnostics module's logger (the dropped-events warning). */
  log: Logger;
  /** Logger the events are written with (`src: 'client'`). */
  clientLog: Logger;
}

/** Verbose logging covers browser events (every area, or `client` among the chosen ones). */
export function acceptsDebug(logs: LogHub): boolean {
  const state = logs.levelState();
  return state.verbose && (state.areas === null || state.areas.includes('client'));
}

function clamp(ms: number): number {
  return Math.min(MAX_EVENT_MS, Math.max(0, ms));
}

// C0/C1 controls except TAB, line/paragraph separators and bidi controls (the logger's message rule).
const UNSAFE_TEXT = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** A browser-supplied string with {@link UNSAFE_TEXT} written as `\uXXXX`. */
function safeText(text: string): string {
  return text.replace(UNSAFE_TEXT, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

type ClientFieldValue = ClientEvent['fields'][string];

function safeValue(value: ClientFieldValue): ClientFieldValue {
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? safeText(v) : v));
  return value;
}

function serializedBytes(fields: ClientEvent['fields']): number {
  return Buffer.byteLength(JSON.stringify(fields));
}

export function createClientEventIntake(deps: ClientEventIntakeDeps): ClientEventIntake {
  const { logs, log, clientLog } = deps;
  const windows = new Map<string, CallerWindow>();

  /** The caller's current window (a new one each minute); re-inserted so the map is in recency order. */
  const windowFor = (caller: string, now: number): CallerWindow => {
    let window = windows.get(caller);
    windows.delete(caller);
    if (window === undefined || now - window.start >= WINDOW_MS || now < window.start) {
      window = { start: now, events: 0, bytes: 0, warned: false };
    }
    windows.set(caller, window);
    while (windows.size > MAX_CALLERS) {
      const oldest = windows.keys().next().value;
      if (oldest === undefined) break;
      windows.delete(oldest);
    }
    return window;
  };

  const write = (event: ClientEvent, tEvent: number, late: boolean, uploadRid: string | null): void => {
    const { rid, ...fields } = event.fields;
    const eventRid = typeof rid === 'string' && REQUEST_ID_REGEX.test(rid) ? rid : undefined;
    for (const key of ['path', 'route']) {
      const value = fields[key];
      if (typeof value === 'string') fields[key] = pathForLog(value);
      else if (Array.isArray(value)) fields[key] = value.map((v) => (typeof v === 'string' ? pathForLog(v) : v));
    }
    const cf: ClientEvent['fields'] = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, safeValue(value)]));
    const page = { ...event.page, version: safeText(event.page.version) };
    const path = cf.path ?? '';
    const status = cf.status ?? '';
    // `quiet` cleared: an accepted debug event belongs in the client ring even though the upload request is quiet.
    withLogContext({ area: 'client', rid: eventRid, quiet: undefined }, () => {
      clientLog[event.level](`client: ${event.msg}`, {
        src: 'client',
        tEvent,
        client: { cat: event.cat, session: event.session, page, late },
        cf,
        repeatKey: `${event.cat} ${event.msg} ${String(path)} ${String(status)}`,
        ...(uploadRid === null ? {} : { uploadRid }),
      });
    });
  };

  return {
    ingest(body, options) {
      const { caller, uploadRid, now } = options;
      const acceptDebug = acceptsDebug(logs);
      const sentAt = Date.parse(body.sentAt);
      const skewMs = Number.isFinite(sentAt) ? now - sentAt : 0;
      const window = windowFor(caller, now);
      let accepted = 0;
      let dropped = 0;
      let limited = 0;
      for (const event of body.events) {
        if (event.level === 'debug' && !acceptDebug) {
          dropped++;
          continue;
        }
        const bytes = serializedBytes(event.fields);
        if (window.events + 1 > CLIENT_EVENTS_PER_MINUTE || window.bytes + bytes > CLIENT_EVENT_BYTES_PER_MINUTE) {
          dropped++;
          limited++;
          continue;
        }
        window.events++;
        window.bytes += bytes;
        const t = Date.parse(event.t);
        const tEvent = clamp((Number.isFinite(t) ? t : now) + skewMs);
        write(event, tEvent, now - tEvent > LATE_EVENT_MS, uploadRid);
        accepted++;
      }
      if (limited > 0 && !window.warned) {
        window.warned = true;
        log.warn('client events dropped', {
          caller,
          dropped: limited,
          perMinute: CLIENT_EVENTS_PER_MINUTE,
          bytesPerMinute: CLIENT_EVENT_BYTES_PER_MINUTE,
          repeatKey: `client events dropped ${caller}`,
        });
      }
      return { accepted, dropped, acceptDebug };
    },
  };
}
