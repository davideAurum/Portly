import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT_ALREADY_RUNNING,
  EXIT_PERMANENT_FAILURE,
  fatalText,
  parseStartupFailure,
  startupFailedMessage,
  writeBootstrapFailure,
} from './lib/exit-codes.ts';
import { createMemoryLogger } from './lib/logger.ts';
import {
  BACKOFF_SCHEDULE_MS,
  CRASH_LOOP_RUNS,
  PERMANENT_FAILURE_LIMIT,
  STABLE_UPTIME_MS,
  STDERR_TAIL_BYTES,
  STDERR_TAIL_LINES,
  createLineTail,
  decideRestart,
  startSupervisor,
} from './supervisor.ts';

describe('decideRestart (pure backoff policy)', () => {
  const crash = (uptimeMs = 5_000) => ({ code: 1, signal: null, uptimeMs });

  it('walks 1 s, 2 s, 5 s, 10 s, 30 s, 60 s and stays capped at 60 s', () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 60_000]);
    let attempt = 0;
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      const d = decideRestart(attempt, crash());
      if (d.action !== 'restart') throw new Error('expected a restart');
      delays.push(d.delayMs);
      attempt = d.attempt;
    }
    expect(delays).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 60_000, 60_000, 60_000]);
  });

  it('resets the backoff after a run of at least 10 minutes', () => {
    expect(decideRestart(7, crash(STABLE_UPTIME_MS))).toEqual({ action: 'restart', delayMs: 1_000, attempt: 1 });
    expect(decideRestart(7, crash(STABLE_UPTIME_MS - 1))).toEqual({ action: 'restart', delayMs: 60_000, attempt: 8 });
  });

  it('stops on exit code 3 (already running) and restarts on signals / other codes', () => {
    expect(decideRestart(0, { code: EXIT_ALREADY_RUNNING, signal: null, uptimeMs: 100 })).toEqual({ action: 'stop', reason: 'already-running' });
    expect(decideRestart(0, { code: 0, signal: null, uptimeMs: 100 })).toMatchObject({ action: 'restart', delayMs: 1_000 });
    expect(decideRestart(2, { code: null, signal: 'SIGKILL', uptimeMs: 100 })).toMatchObject({ action: 'restart', delayMs: 5_000 });
  });
});

