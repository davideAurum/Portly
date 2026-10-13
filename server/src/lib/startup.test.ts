import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_PERMANENT_FAILURE, EXIT_STARTUP_FAILURE } from './exit-codes.ts';
import { createInFlightRequests } from './inflight.ts';
import { createMemoryLogger, type LogFields, type Logger } from './logger.ts';
import {
  MAX_CONSOLE_TEXT,
  MAX_LAST_EXIT,
  StartupError,
  describeLastExit,
  healthCounts,
  redirectConsole,
  reportStartupFailure,
  requireWebDist,
  startupExitCode,
  stopServer,
  waitForRequests,
  type ClosableServer,
  type ConsoleMethods,
  type StoppableServer,
} from './startup.ts';

const noop = (): void => {};

describe('start-up failures', () => {
  it('web/dist: missing in production is a permanent failure with its own code; dev mode never checks', () => {
    const missing = (): boolean => false;
    let thrown: unknown;
    try {
      requireWebDist('/repo/web/dist', false, missing);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StartupError);
    expect(thrown).toMatchObject({ code: 'web_dist_missing', exitCode: EXIT_PERMANENT_FAILURE, fields: { webDist: '/repo/web/dist' } });
    expect(startupExitCode(thrown)).toBe(EXIT_PERMANENT_FAILURE);
    expect(() => requireWebDist('/repo/web/dist', true, missing)).not.toThrow();
    const seen: string[] = [];
    requireWebDist('/repo/web/dist', false, (file) => (seen.push(file), true));
    expect(seen).toEqual([path.join('/repo/web/dist', 'index.html')]);
  });

  it('any other error exits with EXIT_STARTUP_FAILURE', () => {
    expect(startupExitCode(new Error('x'))).toBe(EXIT_STARTUP_FAILURE);
    expect(startupExitCode('text')).toBe(EXIT_STARTUP_FAILURE);
    expect(startupExitCode(new StartupError('no_listener', 'No listener could be started'))).toBe(EXIT_STARTUP_FAILURE);
  });

  it('logs `startup failed` with the phase and the StartupError fields; stderr only when supervised (no console)', () => {
    for (const supervised of [false, true]) {
      const log = createMemoryLogger();
      const stderr: string[] = [];
      const err = new StartupError('web_dist_missing', 'web/dist is missing', { exitCode: EXIT_PERMANENT_FAILURE, fields: { webDist: '/w' } });
      reportStartupFailure('web-dist', err, { log, bootstrapFile: () => 'unused', supervised, writeStderr: (t) => void stderr.push(t) }, { extra: 1 });
      expect(log.lines).toHaveLength(1);
      expect(log.lines[0]).toMatchObject({
        level: 'error',
        message: 'startup failed',
        fields: { phase: 'web-dist', errName: 'StartupError', errMessage: 'web/dist is missing', webDist: '/w', extra: 1 },
      });
      expect(stderr.length).toBe(supervised ? 1 : 0);
      if (supervised) expect(stderr[0]).toMatch(/^Portly: startup failed \(web-dist\): StartupError/);
    }
  });

  it('before the logger exists: a bootstrap line in server.log and the fatal text on stderr', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-startup-'));
    try {
      const file = path.join(dir, 'logs', 'server.log');
      const stderr: string[] = [];
      reportStartupFailure('config', new Error('PORTLY_PORT must be an integer 1-65535 (got "x")'), {
        log: null,
        bootstrapFile: () => file,
        supervised: false,
        writeStderr: (t) => void stderr.push(t),
      });
      expect(JSON.parse(fs.readFileSync(file, 'utf8').trim())).toMatchObject({ lvl: 'error', msg: 'startup failed', phase: 'config' });
      expect(stderr).toHaveLength(1);
      expect(stderr[0]).toMatch(/^Portly: startup failed \(config\): Error: PORTLY_PORT/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('describes the supervisor’s last exit in one scrubbed line', () => {
    expect(describeLastExit(undefined)).toBeNull();
    expect(describeLastExit('  ')).toBeNull();
    expect(describeLastExit(JSON.stringify({ code: 1, signal: null }))).toBe('exit code 1');
    expect(
      describeLastExit(
        JSON.stringify({ code: 1, signal: null, failure: { phase: 'db', errName: 'Error', errCode: 'ERR_SQLITE_ERROR', sqliteCode: 5, message: 'database is locked' } }),
      ),
    ).toBe('exit code 1; phase db: ERR_SQLITE_ERROR sqlite 5 database is locked');
    expect(describeLastExit(JSON.stringify({ code: null, signal: 'SIGKILL' }))).toBe('signal SIGKILL');
    const text = describeLastExit('crashed\nat C:\\Users\\someone\\x.ts with Bearer abc.def.ghi') ?? '';
    expect(text).not.toMatch(/\n|someone|abc\.def\.ghi/);
    expect(describeLastExit('x'.repeat(1000))).toHaveLength(MAX_LAST_EXIT);
  });
});

describe('redirectConsole', () => {
  const fakeConsole = (): ConsoleMethods => ({ debug: noop, log: noop, info: noop, warn: noop, error: noop });

  it('sends console.* to the log at debug/warn/error, formatted and cut to 2 KB', () => {
    const log = createMemoryLogger();
    const target = fakeConsole();
    redirectConsole(log, () => {}, target);
    target.log('a %s %d', 'b', 1);
    target.info('info');
    target.debug('debug');
    target.warn('careful');
    target.error(new Error('boom').message);
    target.log('y'.repeat(5000));
    expect(log.lines.map((l) => [l.level, l.message, l.fields?.component, l.fields?.text])).toEqual([
      ['debug', 'console', 'console', 'a b 1'],
      ['debug', 'console', 'console', 'info'],
      ['debug', 'console', 'console', 'debug'],
      ['warn', 'console', 'console', 'careful'],
      ['error', 'console', 'console', 'boom'],
      ['debug', 'console', 'console', `${'y'.repeat(MAX_CONSOLE_TEXT - 1)}…`],
    ]);
  });

  it('a console call made while one is being logged goes to stderr (scrubbed), not back into the logger', () => {
    const target = fakeConsole();
    const lines: string[] = [];
    // A logger whose sink itself writes to the (redirected) console.
    const logger: Logger = {
      debug: noop,
      info: noop,
      warn: (message: string, fields?: LogFields) => {
        lines.push(String(fields?.text));
        target.error('nested with Bearer abc.def.ghi');
      },
      error: (message: string, fields?: LogFields) => void lines.push(String(fields?.text)),
      child: () => logger,
    };
    const stderr: string[] = [];
    redirectConsole(logger, (t) => void stderr.push(t), target);
    target.warn('outer');
    expect(lines).toEqual(['outer']);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^nested with /);
    expect(stderr[0]).not.toContain('abc.def.ghi');
    // Back to normal once the outer call is done.
    target.error('later');
    expect(lines).toEqual(['outer', 'later']);
    expect(stderr).toHaveLength(1);
  });

  it('a logger that throws does not leave the redirect stuck on stderr', () => {
    const target = fakeConsole();
    let fail = true;
    const seen: string[] = [];
    const logger: Logger = {
      debug: (message: string, fields?: LogFields) => {
        if (fail) throw new Error('sink failed');
        seen.push(String(fields?.text));
      },
      info: noop,
      warn: noop,
      error: noop,
      child: () => logger,
    };
    const stderr: string[] = [];
    redirectConsole(logger, (t) => void stderr.push(t), target);
    expect(() => target.log('first')).toThrow('sink failed');
    fail = false;
    target.log('second');
    expect(seen).toEqual(['second']);
    expect(stderr).toEqual([]);
  });
});

describe('healthCounts (status line)', () => {
  it('counts subjects by status, a job-driven subject past its expected interval as stale whatever its status', () => {
    const now = 1_000_000;
    const counts = healthCounts(
      [
        { status: 'ok', expectEveryMs: 60_000, lastCheckedAt: now - 30_000 },
        { status: 'ok', expectEveryMs: 60_000, lastCheckedAt: now - 60_001 },
        { status: 'failing', expectEveryMs: 60_000, lastCheckedAt: now - 120_000 },
        { status: 'failing', expectEveryMs: null, lastCheckedAt: now - 10 * 60_000_000 },
        { status: 'degraded', expectEveryMs: null, lastCheckedAt: now },
        // Never checked yet: not stale, its own status.
        { status: 'unknown', expectEveryMs: 60_000, lastCheckedAt: null },
      ],
      now,
    );
    expect(counts).toEqual({ ok: 1, degraded: 1, failing: 1, stale: 2, unknown: 1 });
    expect(healthCounts([], now)).toEqual({ ok: 0, degraded: 0, failing: 0, stale: 0, unknown: 0 });
  });
});

describe('waitForRequests', () => {
  it('returns 0 as soon as the open requests finish', async () => {
    const inflight = createInFlightRequests();
    const done = inflight.start('rid0000000', 'GET', '/api/x');
    setTimeout(done, 40);
    const started = Date.now();
    expect(await waitForRequests(inflight, Date.now() + 5_000)).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('returns how many are still open once the deadline passed', async () => {
    const inflight = createInFlightRequests();
    inflight.start('rid0000001', 'GET', '/api/a');
    inflight.start('rid0000002', 'POST', '/api/b');
    expect(await waitForRequests(inflight, Date.now() - 1)).toBe(2);
    expect(await waitForRequests(inflight, Date.now() + 60)).toBe(2);
  });
});

describe('stopServer (shutdown sequence)', () => {
  const setup = (opts: { idle?: boolean; open?: number; dbThrows?: boolean } = {}) => {
    const steps: string[] = [];
    const server = (name: string): ClosableServer => ({
      close(callback) {
        steps.push(`${name}.close`);
        setTimeout(() => {
          steps.push(`${name}.closed`);
          callback();
        }, 10);
      },
      closeAllConnections: () => void steps.push(`${name}.closeAllConnections`),
    });
    const parts: StoppableServer = {
      log: {
        info: (message: string, fields?: LogFields) => void steps.push(`log ${message} ${JSON.stringify(fields)}`),
        close: () => void steps.push('log.close'),
      },
      scheduler: {
        stopAll: () => void steps.push('scheduler.stopAll'),
        idle: async (ms: number) => {
          steps.push(`scheduler.idle ${ms}`);
          return opts.idle ?? true;
        },
      },
      servers: [server('a'), server('b')],
      inflight: { count: () => opts.open ?? 0 },
      health: { close: () => void steps.push('health.close') },
      db: {
        close: () => {
          steps.push('db.close');
          if (opts.dbThrows) throw new Error('database is locked');
        },
      },
    };
    return { steps, parts };
  };

  it('stops jobs → closes the listeners → waits for job runs → health → database → `stopped` → closes the log', async () => {
    const { steps, parts } = setup();
    await stopServer(parts, 0, 5_000);
    expect(steps).toEqual([
      'scheduler.stopAll',
      'a.close',
      'a.closeAllConnections',
      'b.close',
      'b.closeAllConnections',
      'a.closed',
      'b.closed',
      'scheduler.idle 5000',
      'health.close',
      'db.close',
      'log stopped {"exitCode":0,"waitedForJobs":true}',
      'log.close',
    ]);
  });

  it('reports job runs and requests still open after the wait, and still closes the log when the database fails to close', async () => {
    const { steps, parts } = setup({ idle: false, open: 2, dbThrows: true });
    await stopServer(parts, EXIT_STARTUP_FAILURE, 0);
    expect(steps.slice(-4)).toEqual(['health.close', 'db.close', `log stopped {"exitCode":${EXIT_STARTUP_FAILURE},"waitedForJobs":false,"openRequests":2}`, 'log.close']);
  });
});
