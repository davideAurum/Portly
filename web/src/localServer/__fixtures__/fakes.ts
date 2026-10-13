/**
 * Test doubles for the local server controller and its helpers (hybrid mode): in-memory storage,
 * a fake Portly server on this PC whose answers each test sets per route, the browser's local
 * network permission, page visibility/focus signals and cross-tab pairing events. Tests only.
 */
import { vi, type Mock } from 'vitest';
import { PORTLY_API_VERSION, type LogLevel } from '@portly/shared';
import { createLocalServerController, type HybridController, type HybridDiagFields, type LocalServerControllerDeps, type ReportedStatus } from '../controller.ts';
import type { PageEvent, PageSignals } from '../page.ts';
import { createPairingStore, type PairingRecord, type StorageLike } from '../pairing.ts';
import type { LoopbackPermissionSource } from '../permission.ts';
import type { Backend } from '../../capabilities.ts';
import type { LoopbackPermission } from '../types.ts';

export const ORIGIN = 'http://127.0.0.1:5757';
export const APP_URL = 'http://localhost:5757/';
export const TOKEN = 'T'.repeat(43);
export const NEW_TOKEN = 'N'.repeat(43);
export const INSTANCE = 'instance-A';
export const OTHER_INSTANCE = 'instance-B';
export const SERVER_CACHE_KEY = 'portly:query-cache:local-server:/';
/** Epoch ms the fake clock starts at. */
export const START = 1_800_000_000_000;

export interface MemoryStorage extends StorageLike {
  items: Map<string, string>;
}

export function memoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, String(value));
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

/**
 * Storage at its quota, as Chromium behaves: reads and removals work, a write that adds a key or
 * grows a value throws `QuotaExceededError` (one of the same length or shorter goes through).
 * `full = false` lifts the quota.
 */
export function fullStorage(initial: Record<string, string> = {}): MemoryStorage & { full: boolean } {
  const storage = { ...memoryStorage(initial), full: true };
  const write = storage.setItem;
  storage.setItem = (key, value) => {
    const old = storage.items.get(key);
    if (storage.full && (old === undefined || String(value).length > old.length)) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    write(key, value);
  };
  return storage;
}

/** Storage whose every access throws (blocked site data). */
export function throwingStorage(): StorageLike {
  const fail = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function healthBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, version: '0.1.0', vault: 'ready', app: 'portly', apiVersion: PORTLY_API_VERSION, instanceId: INSTANCE, appUrl: APP_URL, ...overrides };
}

export function pairingBody(instanceId = INSTANCE): Record<string, unknown> {
  return { paired: true, pairingId: 'pairing-1', instanceId, label: 'Chrome on Windows', createdAt: '2026-10-01T10:00:00.000Z' };
}

export function pairingRequired(): Response {
  return jsonResponse({ error: { code: 'pairing_required', message: 'Pair this browser first' } }, 401);
}

/** What the fake server does with a request. */
export type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Nothing listens on the port (or the browser refused): fetch's `TypeError`. */
export const down: Handler = () => Promise.reject(new TypeError('Failed to fetch'));

/**
 * Portly answers, but not to this site's CORS requests (its `PORTLY_PAGES_URL` is another
 * site): a CORS request fails like `down`, a `no-cors` one gets an opaque answer.
 */
export const refusesCors: Handler = (url, init) => (init.mode === 'no-cors' ? new Response(null, { status: 200 }) : down(url, init));

/** Never answers (a permission prompt is open, or the server hangs); rejects with an AbortError once aborted. */
export const hang: Handler = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) return reject(new DOMException('The operation was aborted.', 'AbortError'));
    signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  });

export const healthy =
  (overrides: Record<string, unknown> = {}): Handler =>
  () =>
    jsonResponse(healthBody(overrides));

export const accepted =
  (instanceId = INSTANCE): Handler =>
  () =>
    jsonResponse(pairingBody(instanceId));

export interface FakeServer {
  /** `GET /api/health`. */
  health: Handler;
  /** `GET /api/pairing`. */
  pairing: Handler;
  /** `DELETE /api/pairing`. */
  forget: Handler;
  /** Any other path. */
  other: Handler;
  fetch: Mock<(input: string, init?: RequestInit) => Promise<Response>>;
  /** Requests made so far, as `METHOD path`. */
  calls(): string[];
}

