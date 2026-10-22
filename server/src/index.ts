/**
 * Server entry point (§3, §6): config → logger → port probe → db/migrate → health → pairing →
 * vault → settings → accounts → modules (app) → listeners → scheduler.
 *
 * Exit codes (lib/exit-codes.ts): 0 clean shutdown, 1 start-up failure, 3 EXIT_ALREADY_RUNNING
 * (a port is in use — the supervisor stops restarting on this code), 4 EXIT_PERMANENT_FAILURE
 * (`web/dist` is missing — the supervisor gives up after three in a row).
 *
 * Diagnostics (§17):
 * - an invalid configuration is appended to `<data dir>/logs/server.log` as one JSON line
 *   (`startup failed {phase: 'config'}`, there is no logger yet) and written to stderr;
 * - the logger comes right after the config (no console under the supervisor: a supervised
 *   server writes to stderr only for fatal output, so the supervisor's stderr tail is the crash
 *   cause), then the process handlers: until the server runs, an uncaught error or rejection is a
 *   start-up failure;
 * - every phase is timed (`Portly ready {startupMs, phases}`, debug per phase); a failing one logs
 *   `startup failed {phase, …}` and, under the supervisor, reports it over IPC before exiting;
 * - a timed verbose period saved by Settings → Diagnostics is switched back on right after the
 *   migrations, so the rest of start-up is logged verbosely too;
 * - `console.*` and Node warnings go to the log; a `status` line every 6 h and at shutdown;
 * - shutdown: stop jobs → close listeners → wait ≤ 5 s for job runs and open requests → health →
 *   database → `stopped` → close the log.
 *
 * The vault never blocks startup: an unreadable or missing key leaves it `locked` (§4.6), the
 * non-secret features keep working and Settings offers "Reset credentials".
 *
 * The steps that can be tested on their own (failure reports, console redirect, status counts,
 * the shutdown sequence) live in lib/startup.ts: importing this file starts the server.
 */
import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import { createApp, type RequestCounts } from './app.ts';
import { loadConfig, resolveDataDir, startupWarnings, type Config } from './config.ts';
import type { AppContext, AppEnv, RuntimeInfo } from './context.ts';
import { migrate } from './db/migrate.ts';
import { openDb, type Db } from './db/open.ts';
import { createMemoryCache, createSqliteCache } from './lib/cache.ts';
import { EXIT_ALREADY_RUNNING, EXIT_PERMANENT_FAILURE, EXIT_STARTUP_FAILURE, fatalText, startupFailedMessage } from './lib/exit-codes.ts';
import { createHealthRecorder, isInactiveSubject, type HealthRecorder } from './lib/health.ts';
import { createInFlightRequests, type InFlightRequests } from './lib/inflight.ts';
import { isShutdownMessage } from './lib/ipc.ts';
import { migrateFromHomebase } from './lib/legacy-homebase.ts';
import { newRunId, outsideLogContext } from './lib/log-context.ts';
import { createLogger, errorFields, type LogFields, type RootLogger } from './lib/logger.ts';
import { createScheduler, type Scheduler } from './lib/scheduler.ts';
import { createSettingsService } from './lib/settings.ts';
import {
  StartupError,
  describeLastExit,
  healthCounts,
  redirectConsole,
  reportStartupFailure,
  requireWebDist,
  startupExitCode,
  stopServer,
  type StartupFailureOutput,
} from './lib/startup.ts';
import { createAccountService } from './modules/accounts/index.ts';
import { readPersistedVerbose } from './modules/diagnostics/level.ts';
import { createPeerNames } from './lib/peer-names.ts';
import { createDeviceStore } from './security/devices.ts';
import { createPairingStore } from './security/pairing.ts';
import { createSafeFetch } from './security/safe-fetch.ts';
import { openVault } from './security/vault.ts';

export { EXIT_ALREADY_RUNNING, EXIT_PERMANENT_FAILURE, EXIT_STARTUP_FAILURE };

const CACHE_PURGE_INTERVAL_MS = 60 * 60 * 1000;
/** The `status` line (and once more at shutdown). */
const STATUS_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How long shutdown waits for job runs and open requests to finish. */
const SHUTDOWN_WAIT_MS = 5000;

/** Start-up phases (timed, except the `web-dist` check). */
type StartupPhase =
  | 'config'
  | 'logger'
  | 'web-dist'
  | 'port-probe'
  | 'legacy'
  | 'db'
  | 'migrate'
  | 'health'
  | 'pairing'
  | 'devices'
  | 'vault'
  | 'settings'
  | 'accounts'
  | 'modules'
  | 'listen';

interface Running {
  config: Config;
  log: RootLogger;
  db: Db;
  health: HealthRecorder;
  scheduler: Scheduler;
  inflight: InFlightRequests;
  requestCounts: () => RequestCounts;
  runtime: RuntimeInfo;
  servers: ServerType[];
  statusTimer: NodeJS.Timeout | null;
}