describe('startSupervisor (spawns a fake child)', () => {
  let dir: string;
  let counter: string;
  let script: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-supervisor-'));
    counter = path.join(dir, 'runs.txt');
    script = path.join(dir, 'child.mjs');
    // Exits with the code for its run number; the last code repeats.
    fs.writeFileSync(
      script,
      `import fs from 'node:fs';
       const [counter, codes, mode] = process.argv.slice(2);
       fs.appendFileSync(counter, 'run\\n');
       const runs = fs.readFileSync(counter, 'utf8').trim().split('\\n').length;
       const list = codes.split(',').map(Number);
       if (mode === 'hang') { setInterval(() => {}, 1000); }
       else process.exit(list[Math.min(runs, list.length) - 1]);`,
    );
  });
  // A just-killed child can hold the directory open for a moment on Windows (EPERM): retry.
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

  it('restarts crashed children with backoff and stops on exit code 3', async () => {
    const log = createMemoryLogger();
    const started = Date.now();
    const supervisor = startSupervisor({ log, args: [script, counter, '1,2,3'], cwd: dir, schedule: [20, 40] });
    const code = await supervisor.done;
    expect(code).toBe(0);
    expect(supervisor.starts).toBe(3);
    expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    const restarts = log.lines.filter((l) => l.message === 'server exited; restarting').map((l) => [l.fields?.code, l.fields?.delayMs]);
    expect(restarts).toEqual([
      [1, 20],
      [2, 40],
    ]);
    expect(log.lines.some((l) => l.message.includes('already running'))).toBe(true);
    expect(supervisor.childPid).toBeNull();
  }, 20_000);

  it('forwards a stop signal to the running child and exits once it is gone', async () => {
    const log = createMemoryLogger();
    const supervisor = startSupervisor({ log, args: [script, counter, '0', 'hang'], cwd: dir, stopTimeoutMs: 2_000 });
    // Wait until the child has actually started.
    for (let i = 0; i < 200 && !fs.existsSync(counter); i++) await new Promise((r) => setTimeout(r, 25));
    const pid = supervisor.childPid;
    expect(pid).not.toBeNull();
    const code = await supervisor.stop('SIGTERM');
    expect(code).toBe(0);
    expect(supervisor.starts).toBe(1);
    expect(() => process.kill(pid!, 0)).toThrow();
    expect(log.lines.some((l) => l.message === 'server stopped')).toBe(true);
  }, 20_000);

  it('asks the child to shut down gracefully over IPC, so its own shutdown path runs (Windows kill() cannot)', async () => {
    const graceful = path.join(dir, 'graceful.mjs');
    const marker = path.join(dir, 'stopped.txt');
    fs.writeFileSync(
      graceful,
      `import fs from 'node:fs';
       const [marker, started] = process.argv.slice(2);
       const keepAlive = setInterval(() => {}, 1000);
       process.on('message', (m) => {
         if (m && m.type === 'shutdown') { fs.writeFileSync(marker, 'graceful'); clearInterval(keepAlive); process.exit(0); }
       });
       fs.writeFileSync(started, 'up');`,
    );
    const started = path.join(dir, 'started.txt');
    const log = createMemoryLogger();
    const supervisor = startSupervisor({ log, args: [graceful, marker, started], cwd: dir, stopTimeoutMs: 10_000 });
    for (let i = 0; i < 200 && !fs.existsSync(started); i++) await new Promise((r) => setTimeout(r, 25));
    const t0 = Date.now();
    expect(await supervisor.stop('SIGTERM')).toBe(0);
    expect(fs.readFileSync(marker, 'utf8')).toBe('graceful');
    // Well before the forced kill.
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(log.lines.some((l) => l.message.includes('killing'))).toBe(false);
  }, 20_000);

  it('treats a failed spawn as a crash and can be stopped while waiting to restart', async () => {
    const log = createMemoryLogger();
    const supervisor = startSupervisor({ log, command: path.join(dir, 'no-such-node.exe'), args: [], cwd: dir, schedule: [60_000] });
    for (let i = 0; i < 200 && !log.lines.some((l) => l.message === 'server exited; restarting'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(log.lines.some((l) => l.message === 'could not start the server process')).toBe(true);
    expect(await supervisor.stop()).toBe(0);
    expect(supervisor.starts).toBe(1);
  }, 20_000);

  it.runIf(process.platform === 'win32')('takes the server down with it when the supervisor process is killed (Windows job object)', async () => {
    const server = path.join(dir, 'server.mjs');
    const pidFile = path.join(dir, 'server.pid');
    fs.writeFileSync(server, `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`);
    // Runs the real supervisor in its own process, so that process can be killed outright.
    const runner = path.join(dir, 'runner.mjs');
    fs.writeFileSync(
      runner,
      `const [supervisorUrl, loggerUrl, server, pidFile] = process.argv.slice(2);
       const { startSupervisor } = await import(supervisorUrl);
       const { createSilentLogger } = await import(loggerUrl);
       startSupervisor({ log: createSilentLogger(), args: [server, pidFile], cwd: process.cwd() });`,
    );
    const moduleUrl = (file: string) => pathToFileURL(path.join(import.meta.dirname, file)).href;
    const proc = spawn(process.execPath, [runner, moduleUrl('supervisor.ts'), moduleUrl('lib/logger.ts'), server, pidFile], {
      cwd: dir,
      stdio: 'ignore',
      windowsHide: true,
    });
    const exited = new Promise((r) => proc.once('exit', r));
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const readPid = (): number => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0);
    let serverPid = 0;
    try {
      for (let i = 0; i < 400 && !(readPid() > 0); i++) await new Promise((r) => setTimeout(r, 25));
      serverPid = readPid();
      expect(serverPid).toBeGreaterThan(0);
      expect(isAlive(serverPid)).toBe(true);
      // TerminateProcess: the supervisor gets no chance to stop its child itself.
      proc.kill('SIGKILL');
      await exited;
      for (let i = 0; i < 200 && isAlive(serverPid); i++) await new Promise((r) => setTimeout(r, 25));
      expect(isAlive(serverPid)).toBe(false);
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      if (serverPid > 0 && isAlive(serverPid)) process.kill(serverPid, 'SIGKILL');
    }
  }, 20_000);
});

