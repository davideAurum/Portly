/**
 * The server log panel's model (Settings → Diagnostics, ARCHITECTURE §17): its filters and the
 * `GET /api/diagnostics/logs` query they make, how the first page, the records appended by Live
 * polling and the older records read from the log files combine into one list (≤ 2 000 rows), where
 * "Show older" reads the files from, the names of the chips, and the Timeline, which merges this
 * browser's own events into that list by time.
 *
 * Times: a server record sorts by `tEvent ?? t` (an uploaded browser event by when it happened,
 * corrected for the browser's clock skew), a browser event by its own `t`. In the Timeline an
 * uploaded copy of an event the list shows from this browser (same session, category and message,
 * within {@link UPLOADED_COPY_TOLERANCE_MS}) is hidden: the local entry stands for it. Copies of
 * events this browser no longer has (its ring keeps 300 for 7 days) or does not show (filters)
 * stay.
 */
import { LOG_LEVEL_ORDER, type HealthEntry, type LogLevel, type LogRecord, type LogSource } from '@portly/shared';
import type { DiagnosticsLogsFilters } from '../../api/diagnostics.ts';
import type { ClientLogEntry } from '../clientLog.ts';

/** Names for the account and calendar chips (ids otherwise). */
export interface LogNames {
  account(id: string): string | null;
  calendar(id: string): string | null;
}

/**
 * The names the chips use, as one string: the health labels of accounts and calendars, and the
 * accounts list. It changes only when a name does (the summary itself is new every 30 s), so the
 * {@link LogNames} made from it keep their identity: new ones re-render every row of the log.
 */
export function logNameSource(health: readonly Pick<HealthEntry, 'key' | 'label'>[], accounts: readonly { id: string; label: string }[]): string {
  const labels = health.flatMap((entry) => (entry.label !== null && /^(?:account|calendar|ics):/.test(entry.key) ? [[entry.key, entry.label]] : []));
  return JSON.stringify([labels, accounts.map((account) => [account.id, account.label])]);
}

/** The chips' names from {@link logNameSource}: an account by the accounts list, else its health label. */
export function logNamesFrom(source: string): LogNames {
  const [health, accounts] = JSON.parse(source) as [[string, string][], [string, string][]];
  const labels = new Map(health);
  const accountLabels = new Map(accounts);
  return {
    account: (id) => accountLabels.get(id) ?? labels.get(`account:${id}`) ?? null,
    calendar: (id) => labels.get(`calendar:${id}`) ?? labels.get(`ics:${id}`) ?? null,
  };
}

/** Record fields offered as filter chips (click a value to show only its records). */
export const LOG_CHIP_FIELDS = ['rid', 'job', 'run', 'accountId', 'calendarId'] as const;
export type LogChipField = (typeof LOG_CHIP_FIELDS)[number];

export interface LogFilters {
  /** The lowest level shown (`debug` = All). */
  level: LogLevel;
  /** A log area ('' = all). */
  area: string;
  /** `server` (server and supervisor), `client` (browser events uploaded to the server), '' = both. */
  src: '' | Extract<LogSource, 'server' | 'client'>;
  /** Text search over the message and fields. */
  q: string;
  chips: Partial<Record<LogChipField, string>>;
  /** A health key ("Show related log lines"): the server maps it to its context field. */
  key: string | null;
  /** What the key stands for (the subject's label), for its chip. */
  keyLabel: string | null;
  /** Time window (ISO). */
  since: string | null;
  before: string | null;
}

export const DEFAULT_LOG_FILTERS: LogFilters = Object.freeze({
  level: 'info',
  area: '',
  src: '',
  q: '',
  chips: Object.freeze({}),
  key: null,
  keyLabel: null,
  since: null,
  before: null,
}) as LogFilters;

/** Records per request (first page, each Live poll, each "Show older"). */
export const LOG_PAGE_SIZE = 500;
/** Most rows the list keeps (the newest). */
export const MAX_LOG_ROWS = 2000;
/** Live polling interval. */
export const LIVE_POLL_MS = 2000;

/** The memory query of these filters (unset filters left out, so equal filters give equal keys). */
export function logsQueryFor(filters: LogFilters): DiagnosticsLogsFilters {
  const query: DiagnosticsLogsFilters = { scope: 'memory', level: filters.level, limit: LOG_PAGE_SIZE };
  if (filters.area !== '') query.area = filters.area;
  if (filters.src !== '') query.src = filters.src;
  const q = filters.q.trim();
  if (q !== '') query.q = q.slice(0, 200);
  for (const field of LOG_CHIP_FIELDS) {
    const value = filters.chips[field];
    if (value !== undefined && value !== '') query[field] = value;
  }
  if (filters.key !== null) query.key = filters.key;
  if (filters.since !== null) query.since = filters.since;
  if (filters.before !== null) query.before = filters.before;
  return query;
}

