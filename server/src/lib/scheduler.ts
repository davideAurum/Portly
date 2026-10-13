/**
 * In-process scheduler (§6, §9; diagnostics ARCHITECTURE §17).
 *
 * `every(name, intervalMs, fn, {initialDelayMs?})` runs `fn` after `initialDelayMs` (default:
 * `intervalMs`) and then every `intervalMs` measured from the end of the previous run, so runs
 * never overlap. `runNow()` runs immediately, or — if a run is in progress — queues exactly one
 * follow-up run and resolves when it finishes. Errors are logged, never thrown into timers.
 * Job names are `'<module>:...'`; registering an existing name replaces the old job.
 *
 * Diagnostics:
 * - every run is a unit of work: `withLogContext({job, run, area: <prefix before ':'>})`, keeping
 *   only the request id of a `runNow()` caller (the request awaits that run). Timers (`arm()`, the
 *   watchdog) are created outside any context, so later ticks never carry a request's id;
 * - with a health tracker each run records `job:<name>` (failures at error, with the next
 *   attempt); without one a failure logs `error 'job failed'`. Success: `debug 'job finished'`;
 * - a run still going after 2 min logs `warn 'job still running'` (with the last line the run
 *   logged, when the logger keeps it), again every 10 min;
 * - `jobs()` reports {@link JobStats} (overdue / stuck derived), `idle(ms)` waits for every
 *   in-flight run (shutdown).
 */
import { outcomeFromError, type HealthRecorder, type HealthSubject } from './health.ts';
import { getLogContext, newRunId, outsideLogContext, withLogContext } from './log-context.ts';
import { errorFields, isLogHub, type Logger } from './logger.ts';

export interface JobOptions {
  initialDelayMs?: number;
}

export interface Job {
  readonly name: string;
  /** Changes the interval and re-arms the timer `ms` from now (or after the current run). */
  reschedule(ms: number): void;
  /** Runs now (or once more after the current run); resolves when that run finished. */
  runNow(): Promise<void>;
  stop(): void;
}

export type JobFn = () => unknown;

/** A job's state for Settings → Diagnostics (epoch ms; the diagnostics module converts to `JobInfo`). */
export interface JobStats {
  name: string;
  intervalMs: number;
  /** When the next run is due; null while running or stopped. */
  nextRunAt: number | null;
  running: boolean;
  runningSince: number | null;
  /** Running longer than max(2 min, interval): for how long; else null. */
  stuckForMs: number | null;
  /** Not running and the next run is late by more than max(60 s, interval / 10). */
  overdue: boolean;
  runs: number;
  failures: number;
  consecutiveFailures: number;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastMs: number | null;
  lastOk: boolean | null;
  /** Scrubbed (`errorFields`). */
  lastError: { name: string; code: string | null; message: string } | null;
}

export interface Scheduler {
  every(name: string, intervalMs: number, fn: JobFn, opts?: JobOptions): Job;
  /** Runs the named job now (like its `runNow()`); null when no such job is registered. */
  trigger(name: string): Promise<void> | null;
  /** Stops every job (shutdown). Runs in progress finish; see {@link idle}. */
  stopAll(): void;
  /** Registered jobs. */
  jobs(): JobStats[];
  /** Resolves true once no run is in progress (runs, follow-ups, runNow, trigger), false after `timeoutMs`. */
  idle(timeoutMs: number): Promise<boolean>;
}

const MAX_TIMER_MS = 2_147_483_647;
/** First "still running" warning, then the repeat interval. */
export const WATCHDOG_FIRST_MS = 2 * 60 * 1000;
export const WATCHDOG_REPEAT_MS = 10 * 60 * 1000;
const MIN_OVERDUE_MS = 60 * 1000;
const MIN_STUCK_MS = 2 * 60 * 1000;

function checkInterval(name: string, ms: number, what: string): void {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`scheduler job "${name}": ${what} must be ≥ 0 (got ${ms})`);
}

/** `calendar:account-sync` → `calendar`. */
export function jobArea(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(0, colon);
}

/** What every job of one scheduler shares. */
interface JobEnv {
  log: Logger;
  health: HealthRecorder | undefined;
  now: () => number;
  /** In-flight runs of every job (independent of the jobs map, so stopped jobs are still awaited). */
  inflight: Set<Promise<void>>;
  /** Real timers for the "still running" warning (off for the manual scheduler). */
  watchdog: boolean;
}

