/**
 * Test data for the Diagnostics panels (tests only): a diagnostics summary, health entries, jobs
 * and log records in the shapes the server sends, each overridable.
 */
import type { DiagnosticsSummary, HealthEntry, JobInfo, LogRecord, LogsResponse, OutcomeRow } from '@homebase/shared';

export const T0 = '2026-10-11T12:00:00.000Z';

export function healthEntry(key: string, patch: Partial<HealthEntry> = {}): HealthEntry {
  return {
    key,
    area: key.split(':')[0] ?? key,
    label: null,
    accountId: null,
    status: 'ok',
    lastOkAt: T0,
    lastFailAt: null,
    failingSince: null,
    lastCheckedAt: T0,
    expectEveryMs: 900_000,
    consecutiveFailures: 0,
    lastCode: null,
    lastStatus: null,
    lastMessage: null,
    lastMs: 120,
    detail: null,
    causeKey: null,
    nextAttemptAt: null,
    updatedAt: T0,
    ...patch,
  };
}

export function jobInfo(name: string, patch: Partial<JobInfo> = {}): JobInfo {
  return {
    name,
    intervalMs: 300_000,
    nextRunAt: '2026-10-11T12:05:00.000Z',
    running: false,
    runningSince: null,
    stuckForMs: null,
    overdue: false,
    runs: 3,
    failures: 0,
    consecutiveFailures: 0,
    lastStartedAt: T0,
    lastFinishedAt: T0,
    lastMs: 80,
    lastOk: true,
    lastError: null,
    ...patch,
  };
}

export function diagnosticsSummary(patch: Partial<DiagnosticsSummary> = {}): DiagnosticsSummary {
  return {
    generatedAt: T0,
    server: {
      version: '0.0.0-test',
      boot: 'b1x2',
      pid: 4242,
      startedAt: '2026-10-11T09:00:00.000Z',
      uptimeMs: 3 * 3_600_000 + 12 * 60_000,
      node: 'v24.21.0',
      platform: 'win32',
      memory: { rssBytes: 120 * 1024 * 1024, heapUsedBytes: 60 * 1024 * 1024 },
      supervised: false,
      restart: null,
      dataDir: 'C:\\Users\\~\\AppData\\Local\\Homebase',
      logDir: 'C:\\Users\\~\\AppData\\Local\\Homebase\\logs',
    },
    logLevel: { level: 'info', verbose: false, until: null, areas: null, bootLevel: 'info', persisted: false },
    modules: [
      { name: 'core', ok: true },
      { name: 'calendar', ok: true },
    ],
    vault: 'ready',
    hybrid: { pagesOrigin: null, pairings: 0, lastPairedRequestAt: null, foreignOrigins: [], foreignOriginRequests: 0 },
    inFlight: { count: 0, oldestMs: null, routes: [], outbound: [] },
    jobs: [jobInfo('calendar:sync')],
    health: [],
    counts: { server: { warn: 0, error: 0 }, client: { warn: 0, error: 0 }, warnKeysLastHour: 0, memoryRecords: 10 },
    ...patch,
  };
}

let seq = 0;

export function logRecord(patch: Partial<LogRecord> = {}): LogRecord {
  seq += 1;
  return {
    seq,
    t: T0,
    tEvent: null,
    level: 'info',
    msg: 'request',
    src: 'server',
    area: 'server',
    tags: [patch.area ?? 'server'],
    rid: null,
    fields: {},
    ...patch,
  };
}

export function logsResponse(records: LogRecord[], patch: Partial<LogsResponse> = {}): LogsResponse {
  return { records, lastSeq: records.reduce((max, r) => Math.max(max, r.seq), 0), truncated: false, scope: 'memory', ...patch };
}

export function outcomeRow(patch: Partial<OutcomeRow> = {}): OutcomeRow {
  return { id: 1, key: 'calendar:cal-1', at: T0, lastAt: T0, count: 1, ok: false, status: 'failing', code: 'rate_limited', httpStatus: 429, message: 'Rate limited', ms: 80, detail: null, ...patch };
}
