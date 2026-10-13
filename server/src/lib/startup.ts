/**
 * The server entry point's start-up, console, status and shutdown steps (§3, §6, §17), kept free
 * of start-up side effects so they can be tested: `index.ts` starts the server when imported.
 *
 * - {@link StartupError} / {@link requireWebDist}: a start-up failure with its own exit code
 *   (`web/dist` missing → EXIT_PERMANENT_FAILURE) and fields to log.
 * - {@link reportStartupFailure}: `startup failed {phase, …}` in the log (before the logger exists:
 *   a bootstrap line in server.log) and the fatal text on stderr when nobody else shows it.
 * - {@link describeLastExit}: the supervisor's `HOMEBASE_SUPERVISOR_LAST_EXIT` as one scrubbed line.
 * - {@link redirectConsole}: `console.*` into the log, nested calls straight to stderr.
 * - {@link healthCounts}: health subjects by status for the `status` line (`stale` counted apart).
 * - {@link stopServer}: the shutdown sequence (stop jobs → close listeners → wait for job runs and
 *   open requests → health → database → `stopped` → close the log), without the exit.
 */
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { EXIT_PERMANENT_FAILURE, EXIT_STARTUP_FAILURE, fatalText, writeBootstrapFailure } from './exit-codes.ts';
import type { HealthState } from './health.ts';
import type { InFlightRequests } from './inflight.ts';
import { errorFields, scrubText, type LogFields, type Logger, type RootLogger } from './logger.ts';
import type { Scheduler } from './scheduler.ts';

/** Longest `console.*` text kept in a log line. */
export const MAX_CONSOLE_TEXT = 2048;
/** Longest `lastExit` line (Settings → Diagnostics). */
export const MAX_LAST_EXIT = 300;

// ---------------------------------------------------------------------------
// Start-up failures
// ---------------------------------------------------------------------------

/** A start-up failure with its own exit code, a Homebase-authored message and fields to log. */
export class StartupError extends Error {
  override name = 'StartupError';
  readonly code: string;
  readonly exitCode: number;
  readonly fields: LogFields;
  constructor(code: string, message: string, options: { exitCode?: number; fields?: LogFields } = {}) {
    super(message);
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT_STARTUP_FAILURE;
    this.fields = options.fields ?? {};
  }
}

/** The exit code of a failed start-up: a {@link StartupError}'s own, else EXIT_STARTUP_FAILURE. */
export function startupExitCode(err: unknown): number {
  return err instanceof StartupError ? err.exitCode : EXIT_STARTUP_FAILURE;
}

/** Throws `web_dist_missing` (EXIT_PERMANENT_FAILURE) when a production server has no built page to serve. */
export function requireWebDist(webDist: string, dev: boolean, exists: (file: string) => boolean = fs.existsSync): void {
  if (dev || exists(path.join(webDist, 'index.html'))) return;
  throw new StartupError('web_dist_missing', 'web/dist is missing: run `npm run build` before `npm start`', {
    exitCode: EXIT_PERMANENT_FAILURE,
    fields: { webDist },
  });
}

export interface StartupFailureOutput {
  /** The logger, once it exists; before that the failure goes to {@link bootstrapFile}. */
  log: Logger | null;
  /** `<data dir>/logs/server.log`, asked for only when there is no logger yet. */
  bootstrapFile: () => string;
  /** Under the supervisor (no console): the stderr text is the crash cause it keeps. */
  supervised: boolean;
  writeStderr: (text: string) => void;
}

/**
 * Records a failed start-up in `phase`: `error 'startup failed' {…errorFields (stack), phase,
 * …StartupError fields, …fields}`, or a bootstrap line before the logger exists, and the fatal text
 * on stderr unless an unsupervised logger's console line already showed it.
 */
export function reportStartupFailure(phase: string, err: unknown, out: StartupFailureOutput, fields: LogFields = {}): void {
  if (out.log !== null) {
    out.log.error('startup failed', { ...errorFields(err, { stack: true }), phase, ...(err instanceof StartupError ? err.fields : {}), ...fields });
  } else {
    writeBootstrapFailure(out.bootstrapFile(), phase, err);
  }
  if (out.log === null || out.supervised) out.writeStderr(fatalText(`Homebase: startup failed (${phase})`, err));
}

