import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { openDb, type Db } from '../db/open.ts';
import { HttpError } from './errors.ts';
import { createHealthRecorder, type HealthRecorder } from './health.ts';
import { getLogContext, withLogContext, type LogContext } from './log-context.ts';
import { createMemoryLogger, createTestLogger, errorFields } from './logger.ts';
import {
  WATCHDOG_FIRST_MS,
  WATCHDOG_REPEAT_MS,
  createManualScheduler,
  createScheduler,
  jobArea,
  type Scheduler,
} from './scheduler.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('scheduler (real timers, faked)', () => {
  let scheduler: Scheduler;
  let log: ReturnType<typeof createMemoryLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    log = createMemoryLogger();
    scheduler = createScheduler({ log });
  });
  afterEach(() => {
    scheduler.stopAll();
    vi.useRealTimers();
  });

  it('runs after the initial delay, then every interval', async () => {
    const fn = vi.fn();
    scheduler.every('test:a', 1000, fn, { initialDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(99);
    expect(fn).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('defaults the initial delay to the interval', async () => {
    const fn = vi.fn();
    scheduler.every('test:b', 500, fn);
    await vi.advanceTimersByTimeAsync(499);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never overlaps runs: the next run is scheduled after completion', async () => {
    let active = 0;
    let maxActive = 0;
    const gates: ReturnType<typeof deferred>[] = [];
    const fn = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      const d = deferred();
      gates.push(d);
      await d.promise;
      active--;
    });
    scheduler.every('test:slow', 100, fn, { initialDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    gates[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    gates[1]?.resolve();
  });

  it('runNow during a run queues exactly one follow-up', async () => {
    const first = deferred();
    const calls: number[] = [];
    let n = 0;
    const job = scheduler.every(
      'test:now',
      60_000,
      async () => {
        const i = ++n;
        calls.push(i);
        if (i === 1) await first.promise;
      },
      { initialDelayMs: 0 },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([1]);
    const p1 = job.runNow();
    const p2 = job.runNow();
    expect(p1).toBe(p2);
    first.resolve();
    await p1;
    expect(calls).toEqual([1, 2]);
  });

  it('logs errors and keeps running', async () => {
    let n = 0;
    scheduler.every('test:fail', 100, () => {
      n++;
      if (n === 1) throw new Error('password=hunter2 exploded');
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(n).toBe(2);
    const err = log.lines.find((l) => l.level === 'error');
    expect(err?.fields?.job).toBe('test:fail');
    expect(String(err?.fields?.errMessage)).not.toContain('hunter2');
  });

  it('reschedule changes the interval', async () => {
    const fn = vi.fn();
    const job = scheduler.every('test:r', 1000, fn);
    job.reschedule(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stop cancels future runs; re-registering a name replaces the job', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const job = scheduler.every('test:s', 100, a);
    job.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(a).not.toHaveBeenCalled();

    scheduler.every('test:dup', 100, a);
    scheduler.every('test:dup', 100, b);
    await vi.advanceTimersByTimeAsync(100);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('validates intervals', () => {
    expect(() => scheduler.every('test:x', 0, () => {})).toThrow(RangeError);
    expect(() => scheduler.every('test:y', -1, () => {})).toThrow(RangeError);
  });

  it('runs each job in its own log context (job, run, area) and logs "job finished" at debug', async () => {
    const seen: (Readonly<LogContext> | undefined)[] = [];
    scheduler.every('calendar:account-sync', 100, () => {
      seen.push(getLogContext());
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ job: 'calendar:account-sync', run: expect.stringMatching(/^[a-z0-9]{6}$/), area: 'calendar' });
    expect(seen[1]?.run).not.toBe(seen[0]?.run);
    expect(log.lines.filter((l) => l.message === 'job finished')).toEqual([
      { level: 'debug', message: 'job finished', fields: { job: 'calendar:account-sync', ms: expect.any(Number) } },
      { level: 'debug', message: 'job finished', fields: { job: 'calendar:account-sync', ms: expect.any(Number) } },
    ]);
    expect(jobArea('core:cache-purge')).toBe('core');
    expect(jobArea('plain')).toBe('plain');
  });

  it('keeps stats per job: runs, failures, last error (scrubbed), next run', async () => {
    let n = 0;
    scheduler.every(
      'test:stats',
      1000,
      () => {
        n++;
        if (n === 2) throw new HttpError(502, 'provider_error', 'Upstream failed with token=abc123');
      },
      { initialDelayMs: 500 },
    );
    const start = Date.now();
    expect(scheduler.jobs()).toEqual([
      {
        name: 'test:stats',
        intervalMs: 1000,
        nextRunAt: start + 500,
        running: false,
        runningSince: null,
        stuckForMs: null,
        overdue: false,
        runs: 0,
        failures: 0,
        consecutiveFailures: 0,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastMs: null,
        lastOk: null,
        lastError: null,
      },
    ]);
    await vi.advanceTimersByTimeAsync(500);
    expect(scheduler.jobs()[0]).toMatchObject({
      runs: 1,
      failures: 0,
      lastOk: true,
      lastStartedAt: start + 500,
      lastFinishedAt: start + 500,
      lastMs: 0,
      nextRunAt: start + 1500,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const failed = scheduler.jobs()[0];
    expect(failed).toMatchObject({ runs: 2, failures: 1, consecutiveFailures: 1, lastOk: false, lastError: { name: 'HttpError', code: 'provider_error' } });
    expect(failed?.lastError?.message).not.toContain('abc123');
    await vi.advanceTimersByTimeAsync(1000);
    expect(scheduler.jobs()[0]).toMatchObject({ runs: 3, failures: 1, consecutiveFailures: 0, lastOk: true });
  });

  it('marks a run stuck after max(2 min, interval) and warns "job still running" with the run\'s last line', async () => {
    const hub = createTestLogger('debug');
    const s = createScheduler({ log: hub.child({ component: 'scheduler' }) });
    const gate = deferred();
    s.every(
      'feeds:refresh',
      60_000,
      async () => {
        hub.child({ module: 'feeds' }).debug('fetching feed', { feed: 'abcdef0123' });
        await gate.promise;
      },
      { initialDelayMs: 0 },
    );
    await vi.advanceTimersByTimeAsync(0);
    const started = Date.now();
    expect(s.jobs()[0]).toMatchObject({ running: true, runningSince: started, nextRunAt: null, stuckForMs: null });
    await vi.advanceTimersByTimeAsync(WATCHDOG_FIRST_MS);
    const warns = () => hub.query({ level: 'warn' }).records.filter((r) => r.msg === 'job still running');
    expect(warns()).toHaveLength(1);
    const [warn] = warns();
    expect(warn).toMatchObject({
      area: 'feeds',
      rid: null,
      fields: { job: 'feeds:refresh', runningForMs: WATCHDOG_FIRST_MS, lastRecord: { msg: 'fetching feed', area: 'feeds' } },
    });
    expect(warn?.fields.run).toEqual(expect.stringMatching(/^[a-z0-9]{6}$/));
    expect(s.jobs()[0]?.stuckForMs).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.jobs()[0]?.stuckForMs).toBe(WATCHDOG_FIRST_MS + 1000);
    await vi.advanceTimersByTimeAsync(WATCHDOG_REPEAT_MS);
    expect(warns()).toHaveLength(2);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.jobs()[0]).toMatchObject({ running: false, stuckForMs: null, lastOk: true });
    await vi.advanceTimersByTimeAsync(WATCHDOG_REPEAT_MS * 2);
    expect(warns()).toHaveLength(2);
    s.stopAll();
  });

  it('reports a job as overdue when its timer is late by more than max(60 s, interval / 10)', () => {
    let clock = 1_000_000;
    const s = createScheduler({ log, now: () => clock });
    s.every('test:late', 10 * 60_000, () => {});
    expect(s.jobs()[0]).toMatchObject({ nextRunAt: 1_000_000 + 600_000, overdue: false });
    clock += 600_000 + 60_000;
    expect(s.jobs()[0]?.overdue).toBe(false);
    clock += 1;
    expect(s.jobs()[0]?.overdue).toBe(true);
    s.stopAll();
    expect(s.jobs()).toEqual([]);
  });

  it('idle() waits for in-flight runs (also of stopped jobs), false on timeout', async () => {
    expect(await scheduler.idle(0)).toBe(true);
    const gate = deferred();
    scheduler.every('test:idle', 1000, () => gate.promise, { initialDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    scheduler.stopAll();
    expect(await scheduler.idle(0)).toBe(false);
    const timedOut = scheduler.idle(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await timedOut).toBe(false);
    const drained = scheduler.idle(5000);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await drained).toBe(true);
  });

  it('idle() also waits for a follow-up queued by runNow()', async () => {
    const gates = [deferred(), deferred()];
    let n = 0;
    const job = scheduler.every('test:follow', 60_000, () => gates[n++]?.promise, { initialDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    const followUp = job.runNow();
    const idle = scheduler.idle(10_000);
    let settled = false;
    void idle.then(() => {
      settled = true;
    });
    gates[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(2);
    expect(settled).toBe(false);
    gates[1]?.resolve();
    await followUp;
    expect(await idle).toBe(true);
  });
});

describe('scheduler with a health tracker', () => {
  let db: Db;
  let health: HealthRecorder;
  let log: ReturnType<typeof createMemoryLogger>;
  beforeEach(() => {
    vi.useFakeTimers();
    db = openDb(':memory:');
    migrate(db);
    log = createMemoryLogger();
    health = createHealthRecorder({ db, log: log.child({ component: 'health' }) });
  });
  afterEach(() => {
    vi.useRealTimers();
    health.close();
    db.close();
  });

  it('records job:<name> after every run; a failure is an error line from health, not "job failed"', async () => {
    const s = createScheduler({ log, health });
    let fail = false;
    s.every(
      'weather:refresh',
      30 * 60_000,
      () => {
        if (fail) throw new HttpError(504, 'upstream_timeout', 'Request to api.open-meteo.com timed out');
      },
      { initialDelayMs: 0 },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(health.get('job:weather:refresh')).toMatchObject({
      area: 'weather',
      label: 'weather:refresh',
      status: 'ok',
      expectEveryMs: 90 * 60_000,
      lastMs: 0,
    });
    fail = true;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    const finishedAt = Date.now();
    expect(health.get('job:weather:refresh')).toMatchObject({
      status: 'failing',
      lastCode: 'timeout',
      lastMessage: 'Request to api.open-meteo.com timed out',
      nextAttemptAt: finishedAt + 30 * 60_000,
    });
    const failing = log.lines.filter((l) => l.message === 'weather failing');
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({ level: 'error', fields: { key: 'job:weather:refresh', code: 'timeout', component: 'health' } });
    expect(log.lines.filter((l) => l.message === 'job failed').map((l) => l.level)).toEqual(['debug']);
    expect(log.lines.filter((l) => l.level === 'error')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(log.lines.filter((l) => l.message === 'weather still failing').map((l) => l.level)).toEqual(['debug']);
    s.stopAll();
  });

  it('the manual scheduler records health too when given one', async () => {
    const s = createManualScheduler({ log, health });
    s.every('core:backup', 1000, () => {});
    await s.runAll();
    expect(health.get('job:core:backup')).toMatchObject({ status: 'ok', area: 'core', expectEveryMs: 3000 });
  });
});

describe('scheduler log context (real timers)', () => {
  it('a job armed or runNow()-ed inside a request never carries that rid on later timer ticks', async () => {
    const s = createScheduler({ log: createMemoryLogger() });
    const seen: { rid: string | undefined; job: string | undefined }[] = [];
    const record = (): void => {
      const ctx = getLogContext();
      seen.push({ rid: ctx?.rid, job: ctx?.job });
    };
    // Waits for timer ticks by count, not by a fixed sleep: a loaded machine can run a late tick and
    // the sleep's own timer in one pass, leaving fewer ticks than the sleep "should" have allowed.
    const ticksSeen = (n: number): Promise<void> =>
      vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(n), { timeout: 5000, interval: 5 });
    try {
      const job = withLogContext({ rid: 'req0000001', area: 'core', accountId: 'acc-1' }, () =>
        s.every('test:ctx', 15, record, { initialDelayMs: 5 }),
      );
      await ticksSeen(2);
      expect(seen.every((c) => c.rid === undefined && c.job === 'test:ctx')).toBe(true);

      const before = seen.length;
      await withLogContext({ rid: 'req0000002', accountId: 'acc-2' }, async () => {
        await job.runNow();
        // The awaiting request is back in its own context.
        expect(getLogContext()?.rid).toBe('req0000002');
      });
      expect(seen[before]).toEqual({ rid: 'req0000002', job: 'test:ctx' });
      await ticksSeen(before + 3);
      expect(seen.slice(before + 1).every((c) => c.rid === undefined)).toBe(true);

      // trigger() from a request, not awaited by it (the diagnostics "Run now" route).
      const mark = seen.length;
      withLogContext({ rid: 'req0000003' }, () => {
        void s.trigger('test:ctx');
      });
      await ticksSeen(mark + 3);
      expect(seen[mark]?.rid).toBe('req0000003');
      expect(seen.slice(mark + 1).every((c) => c.rid === undefined)).toBe(true);
    } finally {
      s.stopAll();
    }
    expect(await s.idle(1000)).toBe(true);
  });

  it('a per-call worker spawned inside a run reports its failure with that run\'s job and run', async () => {
    const hub = createTestLogger('debug');
    const s = createScheduler({ log: hub.child({ component: 'scheduler' }) });
    const job = s.every('calendar:ics-sync', 60_000, () =>
      new Promise<void>((resolve) => {
        // Spawned in the caller's context (rule 4): its listeners run in it.
        const worker = new Worker('throw new Error("parse failed")', { eval: true });
        worker.on('error', (err) => hub.child({ module: 'calendar' }).warn('worker failed', { ...errorFields(err), reason: 'error' }));
        worker.on('exit', () => setImmediate(resolve));
      }),
    );
    await job.runNow();
    const [line] = hub.query({ q: 'worker failed' }).records;
    expect(line).toMatchObject({ level: 'warn', area: 'calendar', fields: { job: 'calendar:ics-sync', run: expect.stringMatching(/^[a-z0-9]{6}$/) } });
    s.stopAll();
  });

  it('the run context keeps only the caller\'s rid (no other request fields leak into the job)', async () => {
    const s = createScheduler({ log: createMemoryLogger() });
    let ctx: Readonly<LogContext> | undefined;
    const job = s.every('mail:refresh', 60_000, () => {
      ctx = getLogContext();
    });
    await withLogContext({ rid: 'req0000004', area: 'core', accountId: 'acc-1', pairingId: 'p1' }, () => job.runNow());
    expect(ctx).toEqual({ job: 'mail:refresh', run: expect.any(String), area: 'mail', rid: 'req0000004' });
    s.stopAll();
  });
});

describe('manual scheduler', () => {
  it('runs nothing until due, then runDue/advance run due jobs', async () => {
    const s = createManualScheduler();
    const a = vi.fn();
    const b = vi.fn();
    s.every('mod:a', 1000, a, { initialDelayMs: 5000 });
    s.every('mod:b', 300, b);
    expect(await s.runDue()).toEqual([]);
    expect(await s.advance(300)).toEqual(['mod:b']);
    expect(await s.advance(4700)).toEqual(expect.arrayContaining(['mod:a', 'mod:b']));
    expect(a).toHaveBeenCalledTimes(1);
    expect(s.jobs().find((j) => j.name === 'mod:a')?.dueAt).toBe(6000);
  });

  it('runAll runs every job regardless of time; runNow and stop work', async () => {
    const s = createManualScheduler();
    const a = vi.fn();
    const job = s.every('mod:a', 1000, a);
    await s.runAll();
    await job.runNow();
    expect(a).toHaveBeenCalledTimes(2);
    job.stop();
    expect(s.jobs()).toEqual([]);
    expect(await s.runAll()).toEqual([]);
  });

  it('reschedule moves the due time', async () => {
    const s = createManualScheduler();
    const a = vi.fn();
    const job = s.every('mod:a', 1000, a);
    job.reschedule(10);
    expect(await s.advance(10)).toEqual(['mod:a']);
  });

  it('jobs() reports job stats on the virtual clock plus dueAt and stopped', async () => {
    const s = createManualScheduler();
    s.every('mod:a', 1000, () => {
      throw new Error('nope');
    });
    await s.advance(1000);
    expect(s.jobs()).toEqual([
      {
        name: 'mod:a',
        intervalMs: 1000,
        dueAt: 2000,
        stopped: false,
        nextRunAt: 2000,
        running: false,
        runningSince: null,
        stuckForMs: null,
        overdue: false,
        runs: 1,
        failures: 1,
        consecutiveFailures: 1,
        lastStartedAt: 1000,
        lastFinishedAt: 1000,
        lastMs: 0,
        lastOk: false,
        // A library error's own text never reaches the (paired) summary: only its name does.
        lastError: { name: 'Error', code: null, message: 'Error' },
      },
    ]);
    expect(await s.idle(0)).toBe(true);
  });

  it('jobs() keeps the message of Portly errors', async () => {
    const s = createManualScheduler();
    s.every('mod:b', 1000, () => {
      throw new HttpError(502, 'provider_error', 'example.com answered 500');
    });
    await s.advance(1000);
    expect(s.jobs()[0]?.lastError).toEqual({ name: 'HttpError', code: 'provider_error', message: 'example.com answered 500' });
  });
});
