/**
 * The diagnostic report (ARCHITECTURE §17, `GET /api/diagnostics/report?redact=0|1`): one JSON
 * file with everything needed to diagnose a problem away from this PC —
 * `{generatedAt, summary, accounts, calendars, health, history, logs: {main, flight, client, files},
 * supervisorLog, launcherLog, config}`.
 *
 * - `summary` is the full one (data and log directories included; paths are masked below);
 *   `history` the newest 500 outcome rows of every subject; `logs.main` the last 3 000 info+ records
 *   in memory, `flight` the whole debug ring, `client` the whole browser-event ring, `files` the last
 *   2 000 records of `server.log`; `supervisorLog` the last 300 records of `supervisor.log`;
 *   `launcherLog` the last 100 lines of the extension launcher's log (null when it has none).
 * - `config` names the `PORTLY_*` variables that are set, never their values.
 * - Everything passes through `scrubFields` (item by item, so long lists and deep records are not
 *   cut) and this PC's home directory is masked: no secrets, no URLs beyond their host, user paths
 *   as `C:\Users\~\…`. Health and job codes are machine tokens and stay as they are (also null).
 * - `redact=1` applies `redactForSharing` with {@link redactionDictionary}: account labels, emails
 *   and user names, IMAP/CalDAV/webmail hosts, calendar names, ICS and feed hosts, this PC's name
 *   and Windows user name (plus every host/origin found in the report) become `host#n`, `email#n`,
 *   `label#n`, `name#n`. Well-known provider hosts are kept: they say which service failed and
 *   nothing about the user.
 */
import os from 'node:os';
import { REASON_TOKEN, type RedactionDictionary } from '@portly/shared';
import { nativeHostLogPath } from '../../config.ts';
import type { AppContext } from '../../context.ts';
import type { DetailValue, OutcomeRowState, OutcomeStatus } from '../../lib/health.ts';
import { scrubValue, type LogHub, type LogRecordOut } from '../../lib/logger.ts';
import { readLogRecords, readRawTail, rescrubFields, rescrubText, type RecordFilter } from './log-files.ts';
import { buildSummary, isoOr, toLogLevelState, toOutcomeRow } from './summary.ts';

export const REPORT_MAIN_RECORDS = 3000;
export const REPORT_FILE_RECORDS = 2000;
export const REPORT_SUPERVISOR_RECORDS = 300;
export const REPORT_LAUNCHER_LINES = 100;
export const REPORT_HISTORY_ROWS = 500;
/** `launcher.log` is rotated once (`launcher.log.1`, native-host/launcher.mjs). */
const LAUNCHER_ROTATED = 1;
/** Pages of the memory read (the hub answers at most 5 000 records per query). */
const MEMORY_PAGE = 5000;
const MAX_MEMORY_PAGES = 12;

/**
 * Public hosts of the services Portly talks to: kept by `redact=1` (they tell which provider
 * failed, not who the user is).
 */
export const WELL_KNOWN_HOSTS: readonly string[] = [
  'accounts.google.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'gmail.googleapis.com',
  'mail.google.com',
  'suggestqueries.google.com',
  'www.google.com',
  'login.microsoftonline.com',
  'graph.microsoft.com',
  'outlook.live.com',
  'caldav.calendar.yahoo.com',
  'imap.mail.yahoo.com',
  'mail.yahoo.com',
  'api.todoist.com',
  'api.open-meteo.com',
  'geocoding-api.open-meteo.com',
  'site.api.espn.com',
  'a.espncdn.com',
  'duckduckgo.com',
  'icons.duckduckgo.com',
  'api.bing.com',
  'en.wikipedia.org',
];

export interface ReportOptions {
  now: number;
  /** The extension launcher's log (default `nativeHostLogPath()`); null skips it. */
  launcherLogPath?: string | null;
}

// ---------------------------------------------------------------------------
// File name
// ---------------------------------------------------------------------------