/** True when some filter besides the level is set (the list then says "No matching records"). */
export function hasNarrowingFilters(filters: LogFilters): boolean {
  return (
    filters.area !== '' ||
    filters.src !== '' ||
    filters.q.trim() !== '' ||
    LOG_CHIP_FIELDS.some((f) => filters.chips[f] !== undefined) ||
    filters.key !== null ||
    filters.since !== null ||
    filters.before !== null
  );
}

function recordTime(record: LogRecord): number {
  const time = Date.parse(record.tEvent ?? record.t);
  return Number.isFinite(time) ? time : 0;
}

/**
 * What a record says: its time, area, request, message and fields — the records one loop writes in
 * the same millisecond differ in their fields only (one per calendar). A record in memory and its
 * line in the files say the same.
 */
function recordContent(record: LogRecord): string {
  return `${record.t}|${record.area}|${record.rid ?? ''}|${record.msg}|${JSON.stringify(record.fields)}`;
}

/** Identity of a record: its sequence number, or (read from the files: seq 0) all of it. */
export function recordId(record: LogRecord): string {
  return record.seq > 0 ? `s${record.seq}` : `f${recordContent(record)}`;
}

/**
 * The records of a batch read from the files that the list does not show yet: not shown from
 * memory (the files hold what memory holds — info and above, debug while verbose — read back with
 * seq 0) and not brought by an earlier batch. Lines identical in every field within one batch are
 * distinct lines, all kept.
 */
export function newFileRecords(batch: readonly LogRecord[], memory: readonly LogRecord[], older: readonly LogRecord[]): LogRecord[] {
  const shown = new Set(memory.map(recordContent));
  const known = new Set(older.map(recordId));
  return batch.filter((record) => !shown.has(recordContent(record)) && !known.has(recordId(record)));
}

/**
 * The older records after one more "Show older" batch: the batch before what was there, without
 * the records an earlier batch already brought (records identical in every field within one batch
 * are distinct lines, all kept); at most {@link MAX_LOG_ROWS}, the newest.
 */
export function addOlderBatch(batch: readonly LogRecord[], older: readonly LogRecord[]): LogRecord[] {
  const known = new Set(older.map(recordId));
  const out = [...batch.filter((record) => !known.has(recordId(record))), ...older];
  return out.length > MAX_LOG_ROWS ? out.slice(out.length - MAX_LOG_ROWS) : out;
}

/**
 * One list, oldest first: the older records read from the files (as {@link addOlderBatch} keeps
 * them), the first page and the records Live appended — also those a refetch of the first page
 * (the tab shown again, the log level changed) no longer reaches. Duplicate memory records are
 * dropped; at most {@link MAX_LOG_ROWS}, the newest.
 */
export function mergeLogRecords(older: readonly LogRecord[], page: readonly LogRecord[], appended: readonly LogRecord[]): LogRecord[] {
  const seen = new Set<string>();
  const out: LogRecord[] = [...older];
  const add = (record: LogRecord) => {
    const id = recordId(record);
    if (seen.has(id)) return;
    seen.add(id);
    out.push(record);
  };
  for (const record of page) add(record);
  for (const record of appended) add(record);
  out.sort((a, b) => recordTime(a) - recordTime(b) || a.seq - b.seq);
  return out.length > MAX_LOG_ROWS ? out.slice(out.length - MAX_LOG_ROWS) : out;
}

/** "Show older" requests one click may make while the batches bring only records the list shows. */
export const MAX_OLDER_REQUESTS = 5;

/**
 * Where the first "Show older" batch starts: before the newest record shown from memory (`t`, what
 * the files are scanned by), else the filter's end, else now. Not before the oldest one: the memory
 * page mixes rings that reach back unequally far (5 000 info lines; 400 debug lines per area;
 * the browsers'), so records a busy ring dropped can lie between the oldest record shown and the
 * rest. The batch repeats what memory shows ({@link newFileRecords}); the next one starts where
 * {@link nextOlderBefore} says.
 */
export function olderBefore(memory: readonly LogRecord[], filters: LogFilters, now: number): string {
  let newest: LogRecord | null = null;
  for (const record of memory) if (newest === null || Date.parse(record.t) > Date.parse(newest.t)) newest = record;
  if (newest !== null) return newest.t;
  return filters.before ?? new Date(now).toISOString();
}

/**
 * Where the batch after `batch` (read before `before`) starts: after the millisecond of its oldest
 * line, so that lines of that millisecond the batch had no room for come too (one loop writes a
 * line per calendar in the same millisecond; those the batch brought are known,
 * {@link newFileRecords}) — unless the whole batch is that millisecond: then before it, or the files
 * would be read at the same place again. Null for an empty batch.
 */
export function nextOlderBefore(batch: readonly LogRecord[], before: string): string | null {
  let oldest = Number.POSITIVE_INFINITY;
  for (const record of batch) oldest = Math.min(oldest, Date.parse(record.t));
  if (!Number.isFinite(oldest)) return null;
  return new Date(oldest + 1 < Date.parse(before) ? oldest + 1 : oldest).toISOString();
}