/** Shared run/overlap bookkeeping for the real and the manual scheduler. */
class JobCore {
  readonly name: string;
  readonly area: string;
  intervalMs: number;
  readonly #fn: JobFn;
  readonly #env: JobEnv;
  running: Promise<void> | null = null;
  #followUp: Promise<void> | null = null;
  stopped = false;
  runs = 0;
  failures = 0;
  consecutiveFailures = 0;
  runningSince: number | null = null;
  lastStartedAt: number | null = null;
  lastFinishedAt: number | null = null;
  lastMs: number | null = null;
  lastOk: boolean | null = null;
  lastError: JobStats['lastError'] = null;

  constructor(name: string, intervalMs: number, fn: JobFn, env: JobEnv) {
    this.name = name;
    this.area = jobArea(name);
    this.intervalMs = intervalMs;
    this.#fn = fn;
    this.#env = env;
  }

  /** Executes one run (never concurrently with another run of this job). */
  execute(): Promise<void> {
    if (this.running) return this.running;
    // Only a caller's request id carries over (a runNow() from a request awaits this run).
    const rid = getLogContext()?.rid;
    const fields = { job: this.name, run: newRunId(), area: this.area };
    const run = outsideLogContext(() => withLogContext(rid === undefined ? fields : { ...fields, rid }, () => this.#run(fields.run)));
    const tracked = run.finally(() => {
      this.running = null;
      this.#env.inflight.delete(tracked);
    });
    this.running = tracked;
    this.#env.inflight.add(tracked);
    return tracked;
  }

  async #run(runId: string): Promise<void> {
    const { log, health, now } = this.#env;
    const started = now();
    this.runs++;
    this.runningSince = started;
    this.lastStartedAt = started;
    const stopWatchdog = this.#env.watchdog ? this.#startWatchdog(runId, started) : () => {};
    let ok = true;
    let error: unknown;
    try {
      await this.#fn();
    } catch (err) {
      ok = false;
      error = err;
    }
    stopWatchdog();
    const finished = now();
    const ms = Math.max(0, finished - started);
    this.runningSince = null;
    this.lastFinishedAt = finished;
    this.lastMs = ms;
    this.lastOk = ok;
    try {
      if (ok) {
        this.consecutiveFailures = 0;
        log.debug('job finished', { job: this.name, ms });
        health?.record(this.#subject(), { ok: true, ms });
        return;
      }
      this.failures++;
      this.consecutiveFailures++;
      const fields = errorFields(error);
      const outcome = outcomeFromError(error);
      // The summary is readable by the paired Pages site: keep Portly's own text (as health
      // messages do), never a library message; the full errMessage stays in the log line.
      this.lastError = {
        name: String(fields.errName ?? 'Error'),
        code: fields.errCode === undefined ? null : String(fields.errCode),
        message: outcome.message ?? String(fields.errName ?? 'Error'),
      };
      if (health) {
        log.debug('job failed', { ...fields, job: this.name, ms });
        health.record(this.#subject(), {
          ...outcome,
          ok: false,
          ms,
          severity: 'error',
          nextAttemptAt: this.stopped ? null : finished + this.intervalMs,
        });
      } else {
        log.error('job failed', { ...fields, job: this.name, ms });
      }
    } catch {
      // Never throw into timers.
    }
  }

  #subject(): HealthSubject {
    return { key: `job:${this.name}`, area: this.area, label: this.name, expectEveryMs: 3 * this.intervalMs };
  }

