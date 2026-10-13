/**
 * `GET /api/diagnostics/summary` (diagnostics spec §8.1, ARCHITECTURE §17): the server process,
 * log level, modules, vault, hybrid mode, requests and outbound calls in progress, jobs, the
 * health of every synced subject and the warning counts of the last hour — converted from the
 * epoch-ms states of lib/{health,scheduler,logger}.ts to the shared DTOs (ISO times, integers).
 *
 * - Labels are resolved at read time: `account:`/`mail:`/`calendar-list:<id>` → the account's
 *   label, `calendar:`/`ics:<id>` → the calendar's name (calendars table), `job:<name>` → the job
 *   name, `sports:<league>` → the league's name (health labels must be tokens, so "Premier League"
 *   cannot be stored); every other subject keeps the label it was recorded with (feed/ICS host,
 *   provider).
 * - `stale`: a subject that expects a check every `expectEveryMs` got none for longer, or
 *   it is `ok` and the job that checks it is overdue or stuck (`job:<name>` → that job,
 *   `calendar-list:`/`calendar:` → `calendar:sync`, `ics:` → `calendar:ics`, else the only job
 *   of its area); a failing or degraded subject keeps saying what is wrong. Subjects checked on
 *   demand (`expectEveryMs` null) are never stale; subjects never checked stay `unknown`.
 * - An account that is not `ok` but has no `account:<id>` subject (a status from before
 *   diagnostics, or a subject purged while nothing re-checked it) is listed from its stored status
 *   ({@link withAccountStatusEntries}), so its dependents' `causeKey` names a listed subject.
 * - A request from the Pages site gets `server.dataDir`/`logDir` blank (as `/api/about`: the
 *   paths contain the Windows user name); everything else is the same (amendment 1).
 */
import os from 'node:os';
import {
  sportsLeague,
  type Account,
  type DiagnosticsSummary,
  type HealthEntry,
  type HealthStatus,
  type JobInfo,
  type LogLevelState,
  type OutcomeRow,
  type VaultState,
} from '@homebase/shared';
import type { AppContext } from '../../context.ts';
import { isInactiveSubject, type HealthState, type OutcomeRowState } from '../../lib/health.ts';
import { scrubText, type LogLevelInfo } from '../../lib/logger.ts';
import { jobArea, type JobStats } from '../../lib/scheduler.ts';
import { foreignOrigins } from '../../security/foreign-origins.ts';
import { inflightOutbound } from '../../security/safe-fetch.ts';
import { ACCOUNT_SYNC_JOB, ICS_SYNC_JOB } from '../calendar/index.ts';

/** Warning counts cover this long. */
export const COUNTS_WINDOW_MS = 60 * 60 * 1000;
/** 9999-12-31T23:59:59.999Z: later times have no 4-digit-year ISO form (`IsoDateTime` refuses them). */
const MAX_ISO_MS = 253_402_300_799_999;

// ---------------------------------------------------------------------------
// Time and number helpers
// ---------------------------------------------------------------------------

/** ISO text of an epoch-ms time between 1970 and 9999, else null. */
export function isoOrNull(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_ISO_MS) return null;
  return new Date(ms).toISOString();
}

/** ISO text of `ms`, or of `fallback` when `ms` has none (required DTO times). */
export function isoOr(ms: number | null | undefined, fallback: number): string {
  return isoOrNull(ms) ?? isoOrNull(fallback) ?? new Date(0).toISOString();
}

