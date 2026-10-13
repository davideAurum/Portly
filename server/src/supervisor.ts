/**
 * Autostart supervisor (§3, §12): `node server/src/supervisor.ts` (started at logon by the
 * "Portly Server" scheduled task) keeps the server running.
 *
 * - Spawns `process.execPath --no-warnings server/src/index.ts` with `windowsHide: true`, stdin and
 *   stdout ignored, stderr piped and an IPC channel. The server logs to its own `logs/server.log`
 *   (no console when supervised) and writes to stderr only for fatal output, so the supervisor
 *   keeps the last lines of it (scrubbed, ≤ 40 lines / 16 KB) as the crash cause; Node's own
 *   warnings stay off stderr (the server logs them).
 * - The child gets `PORTLY_SUPERVISED=1` and, on a restart, `PORTLY_SUPERVISOR_ATTEMPT` and
 *   `PORTLY_SUPERVISOR_LAST_EXIT` (JSON `{code, signal, failure?}`; Settings → Diagnostics shows
 *   them). A server whose start-up fails reports why over IPC (`startup-failed`): logged with that
 *   run's exit as `lastFailure` (a run that reported nothing has none, whatever earlier runs said).
 * - Restarts on exit with backoff 1 s, 2 s, 5 s, 10 s, 30 s, 60 s (cap); the backoff resets once a
 *   run lasted 10 minutes. Five runs in a row shorter than a minute log `server keeps crashing at
 *   start-up` once per such loop.
 * - Exit code 3 (EXIT_ALREADY_RUNNING: another Portly holds the port) → the supervisor exits
 *   without restarting. Exit code 4 (EXIT_PERMANENT_FAILURE, e.g. `web/dist` missing) three times
 *   in a row → `server cannot start; not restarting` and the supervisor exits with code 4.
 * - On SIGINT/SIGTERM (and SIGBREAK on Windows) the child is asked to shut down gracefully over
 *   the IPC channel (`{type: 'shutdown'}`): on Windows `ChildProcess.kill(signal)` terminates the
 *   process immediately whatever the signal, so the server's own shutdown (stop jobs, close
 *   listeners, close the database and checkpoint its WAL) would never run. Without a channel the
 *   signal is sent instead. The supervisor exits once the child is gone (killed after 10 s).
 * - When the supervisor itself is killed, the server dies with it (on Windows): libuv puts every
 *   child spawned without `detached` into a job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so
 *   killing the supervisor (Task Manager, `Stop-Process`, scripts/uninstall-autostart.ps1) also
 *   terminates the server, skipping its graceful shutdown. This is intended: an orphaned server
 *   would keep the port, so the next supervisor's server would exit with code 3 and nothing would
 *   supervise it. (Elsewhere a killed supervisor leaves the server running; autostart is Windows-only.)
 * - Logs JSON Lines to `<dataDir>/logs/supervisor.log` (records `src: 'supervisor'`); an invalid
 *   configuration is written there as one line before exiting.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { loadConfig, resolveDataDir } from './config.ts';
import {
  EXIT_ALREADY_RUNNING,
  EXIT_OK,
  EXIT_PERMANENT_FAILURE,
  EXIT_STARTUP_FAILURE,
  fatalText,
  parseStartupFailure,
  writeBootstrapFailure,
  type StartupFailure,
} from './lib/exit-codes.ts';
import { SHUTDOWN_MESSAGE } from './lib/ipc.ts';
import { createLogger, errorFields, scrubText, type Logger } from './lib/logger.ts';

export const BACKOFF_SCHEDULE_MS: readonly number[] = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000, 60_000]);
/** A run at least this long counts as healthy: the next restart starts the schedule over. */
export const STABLE_UPTIME_MS = 10 * 60 * 1000;
/** How long a graceful stop may take before the child is killed forcefully. */
export const STOP_TIMEOUT_MS = 10_000;
/** Consecutive runs shorter than {@link CRASH_LOOP_UPTIME_MS} that make a crash loop. */
export const CRASH_LOOP_RUNS = 5;
export const CRASH_LOOP_UPTIME_MS = 60_000;
/** Consecutive EXIT_PERMANENT_FAILURE exits after which the supervisor stops restarting. */
export const PERMANENT_FAILURE_LIMIT = 3;
/** The child's stderr kept per run, and the lines of it logged with an exit. */
export const STDERR_TAIL_LINES = 40;
export const STDERR_TAIL_BYTES = 16 * 1024;
export const STDERR_TAIL_LOGGED = 10;
/** After `exit`, how long to wait for `close` (stderr fully read) before using the tail anyway. */
export const CLOSE_GRACE_MS = 1000;