/** `HOMEBASE_SUPERVISOR_LAST_EXIT`: JSON `{code, signal, failure?}` → one scrubbed line; other text as is (scrubbed). */
export function describeLastExit(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  let text = raw.trim();
  try {
    const exit = JSON.parse(text) as { code?: unknown; signal?: unknown; failure?: unknown };
    const parts: string[] = [];
    if (typeof exit.code === 'number') parts.push(`exit code ${exit.code}`);
    if (typeof exit.signal === 'string' && exit.signal !== '') parts.push(`signal ${exit.signal}`);
    const f = exit.failure;
    if (f !== null && typeof f === 'object') {
      const { phase, errCode, errName, sqliteCode, message } = f as Record<string, unknown>;
      const what = [errCode ?? errName, sqliteCode === undefined ? undefined : `sqlite ${String(sqliteCode)}`, message]
        .filter((v): v is string | number => (typeof v === 'string' && v !== '') || typeof v === 'number')
        .map(String)
        .join(' ');
      parts.push(typeof phase === 'string' ? `phase ${phase}: ${what}` : what);
    }
    if (parts.length > 0) text = parts.join('; ');
  } catch {
    // Plain text.
  }
  const line = scrubText(text).replace(/[\r\n]+/g, ' ');
  return line.length > MAX_LAST_EXIT ? `${line.slice(0, MAX_LAST_EXIT - 1)}…` : line;
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

export type ConsoleMethods = Pick<Console, 'debug' | 'log' | 'info' | 'warn' | 'error'>;

/**
 * `console.debug/log/info` → debug, `console.warn` → warn, `console.error` → error: one `console`
 * line `{text}` (formatted like the console would, ≤ 2 KB). A console call made while one is
 * being logged goes straight to `writeStderr`, scrubbed (no recursion through the logger).
 */
export function redirectConsole(log: Logger, writeStderr: (text: string) => void, target: ConsoleMethods = console): void {
  const consoleLog = log.child({ component: 'console' });
  let inside = false;
  const route =
    (level: 'debug' | 'warn' | 'error') =>
    (...args: unknown[]): void => {
      let text: string;
      try {
        text = util.format(...args);
      } catch {
        text = '[console output that could not be formatted]';
      }
      if (inside) {
        writeStderr(`${scrubText(text)}\n`);
        return;
      }
      inside = true;
      try {
        consoleLog[level]('console', { text: text.length > MAX_CONSOLE_TEXT ? `${text.slice(0, MAX_CONSOLE_TEXT - 1)}…` : text });
      } finally {
        inside = false;
      }
    };
  target.debug = route('debug');
  target.log = route('debug');
  target.info = route('debug');
  target.warn = route('warn');
  target.error = route('error');
}

// ---------------------------------------------------------------------------
// Status line and shutdown
// ---------------------------------------------------------------------------

export type HealthCounts = Record<'ok' | 'degraded' | 'failing' | 'stale' | 'unknown', number>;

/** Health subjects by status; `stale` = expected every N ms but not checked for longer (§17), whatever its status. */
export function healthCounts(subjects: readonly Pick<HealthState, 'status' | 'expectEveryMs' | 'lastCheckedAt'>[], now: number): HealthCounts {
  const counts: HealthCounts = { ok: 0, degraded: 0, failing: 0, stale: 0, unknown: 0 };
  for (const subject of subjects) {
    const stale = subject.expectEveryMs !== null && subject.lastCheckedAt !== null && now - subject.lastCheckedAt > subject.expectEveryMs;
    counts[stale ? 'stale' : subject.status]++;
  }
  return counts;
}

/** Waits until no request is open or `deadline` passes (polling every 25 ms); returns how many are still open. */
export async function waitForRequests(inflight: Pick<InFlightRequests, 'count'>, deadline: number, now: () => number = Date.now): Promise<number> {
  while (inflight.count() > 0 && now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  return inflight.count();
}

/** A listener as shutdown closes it (`ServerType` of @hono/node-server). */
export interface ClosableServer {
  close(callback: () => void): unknown;
  closeAllConnections?: () => void;
}

function closeServer(server: ClosableServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Keep-alive sockets would otherwise hold the process open.
    server.closeAllConnections?.();
  });
}

/** What {@link stopServer} stops. */
export interface StoppableServer {
  log: Pick<RootLogger, 'info' | 'close'>;
  scheduler: Pick<Scheduler, 'stopAll' | 'idle'>;
  servers: readonly ClosableServer[];
  inflight: Pick<InFlightRequests, 'count'>;
  health: { close(): void };
  db: { close(): void };
}

/**
 * The shutdown sequence, without the exit: stops jobs, closes the listeners, waits up to `waitMs`
 * for job runs and open requests (one deadline for both), then closes health (its last flush needs
 * the database), the database, logs `stopped {exitCode, waitedForJobs, openRequests?}` and closes
 * the log.
 */
export async function stopServer(parts: StoppableServer, exitCode: number, waitMs: number): Promise<void> {
  parts.scheduler.stopAll();
  await Promise.all(parts.servers.map(closeServer));
  const deadline = Date.now() + waitMs;
  // True when every job run finished within the wait.
  const waitedForJobs = await parts.scheduler.idle(waitMs);
  const openRequests = await waitForRequests(parts.inflight, deadline);
  parts.health.close();
  try {
    parts.db.close();
  } catch {
    // ignore
  }
  parts.log.info('stopped', { exitCode, waitedForJobs, ...(openRequests > 0 ? { openRequests } : {}) });
  parts.log.close();
}