/** A rounded integer, or null for null / non-finite values. */
function intOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function int(value: number, fallback = 0): number {
  return intOrNull(value) ?? fallback;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** What labels are resolved from: account labels and calendar names by id. */
export interface LabelSources {
  accounts: ReadonlyMap<string, string>;
  calendars: ReadonlyMap<string, string>;
}

/** Account labels (`ctx.accounts`) and calendar names (calendars table); empty maps when unreadable. */
export function loadLabelSources(ctx: Pick<AppContext, 'accounts' | 'db'>): LabelSources {
  const accounts = new Map<string, string>();
  const calendars = new Map<string, string>();
  try {
    for (const account of ctx.accounts.list()) accounts.set(account.id, account.label);
  } catch {
    // Labels are a convenience: the stored ones are shown instead.
  }
  try {
    for (const row of ctx.db.all<{ id: string; name: string }>('SELECT id, name FROM calendars')) {
      if (typeof row.id === 'string' && typeof row.name === 'string') calendars.set(row.id, row.name);
    }
  } catch {
    // As above.
  }
  return { accounts, calendars };
}

/** The label a health key shows: account label, calendar name, job or league name, else the stored one. */
export function resolveLabel(key: string, stored: string | null, sources: LabelSources): string | null {
  const colon = key.indexOf(':');
  if (colon === -1) return stored;
  const prefix = key.slice(0, colon);
  const id = key.slice(colon + 1);
  if (id === '') return stored;
  switch (prefix) {
    case 'account':
    case 'mail':
    case 'calendar-list':
      return sources.accounts.get(id) ?? stored;
    case 'calendar':
    case 'ics':
      return sources.calendars.get(id) ?? stored;
    case 'job':
      return id;
    case 'sports':
      return sportsLeague(id)?.name ?? stored;
    default:
      return stored;
  }
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/** Key prefix → the job that checks the subject, where its area has several jobs (calendar). */
const SUBJECT_JOBS: ReadonlyMap<string, string> = new Map([
  ['calendar-list', ACCOUNT_SYNC_JOB],
  ['calendar', ACCOUNT_SYNC_JOB],
  ['ics', ICS_SYNC_JOB],
]);

/** What staleness needs from the jobs: the overdue or stuck ones, and the job names of each area. */
export interface JobLateness {
  late: ReadonlySet<string>;
  byArea: ReadonlyMap<string, readonly string[]>;
}

export function jobLateness(jobs: readonly JobStats[]): JobLateness {
  const late = new Set<string>();
  const byArea = new Map<string, string[]>();
  for (const job of jobs) {
    if (job.overdue || job.stuckForMs !== null) late.add(job.name);
    const area = jobArea(job.name);
    const names = byArea.get(area);
    if (names === undefined) byArea.set(area, [job.name]);
    else names.push(job.name);
  }
  return { late, byArea };
}

/**
 * The job that checks a subject: `job:<name>` → that job, calendar keys → their sync job, else
 * the job of its area when the area has exactly one; null when none can be told.
 */
export function subjectJob(key: string, area: string, byArea: JobLateness['byArea']): string | null {
  const colon = key.indexOf(':');
  if (colon !== -1) {
    const prefix = key.slice(0, colon);
    if (prefix === 'job') {
      const name = key.slice(colon + 1);
      return name === '' ? null : name;
    }
    const job = SUBJECT_JOBS.get(prefix);
    if (job !== undefined) return job;
  }
  const names = byArea.get(area);
  return names !== undefined && names.length === 1 ? (names[0] ?? null) : null;
}

/**
 * The status shown for a subject: its recorded one, or `stale`. A late job only questions
 * an `ok`: failing and degraded subjects keep their code and `failingSince`, the more useful signal.
 */
export function healthStatus(state: HealthState, now: number, jobs: JobLateness): HealthStatus {
  if (state.status === 'unknown' || state.expectEveryMs === null) return state.status;
  if (state.lastCheckedAt !== null && now - state.lastCheckedAt > state.expectEveryMs) return 'stale';
  if (state.status !== 'ok') return state.status;
  const job = subjectJob(state.key, state.area, jobs.byArea);
  return job !== null && jobs.late.has(job) ? 'stale' : 'ok';
}

// ---------------------------------------------------------------------------
// DTO converters
// ---------------------------------------------------------------------------

export function toHealthEntry(state: HealthState, label: string | null, status: HealthStatus): HealthEntry {
  return {
    key: state.key,
    area: state.area,
    label,
    accountId: state.accountId,
    status,
    lastOkAt: isoOrNull(state.lastOkAt),
    lastFailAt: isoOrNull(state.lastFailAt),
    failingSince: isoOrNull(state.failingSince),
    lastCheckedAt: isoOrNull(state.lastCheckedAt),
    expectEveryMs: intOrNull(state.expectEveryMs),
    consecutiveFailures: int(state.consecutiveFailures),
    lastCode: state.lastCode,
    lastStatus: intOrNull(state.lastStatus),
    lastMessage: state.lastMessage,
    lastMs: intOrNull(state.lastMs),
    detail: state.detail === null ? null : { ...state.detail },
    causeKey: state.causeKey,
    nextAttemptAt: isoOrNull(state.nextAttemptAt),
    updatedAt: isoOr(state.updatedAt, 0),
  };
}

/** Every active subject with its label resolved and `stale` derived (inactive feeds/providers left out). */
export function healthEntries(states: readonly HealthState[], sources: LabelSources, jobs: readonly JobStats[], now: number): HealthEntry[] {
  const lateness = jobLateness(jobs);
  return states
    .filter((state) => !isInactiveSubject(state, now))
    .map((state) => toHealthEntry(state, resolveLabel(state.key, state.label, sources), healthStatus(state, now, lateness)));
}

const MAX_STATUS_MESSAGE = 300;
const MESSAGE_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu;

/** An account's status message under the health message rule (scrubbed, one line, ≤ 300). */
function statusMessageText(message: string | null): string | null {
  if (message === null) return null;
  const text = scrubText(message.slice(0, MAX_STATUS_MESSAGE * 8)).replace(MESSAGE_CONTROL, ' ').trim();
  if (text === '') return null;
  return text.length > MAX_STATUS_MESSAGE ? `${text.slice(0, MAX_STATUS_MESSAGE - 1)}…` : text;
}

/**
 * `entries` plus an `account:<id>` entry for every account that is not `ok` and has no subject of
 * its own, so a dependent's `causeKey` always names a listed subject: a status stored before
 * diagnostics existed, or a subject purged after 30 days without a record (an OAuth account in
 * reauth and an IMAP account parked by a rejected password are not checked again until the user
 * acts). Built from the stored status (`failing`; `reauth_required`, `vault_locked` while the vault
 * is locked, no code for `error`; the status message; detail `{fromStatus: true}`); times unknown.
 * Sorted by key, as the tracker's list.
 */
export function withAccountStatusEntries(
  entries: readonly HealthEntry[],
  accounts: readonly Account[],
  vault: VaultState,
  now: number,
): HealthEntry[] {
  const known = new Set(entries.map((e) => e.key));
  const added: HealthEntry[] = [];
  for (const account of accounts) {
    const key = `account:${account.id}`;
    if (account.status === 'ok' || known.has(key)) continue;
    added.push({
      key,
      area: 'accounts',
      label: account.label,
      accountId: account.id,
      status: 'failing',
      lastOkAt: null,
      lastFailAt: null,
      failingSince: null,
      lastCheckedAt: null,
      expectEveryMs: null,
      consecutiveFailures: 0,
      lastCode: vault === 'locked' ? 'vault_locked' : account.status === 'reauth' ? 'reauth_required' : null,
      lastStatus: null,
      lastMessage: statusMessageText(account.statusMessage),
      lastMs: null,
      detail: { fromStatus: true },
      causeKey: null,
      nextAttemptAt: null,
      updatedAt: isoOr(Date.parse(account.updatedAt), now),
    });
  }
  if (added.length === 0) return [...entries];
  return [...entries, ...added].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** `ctx.accounts.list()`, or none when it cannot be read (the summary still answers). */
function listAccounts(ctx: Pick<AppContext, 'accounts'>): Account[] {
  try {
    return ctx.accounts.list();
  } catch {
    return [];
  }
}

export function toOutcomeRow(row: OutcomeRowState): OutcomeRow {
  return {
    id: int(row.id),
    key: row.key,
    at: isoOr(row.at, 0),
    lastAt: isoOr(row.lastAt, row.at),
    count: int(row.count, 1),
    ok: row.ok,
    status: row.status,
    code: row.code,
    httpStatus: intOrNull(row.httpStatus),
    message: row.message,
    ms: intOrNull(row.ms),
    detail: row.detail === null ? null : { ...row.detail },
  };
}

/** `JobStats` (or the manual scheduler's `ManualJobInfo`) → `JobInfo` (only the contract's fields). */
export function toJobInfo(job: JobStats): JobInfo {
  return {
    name: job.name,
    intervalMs: int(job.intervalMs),
    nextRunAt: isoOrNull(job.nextRunAt),
    running: job.running,
    runningSince: isoOrNull(job.runningSince),
    stuckForMs: intOrNull(job.stuckForMs),
    overdue: job.overdue,
    runs: int(job.runs),
    failures: int(job.failures),
    consecutiveFailures: int(job.consecutiveFailures),
    lastStartedAt: isoOrNull(job.lastStartedAt),
    lastFinishedAt: isoOrNull(job.lastFinishedAt),
    lastMs: intOrNull(job.lastMs),
    lastOk: job.lastOk,
    lastError: job.lastError === null ? null : { name: job.lastError.name, code: job.lastError.code, message: job.lastError.message },
  };
}

/** The logger's level state as the contract shows it; timed verbose survives a restart (persisted). */
export function toLogLevelState(info: LogLevelInfo): LogLevelState {
  return {
    level: info.level,
    verbose: info.verbose,
    until: isoOrNull(info.until),
    areas: info.areas === null ? null : [...info.areas],
    bootLevel: info.bootLevel,
    persisted: info.verbose && info.until !== null,
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface SummaryOptions {
  /** A request from the Pages site: data and log directories blank. */
  fromPages: boolean;
  now: number;
  /** The request asking for the summary: left out of `inFlight` (it is always open while it is built). */
  requestId?: string;
}

function processMemory(): DiagnosticsSummary['server']['memory'] {
  try {
    const usage = process.memoryUsage();
    return { rssBytes: int(usage.rss), heapUsedBytes: int(usage.heapUsed) };
  } catch {
    return null;
  }
}

function platformText(): string {
  try {
    return `${process.platform} ${process.arch} ${os.release()}`;
  } catch {
    return `${process.platform} ${process.arch}`;
  }
}

function hybridState(ctx: AppContext): DiagnosticsSummary['hybrid'] {
  const pairings = ctx.pairing.list();
  let lastUsed: number | null = null;
  for (const record of pairings) {
    if (record.lastUsedAt !== null && (lastUsed === null || record.lastUsedAt > lastUsed)) lastUsed = record.lastUsedAt;
  }
  const foreign = foreignOrigins.snapshot();
  return {
    pagesOrigin: ctx.config.pagesOrigin,
    pairings: pairings.length,
    lastPairedRequestAt: isoOrNull(lastUsed),
    foreignOrigins: foreign.origins.map((o) => ({
      origin: o.origin,
      firstAt: isoOr(o.firstAt, 0),
      lastAt: isoOr(o.lastAt, o.firstAt),
      count: int(o.count),
    })),
    foreignOriginRequests: int(foreign.requests),
  };
}

function inFlightState(ctx: AppContext, now: number, requestId: string | undefined): DiagnosticsSummary['inFlight'] {
  const requests = ctx.runtime.inflight.snapshot(now, requestId);
  return {
    count: int(requests.count),
    oldestMs: intOrNull(requests.oldestMs),
    routes: [...requests.routes],
    // `run`/`rid` stay in the log lines: the summary names host and purpose only.
    outbound: inflightOutbound(now).map((o) => ({ host: o.host, purpose: o.purpose, ms: int(o.ms) })),
  };
}

export function buildSummary(ctx: AppContext, options: SummaryOptions): DiagnosticsSummary {
  const { now, fromPages } = options;
  const { runtime, config } = ctx;
  const jobs = ctx.scheduler.jobs();
  const counts = ctx.logs.counts(now - COUNTS_WINDOW_MS);
  return {
    generatedAt: isoOr(now, Date.now()),
    server: {
      version: config.version,
      boot: runtime.boot,
      pid: process.pid,
      startedAt: isoOr(runtime.startedAt, now),
      uptimeMs: Math.max(0, int(now - runtime.startedAt)),
      node: process.version,
      platform: platformText(),
      memory: processMemory(),
      supervised: runtime.supervised,
      restart: runtime.restart === null ? null : { attempt: int(runtime.restart.attempt), lastExit: runtime.restart.lastExit },
      dataDir: fromPages ? '' : config.dataDir,
      logDir: fromPages ? '' : config.paths.logsDir,
    },
    logLevel: toLogLevelState(ctx.logs.levelState()),
    modules: runtime.modules.map((m) => ({ name: m.name, ok: m.ok })),
    vault: ctx.vault.state,
    hybrid: hybridState(ctx),
    inFlight: inFlightState(ctx, now, options.requestId),
    jobs: jobs.map(toJobInfo),
    health: withAccountStatusEntries(healthEntries(ctx.health.list(), loadLabelSources(ctx), jobs, now), listAccounts(ctx), ctx.vault.state, now),
    counts: {
      server: { warn: counts.server.warn, error: counts.server.error },
      client: { warn: counts.client.warn, error: counts.client.error },
      warnKeysLastHour: counts.warnKeys,
      memoryRecords: ctx.logs.size,
    },
  };
}
