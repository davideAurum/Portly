/**
 * Test harness (§13): `createTestContext(overrides?)` → a complete AppContext with
 * - a `:memory:` database with every migration applied,
 * - an in-memory vault: the real AES-256-GCM engine over a Map with a fixed test key (no DPAPI,
 *   nothing persisted; `ctx.vault.setState('locked')` simulates a locked vault),
 * - safe-fetch over a fake transport (`fetchRoutes`; unmatched URLs fail the test),
 * - a FakeAccountService (canned tokens and secrets; pass `accounts` seeds or your own service),
 * - a manual scheduler (`runDue()`, `advance(ms)`, `runAll()`),
 * - one test logger (`createTestLogger()`: no file, no console) used as both `log` and `logs`, so
 *   `ctx.logs.query()` sees what modules log; pass `log: createMemoryLogger()` to assert on lines
 *   (then `logs` is a separate test logger), or `logs` alone to use that hub as `log` too,
 * - the real health tracker over that database, and a runtime (fresh in-flight registry, no
 *   modules until `createApp` fills them),
 * - the real pairing store over that database (`now` overridable).
 */
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config.ts';
import { loadConfig } from '../config.ts';
import type { AccountService, AppContext } from '../context.ts';
import { migrate } from '../db/migrate.ts';
import { openDb, type Db } from '../db/open.ts';
import { newId } from '../lib/ids.ts';
import { createMemoryCache, createSqliteCache } from '../lib/cache.ts';
import { createHealthRecorder } from '../lib/health.ts';
import { createInFlightRequests } from '../lib/inflight.ts';
import { newRunId } from '../lib/log-context.ts';
import { createTestLogger, type LogHub, type Logger } from '../lib/logger.ts';
import { createManualScheduler, type ManualScheduler } from '../lib/scheduler.ts';
import { createSettingsService } from '../lib/settings.ts';
import { createPairingStore } from '../security/pairing.ts';
import { createSafeFetch, type SafeFetch } from '../security/safe-fetch.ts';
import { createMemoryVault, type MemoryVault } from '../security/vault.ts';
import { createFakeAccountService, type FakeAccountSeed } from './fake-accounts.ts';
import { createFakeFetch, type FakeFetch, type FakeFetchRoute } from './fake-fetch.ts';

export interface TestContextOverrides {
  /** Environment used to build the config (defaults: port 5757, a unique temp data dir). */
  env?: Record<string, string>;
  /** Replaces individual config fields after loading. */
  config?: Partial<Config>;
  /** Routes for the fake transport behind `ctx.fetch`. */
  fetchRoutes?: FakeFetchRoute[];
  /** Replaces safe-fetch entirely. */
  fetch?: SafeFetch;
  /** Seeds for the default FakeAccountService, or a complete AccountService. */
  accounts?: FakeAccountSeed[] | AccountService;
  /** Initial vault secrets. */
  secrets?: Record<string, string>;
  /** `ctx.log` (default: the test logger that is also `ctx.logs`). */
  log?: Logger;
  /** `ctx.logs`; given alone, it is `ctx.log` too. */
  logs?: Logger & LogHub;
  /** Clock of the pairing store. */
  now?: () => number;
}

export interface TestContext extends AppContext {
  vault: MemoryVault;
  scheduler: ManualScheduler;
  /** The fake transport (null when `fetch` was overridden). */
  fakeFetch: FakeFetch | null;
  db: Db;
  /** Closes the health tracker, then the database. */
  close(): void;
}

export const TEST_PORT = 5757;

/** Config for tests: default port and origin, a unique (never created) temp data dir. */
export function testConfig(env: Record<string, string> = {}, patch: Partial<Config> = {}): Config {
  const base = loadConfig({
    HOMEBASE_PORT: String(TEST_PORT),
    HOMEBASE_DATA_DIR: path.join(os.tmpdir(), `homebase-test-${newId()}`),
    ...env,
  });
  return Object.freeze({ ...base, ...patch });
}

export function createTestContext(overrides: TestContextOverrides = {}): TestContext {
  const config = testConfig(overrides.env, overrides.config);
  // Neither given: one test logger is both. Only `log`: a separate hub. Only `logs`: it is `log` too.
  const logs: Logger & LogHub = overrides.logs ?? createTestLogger();
  const log: Logger = overrides.log ?? logs;
  const db = openDb(':memory:');
  migrate(db);
  const health = createHealthRecorder({ db, log: log.child({ component: 'health' }) });

  const fakeFetch = overrides.fetch ? null : createFakeFetch(overrides.fetchRoutes ?? []);
  const fetch = overrides.fetch ?? createSafeFetch({ version: config.version, log, fetchImpl: fakeFetch ?? undefined });

  const accounts: AccountService = Array.isArray(overrides.accounts)
    ? createFakeAccountService(overrides.accounts)
    : (overrides.accounts ?? createFakeAccountService());

  return {
    config,
    db,
    vault: createMemoryVault(overrides.secrets ?? {}),
    log,
    fetch,
    cache: createSqliteCache(db),
    memo: createMemoryCache(),
    scheduler: createManualScheduler({ log }),
    settings: createSettingsService({ db, log }),
    accounts,
    pairing: createPairingStore({ db, log, now: overrides.now }),
    logs,
    health,
    runtime: {
      boot: newRunId(),
      startedAt: Date.now(),
      supervised: false,
      restart: null,
      inflight: createInFlightRequests(),
      modules: [],
    },
    fakeFetch,
    close: () => {
      health.close();
      db.close();
    },
  };
}