/** What exists so far: start-up failures and the process handlers act on it. */
const state: {
  phase: StartupPhase;
  log: RootLogger | null;
  supervised: boolean;
  db: Db | null;
  running: Running | null;
  failing: boolean;
} = { phase: 'config', log: null, supervised: false, db: null, running: null, failing: false };

// Captured before the console redirect: fatal output and nested console calls bypass the logger.
const writeStderr = (text: string): void => {
  try {
    process.stderr.write(text);
  } catch {
    // Nothing left to tell.
  }
};

/** Start-up facts for the Diagnostics summary (supervisor variables: `PORTLY_SUPERVISED`, `_ATTEMPT`, `_LAST_EXIT`). */
function runtimeInfo(env: NodeJS.ProcessEnv = process.env): RuntimeInfo {
  const rawAttempt = env.PORTLY_SUPERVISOR_ATTEMPT?.trim() ?? '';
  return {
    boot: newRunId(),
    startedAt: Date.now(),
    supervised: env.PORTLY_SUPERVISED === '1',
    restart: /^\d{1,6}$/.test(rawAttempt)
      ? { attempt: Number(rawAttempt), lastExit: describeLastExit(env.PORTLY_SUPERVISOR_LAST_EXIT) }
      : null,
    inflight: createInFlightRequests(),
    modules: [],
  };
}

function listen(app: Hono<AppEnv>, hostname: string, port: number): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname, port });
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

/**
 * Checks that `port` can be bound on `hostname` (the socket is closed again right away). Run
 * before the database and vault are touched, so a second instance exits with
 * EXIT_ALREADY_RUNNING without migrating, calling DPAPI or possibly quarantining the running
 * instance's key file after a transient failure.
 */
function probePort(hostname: string, port: number): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => resolve(err));
    probe.once('listening', () => probe.close(() => resolve(null)));
    probe.listen({ host: hostname, port, exclusive: true });
  });
}

// ---------------------------------------------------------------------------
// Start-up failures and process-level handlers
// ---------------------------------------------------------------------------