export function fakeServer(): FakeServer {
  const server: FakeServer = {
    health: healthy(),
    pairing: accepted(),
    forget: () => jsonResponse(null, 204),
    other: () => jsonResponse({ ok: true }),
    fetch: vi.fn(async (input: string, init: RequestInit = {}) => {
      const path = input.startsWith(ORIGIN) ? input.slice(ORIGIN.length) : input;
      const method = init.method ?? 'GET';
      if (path === '/api/health') return server.health(input, init);
      if (path === '/api/pairing') return (method === 'DELETE' ? server.forget : server.pairing)(input, init);
      return server.other(input, init);
    }),
    calls: () => server.fetch.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${input.startsWith(ORIGIN) ? input.slice(ORIGIN.length) : input}`),
  };
  return server;
}

export interface FakePermission {
  source: LoopbackPermissionSource;
  state: LoopbackPermission;
  /** Changes the permission and tells subscribers (as the browser's `change` event does). */
  set(state: LoopbackPermission): void;
}

export function fakePermission(initial: LoopbackPermission = 'granted'): FakePermission {
  const listeners = new Set<(state: LoopbackPermission) => void>();
  const permission: FakePermission = {
    state: initial,
    source: {
      query: async () => permission.state,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    set(state) {
      permission.state = state;
      for (const listener of [...listeners]) listener(state);
    },
  };
  return permission;
}

export interface FakePage {
  signals: PageSignals;
  visible: boolean;
  /** Sends a page event; `visible`/`hidden` also change the visibility. */
  emit(event: PageEvent): void;
}

export function fakePage(visible = true): FakePage {
  const listeners = new Set<(event: PageEvent) => void>();
  const page: FakePage = {
    visible,
    signals: {
      visible: () => page.visible,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit(event) {
      if (event === 'visible') page.visible = true;
      if (event === 'hidden') page.visible = false;
      for (const listener of [...listeners]) listener(event);
    },
  };
  return page;
}

export interface HarnessOptions {
  backend?: Backend;
  /** This browser's pairing (default none); `true` = the default record. */
  paired?: PairingRecord | boolean;
  permission?: LoopbackPermission;
  visible?: boolean;
  busy?: boolean;
  origin?: string;
  framed?: boolean;
  local?: MemoryStorage;
  /** The `no-cors` fallback after a failed CORS probe (off by default here, so request counts stay simple). */
  noCors?: boolean;
  /** The status this browser reported last (an earlier page load), default none. */
  lastReported?: ReportedStatus | null;
}

/** A diagnostic event the controller reported (`deps.diag`). */
export interface DiagEvent {
  level: LogLevel;
  msg: string;
  fields: HybridDiagFields;
}

export interface Harness {
  controller: HybridController;
  server: FakeServer;
  permission: FakePermission;
  page: FakePage;
  local: MemoryStorage;
  session: MemoryStorage;
  reload: Mock<() => void>;
  assign: Mock<(url: string) => void>;
  busy: { value: boolean };
  /** Tells the controller another tab changed the pairing record. */
  pairingChanged(): void;
  store: ReturnType<typeof createPairingStore>;
  deps: LocalServerControllerDeps;
  /** Every diagnostic event so far, oldest first. */
  events: DiagEvent[];
}

export function pairingRecord(overrides: Partial<PairingRecord> = {}): PairingRecord {
  return { token: TOKEN, instanceId: INSTANCE, pairedAt: START - 86_400_000, ...overrides };
}

/** A controller wired to fakes (not started). Use with fake timers (`Date` faked: `now` is `Date.now`). */
export function harness(options: HarnessOptions = {}): Harness {
  const local = options.local ?? memoryStorage();
  const session = memoryStorage();
  const store = createPairingStore(local, '/');
  if (options.paired) store.save(options.paired === true ? pairingRecord() : options.paired);
  const server = fakeServer();
  const permission = fakePermission(options.permission ?? 'granted');
  const page = fakePage(options.visible ?? true);
  const busy = { value: options.busy ?? false };
  const pairingListeners = new Set<() => void>();
  const reload = vi.fn<() => void>();
  const assign = vi.fn<(url: string) => void>();
  const events: DiagEvent[] = [];
  const deps: LocalServerControllerDeps = {
    origin: options.origin ?? ORIGIN,
    backend: options.backend ?? 'browser',
    framed: options.framed ?? false,
    fetch: server.fetch,
    now: () => Date.now(),
    localStorage: local,
    sessionStorage: session,
    base: '/',
    permission: permission.source,
    page: page.signals,
    subscribePairing(listener) {
      pairingListeners.add(listener);
      return () => {
        pairingListeners.delete(listener);
      };
    },
    reload,
    isBusy: () => busy.value,
    assign,
    // Deterministic nonces.
    random: (bytes) => bytes.fill(7),
    serverCacheKey: SERVER_CACHE_KEY,
    noCorsFallback: options.noCors ?? false,
    diag: (level, msg, fields) => {
      events.push({ level, msg, fields });
    },
    lastReportedStatus: () => options.lastReported ?? null,
  };
  const controller = createLocalServerController(deps);
  return {
    controller,
    server,
    permission,
    page,
    local,
    session,
    reload,
    assign,
    busy,
    store,
    deps,
    events,
    pairingChanged: () => {
      for (const listener of [...pairingListeners]) listener();
    },
  };
}