describe('decideRestart: permanent failures (exit code 4)', () => {
  const permanent = { code: EXIT_PERMANENT_FAILURE, signal: null, uptimeMs: 200 };

  it(`restarts after the first ${PERMANENT_FAILURE_LIMIT - 1} and stops at the ${PERMANENT_FAILURE_LIMIT}th in a row`, () => {
    expect(decideRestart(0, permanent, BACKOFF_SCHEDULE_MS, STABLE_UPTIME_MS, 0)).toMatchObject({ action: 'restart' });
    expect(decideRestart(1, permanent, BACKOFF_SCHEDULE_MS, STABLE_UPTIME_MS, PERMANENT_FAILURE_LIMIT - 2)).toMatchObject({ action: 'restart' });
    expect(decideRestart(2, permanent, BACKOFF_SCHEDULE_MS, STABLE_UPTIME_MS, PERMANENT_FAILURE_LIMIT - 1)).toEqual({ action: 'stop', reason: 'permanent-failure' });
    // Another exit code in between starts the count over (the caller resets it).
    expect(decideRestart(2, { ...permanent, code: 1 }, BACKOFF_SCHEDULE_MS, STABLE_UPTIME_MS, PERMANENT_FAILURE_LIMIT - 1)).toMatchObject({ action: 'restart' });
  });
});

describe('createLineTail (the child stderr tail)', () => {
  it('joins lines split across chunks, skips empty ones and keeps a trailing partial line', () => {
    const tail = createLineTail();
    tail.push('first li');
    tail.push('ne\r\n\nsecond line\nthird');
    expect(tail.lines()).toEqual(['first line', 'second line', 'third']);
  });

  it(`keeps at most ${STDERR_TAIL_LINES} lines and ${STDERR_TAIL_BYTES} characters, newest last`, () => {
    const tail = createLineTail();
    for (let i = 0; i < 100; i++) tail.push(`line ${i}\n`);
    const lines = tail.lines();
    expect(lines).toHaveLength(STDERR_TAIL_LINES);
    expect(lines.at(-1)).toBe('line 99');
    const big = createLineTail();
    for (let i = 0; i < 30; i++) big.push(`${String(i).padStart(3, '0')}${'x'.repeat(997)}\n`);
    expect(big.lines().join('').length).toBeLessThanOrEqual(STDERR_TAIL_BYTES);
    expect(big.lines().at(-1)?.startsWith('029')).toBe(true);
  });

  it('scrubs secrets and user paths', () => {
    const tail = createLineTail();
    tail.push('Authorization: Bearer abc.def.ghi\n    at run (C:\\Users\\someone\\Homebase\\server\\src\\index.ts:1:1)\n');
    const text = tail.lines().join('\n');
    expect(text).not.toContain('abc.def.ghi');
    expect(text).not.toContain('someone');
  });
});