const SERVER_ENTRY = path.join(import.meta.dirname, 'index.ts');
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
/** One stderr line is cut to this length (a minified stack line can be huge). */
const MAX_TAIL_LINE = 1000;

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  uptimeMs: number;
}

export type RestartDecision =
  | { action: 'stop'; reason: 'already-running' }
  | { action: 'stop'; reason: 'permanent-failure' }
  | { action: 'restart'; delayMs: number; attempt: number };

/**
 * Restart policy (pure). `attempt` counts consecutive short-lived runs before this exit (0 for the
 * first); `permanentFailures` counts the EXIT_PERMANENT_FAILURE exits right before this one.
 * Returns the delay before the next start and the attempt counter to carry forward.
 */
export function decideRestart(
  attempt: number,
  exit: ChildExit,
  schedule: readonly number[] = BACKOFF_SCHEDULE_MS,
  stableUptimeMs: number = STABLE_UPTIME_MS,
  permanentFailures = 0,
): RestartDecision {
  if (exit.code === EXIT_ALREADY_RUNNING) return { action: 'stop', reason: 'already-running' };
  if (exit.code === EXIT_PERMANENT_FAILURE && permanentFailures + 1 >= PERMANENT_FAILURE_LIMIT) {
    return { action: 'stop', reason: 'permanent-failure' };
  }
  const base = exit.uptimeMs >= stableUptimeMs ? 0 : Math.max(0, attempt);
  const delayMs = schedule[Math.min(base, schedule.length - 1)] ?? 0;
  return { action: 'restart', delayMs, attempt: base + 1 };
}

export interface LineTail {
  /** Adds a chunk of text (lines may span chunks). */
  push(chunk: string): void;
  /** The kept lines, oldest first (a trailing partial line included). */
  lines(): string[];
}

/**
 * The last lines of a stream, scrubbed (secrets, user paths), at most `maxLines` lines and
 * `maxBytes` characters; empty lines are skipped.
 */
export function createLineTail(maxLines: number = STDERR_TAIL_LINES, maxBytes: number = STDERR_TAIL_BYTES): LineTail {
  const kept: string[] = [];
  let size = 0;
  let partial = '';
  const keep = (raw: string): void => {
    const trimmed = raw.replace(/\s+$/, '');
    if (trimmed === '') return;
    const line = scrubText(trimmed.length > MAX_TAIL_LINE ? `${trimmed.slice(0, MAX_TAIL_LINE - 1)}…` : trimmed);
    kept.push(line);
    size += line.length;
    while (kept.length > maxLines || (size > maxBytes && kept.length > 1)) size -= kept.shift()?.length ?? 0;
  };
  return {
    push(chunk) {
      const parts = (partial + chunk).split(/\r?\n/);
      partial = parts.pop() ?? '';
      // An endless line must not grow without bound.
      if (partial.length > MAX_TAIL_LINE * 4) {
        keep(partial);
        partial = '';
      }
      for (const part of parts) keep(part);
    },
    lines() {
      return partial.trim() === '' ? [...kept] : [...kept, scrubText(partial.slice(0, MAX_TAIL_LINE))].slice(-maxLines);
    },
  };
}

export interface SupervisorOptions {
  log: Logger;
  /** Executable (default `process.execPath`). */
  command?: string;
  /** Arguments (default `[--no-warnings, <repo>/server/src/index.ts]`). */
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  schedule?: readonly number[];
  stableUptimeMs?: number;
  stopTimeoutMs?: number;
  now?: () => number;
}

