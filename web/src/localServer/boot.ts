/**
 * Boot of the Pages build in hybrid mode (`main.tsx` imports this module dynamically, so it never
 * reaches the server build's bundle). Before the first render, and after `consumePairingReturn`:
 *
 * 1. Without a pairing record, the server backend's leftovers go: its persisted query cache and
 *    the mode hints (after a revoke or disconnect, including a snapshot the throttled persister
 *    wrote after the reload was requested).
 * 2. This page load's backend is decided ({@link decideBootBackend}) and set for the capabilities.
 * 3. The controller is created here, not at module top level, and plugged into the store and
 *    the transport; a server-backend page also gets its image source. Its diagnostic events
 *    become this browser's `hybrid` events (`recordClientEvent`, ARCHITECTURE §17), and so does the
 *    backend decision (debug: one per page load, recorded once the page is painted — the first
 *    event of a page load reads and checks the stored ones); the same log tells it which status
 *    was reported last ({@link lastReportedStatus}).
 *
 * `start()` (after the first render) starts the controller's probing. {@link takeModeSwitchNotice}
 * gives the toast to show after a reload that switched backend.
 */
import { setPageBackend, type Backend } from '../capabilities.ts';
import { getClientEvents, recordClientEvent } from '../diagnostics/clientLog.ts';
import { setServerAssetSource } from '../static/assets.ts';
import { createServerAssetCache } from './assets.ts';
import { HYBRID_ENABLED, LOCAL_SERVER_ORIGIN } from './config.ts';
import {
  HYBRID_STATUS_EVENT,
  createLocalServerController,
  setAppLocalServerController,
  type HybridController,
  type LocalServerControllerDeps,
  type ReportedStatus,
} from './controller.ts';
import { browserPageSignals, isFramed, isPageBusy } from './page.ts';
import {
  MODE_SWITCH_TOAST_KEY,
  bootDecisionReason,
  browserLocalStorage,
  browserSessionStorage,
  createPairingStore,
  decideBootBackend,
  readItem,
  removeItem,
  subscribePairingChanges,
  type BootDecisionInput,
  type StorageLike,
} from './pairing.ts';
import { pageLoopbackPermissionSource } from './permission.ts';
import { setLocalServerController } from './store.ts';
import { localServerFetch } from './transport.ts';
import type { PendingSwitchReason } from './types.ts';

// The decision lives with the hints it reads (the controller checks it before a switch reloads).
export { BOOT_SERVER_RECENT_MS, decideBootBackend, type BootDecisionInput } from './pairing.ts';

export interface PagesBootOptions {
  /** localStorage key of the server backend's persisted query cache (`app/providers.tsx`). */
  serverCacheKey: string;
  /** Overrides for tests; the defaults are the build's and the browser's. */
  enabled?: boolean;
  origin?: string;
  framed?: boolean;
  localStorage?: StorageLike | null;
  sessionStorage?: StorageLike | null;
  now?: () => number;
  base?: string;
  /** Controller dependencies to replace (tests). */
  controllerDeps?: Partial<LocalServerControllerDeps>;
  /** Runs work that can wait until the first frame is painted (default {@link whenIdleAfterPaint}). */
  afterFirstPaint?: (run: () => void) => void;
}

export interface PagesBoot {
  backend: Backend;
  /** The paired server's id on a server-backend page (keys its persisted cache), else null. */
  instanceId: string | null;
  /** Null when hybrid mode is off. */
  controller: HybridController | null;
  /** Starts the controller and, once the page is painted, records the backend decision (after the first render). */
  start(): void;
}

/** The hybrid status this browser last reported above debug (its event log survives reloads), or null. */
export function lastReportedStatus(): ReportedStatus | null {
  const entries = getClientEvents();
  for (let i = entries.length - 1; i >= 0; i--) {
    const { event } = entries[i]!;
    if (event.cat !== 'hybrid' || event.msg !== HYBRID_STATUS_EVENT || event.level === 'debug') continue;
    const { to, reason } = event.fields;
    if (typeof to === 'string') return { status: to, reason: typeof reason === 'string' ? reason : null };
  }
  return null;
}

/** Runs `run` when the browser is idle after painting (a moment later where it has no idle callback). */
function whenIdleAfterPaint(run: () => void): void {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => run(), { timeout: 2000 });
  else setTimeout(run, 200);
}