/** Tells the supervisor (IPC channel) why start-up failed; resolves once sent, or after 1 s. */
function reportToSupervisor(phase: string, err: unknown): Promise<void> {
  const send = process.send?.bind(process);
  if (send === undefined || !process.connected) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    try {
      send(startupFailedMessage(phase, err), undefined, undefined, () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

/**
 * Start-up failed in `phase`: logs `startup failed` (before the logger exists: a bootstrap line in
 * server.log), writes the cause to stderr when nobody else shows it, tells a supervisor, closes
 * the database and exits.
 */
async function startupFailed(phase: StartupPhase, err: unknown): Promise<void> {
  if (state.failing) return;
  state.failing = true;
  const log = state.log;
  reportStartupFailure(phase, err, failureOutput(log));
  await reportToSupervisor(phase, err);
  try {
    state.db?.close();
  } catch {
    // ignore
  }
  log?.close();
  process.exit(startupExitCode(err));
}

/** Where a start-up failure is reported: the logger (before it exists, the bootstrap line) and stderr. */
function failureOutput(log: RootLogger | null): StartupFailureOutput {
  return { log, bootstrapFile: () => path.join(resolveDataDir(), 'logs', 'server.log'), supervised: state.supervised, writeStderr };
}

/**
 * Installed right after the logger: before the server runs, an uncaught error or rejection fails
 * start-up; afterwards a rejection is logged and an uncaught exception shuts down (exit 1).
 */
function installProcessHandlers(log: RootLogger): void {
  process.on('unhandledRejection', (reason) => {
    if (state.running === null) {
      void startupFailed(state.phase, reason);
      return;
    }
    log.error('unhandled promise rejection', errorFields(reason, { stack: true }));
  });
  process.on('uncaughtException', (err) => {
    const running = state.running;
    if (running === null) {
      void startupFailed(state.phase, err);
      return;
    }
    outsideLogContext(() => {
      log.error('uncaught exception', errorFields(err, { stack: true }));
      if (state.supervised) writeStderr(fatalText('Portly: uncaught exception', err));
      void shutdown(running, EXIT_STARTUP_FAILURE, 0);
    });
  });
  process.on('warning', (warning) => {
    log.warn('node warning', { name: warning.name, code: (warning as NodeJS.ErrnoException).code, message: warning.message });
  });
}

/** A timed verbose period saved by Settings → Diagnostics, switched back on before the rest of start-up. */
function restoreVerbose(db: Db, log: RootLogger): void {
  try {
    const persisted = readPersistedVerbose(db);
    if (persisted !== null && persisted.until > Date.now()) log.setVerbose({ until: persisted.until, areas: persisted.areas });
  } catch (err) {
    log.warn('could not restore verbose logging', errorFields(err));
  }
}

// ---------------------------------------------------------------------------
// Status line and shutdown
// ---------------------------------------------------------------------------

/** `info 'status'`: uptime, job runs/failures, health by status, API answers, memory. */
function logStatus(running: Running): void {
  try {
    const now = Date.now();
    const jobs: Record<string, { runs: number; failures: number; overdue: boolean }> = {};
    for (const job of running.scheduler.jobs()) jobs[job.name] = { runs: job.runs, failures: job.failures, overdue: job.overdue };
    running.log.info('status', {
      uptimeMs: now - running.runtime.startedAt,
      jobs,
      health: healthCounts(running.health.list().filter((s) => !isInactiveSubject(s, now)), now),
      requests: running.requestCounts(),
      rssBytes: process.memoryUsage.rss(),
    });
  } catch (err) {
    running.log.warn('status line failed', errorFields(err));
  }
}

let shuttingDown = false;

/**
 * Logs a last `status` line, runs the shutdown sequence (lib/startup.ts `stopServer`: stop jobs,
 * close the listeners, wait up to `waitMs` for job runs and open requests — 0 after an uncaught
 * exception — then health, the database and the log) and exits with `code`.
 */
async function shutdown(running: Running, code: number, waitMs: number = SHUTDOWN_WAIT_MS): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (running.statusTimer !== null) clearInterval(running.statusTimer);
  // Before stopAll(): stopped jobs leave the scheduler's list.
  logStatus(running);
  await stopServer(running, code, waitMs);
  process.exit(code);
}

function installShutdown(running: Running): void {
  const onSignal = (signal: string): void => {
    running.log.info('shutting down', { signal });
    void shutdown(running, 0);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGBREAK', () => onSignal('SIGBREAK'));
  // Under the supervisor (IPC channel): a graceful stop request. On Windows signals cannot be
  // delivered to the child, so this is the only way its shutdown path runs.
  process.on('message', (message: unknown) => {
    if (isShutdownMessage(message)) onSignal('supervisor');
  });
}

/** A listener could not be started: `startup failed {phase: 'listen'}`, the supervisor told, shut down. */
async function listenFailed(running: Running, err: unknown, fields: LogFields = {}): Promise<void> {
  state.failing = true;
  reportStartupFailure('listen', err, failureOutput(running.log), fields);
  await reportToSupervisor('listen', err);
  await shutdown(running, EXIT_STARTUP_FAILURE);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const phases: Partial<Record<StartupPhase, number>> = {};
  /** Runs one start-up phase, timing it; a throw fails start-up in that phase (main's catch). */
  const timed = async <T>(phase: StartupPhase, fn: () => T | Promise<T>): Promise<T> => {
    state.phase = phase;
    const started = performance.now();
    const result = await fn();
    const ms = Math.round(performance.now() - started);
    phases[phase] = ms;
    state.log?.debug('startup phase', { phase, ms });
    return result;
  };

  const runtime = runtimeInfo();
  state.supervised = runtime.supervised;
  const config = await timed('config', () => loadConfig());

  const log = await timed('logger', () => {
    for (const dir of [config.dataDir, config.paths.logsDir, config.paths.backupsDir]) fs.mkdirSync(dir, { recursive: true });
    const logger = createLogger({ level: config.logLevel, file: config.paths.logFile, console: !runtime.supervised });
    state.log = logger;
    installProcessHandlers(logger);
    redirectConsole(logger, writeStderr);
    return logger;
  });
  log.info('starting Portly', {
    version: config.version,
    dev: config.dev,
    dataDir: config.dataDir,
    port: config.port,
    pid: process.pid,
    boot: runtime.boot,
    node: process.version,
    supervised: runtime.supervised,
    restart: runtime.restart,
  });
  for (const warning of startupWarnings(config)) log.warn(warning.message, warning.fields);

  state.phase = 'web-dist';
  requireWebDist(config.paths.webDist, config.dev);

  await timed('port-probe', async () => {
    for (const hostname of config.bindAddresses) {
      for (const port of config.remotePort === null ? [config.port] : [config.port, config.remotePort]) {
        if ((await probePort(hostname, port))?.code !== 'EADDRINUSE') continue;
        log.error('port already in use — is Portly already running?', { hostname, port });
        log.close();
        process.exit(EXIT_ALREADY_RUNNING);
      }
    }
  });

  // A pending request (install-autostart.ps1, `portly --copy-from-homebase`): copy Homebase's
  // database and vault key before the db phase creates an empty one (lib/legacy-homebase.ts).
  await timed('legacy', () =>
    migrateFromHomebase({ dataDir: config.dataDir, db: config.paths.db, vaultKey: config.paths.vaultKey }, { log }),
  );

  const db = await timed('db', () => openDb(config.paths.db));
  state.db = db;
  await timed('migrate', () => {
    const applied = migrate(db, { log });
    if (applied.length > 0) log.info('database migrated', { applied: applied.length });
  });
  restoreVerbose(db, log);
  const health = await timed('health', () => createHealthRecorder({ db, log: log.child({ component: 'health' }) }));
  const pairing = await timed('pairing', () => {
    const store = createPairingStore({ db, log: log.child({ component: 'pairing' }) });
    if (config.pagesUrl !== null) log.info('Pages site can pair with this server', { pagesUrl: config.pagesUrl });
    return store;
  });
  const devices = await timed('devices', () => {
    const store = createDeviceStore({ db, log: log.child({ component: 'devices' }) });
    if (config.remoteOrigin !== null) log.info('other PCs can connect through the remote origin', { remoteOrigin: config.remoteOrigin });
    return store;
  });
  // Only worth a process when other PCs can connect at all; otherwise every lookup answers null.
  const peerNames = createPeerNames(
    config.remoteOrigin === null ? { log, run: async () => '' } : { log: log.child({ component: 'peer-names' }) },
  );

  const vault = await timed('vault', async () => {
    const opened = await openVault({ config, db, log: log.child({ component: 'vault' }) });
    if (opened.state === 'locked') log.warn('credential vault is locked; accounts and Todoist need "Reset credentials" in Settings');
    return opened;
  });
  const { settings, fetch, cache, memo, scheduler } = await timed('settings', () => ({
    settings: createSettingsService({ db, log: log.child({ component: 'settings' }) }),
    fetch: createSafeFetch({ version: config.version, log: log.child({ component: 'fetch' }) }),
    cache: createSqliteCache(db),
    memo: createMemoryCache(),
    // Created now, but jobs only fire after their initial delays (listeners are up by then).
    scheduler: createScheduler({ log: log.child({ component: 'scheduler' }), health }),
  }));
  const accounts = await timed('accounts', () =>
    createAccountService({ config, db, vault, log: log.child({ module: 'accounts' }), fetch, health }),
  );

  const ctx: AppContext = {
    config,
    db,
    vault,
    log,
    fetch,
    cache,
    memo,
    scheduler,
    settings,
    accounts,
    pairing,
    devices,
    peerNames,
    logs: log,
    health,
    runtime,
  };
  const created = await timed('modules', () => createApp(ctx));
  const failed = created.modules.filter((m) => !m.ok).map((m) => m.name);
  if (failed.length > 0) log.warn('some modules are unavailable', { modules: failed });

  const running: Running = {
    config,
    log,
    db,
    health,
    scheduler,
    inflight: runtime.inflight,
    requestCounts: created.requestCounts,
    runtime,
    servers: [],
    statusTimer: null,
  };
  installShutdown(running);

  state.phase = 'listen';
  const listenStarted = performance.now();
  // The main port, then the remote port (other PCs, through the reverse proxy) when configured.
  const ports = config.remotePort === null ? [config.port] : [config.port, config.remotePort];
  for (const port of ports) {
    let listeners = 0;
    for (const hostname of config.bindAddresses) {
      try {
        const server = await listen(created.app, hostname, port);
        running.servers.push(server);
        listeners += 1;
        const addr = server.address() as AddressInfo | null;
        log.info('listening', { address: addr ? `${addr.address}:${addr.port}` : `${hostname}:${port}`, remote: port === config.remotePort || undefined });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EADDRINUSE') {
          log.error('port already in use — is Portly already running?', { hostname, port });
          await shutdown(running, EXIT_ALREADY_RUNNING);
          return;
        }
        if ((code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') && hostname.includes(':')) {
          log.warn('IPv6 loopback unavailable; continuing IPv4-only', { hostname, code });
          continue;
        }
        await listenFailed(running, err, { hostname, port });
        return;
      }
    }
    if (listeners === 0) {
      await listenFailed(running, new StartupError('no_listener', 'No listener could be started'), { port });
      return;
    }
  }
  phases.listen = Math.round(performance.now() - listenStarted);
  log.debug('startup phase', { phase: 'listen', ms: phases.listen });

  state.running = running;
  scheduler.every('core:cache-purge', CACHE_PURGE_INTERVAL_MS, () => cache.purgeExpired());
  // Outside any context: the interval outlives start-up.
  running.statusTimer = outsideLogContext(() => setInterval(() => logStatus(running), STATUS_INTERVAL_MS));
  running.statusTimer.unref();
  log.info('Portly ready', {
    url: config.origin,
    app: config.appOrigin,
    remote: config.remoteOrigin ?? undefined,
    remotePort: config.remotePort ?? undefined,
    startupMs: Math.round(performance.now()),
    phases,
  });
}

main().catch((err: unknown) => startupFailed(state.phase, err));