export interface Supervisor {
  /** Resolves with the supervisor's exit code once it has stopped for good. */
  readonly done: Promise<number>;
  /** Forwards `signal` to the child and resolves once it (and the supervisor) stopped. */
  stop(signal?: NodeJS.Signals): Promise<number>;
  /** Number of child processes started so far. */
  readonly starts: number;
  /** PID of the running child, if any. */
  readonly childPid: number | null;
}

/** What the last run's exit looked like (`PORTLY_SUPERVISOR_LAST_EXIT`). */
interface LastExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  failure?: StartupFailure;
}

export function startSupervisor(options: SupervisorOptions): Supervisor {
  const { log } = options;
  const command = options.command ?? process.execPath;
  const args = [...(options.args ?? ['--no-warnings', SERVER_ENTRY])];
  const schedule = options.schedule ?? BACKOFF_SCHEDULE_MS;
  const stableUptimeMs = options.stableUptimeMs ?? STABLE_UPTIME_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  let child: ChildProcess | null = null;
  let attempt = 0;
  let starts = 0;
  let stopping = false;
  let restartTimer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let resolveDone!: (code: number) => void;
  let finished = false;
  // Across runs: what the next child is told, and what the crash-loop line reports.
  let lastExit: LastExit | null = null;
  let shortRuns = 0;
  let loopReported = false;
  let permanentFailures = 0;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (killTimer) clearTimeout(killTimer);
    restartTimer = null;
    killTimer = null;
    resolveDone(code);
  };

  /** The child's environment: supervised, and on a restart the attempt and how the last run ended. */
  const childEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), PORTLY_SUPERVISED: '1' };
    delete env.PORTLY_SUPERVISOR_ATTEMPT;
    delete env.PORTLY_SUPERVISOR_LAST_EXIT;
    if (lastExit !== null) {
      env.PORTLY_SUPERVISOR_ATTEMPT = String(attempt);
      env.PORTLY_SUPERVISOR_LAST_EXIT = JSON.stringify(lastExit);
    }
    return env;
  };

  const launch = (): void => {
    restartTimer = null;
    if (stopping) {
      finish(EXIT_OK);
      return;
    }
    const startedAt = now();
    let gone = false;
    let runFailure: StartupFailure | null = null;
    const tail = createLineTail();
    starts++;
    // No `detached`: the server must die with the supervisor (see above). `detached: true` would
    // only keep it out of libuv's job; it does not add CREATE_BREAKAWAY_FROM_JOB.
    const proc = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: childEnv(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
      windowsHide: true,
    });
    // Synchronously, before any output can be lost: flowing mode, never paused, no awaits.
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => tail.push(chunk));
    proc.stderr?.on('error', () => {});
    // A child that exits closes the channel; a failed send must never crash the supervisor.
    proc.on('error', () => {});
    proc.on('message', (message: unknown) => {
      const failure = parseStartupFailure(message);
      if (failure !== null) runFailure = failure;
    });
    child = proc;

    const onGone = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (gone) return;
      gone = true;
      if (child === proc) child = null;
      if (killTimer) clearTimeout(killTimer);
      killTimer = null;
      const uptimeMs = now() - startedAt;
      const stderrTail = tail.lines().slice(-STDERR_TAIL_LOGGED);
      if (stopping) {
        log.info('server stopped', { code, signal });
        finish(EXIT_OK);
        return;
      }
      const decision = decideRestart(attempt, { code, signal, uptimeMs }, schedule, stableUptimeMs, permanentFailures);
      permanentFailures = code === EXIT_PERMANENT_FAILURE ? permanentFailures + 1 : 0;
      if (decision.action === 'stop') {
        if (decision.reason === 'already-running') {
          log.warn('another Portly is already running; supervisor exiting', { code });
          finish(EXIT_OK);
        } else {
          log.error('server cannot start; not restarting', { code, attempts: permanentFailures, lastFailure: runFailure, stderrTail });
          finish(EXIT_PERMANENT_FAILURE);
        }
        return;
      }
      attempt = decision.attempt;
      lastExit = runFailure === null ? { code, signal } : { code, signal, failure: runFailure };
      log.warn('server exited; restarting', { code, signal, uptimeMs, delayMs: decision.delayMs, attempt, lastFailure: runFailure, stderrTail });
      if (uptimeMs < CRASH_LOOP_UPTIME_MS) {
        shortRuns++;
        if (shortRuns >= CRASH_LOOP_RUNS && !loopReported) {
          loopReported = true;
          log.error('server keeps crashing at start-up', { attempts: shortRuns, lastExit, lastFailure: runFailure, stderrTail });
        }
      } else {
        shortRuns = 0;
        loopReported = false;
      }
      restartTimer = setTimeout(launch, decision.delayMs);
    };

    // The exit is handled once stderr is fully read (`close`), or a moment later when something
    // keeps the pipe open (a grandchild holding the handle).
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let closeTimer: NodeJS.Timeout | null = null;
    const settle = (): void => {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = null;
      if (exitInfo !== null) onGone(exitInfo.code, exitInfo.signal);
    };
    proc.once('spawn', () => log.info('server started', { pid: proc.pid, attempt: lastExit === null ? 0 : attempt }));
    proc.once('error', (err) => {
      log.error('could not start the server process', errorFields(err));
      // A failed spawn emits no 'exit'; treat it as an immediate crash.
      if (proc.pid === undefined) onGone(null, null);
    });
    proc.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      closeTimer = setTimeout(settle, CLOSE_GRACE_MS);
    });
    proc.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      exitInfo ??= { code, signal };
      settle();
    });
  };

  const supervisor: Supervisor = {
    done,
    get starts() {
      return starts;
    },
    get childPid() {
      return child?.pid ?? null;
    },
    stop(signal = 'SIGTERM') {
      if (finished) return done;
      stopping = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      const running = child;
      if (!running || running.exitCode !== null || running.signalCode !== null) {
        finish(EXIT_OK);
        return done;
      }
      log.info('stopping server', { pid: running.pid, signal });
      const signalChild = (): void => {
        try {
          running.kill(signal);
        } catch (err) {
          log.warn('could not signal the server process', errorFields(err));
        }
      };
      if (running.connected) {
        try {
          running.send(SHUTDOWN_MESSAGE, (err) => {
            if (err) signalChild();
          });
        } catch {
          signalChild();
        }
      } else {
        signalChild();
      }
      killTimer ??= setTimeout(() => {
        log.warn('server did not stop in time; killing it', { pid: running.pid });
        running.kill('SIGKILL');
      }, stopTimeoutMs);
      return done;
    },
  };

  launch();
  return supervisor;
}

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    writeBootstrapFailure(path.join(resolveDataDir(), 'logs', 'supervisor.log'), 'config', err, { src: 'supervisor' });
    process.stderr.write(fatalText('Portly supervisor: invalid configuration', err));
    process.exit(EXIT_STARTUP_FAILURE);
  }
  const root = createLogger({ level: config.logLevel, file: config.paths.supervisorLog });
  const log = root.child({ src: 'supervisor' });
  log.info('supervisor starting', { pid: process.pid, node: process.version, dataDir: config.dataDir });

  const supervisor = startSupervisor({ log });
  const forward = (signal: NodeJS.Signals): void => {
    log.info('supervisor stopping', { signal });
    // Windows has no POSIX signals; SIGBREAK (Ctrl+Break) is forwarded as SIGTERM.
    void supervisor.stop(signal === 'SIGBREAK' ? 'SIGTERM' : signal);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, () => forward(signal));

  const code = await supervisor.done;
  log.info('supervisor exiting', { exitCode: code });
  root.close();
  process.exit(code);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(fatalText('Portly supervisor failed', err));
    process.exit(EXIT_STARTUP_FAILURE);
  });
}