  /** Warns while the run keeps going (timers outside the run's context; the line names the run). */
  #startWatchdog(runId: string, started: number): () => void {
    const { log, now } = this.#env;
    let timer: NodeJS.Timeout | null = null;
    const warn = (): void => {
      try {
        const lastRecord = isLogHub(log) ? log.lastRecordFor(runId) : null;
        log.warn('job still running', {
          area: this.area,
          job: this.name,
          run: runId,
          runningForMs: Math.max(0, now() - started),
          ...(lastRecord === null ? {} : { lastRecord: { msg: lastRecord.msg, t: new Date(lastRecord.t).toISOString(), area: lastRecord.area } }),
        });
      } catch {
        // ignore
      }
      arm(WATCHDOG_REPEAT_MS);
    };
    const arm = (ms: number): void => {
      timer = outsideLogContext(() => setTimeout(warn, ms));
      timer.unref();
    };
    arm(WATCHDOG_FIRST_MS);
    return () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
  }

  /** runNow semantics: run immediately, or once more after the in-progress run. */
  requestRun(afterRun: () => void): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.running) {
      return this.execute().then(afterRun);
    }
    if (!this.#followUp) {
      this.#followUp = this.running.then(() => {
        this.#followUp = null;
        if (this.stopped) return;
        return this.execute().then(afterRun);
      });
    }
    return this.#followUp;
  }

  stats(nextRunAt: number | null, now: number): JobStats {
    const running = this.running !== null;
    const runningFor = running && this.runningSince !== null ? Math.max(0, now - this.runningSince) : null;
    const lateBy = Math.max(MIN_OVERDUE_MS, this.intervalMs / 10);
    return {
      name: this.name,
      intervalMs: this.intervalMs,
      nextRunAt: running || this.stopped ? null : nextRunAt,
      running,
      runningSince: running ? this.runningSince : null,
      stuckForMs: runningFor !== null && runningFor > Math.max(MIN_STUCK_MS, this.intervalMs) ? runningFor : null,
      overdue: !running && !this.stopped && nextRunAt !== null && nextRunAt < now - lateBy,
      runs: this.runs,
      failures: this.failures,
      consecutiveFailures: this.consecutiveFailures,
      lastStartedAt: this.lastStartedAt,
      lastFinishedAt: this.lastFinishedAt,
      lastMs: this.lastMs,
      lastOk: this.lastOk,
      lastError: this.lastError === null ? null : { ...this.lastError },
    };
  }
}