/**
 * How far an uploaded copy's time (`tEvent`: the event's time plus the browser's clock skew at the
 * upload) may lie from the local entry's. Wider than the skew of a synced clock; for a browser whose
 * clock is further off both copies show.
 */
export const UPLOADED_COPY_TOLERANCE_MS = 60_000;

/** The server writes an uploaded event as `client: <msg>`. */
const UPLOADED_PREFIX = 'client: ';

function copyKey(session: string, cat: string, msg: string): string {
  return `${session}\n${cat}\n${msg}`;
}

/** What names an uploaded record's browser event: its session and category (`fields.client`) and message. */
function uploadedKey(record: LogRecord): string | null {
  if (record.src !== 'client' || !record.msg.startsWith(UPLOADED_PREFIX)) return null;
  const client = record.fields.client;
  if (client === null || typeof client !== 'object') return null;
  const { session, cat } = client as Record<string, unknown>;
  return typeof session === 'string' && typeof cat === 'string' ? copyKey(session, cat, record.msg.slice(UPLOADED_PREFIX.length)) : null;
}

/** An uploaded browser event the server marked late (it reached the server > 5 min after it happened). */
export function isLate(record: LogRecord): boolean {
  if (record.src !== 'client') return false;
  const client = record.fields.client;
  return client !== null && typeof client === 'object' && (client as Record<string, unknown>).late === true;
}

/** Whether a browser event passes the filters (level, area/source, text, chips; the window). */
export function browserEventMatches(entry: ClientLogEntry, filters: LogFilters): boolean {
  const { event } = entry;
  if (LOG_LEVEL_ORDER[event.level] < LOG_LEVEL_ORDER[filters.level]) return false;
  if (filters.src === 'server') return false;
  if (filters.area !== '' && filters.area !== 'client') return false;
  // A health key stands for a context field this browser's events do not carry.
  if (filters.key !== null) return false;
  for (const field of LOG_CHIP_FIELDS) {
    const wanted = filters.chips[field];
    if (wanted !== undefined && event.fields[field] !== wanted) return false;
  }
  const time = Date.parse(event.t);
  if (filters.since !== null && time < Date.parse(filters.since)) return false;
  if (filters.before !== null && time >= Date.parse(filters.before)) return false;
  const q = filters.q.trim().toLowerCase();
  if (q !== '' && !`${event.cat} ${event.msg} ${JSON.stringify(event.fields)}`.toLowerCase().includes(q)) return false;
  return true;
}

export type LogRow = { kind: 'server'; id: string; time: number; record: LogRecord } | { kind: 'browser'; id: string; time: number; entry: ClientLogEntry };

/**
 * The rows to show, newest first: the server's records, plus (Timeline) this browser's events
 * that pass the filters — without the uploaded copies of the events shown. Identical file records
 * (distinct lines) get distinct row ids.
 */
export function logRows(records: readonly LogRecord[], browser: readonly ClientLogEntry[] | null, filters: LogFilters): LogRow[] {
  const shown: LogRow[] = [];
  /** When the shown browser events happened, per session, category and message. */
  const localTimes = new Map<string, number[]>();
  for (const entry of browser ?? []) {
    if (!browserEventMatches(entry, filters)) continue;
    const parsed = Date.parse(entry.event.t);
    const time = Number.isFinite(parsed) ? parsed : 0;
    shown.push({ kind: 'browser', id: `c${entry.id}`, time, entry });
    const key = copyKey(entry.event.session, entry.event.cat, entry.event.msg);
    const times = localTimes.get(key);
    if (times === undefined) localTimes.set(key, [time]);
    else times.push(time);
  }
  const rows: LogRow[] = [];
  const ids = new Map<string, number>();
  for (const record of records) {
    const time = recordTime(record);
    const key = localTimes.size === 0 ? null : uploadedKey(record);
    if (key !== null && localTimes.get(key)?.some((t) => Math.abs(t - time) <= UPLOADED_COPY_TOLERANCE_MS)) continue;
    const id = recordId(record);
    const count = ids.get(id) ?? 0;
    ids.set(id, count + 1);
    rows.push({ kind: 'server', id: count === 0 ? id : `${id}#${count}`, time, record });
  }
  rows.push(...shown);
  rows.sort((a, b) => b.time - a.time || (a.kind === 'server' && b.kind === 'server' ? b.record.seq - a.record.seq : 0));
  return rows.length > MAX_LOG_ROWS ? rows.slice(0, MAX_LOG_ROWS) : rows;
}

/** The values a record offers as chips (`rid` from the record, the others from its fields). */
export function recordChips(record: LogRecord): [LogChipField, string][] {
  const out: [LogChipField, string][] = [];
  for (const field of LOG_CHIP_FIELDS) {
    const value = field === 'rid' ? record.rid : record.fields[field];
    if (typeof value === 'string' && value !== '') out.push([field, value]);
  }
  return out;
}