describe('startSupervisor: diagnostics (fake children)', () => {
  let dir: string;
  let counter: string;
  let envFile: string;
  let script: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-supervisor-'));
    counter = path.join(dir, 'runs.txt');
    envFile = path.join(dir, 'env.jsonl');
    script = path.join(dir, 'child.mjs');
    // Records its environment, writes fatal-looking stderr, reports a start-up failure over IPC
    // when `failure` is `yes` for its run number, then exits with the code for its run number (in
    // both lists the last entry repeats).
    fs.writeFileSync(
      script,
      `import fs from 'node:fs';
       const [counter, codes, envFile, failure] = process.argv.slice(2);
       fs.appendFileSync(counter, 'run\\n');
       const runs = fs.readFileSync(counter, 'utf8').trim().split('\\n').length;
       const list = codes.split(',').map(Number);
       const code = list[Math.min(runs, list.length) - 1];
       const failures = failure.split(',');
       const fails = failures[Math.min(runs, failures.length) - 1] === 'yes';
       fs.appendFileSync(envFile, JSON.stringify({
         supervised: process.env.HOMEBASE_SUPERVISED ?? null,
         attempt: process.env.HOMEBASE_SUPERVISOR_ATTEMPT ?? null,
         lastExit: process.env.HOMEBASE_SUPERVISOR_LAST_EXIT ?? null,
       }) + '\\n');
       process.stderr.write('Homebase: startup failed (db): Error[SQLITE_BUSY]: database is locked\\n    at open (C:\\\\Users\\\\someone\\\\db.ts:1:1)\\n');
       const exit = () => setTimeout(() => process.exit(code), 20);
       if (fails && process.send) {
         process.send({ type: 'startup-failed', phase: 'db', errName: 'Error', errCode: 'SQLITE_BUSY', message: 'database is locked' }, exit);
       } else exit();`,
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

  const envs = (): { supervised: string | null; attempt: string | null; lastExit: string | null }[] =>
    fs
      .readFileSync(envFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { supervised: string | null; attempt: string | null; lastExit: string | null });

  it('tells the child it is supervised, and on restarts the attempt and how the last run ended (incl. its IPC failure)', async () => {
    const log = createMemoryLogger();
    const supervisor = startSupervisor({
      log,
      args: [script, counter, '1,1,3', envFile, 'yes'],
      cwd: dir,
      schedule: [10, 10],
      env: { ...process.env, HOMEBASE_SUPERVISOR_ATTEMPT: '99', HOMEBASE_SUPERVISOR_LAST_EXIT: 'stale' },
    });
    expect(await supervisor.done).toBe(0);
    const runs = envs();
    expect(runs.map((r) => [r.supervised, r.attempt])).toEqual([
      ['1', null],
      ['1', '1'],
      ['1', '2'],
    ]);
    expect(runs[0]?.lastExit).toBeNull();
    expect(JSON.parse(runs[1]?.lastExit ?? 'null')).toEqual({
      code: 1,
      signal: null,
      failure: { phase: 'db', errName: 'Error', errCode: 'SQLITE_BUSY', message: 'database is locked' },
    });

    const restart = log.lines.find((l) => l.message === 'server exited; restarting');
    expect(restart?.fields).toMatchObject({ code: 1, attempt: 1, lastFailure: { phase: 'db', errCode: 'SQLITE_BUSY' } });
    const tail = restart?.fields?.stderrTail as string[];
    expect(tail[0]).toBe('Homebase: startup failed (db): Error[SQLITE_BUSY]: database is locked');
    expect(tail.join('\n')).not.toContain('someone');
  }, 20_000);

  it(`logs a crash loop once after ${CRASH_LOOP_RUNS} short runs in a row`, async () => {
    const log = createMemoryLogger();
    const supervisor = startSupervisor({ log, args: [script, counter, '1,1,1,1,1,1,3', envFile, 'no'], cwd: dir, schedule: [5] });
    expect(await supervisor.done).toBe(0);
    expect(log.lines.filter((l) => l.message === 'server exited; restarting')).toHaveLength(6);
    const loops = log.lines.filter((l) => l.message === 'server keeps crashing at start-up');
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ level: 'error', fields: { attempts: CRASH_LOOP_RUNS, lastExit: { code: 1, signal: null } } });
    expect((loops[0]?.fields?.stderrTail as string[]).length).toBeGreaterThan(0);
  }, 20_000);

  it("reports the latest run's start-up failure, never an earlier run's, in the crash-loop line", async () => {
    const log = createMemoryLogger();
    // Run 1 reports a failure over IPC; runs 2–5 crash without one.
    const supervisor = startSupervisor({ log, args: [script, counter, '1,1,1,1,1,3', envFile, 'yes,no'], cwd: dir, schedule: [5] });
    expect(await supervisor.done).toBe(0);
    const restarts = log.lines.filter((l) => l.message === 'server exited; restarting');
    expect(restarts.map((l) => (l.fields?.lastFailure as { errCode?: string } | null)?.errCode ?? null)).toEqual(['SQLITE_BUSY', null, null, null, null]);
    const loop = log.lines.find((l) => l.message === 'server keeps crashing at start-up');
    expect(loop?.fields).toMatchObject({ lastFailure: null, lastExit: { code: 1, signal: null } });
    expect(loop?.fields?.lastExit).not.toHaveProperty('failure');
  }, 20_000);

  it('starts the exit-code-4 count over after any other exit code', async () => {
    const log = createMemoryLogger();
    // 4, 4, then 1 breaks the streak: 4, 4 again is no third in a row; 3 (already running) ends it.
    const supervisor = startSupervisor({ log, args: [script, counter, '4,4,1,4,4,3', envFile, 'no'], cwd: dir, schedule: [5] });
    expect(await supervisor.done).toBe(0);
    expect(supervisor.starts).toBe(6);
    expect(log.lines.some((l) => l.message === 'server cannot start; not restarting')).toBe(false);
    expect(log.lines.filter((l) => l.message === 'server exited; restarting').map((l) => l.fields?.code)).toEqual([4, 4, 1, 4, 4]);
  }, 30_000);

  it('reports a second crash loop after a run that stayed up (the loop report re-arms)', async () => {
    const log = createMemoryLogger();
    // Runs 1–5 and 7–11 crash at once; run 6 stays up past the crash-loop threshold: the clock
    // jumps while it runs (the child records each run in `counter` when it starts).
    const runsStarted = (): number => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').length : 0);
    const now = (): number => Date.now() + (runsStarted() >= 6 ? 61_000 : 0);
    const supervisor = startSupervisor({ log, args: [script, counter, '1,1,1,1,1,1,1,1,1,1,1,3', envFile, 'no'], cwd: dir, schedule: [5], now });
    expect(await supervisor.done).toBe(0);
    expect(supervisor.starts).toBe(12);
    const restarts = log.lines.filter((l) => l.message === 'server exited; restarting');
    expect(restarts.map((l) => (l.fields?.uptimeMs as number) >= 60_000)).toEqual([false, false, false, false, false, true, false, false, false, false, false]);
    const loops = log.lines.filter((l) => l.message === 'server keeps crashing at start-up');
    expect(loops).toHaveLength(2);
    expect(loops.map((l) => l.fields?.attempts)).toEqual([CRASH_LOOP_RUNS, CRASH_LOOP_RUNS]);
  }, 30_000);

  it(`gives up after exit code 4 (cannot start) ${PERMANENT_FAILURE_LIMIT} times in a row and exits with 4`, async () => {
    const log = createMemoryLogger();
    const supervisor = startSupervisor({ log, args: [script, counter, '4', envFile, 'yes'], cwd: dir, schedule: [5] });
    expect(await supervisor.done).toBe(EXIT_PERMANENT_FAILURE);
    expect(supervisor.starts).toBe(PERMANENT_FAILURE_LIMIT);
    const stop = log.lines.find((l) => l.message === 'server cannot start; not restarting');
    expect(stop).toMatchObject({ level: 'error', fields: { code: 4, attempts: PERMANENT_FAILURE_LIMIT, lastFailure: { phase: 'db' } } });
  }, 20_000);
});