export function bootPagesBackend(options: PagesBootOptions): PagesBoot {
  const enabled = options.enabled ?? HYBRID_ENABLED;
  const origin = options.origin ?? LOCAL_SERVER_ORIGIN;
  const framed = options.framed ?? isFramed();
  const local = options.localStorage === undefined ? browserLocalStorage() : options.localStorage;
  const now = options.now ?? (() => Date.now());
  const store = createPairingStore(local, options.base);

  const record = store.read();
  if (record === null) {
    removeItem(local, options.serverCacheKey);
    store.setLastMode(null);
    store.setLastServerSeenAt(null);
  }
  const decision: BootDecisionInput = {
    enabled,
    framed,
    record,
    lastMode: store.lastMode(),
    lastServerSeenAt: store.lastServerSeenAt(),
    now: now(),
  };
  const backend = decideBootBackend(decision);
  setPageBackend(backend);
  // Not before the first paint: this page load's first event reads and checks the stored ones.
  const chosen = { target: backend, reason: bootDecisionReason(decision) };
  const recordChoice = () => (options.afterFirstPaint ?? whenIdleAfterPaint)(() => recordClientEvent('debug', 'hybrid', 'page backend chosen', chosen));
  if (!enabled) return { backend, instanceId: null, controller: null, start: recordChoice };

  const controller = createLocalServerController({
    origin,
    backend,
    framed,
    fetch: (input, init) => fetch(input, init),
    now,
    localStorage: local,
    sessionStorage: options.sessionStorage === undefined ? browserSessionStorage() : options.sessionStorage,
    base: options.base,
    permission: pageLoopbackPermissionSource(window.location.hostname),
    page: browserPageSignals(),
    subscribePairing: (listener) => subscribePairingChanges(listener, window, store.keys),
    reload: () => window.location.reload(),
    isBusy: () => isPageBusy(),
    assign: (url) => window.location.assign(url),
    serverCacheKey: options.serverCacheKey,
    diag: (level, msg, fields) => {
      recordClientEvent(level, 'hybrid', msg, fields);
    },
    lastReportedStatus,
    ...options.controllerDeps,
  });
  setAppLocalServerController(controller);
  setLocalServerController(controller);
  if (backend === 'server') setServerAssetSource(createServerAssetCache({ fetch: localServerFetch }));
  return {
    backend,
    instanceId: backend === 'server' ? (record?.instanceId ?? null) : null,
    controller,
    start: () => {
      recordChoice();
      controller.start();
    },
  };
}

export interface ModeSwitchNotice {
  /** `success` for reaching the server, `info` for falling back to this browser's copy. */
  tone: 'success' | 'info';
  message: string;
}

const BROWSER_NOTICES: Readonly<Record<PendingSwitchReason, string>> = Object.freeze({
  connected: 'Using this browser’s copy',
  unreachable: 'Homebase on this PC isn’t reachable — using this browser’s copy',
  revoked: 'Homebase on this PC no longer accepts this browser — using this browser’s copy',
  disconnected: 'Disconnected from Homebase on this PC — using this browser’s copy',
  'other-server': 'A different Homebase answers on this PC — using this browser’s copy',
  incompatible: 'This page and Homebase on this PC need updating to the same version — using this browser’s copy',
  blocked: 'The browser blocks access to Homebase on this PC — using this browser’s copy',
});

/**
 * The toast for the backend switch the reload just applied (read once, from sessionStorage), or
 * null. A notice for the other backend than `backend` (this page load's) is dropped: the hints
 * may have changed between the switch and this load (another tab), and the toast must not claim
 * a switch that did not happen.
 */
export function takeModeSwitchNotice(backend: Backend, session: StorageLike | null = browserSessionStorage()): ModeSwitchNotice | null {
  const raw = readItem(session, MODE_SWITCH_TOAST_KEY);
  if (raw === null) return null;
  removeItem(session, MODE_SWITCH_TOAST_KEY);
  const [target, reason] = raw.split(':', 2);
  if (target !== backend) return null;
  if (target === 'server') return { tone: 'success', message: 'Connected to Homebase on this PC' };
  if (target === 'browser' && reason !== undefined && Object.hasOwn(BROWSER_NOTICES, reason)) {
    return { tone: 'info', message: BROWSER_NOTICES[reason as PendingSwitchReason] };
  }
  return null;
}