/** Resolves true once `inflight` is empty, false after `timeoutMs` (0: answer right away). */
async function waitIdle(inflight: Set<Promise<void>>, timeoutMs: number): Promise<boolean> {
  if (inflight.size === 0) return true;
  if (!(timeoutMs > 0)) return false;
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<false>((resolve) => {
    timer = outsideLogContext(() => setTimeout(() => resolve(false), Math.min(timeoutMs, MAX_TIMER_MS)));
    timer.unref();
  });
  try {
    // Runs started meanwhile (follow-ups) are awaited too.
    while (inflight.size > 0) {
      const drained = await Promise.race([Promise.allSettled([...inflight]).then(() => true as const), timeout]);
      if (!drained) return false;
    }
    return true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SchedulerOptions {
  log: Logger;
  /** Records `job:<name>` after every run. */
  health?: HealthRecorder;
  /** Clock for stats (epoch ms; default `Date.now`). Timers stay real. */
  now?: () => number;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const env: JobEnv = {
    log: options.log,
    health: options.health,
    now: options.now ?? Date.now,
    inflight: new Set(),
    watchdog: true,
  };
  const jobs = new Map<string, { job: Job; stats: () => JobStats }>();

  return {
    every(name, intervalMs, fn, opts = {}) {
      checkInterval(name, intervalMs, 'intervalMs');
      if (intervalMs === 0) throw new RangeError(`scheduler job "${name}": intervalMs must be > 0`);
      const initialDelay = opts.initialDelayMs ?? intervalMs;
      checkInterval(name, initialDelay, 'initialDelayMs');

      jobs.get(name)?.job.stop();
      const core = new JobCore(name, intervalMs, fn, env);
      let timer: NodeJS.Timeout | null = null;
      let nextRunAt: number | null = null;

      const clear = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
        nextRunAt = null;
      };
      // Timers outlive whatever unit of work armed them: created outside any log context.
      const arm = (delay: number): void => {
        clear();
        if (core.stopped) return;
        const ms = Math.min(delay, MAX_TIMER_MS);
        timer = outsideLogContext(() => setTimeout(tick, ms));
        timer.unref();
        nextRunAt = env.now() + ms;
      };
      const tick = (): void => {
        timer = null;
        nextRunAt = null;
        void core.execute().then(() => arm(core.intervalMs));
      };

      const job: Job = {
        name,
        reschedule(ms) {
          checkInterval(name, ms, 'interval');
          if (ms === 0) throw new RangeError(`scheduler job "${name}": interval must be > 0`);
          core.intervalMs = ms;
          if (!core.running) arm(ms);
          // If running, the completion handler re-arms with the new interval.
        },
        runNow() {
          clear();
          return core.requestRun(() => arm(core.intervalMs));
        },
        stop() {
          core.stopped = true;
          clear();
          if (jobs.get(name)?.job === job) jobs.delete(name);
        },
      };
      jobs.set(name, { job, stats: () => core.stats(nextRunAt, env.now()) });
      arm(initialDelay);
      return job;
    },
    trigger(name) {
      return jobs.get(name)?.job.runNow() ?? null;
    },
    stopAll() {
      for (const { job } of [...jobs.values()]) job.stop();
    },
    jobs() {
      return [...jobs.values()].map((j) => j.stats());
    },
    idle(timeoutMs) {
      return waitIdle(env.inflight, timeoutMs);
    },
  };
}

// ---------------------------------------------------------------------------
// Manual scheduler (tests): virtual clock, nothing runs until asked.
// ---------------------------------------------------------------------------

/** {@link JobStats} on the virtual clock, plus the due time and whether the job was stopped. */
export interface ManualJobInfo extends JobStats {
  dueAt: number;
  stopped: boolean;
}

export interface ManualScheduler extends Scheduler {
  /** Virtual time in ms since the scheduler was created. */
  readonly now: number;
  /** Runs (sequentially) every job whose due time ≤ now; returns the names run. */
  runDue(): Promise<string[]>;
  /** Advances the virtual clock by `ms`, then {@link runDue}. */
  advance(ms: number): Promise<string[]>;
  /** Runs every active job once, regardless of due time. */
  runAll(): Promise<string[]>;
  jobs(): ManualJobInfo[];
  job(name: string): Job | undefined;
}

export function createManualScheduler(options: { log?: Logger; health?: HealthRecorder } = {}): ManualScheduler {
  const noop = (): void => {};
  const log: Logger = options.log ?? { debug: noop, info: noop, warn: noop, error: noop, child: () => log };
  let now = 0;
  const env: JobEnv = { log, health: options.health, now: () => now, inflight: new Set(), watchdog: false };
  const entries = new Map<string, { core: JobCore; job: Job; dueAt: number }>();

  const runEntry = async (name: string): Promise<void> => {
    const entry = entries.get(name);
    if (!entry || entry.core.stopped) return;
    await entry.core.execute();
    entry.dueAt = now + entry.core.intervalMs;
  };

  const scheduler: ManualScheduler = {
    get now() {
      return now;
    },
    every(name, intervalMs, fn, opts = {}) {
      checkInterval(name, intervalMs, 'intervalMs');
      if (intervalMs === 0) throw new RangeError(`scheduler job "${name}": intervalMs must be > 0`);
      const initialDelay = opts.initialDelayMs ?? intervalMs;
      checkInterval(name, initialDelay, 'initialDelayMs');
      entries.get(name)?.job.stop();

      const core = new JobCore(name, intervalMs, fn, env);
      const job: Job = {
        name,
        reschedule(ms) {
          checkInterval(name, ms, 'interval');
          core.intervalMs = ms;
          const entry = entries.get(name);
          if (entry && entry.core === core) entry.dueAt = now + ms;
        },
        runNow() {
          return core.requestRun(() => {
            const entry = entries.get(name);
            if (entry && entry.core === core) entry.dueAt = now + core.intervalMs;
          });
        },
        stop() {
          core.stopped = true;
          const entry = entries.get(name);
          if (entry && entry.core === core) entries.delete(name);
        },
      };
      entries.set(name, { core, job, dueAt: now + initialDelay });
      return job;
    },
    trigger(name) {
      return entries.get(name)?.job.runNow() ?? null;
    },
    stopAll() {
      for (const { job } of [...entries.values()]) job.stop();
    },
    idle(timeoutMs) {
      return waitIdle(env.inflight, timeoutMs);
    },
    async runDue() {
      const due = [...entries.entries()]
        .filter(([, e]) => e.dueAt <= now && !e.core.stopped)
        .sort((a, b) => a[1].dueAt - b[1].dueAt)
        .map(([name]) => name);
      for (const name of due) await runEntry(name);
      return due;
    },
    async advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance(ms) needs ms ≥ 0');
      now += ms;
      return scheduler.runDue();
    },
    async runAll() {
      const names = [...entries.keys()];
      for (const name of names) await runEntry(name);
      return names;
    },
    jobs() {
      return [...entries.values()].map(({ core, dueAt }) => ({
        ...core.stats(dueAt, now),
        dueAt,
        stopped: core.stopped,
      }));
    },
    job(name) {
      return entries.get(name)?.job;
    },
  };
  return scheduler;
}