describe('exit-codes: start-up failure reports', () => {
  it('builds and re-validates the IPC message (codes and a scrubbed message only)', () => {
    const err = Object.assign(new Error('cannot open C:\\Users\\someone\\AppData\\Local\\Homebase\\homebase.db (Bearer abc.def.ghi)'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 5,
    });
    const message = startupFailedMessage('db', err);
    expect(message).toMatchObject({ type: 'startup-failed', phase: 'db', errName: 'Error', errCode: 'ERR_SQLITE_ERROR', sqliteCode: 5 });
    expect(message.message).not.toMatch(/someone|abc\.def\.ghi/);
    expect(parseStartupFailure(message)).toEqual({ phase: 'db', errName: 'Error', errCode: 'ERR_SQLITE_ERROR', sqliteCode: 5, message: message.message });
    expect(parseStartupFailure({ type: 'shutdown' })).toBeNull();
    expect(parseStartupFailure({ type: 'startup-failed', phase: 'DROP TABLE' })).toBeNull();
    expect(parseStartupFailure({ type: 'startup-failed', phase: 'db', errName: 'x y z', message: 'token=abc123 at C:\\Users\\someone\\x' })).toEqual({
      phase: 'db',
      message: expect.not.stringMatching(/abc123|someone/),
    });
  });

  it('writes a bootstrap line in the log file format', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-bootstrap-'));
    try {
      const file = path.join(dir, 'logs', 'supervisor.log');
      writeBootstrapFailure(file, 'config', new Error('HOMEBASE_PORT must be an integer 1-65535 (got "x")'), { src: 'supervisor' });
      const line = JSON.parse(fs.readFileSync(file, 'utf8').trim()) as Record<string, unknown>;
      expect(line).toMatchObject({ lvl: 'error', msg: 'startup failed', src: 'supervisor', area: 'server', phase: 'config', errName: 'Error' });
      expect(typeof line.t).toBe('string');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fatal stderr text: the error and its frame lines, never the stack header', () => {
    const err = new Error('secret token=abc123 in the message');
    const text = fatalText('Homebase: startup failed (db)', err);
    expect(text.split('\n')[0]).toMatch(/^Homebase: startup failed \(db\): Error: /);
    expect(text).not.toContain('abc123');
    expect(text.split('\n').slice(1, -1).every((line) => line.startsWith('    at '))).toBe(true);
  });
});
