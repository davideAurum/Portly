/**
 * Application context handed to every module's `register(app, ctx)` (§6), plus the Hono env type
 * and the runtime facts the Diagnostics page reads (§17: log hub, health tracker, start-up info).
 */
import type { HttpBindings } from '@hono/node-server';
import type { Hono } from 'hono';
import type {
  Account,
  AccountConfigByKind,
  AccountDraft,
  AccountKind,
  Capability,
} from '@homebase/shared';
import type { Config } from './config.ts';
import type { Db } from './db/open.ts';
import type { Cache, MemoryCache } from './lib/cache.ts';
import type { HealthRecorder } from './lib/health.ts';
import type { InFlightRequests } from './lib/inflight.ts';
import type { LogHub, Logger } from './lib/logger.ts';
import type { RouteMeta } from './lib/routes.ts';
import type { Scheduler } from './lib/scheduler.ts';
import type { SettingsService } from './lib/settings.ts';
import type { PairingStore } from './security/pairing.ts';
import type { SafeFetch } from './security/safe-fetch.ts';
import type { Vault } from './security/vault.ts';

/** A Pages preflight the gate accepted (hybrid mode): what the CORS answer allows. */
export interface PagesPreflight {
  /** The requested method (`Access-Control-Request-Method`), one the API uses. */
  method: string;
  /** The browser asked for Private Network Access (`Access-Control-Request-Private-Network: true`). */
  privateNetwork: boolean;
}

/** Hono environment: Node bindings (absent under `app.request()` in tests) + per-request variables. */
export interface AppEnv {
  Bindings: Partial<HttpBindings>;
  Variables: {
    /** Gate metadata of the matched route (set by the gate). */
    routeMeta: RouteMeta;
    /** The request comes from the configured Pages origin: its answer carries CORS headers (set by the gate). */
    pagesCors: boolean | undefined;
    /** Set by the gate when it answered a Pages preflight. */
    pagesPreflight: PagesPreflight | undefined;
    /** The pairing a Pages request's token belongs to (set by the gate after verifying it). */
    pairingId: string | undefined;
    /** This request's id (`X-Request-Id`, set by the request middleware). */
    requestId: string | undefined;
    /** The API error code the answer carries (set by `errorResponse()` and the error handler; logged on the request line). */
    errorCode: string | undefined;
  };
}

/** A module and whether its `register()` completed (modules/index.ts re-exports this). */
export interface ModuleStatus {
  name: string;
  ok: boolean;
}

/** Facts about this server process (Settings → Diagnostics summary, start-up and status lines). */
export interface RuntimeInfo {
  /** Random id of this process start (tells restarts apart in logs and reports). */
  boot: string;
  /** Epoch ms. */
  startedAt: number;
  /** Started by the supervisor (`HOMEBASE_SUPERVISED=1`). */
  supervised: boolean;
  /** Supervisor restart facts (`HOMEBASE_SUPERVISOR_ATTEMPT` / `_LAST_EXIT`, JSON or text); null when not restarted by it. */
  restart: { attempt: number; lastExit: string | null } | null;
  /** Requests in progress (request middleware). */
  inflight: InFlightRequests;
  /** Module registration results, filled by `createApp` (replaced, not appended, per app). */
  modules: ModuleStatus[];
}

export interface AppContext {
  config: Config;
  /** run/get/all/exec + tx(fn) (BEGIN IMMEDIATE/COMMIT/ROLLBACK); rows → plain objects. */
  db: Db;
  /** §4.6 */
  vault: Vault;
  log: Logger;
  /** §4.8 */
  fetch: SafeFetch;
  /** get<T>(k), set(k, v, ttlMs), getOrSet<T>(k, ttlMs, fn), delPrefix(p) — SQLite `cache` table,
   *  non-sensitive data only; keys '<module>:...' */
  cache: Cache;
  /** Same API, in-memory LRU (sensitive data, e.g. mail lists). */
  memo: MemoryCache;
  /** every(name, intervalMs, fn, {initialDelayMs?}) → {reschedule(ms), runNow(), stop()};
   *  no overlapping runs; errors logged; names '<module>:...' */
  scheduler: Scheduler;
  /** get<K extends keyof Settings>(ns: K): Settings[K]; onChange(ns, cb) */
  settings: SettingsService;
  accounts: AccountService;
  /** Browsers paired with this server through the Pages site (hybrid mode) and the server's instance id. */
  pairing: PairingStore;
  /** The log's memory rings, level switch and queries (in production the same object as `log`). */
  logs: LogHub;
  /** Health of every synced subject (lib/health.ts, §17): `record`, `touch`, `forget`, … */
  health: HealthRecorder;
  runtime: RuntimeInfo;
}

export type AccountChangeEvent = { type: 'created' | 'updated' | 'deleted'; accountId: string };

export type AccountProbe = (draft: AccountDraft) => Promise<{ configPatch?: Record<string, unknown> }>;

export interface AccountService {
  /** Accounts, optionally filtered by kind and/or an *enabled* capability. */
  list(f?: { kind?: AccountKind; capability?: Capability }): Account[];
  get(id: string): Account | null;
  getConfig<K extends AccountKind>(id: string): AccountConfigByKind[K];
  /** google|microsoft; §4.7 semantics; throws HttpError(409, 'reauth_required', {accountId}). */
  getAccessToken(id: string): Promise<string>;
  /** On provider 401 (fn throws ProviderUnauthorizedError): force refresh once, retry once. */
  withToken<T>(id: string, fn: (token: string) => Promise<T>): Promise<T>;
  /** App-password accounts (yahoo/caldav/imap). */
  getSecret(id: string): Promise<{ password: string }>;
  /** `meta`: machine reason (`invalid_grant`, `caldav_password_rejected` …) and the module that decided it (logs, health). */
  setStatus(id: string, status: 'ok' | 'error' | 'reauth', message?: string, meta?: { reason?: string; source?: string }): void;
  registerProbe(capability: Capability, kinds: AccountKind[], probe: AccountProbe): void;
  onChange(cb: (e: AccountChangeEvent) => void): void;
}

/** A module's registration function (`modules/<name>/index.ts` exports `register`). */
export type RegisterModule = (app: Hono<AppEnv>, ctx: AppContext) => void;