/** `portly-diagnostics-YYYYMMDD-HHmm.json` (local time). */
export function reportFilename(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `portly-diagnostics-${day}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
}

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

/** `scrubValue` (home directory, `scrubFields`, unsafe characters): one value (its own depth and list limits). */
function scrubbed(value: unknown): unknown {
  return scrubValue(value);
}

/** Each item scrubbed on its own (a whole list would be cut at 50 items). */
function scrubEach(items: readonly unknown[]): unknown[] {
  return items.map(scrubbed);
}

/** A placeholder `scrubFields` keeps under the key `code` (letters and underscores). */
const CODE_PLACEHOLDER = 'portly_code_placeholder';

/**
 * Scrubs an object whose `code` is a health or job code: `scrubFields` treats any `code` that is
 * not an error-code word as an OAuth code (and null as a secret too), so it is kept aside when it
 * is a machine token or null.
 */
function scrubbedWithCode(value: Record<string, unknown>): Record<string, unknown> {
  const code = value.code;
  const keep = code === null || (typeof code === 'string' && REASON_TOKEN.test(code));
  const out = scrubbed(keep ? { ...value, code: CODE_PLACEHOLDER } : value) as Record<string, unknown>;
  if (keep) out.code = code;
  return out;
}

function scrubRecord(rec: LogRecordOut): unknown {
  return {
    ...rec,
    msg: rescrubText(rec.msg),
    rid: rec.rid === null ? null : rescrubText(rec.rid, 64),
    tags: rec.tags.map((tag) => rescrubText(tag, 64)),
    fields: rescrubFields(rec.fields),
  };
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * Every record in memory, oldest first. The hub answers the newest 5 000 matches per query, so
 * the rings are read in pages going back in time (`before`), de-duplicated by seq.
 */
export function memoryRecords(logs: LogHub): LogRecordOut[] {
  const bySeq = new Map<number, LogRecordOut>();
  let before: number | undefined;
  for (let page = 0; page < MAX_MEMORY_PAGES; page++) {
    const result = logs.query(before === undefined ? { limit: MEMORY_PAGE } : { before, limit: MEMORY_PAGE });
    let added = 0;
    for (const rec of result.records) {
      if (bySeq.has(rec.seq)) continue;
      bySeq.set(rec.seq, rec);
      added++;
    }
    const oldest = result.records[0];
    if (!result.truncated || oldest === undefined) break;
    const oldestMs = Date.parse(oldest.t);
    // Records sharing the oldest millisecond are asked for again (de-duplicated); when a page brought
    // nothing new, that millisecond is skipped.
    before = added === 0 || (before !== undefined && oldestMs + 1 >= before) ? oldestMs : oldestMs + 1;
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The rings as the report lists them: info+ server records, debug records, browser events. */
export function memoryRings(logs: LogHub): { main: LogRecordOut[]; flight: LogRecordOut[]; client: LogRecordOut[] } {
  const main: LogRecordOut[] = [];
  const flight: LogRecordOut[] = [];
  const client: LogRecordOut[] = [];
  for (const rec of memoryRecords(logs)) {
    if (rec.src === 'client') client.push(rec);
    else if (rec.level === 'debug') flight.push(rec);
    else main.push(rec);
  }
  return { main: main.slice(-REPORT_MAIN_RECORDS), flight, client };
}

interface OutcomeDbRow {
  id: unknown;
  key: unknown;
  at: unknown;
  last_at: unknown;
  count: unknown;
  ok: unknown;
  status: unknown;
  code: unknown;
  http_status: unknown;
  message: unknown;
  ms: unknown;
  detail: unknown;
}

function num(value: unknown): number | null {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function detailOf(value: unknown): Record<string, DetailValue> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, DetailValue> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/** The newest outcome rows of every subject (the tracker's own `history()` reads one key). */
export function recentOutcomes(ctx: Pick<AppContext, 'db' | 'health'>, limit = REPORT_HISTORY_ROWS): OutcomeRowState[] {
  ctx.health.flush();
  const rows = ctx.db.all<OutcomeDbRow>('SELECT * FROM diag_outcomes ORDER BY id DESC LIMIT ?', [limit]);
  return rows.map((row) => {
    const status: OutcomeStatus = row.status === 'ok' || row.status === 'degraded' ? row.status : 'failing';
    const at = num(row.at) ?? 0;
    return {
      id: num(row.id) ?? 0,
      key: str(row.key) ?? '',
      at,
      lastAt: num(row.last_at) ?? at,
      count: num(row.count) ?? 1,
      ok: num(row.ok) === 1,
      status,
      code: str(row.code),
      httpStatus: num(row.http_status),
      message: str(row.message),
      ms: num(row.ms),
      detail: detailOf(row.detail),
    };
  });
}

interface CalendarListRow {
  id: string;
  account_id: string | null;
  name: string;
  source: string;
  display_url: string | null;
}

function calendarRows(ctx: Pick<AppContext, 'db'>): CalendarListRow[] {
  try {
    return ctx.db.all<CalendarListRow>('SELECT id, account_id, name, source, display_url FROM calendars ORDER BY sort, name');
  } catch {
    return [];
  }
}

/** Names of the `PORTLY_*` variables that are set (values never). */
export function portlyEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((name) => /^PORTLY_[A-Z0-9_]+$/i.test(name) && env[name] !== undefined)
    .sort();
}

const ALL_RECORDS: RecordFilter = { level: 'debug', fieldEquals: {} };

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** The report (scrubbed plain data, not yet redacted for sharing). */
export async function buildReport(ctx: AppContext, options: ReportOptions): Promise<Record<string, unknown>> {
  const { now } = options;
  const summary = buildSummary(ctx, { hidePaths: false, now });
  const rings = memoryRings(ctx.logs);
  const [files, supervisor, launcher] = await Promise.all([
    readLogRecords(ctx.config.paths.logFile, ALL_RECORDS, REPORT_FILE_RECORDS),
    readLogRecords(ctx.config.paths.supervisorLog, ALL_RECORDS, REPORT_SUPERVISOR_RECORDS),
    (async (): Promise<string[] | null> => {
      const file = options.launcherLogPath === undefined ? nativeHostLogPath() : options.launcherLogPath;
      return file === null ? null : readRawTail(file, REPORT_LAUNCHER_LINES, LAUNCHER_ROTATED);
    })(),
  ]);

  let accounts: unknown[] = [];
  try {
    accounts = ctx.accounts.list().map((a) => ({ id: a.id, kind: a.kind, label: a.label, status: a.status, statusMessage: a.statusMessage }));
  } catch {
    accounts = [];
  }
  const calendars = calendarRows(ctx).map((row) => ({ id: row.id, accountId: row.account_id, name: row.name, source: row.source }));

  // The lists are scrubbed item by item (and a job's error with its code kept), in place.
  const health = scrubEach(summary.health);
  const summaryOut = scrubbed({ ...summary, jobs: [], health: [] }) as Record<string, unknown>;
  summaryOut.jobs = summary.jobs.map((job) => {
    const out = scrubbed({ ...job, lastError: null }) as Record<string, unknown>;
    if (job.lastError !== null) out.lastError = scrubbedWithCode(job.lastError);
    return out;
  });
  summaryOut.health = health;
  return {
    generatedAt: isoOr(now, Date.now()),
    summary: summaryOut,
    accounts: scrubEach(accounts),
    calendars: scrubEach(calendars),
    health,
    history: recentOutcomes(ctx).map((row) => scrubbedWithCode({ ...toOutcomeRow(row) })),
    logs: {
      main: rings.main.map(scrubRecord),
      flight: rings.flight.map(scrubRecord),
      client: rings.client.map(scrubRecord),
      files: files.records.map(scrubRecord),
    },
    supervisorLog: supervisor.records.map(scrubRecord),
    launcherLog: launcher,
    config: scrubbed({
      port: ctx.config.port,
      bindAddresses: [...ctx.config.bindAddresses],
      dev: ctx.config.dev,
      pagesOrigin: ctx.config.pagesOrigin,
      logLevel: toLogLevelState(ctx.logs.levelState()),
      envSet: portlyEnvNames(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Redaction dictionary (`redact=1`)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeHostname(): string | null {
  try {
    return os.hostname();
  } catch {
    return null;
  }
}

function safeUsername(): string | null {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

/**
 * What `redact=1` replaces: account labels, emails and user names, the hosts of IMAP,
 * CalDAV, webmail and ICS addresses, calendar names, feed hosts, the Pages site, this PC's name and
 * the Windows user name. `redactForSharing` adds every host and origin found in the report.
 */
export function redactionDictionary(ctx: AppContext): RedactionDictionary {
  const hosts: string[] = [];
  const emails: string[] = [];
  const labels: string[] = [];
  const names: string[] = [];
  const addUser = (value: unknown): void => {
    if (typeof value !== 'string') return;
    (value.includes('@') ? emails : names).push(value);
  };

  let accounts: ReturnType<AppContext['accounts']['list']> = [];
  try {
    accounts = ctx.accounts.list();
  } catch {
    accounts = [];
  }
  for (const account of accounts) {
    labels.push(account.label);
    if (account.email !== null) emails.push(account.email);
    let config: unknown;
    try {
      config = ctx.accounts.getConfig(account.id);
    } catch {
      continue;
    }
    if (!isRecord(config)) continue;
    addUser(config.username);
    const caldav = config.caldav;
    if (isRecord(caldav)) {
      for (const key of ['serverUrl', 'principalUrl', 'calendarHomeUrl'] as const) {
        if (typeof caldav[key] === 'string') hosts.push(caldav[key]);
      }
      if (Array.isArray(caldav.credentialOrigins)) for (const origin of caldav.credentialOrigins) if (typeof origin === 'string') hosts.push(origin);
    }
    const imap = config.imap;
    if (isRecord(imap)) {
      if (typeof imap.host === 'string') hosts.push(imap.host);
      if (typeof imap.webmailUrl === 'string') hosts.push(imap.webmailUrl);
    }
  }

  for (const row of calendarRows(ctx)) {
    names.push(row.name);
    if (row.display_url !== null) hosts.push(row.display_url);
  }
  for (const state of ctx.health.list()) {
    // Feed and ICS subjects are labelled with their host.
    if (state.label !== null && (state.key.startsWith('feed:') || state.key.startsWith('ics:'))) hosts.push(state.label);
  }
  if (ctx.config.pagesOrigin !== null) hosts.push(ctx.config.pagesOrigin);
  const hostname = safeHostname();
  if (hostname !== null) hosts.push(hostname);
  const username = safeUsername();
  if (username !== null) names.push(username);

  return { hosts, emails, labels, names, keep: WELL_KNOWN_HOSTS };
}
