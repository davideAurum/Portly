/**
 * The local server controller (hybrid mode, Pages build). It looks for the Homebase server on this
 * PC, knows whether this browser is paired with it, and decides when this page load should switch
 * backend. The backend itself never changes in place: each page load has one (`browser`, the
 * in-browser copy, or `server`), and a switch persists what the next load needs and reloads the
 * page — at once when the tab is hidden or the user is idle, otherwise once the page is idle again
 * (or the user clicks Switch now).
 *
 * When it probes:
 * - hybrid mode off or a framed page: never;
 * - not paired: on boot, focus and visibility, and only once the browser's local network
 *   permission is `granted` (or the browser has none); otherwise only when the user asks
 *   (`lookForServer`, a user gesture that may show the permission prompt);
 * - paired: on boot, then every 30 s while connected (skipped while the server answered requests
 *   in the last 30 s), every 2 s while reconnecting, else with a 5→10→20→30→60 s backoff that
 *   visibility, focus, `online`, permission and pairing changes and `checkNow()` reset.
 * One probe at a time. While the permission prompt may be open (`prompt`, or no permission API)
 * a probe is never aborted: after 3 s it reports `waiting-permission` and waits. Otherwise a probe
 * gives up after 5 s, which says nothing when the server answered something in the last 30 s.
 *
 * Outcomes (`B` = this page load's backend):
 *
 * | Probe result                        | B = browser                     | B = server                    |
 * | ----------------------------------- | ------------------------------- | ----------------------------- |
 * | unreachable / not Homebase          | `absent`                        | `reconnecting` (grace)        |
 * | permission denied                   | `blocked`                       | switch → browser (`blocked`)  |
 * | apiVersion ≠ ours                   | `incompatible`                  | switch → browser              |
 * | healthy, not paired                 | `unpaired`                      | switch → browser              |
 * | healthy, paired, other instanceId   | `other-server` (no token sent)  | switch → browser              |
 * | healthy, paired, pairing accepted   | `connected` → switch → server   | `connected` (*)               |
 * | pairing refused (401)               | `revoked`, compare-and-clear    | `revoked`, clear, → browser   |
 * | pairing check failed (network)      | `absent`                        | `reconnecting`                |
 *
 * (*) Only with the server the page booted with: one paired since in another tab has other data,
 * so the page switches (`other-server`) rather than mixing the two.
 *
 * A server-backend page that stays `reconnecting` for {@link GRACE_MS} (not counting time spent
 * waiting for the permission prompt) switches to the browser, once no tab has seen the server for
 * as long either; a hidden tab first re-probes once it is visible again. Requests of a
 * server-backend page wait for `connected` through `whenServerReady` and fail with
 * {@link ServerModeEndedError} once a switch away is requested.
 *
 * A switch reloads on its own only when the hints it writes make the next load start on the
 * other backend (storage may refuse them): otherwise the reload would come back to this backend
 * and switch again, in a loop. It then waits for Switch now, and retries the hints meanwhile.
 *
 * A CORS probe that fails with the permission granted (or no such permission) is followed by one
 * `no-cors` health request (`probeHealthWithoutCors`, which carries nothing): an opaque answer means
 * Homebase runs on this PC but does not accept this site (`unreachableReason:
 * 'answers-without-cors'` — its `HOMEBASE_PAGES_URL` is another site).
 *
 * What happens is reported through the `diag` dependency (`boot.ts`: this browser's `hybrid`
 * events, ARCHITECTURE §17): status transitions with the probe that caused them, every probe's
 * details (debug; info when a changed result leaves the status as it was), pairing-check failures, the grace, backend switches requested, deferred,
 * withdrawn and performed. A page load's first status is info only when it differs from the one
 * this browser last reported (`lastReportedStatus`: earlier page loads, other tabs) — or, with none
 * reported yet, when it needs the user — so opening a tab does not log one event every time.
 *
 * Every side effect is a dependency ({@link LocalServerControllerDeps}), so the whole state machine
 * runs under fake timers in tests. `boot.ts` builds the page's instance from the browser's.
 */
import { HOMEBASE_API_VERSION, type LogLevel } from '@homebase/shared';
import type { Backend } from '../capabilities.ts';
import type { PageEvent, PageSignals } from './page.ts';
import {
  MODE_SWITCH_TOAST_KEY,
  createPairingStore,
  removeItem,
  startPairing,
  writeItem,
  type PairingRecord,
  type StorageLike,
} from './pairing.ts';
import type { LoopbackPermissionSource } from './permission.ts';
import {
  LOOPBACK_REQUEST_INIT,
  checkPairingDetailed,
  pairedHeaders,
  probeHealth,
  probeHealthDetailed,
  probeHealthWithoutCors,
  type FetchLike,
  type HealthProbeResult,
  type LoopbackRequestInit,
  type ProbeDetails,
} from './probe.ts';
import type {
  LocalServerActions,
  LocalServerController,
  LocalServerInfo,
  LocalServerState,
  LocalServerStatus,
  LocalServerUnreachableReason,
  LoopbackPermission,
  PendingSwitch,
  PendingSwitchReason,
} from './types.ts';
import { validateAppUrl } from './urls.ts';

/** How long a server-backend page keeps reconnecting before it switches to the browser. */
export const GRACE_MS = 45_000;
/** A probe gives up after this (only when it cannot be waiting for the permission prompt). */
export const PROBE_TIMEOUT_MS = 5_000;
/** A probe still unanswered after this may be waiting for the permission prompt. */
export const PERMISSION_WAIT_MS = 3_000;
/** Probe interval while connected. */
export const CONNECTED_INTERVAL_MS = 30_000;
/** A server response this recent makes a periodic probe unnecessary and a timeout inconclusive. */
export const RECENT_RESPONSE_MS = 30_000;
/** Probe interval while reconnecting. */
export const RECONNECT_INTERVAL_MS = 2_000;
/** Probe intervals for every other paired state. */
export const BACKOFF_MS: readonly number[] = Object.freeze([5_000, 10_000, 20_000, 30_000, 60_000]);
/** How often a pending switch checks whether the page became idle. */
export const BUSY_POLL_MS = 2_000;
/** `lastServerSeenAt` is written at most this often. */
export const SEEN_WRITE_INTERVAL_MS = 60_000;
/** Pairing starts from a healthy probe at most this old (else it probes first). */
export const PAIRING_PROBE_FRESH_MS = 60_000;
/** The best-effort `DELETE /api/pairing` of `disconnect()` waits at most this long. */
export const DISCONNECT_TIMEOUT_MS = 3_000;

/**
 * A request of a server-backend page that can no longer be served: the page is switching to the
 * browser's copy (it reloads). A `TypeError`, like any failed fetch, so the API client reports it
 * as `network_error` — without an `api` event of its own (the switch's `hybrid` events say why).
 */
export class ServerModeEndedError extends TypeError {
  override name = 'ServerModeEndedError';

  constructor(message = 'This page is switching to the copy in this browser') {
    super(message);
  }
}

export interface LocalServerControllerDeps {
  /** Origin of the Homebase server on this PC (`LOCAL_SERVER_ORIGIN`); `''` disables the controller. */
  origin: string;
  /** This page load's backend. */
  backend: Backend;
  /** The page runs inside a frame (never uses the local server). */
  framed?: boolean;
  fetch: FetchLike;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Where the pairing record and the mode hints live (`pairing.ts`); null when unavailable. */
  localStorage: StorageLike | null;
  /** The post-reload toast and the pairing nonce; null when unavailable. */
  sessionStorage: StorageLike | null;
  /** Pages base path the storage keys are namespaced by (default: this build's). */
  base?: string;
  permission: LoopbackPermissionSource;
  page: PageSignals;
  /** Calls `listener` when another tab changes the pairing record. */
  subscribePairing(listener: () => void): () => void;
  /** Reloads the page (`location.reload()`). */
  reload(): void;
  /** True while a reload would interrupt the user (`page.ts` `isPageBusy`). */
  isBusy(): boolean;
  /** Navigates this tab (`location.assign`), to pair. */
  assign(url: string): void;
  random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array;
  /** localStorage key of the server backend's persisted query cache, removed by `disconnect()`. */
  serverCacheKey: string;
  /**
   * After a CORS probe failed with the permission granted (or none in this browser): one `no-cors`
   * health request, to tell a server that refuses this site from nothing answering (default true).
   */
  noCorsFallback?: boolean;
  /**
   * Receives the controller's diagnostic events (`boot.ts`: this browser's `hybrid` events). Field
   * values are plain data; a throwing callback never disturbs the controller.
   */
  diag?: (level: LogLevel, msg: string, fields: HybridDiagFields) => void;
  /**
   * The status this browser last reported above debug, from any tab or earlier page load (`boot.ts`:
   * its event log), so that a page load reports its first status only when it differs.
   */
  lastReportedStatus?: () => ReportedStatus | null;
}

/** A status as its diagnostic event reported it. */
export interface ReportedStatus {
  status: string;
  reason: string | null;
}

/** The message of a status transition's diagnostic event. */
export const HYBRID_STATUS_EVENT = 'hybrid status changed';

/** Fields of a diagnostic event (the `hybrid` category's allowlist decides which are kept). */
export type HybridDiagFields = Readonly<Record<string, string | number | boolean | null>>;

/** The controller as the page's transport and boot code use it (the UI sees only {@link LocalServerController}). */
export interface HybridController extends LocalServerController {
  /** Starts watching and probing (after the first render). */
  start(): void;
  /** Stops every timer, probe and listener (tests, teardown). */
  stop(): void;
  /**
   * Resolves once the server is connected; waits while a server-backend page is checking,
   * reconnecting or waiting for the permission; rejects with {@link ServerModeEndedError} once a
   * switch to the browser is requested (or on a browser-backend page), and with the signal's
   * reason when it aborts.
   */
  whenServerReady(signal?: AbortSignal | null): Promise<void>;
  /** The server answered a request (any status): it is alive. */
  reportResponse(): void;
  /** A request of this server-backend page failed at the network level: probe now. */
  reportNetworkFailure(): void;
  /**
   * The server refused `token` (401 `pairing_required`). Not proof by itself (another Homebase may
   * answer on the port now): a probe decides, and clears the pairing only for the paired server.
   */
  reportUnpaired(token: string): void;
  /** The pairing token requests carry, or null when not paired. */
  token(): string | null;
}

/**
 * What starts a probe: `timer` (the schedule) and `event` (focus, visibility, online) are skipped
 * while the connected server answered requests recently; `retry` (after an inconclusive timeout)
 * and the others always probe when the permission rules allow it; `manual` ignores them.
 */
type Trigger = 'boot' | 'timer' | 'retry' | 'event' | 'change' | 'manual' | 'response';

/** Why a probe found nothing usable, when it knows: a refusing server, or something that is not Homebase. */
type UnreachableCause = LocalServerUnreachableReason | 'not-homebase';

type Outcome =
  | { kind: 'aborted' }
  | { kind: 'inconclusive' }
  | { kind: 'unreachable'; cause?: UnreachableCause }
  | { kind: 'denied' }
  | { kind: 'incompatible'; info: LocalServerInfo }
  | { kind: 'unpaired'; info: LocalServerInfo }
  | { kind: 'other-server'; info: LocalServerInfo }
  | { kind: 'connected'; info: LocalServerInfo }
  | { kind: 'revoked'; info: LocalServerInfo; token: string }
  | { kind: 'pairing-error'; info: LocalServerInfo };

interface Probe {
  abort: AbortController;
  /** The 5 s timeout (only armed while the permission prompt cannot be open). */
  timeout: unknown;
  /** The 3 s timer after which the probe may be waiting for the permission prompt. */
  wait: unknown;
  timedOut: boolean;
  manual: boolean;
  statusBefore: LocalServerStatus;
  done: Promise<void>;
  /** When it started (its diagnostic event's `ms`). */
  startedAt: number;
  /** What the health request (then the pairing check, when one ran) showed. */
  details: ProbeDetails | null;
}

/** What a status change is reported with: why, and the fields of the probe that caused it. */
interface StatusCause {
  reason: string;
  probe?: HybridDiagFields;
}

/**
 * Statuses that need the user: the first status of a page load is reported at info when it is one
 * of these and nothing was reported before (routine first statuses are debug).
 */
const NEEDS_ATTENTION: ReadonlySet<LocalServerStatus> = new Set(['blocked', 'incompatible', 'revoked', 'other-server', 'waiting-permission', 'reconnecting']);

/** Statuses during which a server-backend page's requests wait instead of failing. */
const WAITING_STATUSES: ReadonlySet<LocalServerStatus> = new Set(['idle', 'checking', 'reconnecting', 'waiting-permission']);
/** Statuses `unreachableReason` explains (and `checking`, which re-probes from one): every other one clears it. */
const UNREACHABLE_REASON_STATUSES: ReadonlySet<LocalServerStatus> = new Set(['absent', 'reconnecting', 'checking']);
/** Statuses from which pairing can start (the server answered and speaks our API version). */
const PAIRABLE_STATUSES: ReadonlySet<LocalServerStatus> = new Set(['unpaired', 'revoked', 'other-server', 'connected']);

function serverInfo(result: Extract<HealthProbeResult, { kind: 'ok' }>): LocalServerInfo {
  const { health, appUrl } = result;
  return { version: health.version, instanceId: health.instanceId ?? null, appUrl, apiVersion: health.apiVersion ?? null, vault: health.vault };
}

function sameServer(a: LocalServerInfo | null, b: LocalServerInfo): boolean {
  return a !== null && a.version === b.version && a.instanceId === b.instanceId && a.appUrl === b.appUrl && a.apiVersion === b.apiVersion && a.vault === b.vault;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function createLocalServerController(deps: LocalServerControllerDeps): HybridController {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimeout ?? ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms));
  const clearTimer = (handle: unknown): void => {
    if (handle === null) return;
    if (deps.clearTimeout) deps.clearTimeout(handle);
    else globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  };
  const store = createPairingStore(deps.localStorage, deps.base);
  /** Hybrid mode on and not framed: the controller may probe. */
  const active = deps.origin !== '' && deps.framed !== true;
  let record: PairingRecord | null = active ? store.read() : null;
  /** The server whose data a server-backend page shows (its persisted cache is keyed by it). */
  const bootInstanceId = deps.backend === 'server' ? (record?.instanceId ?? null) : null;

  let state: LocalServerState = Object.freeze({
    backend: deps.backend,
    status: deps.origin === '' ? 'disabled' : deps.framed === true ? 'framed' : record !== null ? 'checking' : 'idle',
    server: null,
    paired: record !== null,
    checkedAt: null,
    pendingSwitch: null,
    permission: null,
    manual: false,
    unreachableReason: null,
  } satisfies LocalServerState);

  const listeners = new Set<() => void>();
  /** `whenServerReady` callers, re-checked on every change (also changes outside `state`). */
  const waiters = new Set<() => void>();
  const cleanups: (() => void)[] = [];
  let started = false;
  let stopped = false;
  let reloading = false;
  let probe: Probe | null = null;
  let probeTimer: unknown = null;
  let busyTimer: unknown = null;
  let backoffStep = 0;
  let lastResponseAt: number | null = null;
  let lastHealthyAt: number | null = null;
  let lastSeenWriteAt: number | null = null;
  let switchRequest: PendingSwitch | null = null;
  // Grace of a server-backend page: when this reconnecting spell began, and how much of it was
  // spent waiting for the permission prompt (which does not count).
  let graceStart: number | null = null;
  let gracePaused = 0;
  let waitingSince: number | null = null;
  const resolved = Promise.resolve();
  // Diagnostics: the last status other than `checking` (transitions are reported between these),
  // whether one was reported yet in this page load, the last probe's signature (a change is worth
  // more than debug) and whether the pending switch was reported as deferred.
  let settledStatus: LocalServerStatus = state.status;
  let statusReported = false;
  let lastProbeSignature: string | null = null;
  let switchDeferredReported = false;

  function running(): boolean {
    return active && started && !stopped && !reloading;
  }

  function wake(): void {
    for (const waiter of [...waiters]) waiter();
  }

  /** Reports a diagnostic event (never throws). */
  function diag(level: LogLevel, msg: string, fields: HybridDiagFields = {}): void {
    if (deps.diag === undefined) return;
    try {
      deps.diag(level, msg, fields);
    } catch {
      // Diagnostics never disturb the controller.
    }
  }

  function lastReported(): ReportedStatus | null {
    try {
      return deps.lastReportedStatus?.() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A status change: `checking` is debug; otherwise a transition between settled statuses (info).
   * A page load's first status is compared with the one this browser last reported (earlier page
   * loads, other tabs): info when it differs, debug when it is the same. With nothing reported yet,
   * only a status that needs the user is info.
   */
  function reportStatus(from: LocalServerStatus, to: LocalServerStatus, cause: StatusCause | undefined): void {
    const reason = cause?.reason ?? null;
    const fields = { ...cause?.probe, from, to, reason };
    if (to === 'checking') return diag('debug', HYBRID_STATUS_EVENT, fields);
    const before = settledStatus;
    settledStatus = to;
    if (statusReported) {
      // Back where it was before a check: nothing changed.
      if (before !== to) diag('info', HYBRID_STATUS_EVENT, { ...fields, from: before });
      return;
    }
    statusReported = true;
    const previous = lastReported();
    if (previous !== null) {
      const same = previous.status === to && previous.reason === reason;
      return diag(same ? 'debug' : 'info', HYBRID_STATUS_EVENT, { ...fields, from: previous.status });
    }
    const attention = NEEDS_ATTENTION.has(to) || reason === 'answers-without-cors' || (deps.backend === 'server' && to !== 'connected');
    diag(attention ? 'info' : 'debug', HYBRID_STATUS_EVENT, { ...fields, from: before });
  }

  function update(patch: Partial<LocalServerState>, cause?: StatusCause): void {
    const next: LocalServerState = { ...state, ...patch };
    // The reason explains the status it was found with (a later status change never leaves it behind).
    if (!UNREACHABLE_REASON_STATUSES.has(next.status)) next.unreachableReason = null;
    const keys = Object.keys(next) as (keyof LocalServerState)[];
    if (keys.every((key) => Object.is(next[key], state[key]))) return;
    const from = state.status;
    state = Object.freeze(next);
    if (next.status !== from) reportStatus(from, next.status, cause);
    for (const listener of [...listeners]) listener();
    wake();
  }

  function setServer(info: LocalServerInfo): void {
    if (!sameServer(state.server, info)) update({ server: Object.freeze(info) });
  }

  // -- scheduling --------------------------------------------------------------------------

  function cancelSchedule(): void {
    clearTimer(probeTimer);
    probeTimer = null;
  }

  function schedule(ms: number, trigger: Trigger = 'timer'): void {
    cancelSchedule();
    probeTimer = setTimer(() => {
      probeTimer = null;
      void kick(trigger);
    }, ms);
  }

  function scheduleNext(): void {
    if (!running() || probe !== null || state.status === 'waiting-permission') return;
    // Not paired: probes follow page events only.
    if (record === null) return;
    if (state.status === 'connected') return schedule(CONNECTED_INTERVAL_MS);
    if (state.status === 'reconnecting') return schedule(RECONNECT_INTERVAL_MS);
    const delay = BACKOFF_MS[Math.min(backoffStep, BACKOFF_MS.length - 1)] ?? CONNECTED_INTERVAL_MS;
    backoffStep += 1;
    schedule(delay);
  }

  function recentResponse(at: number): boolean {
    return lastResponseAt !== null && at - lastResponseAt < RECENT_RESPONSE_MS;
  }

  function healthyRecently(): boolean {
    return lastHealthyAt !== null && now() - lastHealthyAt < PAIRING_PROBE_FRESH_MS;
  }

  /** Probes now when the rules allow it (`manual`: the user asked, so permission rules do not apply). */
  function kick(trigger: Trigger): Promise<void> {
    if (!running()) return resolved;
    const manual = trigger === 'manual';
    if (probe !== null) {
      if (manual && !probe.manual) {
        probe.manual = true;
        const showChecking = state.status !== 'connected' && state.status !== 'waiting-permission';
        update({ manual: true, ...(showChecking ? { status: 'checking' } : {}) }, { reason: 'manual' });
      }
      return probe.done;
    }
    if (!manual) {
      const permission = state.permission;
      // Not known yet: the boot probe follows the permission query.
      if (permission === null) return resolved;
      if (record === null && permission !== 'granted' && permission !== 'unsupported') return resolved;
      // The prompt cannot show in a background tab: the request would just hang.
      if (permission === 'prompt' && !deps.page.visible()) return resolved;
      if ((trigger === 'timer' || trigger === 'event') && state.status === 'connected') {
        const at = now();
        if (lastResponseAt !== null && recentResponse(at)) {
          if (record !== null) schedule(lastResponseAt + CONNECTED_INTERVAL_MS - at);
          return resolved;
        }
      }
    }
    return runProbe(manual);
  }

  // -- probing -----------------------------------------------------------------------------

  function armTimeout(current: Probe): void {
    current.timeout = setTimer(() => {
      current.timedOut = true;
      current.abort.abort();
    }, PROBE_TIMEOUT_MS);
  }

  function runProbe(manual: boolean): Promise<void> {
    cancelSchedule();
    const current: Probe = {
      abort: new AbortController(),
      timeout: null,
      wait: null,
      timedOut: false,
      manual,
      statusBefore: state.status,
      done: resolved,
      startedAt: now(),
      details: null,
    };
    probe = current;
    // Background re-probes keep the status as it is; only a first or a requested check shows "Checking…".
    const showChecking = state.status === 'idle' || (manual && state.status !== 'connected');
    update({ manual, ...(showChecking ? { status: 'checking' } : {}) }, { reason: manual ? 'manual' : 'probe' });
    if (state.permission === 'granted' || state.permission === 'denied') {
      armTimeout(current);
    } else {
      // The permission prompt may be open: never abort, but say so after a while.
      current.wait = setTimer(() => {
        current.wait = null;
        if (probe === current && running()) enterWaitingPermission();
      }, PERMISSION_WAIT_MS);
    }
    current.done = execute(current).then(
      (outcome) => settle(current, outcome),
      () => settle(current, { kind: 'unreachable' }),
    );
    return current.done;
  }

  async function permissionNow(): Promise<LoopbackPermission> {
    const permission = await deps.permission.query().catch((): LoopbackPermission => 'unsupported');
    if (running()) update({ permission });
    return permission;
  }

  async function execute(current: Probe): Promise<Outcome> {
    const signal = current.abort.signal;
    // A denied permission fails every request at once: nothing to learn from trying.
    if (state.permission === 'denied') return { kind: 'denied' };
    const probed = await probeHealthDetailed(deps.origin, { fetch: deps.fetch, signal, now });
    current.details = probed.details;
    const health = probed.result;
    if (health.kind === 'aborted') return { kind: 'aborted' };
    if (health.kind === 'unreachable') {
      // The user may just have answered the prompt with Block: a denial looks like any network error.
      const permission = await permissionNow();
      return permission === 'denied' ? { kind: 'denied' } : withoutCors(current, permission);
    }
    if (health.kind === 'not-homebase') return { kind: 'unreachable', cause: 'not-homebase' };
    const info = serverInfo(health);
    if (info.apiVersion !== HOMEBASE_API_VERSION) return { kind: 'incompatible', info };
    const paired = record;
    if (paired === null) return { kind: 'unpaired', info };
    // Another Homebase never sees this browser's token.
    if (info.instanceId !== paired.instanceId) return { kind: 'other-server', info };
    const checked = await checkPairingDetailed(deps.origin, paired.token, { fetch: deps.fetch, signal, now });
    current.details = checked.details;
    const check = checked.result;
    switch (check.kind) {
      case 'ok':
        return { kind: 'connected', info };
      case 'unpaired':
        return { kind: 'revoked', info, token: paired.token };
      case 'error':
        return { kind: 'pairing-error', info };
      case 'aborted':
        return { kind: 'aborted' };
    }
  }

  /**
   * After a failed CORS probe: one `no-cors` request (which carries nothing) tells whether anything
   * answers on the port at all. Only while it cannot be the request that shows the permission
   * prompt (granted, or no such permission in this browser).
   */
  async function withoutCors(current: Probe, permission: LoopbackPermission): Promise<Outcome> {
    if (deps.noCorsFallback === false || (permission !== 'granted' && permission !== 'unsupported') || !running()) return { kind: 'unreachable' };
    const answer = await probeHealthWithoutCors(deps.origin, { fetch: deps.fetch, signal: current.abort.signal, now });
    if (answer.result === 'aborted') return { kind: 'aborted' };
    return answer.result === 'answers' ? { kind: 'unreachable', cause: 'answers-without-cors' } : { kind: 'unreachable' };
  }

  function enterWaitingPermission(): void {
    waitingSince = now();
    cancelSchedule();
    update({ status: 'waiting-permission' }, { reason: 'permission-prompt' });
  }

  function leaveWaitingPermission(at: number): void {
    if (waitingSince === null) return;
    if (graceStart !== null) gracePaused += at - waitingSince;
    waitingSince = null;
  }

  function graceElapsed(at: number): number {
    if (graceStart === null) return 0;
    return at - graceStart - gracePaused - (waitingSince === null ? 0 : at - waitingSince);
  }

  function settle(current: Probe, result: Outcome): void {
    clearTimer(current.timeout);
    clearTimer(current.wait);
    if (probe === current) probe = null;
    if (!running()) return;
    let outcome = result;
    if (outcome.kind === 'aborted') {
      // Only our own timeout aborts a probe while running; anything else learned nothing.
      if (!current.timedOut) return;
      outcome = recentResponse(now()) ? { kind: 'inconclusive' } : { kind: 'unreachable' };
    }
    const status = statusAfter(outcome, current);
    apply(outcome, current, status, reportProbe(outcome, current, status));
  }

  /** The status a settled probe leads to (what `apply` sets). */
  function statusAfter(outcome: Exclude<Outcome, { kind: 'aborted' }>, current: Probe): LocalServerStatus {
    switch (outcome.kind) {
      case 'inconclusive':
        // The server answered recently: a slow probe proves nothing, the status stays.
        return state.status === 'checking' || state.status === 'waiting-permission' ? current.statusBefore : state.status;
      case 'unreachable':
      case 'pairing-error':
        return deps.backend === 'server' ? 'reconnecting' : 'absent';
      case 'denied':
        return 'blocked';
      case 'unpaired':
        // "Pairing removed" stays until the user checks again.
        return current.statusBefore === 'revoked' && !current.manual ? 'revoked' : 'unpaired';
      default:
        return outcome.kind;
    }
  }

  /** Why a probe ended as it did, as the diagnostic `reason`. */
  function probeReason(outcome: Exclude<Outcome, { kind: 'aborted' }>, current: Probe): string {
    if (outcome.kind === 'unreachable') return outcome.cause ?? (current.timedOut ? 'timeout' : 'unreachable');
    return outcome.kind;
  }

  /**
   * Reports a settled probe: debug every time; info when it ended differently from the last one but
   * leaves the status (`status`, what it leads to) as it was — a status change's event carries the
   * probe's fields — and not for a page load's first probe (its status event says whether that
   * needs attention); warn for a pairing check that started failing or a revoked pairing. Returns
   * the cause its status change is reported with.
   */
  function reportProbe(outcome: Exclude<Outcome, { kind: 'aborted' }>, current: Probe, status: LocalServerStatus): StatusCause {
    const reason = probeReason(outcome, current);
    const details = current.details;
    const probe: HybridDiagFields = {
      kind: outcome.kind,
      httpStatus: details?.httpStatus ?? null,
      ms: Math.max(0, now() - current.startedAt),
      timedOut: current.timedOut,
      errName: details?.errName ?? null,
      permission: state.permission,
    };
    const signature = `${reason}|${String(probe.httpStatus)}|${String(probe.errName)}`;
    const first = lastProbeSignature === null;
    const changed = signature !== lastProbeSignature;
    lastProbeSignature = signature;
    const fields = { ...probe, reason };
    if (outcome.kind === 'pairing-error') diag(changed ? 'warn' : 'debug', 'pairing check failed', fields);
    else if (outcome.kind === 'revoked') diag('warn', 'pairing revoked by Homebase on this PC', fields);
    else diag(changed && !first && outcome.kind !== 'inconclusive' && status === settledStatus ? 'info' : 'debug', 'probe result', fields);
    return { reason, probe };
  }

  function apply(outcome: Exclude<Outcome, { kind: 'aborted' }>, current: Probe, status: LocalServerStatus, cause: StatusCause): void {
    const at = now();
    leaveWaitingPermission(at);
    if (outcome.kind === 'inconclusive') {
      // The server answered recently: a slow probe proves nothing. Keep the status, retry soon.
      update({ status }, cause);
      schedule(BACKOFF_MS[0] ?? RECONNECT_INTERVAL_MS, 'retry');
      return;
    }
    const server = deps.backend === 'server';
    if ('info' in outcome) setServer(outcome.info);
    const unreachableReason: LocalServerUnreachableReason | null = outcome.kind === 'unreachable' && outcome.cause === 'answers-without-cors' ? outcome.cause : null;
    if (unreachableReason === null) update({ unreachableReason: null });
    switch (outcome.kind) {
      case 'unreachable':
      case 'pairing-error':
        if (server) reconnecting(at, cause, unreachableReason);
        else {
          update({ status, unreachableReason }, cause);
          dropSwitch('server');
        }
        break;
      case 'denied':
        update({ status }, cause);
        if (server) requestModeSwitch('browser', 'blocked');
        else dropSwitch('server');
        break;
      case 'incompatible':
        update({ status }, cause);
        if (server) requestModeSwitch('browser', 'incompatible');
        else dropSwitch('server');
        break;
      case 'unpaired':
        lastHealthyAt = at;
        update({ status }, cause);
        if (server) requestModeSwitch('browser', 'disconnected');
        else dropSwitch('server');
        break;
      case 'other-server':
        lastHealthyAt = at;
        update({ status }, cause);
        if (server) requestModeSwitch('browser', 'other-server');
        else dropSwitch('server');
        break;
      case 'revoked':
        lastHealthyAt = at;
        store.clear(outcome.token);
        record = store.read();
        update({ status, paired: record !== null }, cause);
        if (server) requestModeSwitch('browser', 'revoked');
        else dropSwitch('server');
        break;
      case 'connected':
        lastHealthyAt = at;
        lastResponseAt = at;
        backoffStep = 0;
        if (graceStart !== null) diag('info', 'reconnect grace ended', { reason: 'connected', graceMs: graceElapsed(at) });
        graceStart = null;
        gracePaused = 0;
        store.setLastMode('server');
        markSeen(at);
        update({ status }, cause);
        if (!server) requestModeSwitch('server', 'connected');
        // The server this page's data came from is back: a switch away is no longer needed.
        else if (outcome.info.instanceId === bootInstanceId) dropSwitch('browser');
        // Paired with another server meanwhile (another tab): its data is not this page's.
        else requestModeSwitch('browser', 'other-server');
        break;
    }
    update({ checkedAt: at });
    scheduleNext();
  }

  /** A server-backend page lost the server: reconnect, and give up after the grace. */
  function reconnecting(at: number, cause: StatusCause, unreachableReason: LocalServerUnreachableReason | null): void {
    if (graceStart === null) {
      graceStart = at;
      gracePaused = 0;
      diag('warn', 'reconnect grace started', { reason: cause.reason, graceMs: GRACE_MS });
    }
    update({ status: 'reconnecting', unreachableReason }, cause);
    if (graceElapsed(at) < GRACE_MS || switchRequest !== null) return;
    // A hidden tab may have been asleep: it re-probes once it is visible before giving up.
    if (!deps.page.visible()) return diag('debug', 'reconnect grace over, waiting until the tab is visible', { graceMs: graceElapsed(at) });
    // Another tab reached the server within the grace (this page's own sightings are older): it is
    // likely back, and the next load would start on it anyway. Keep reconnecting until nobody has
    // seen it for the grace, so that the switch, its toast and the next load all say `browser`.
    const seen = store.lastServerSeenAt();
    if (seen !== null && at - seen < GRACE_MS) return diag('debug', 'reconnect grace over, another tab saw the server recently', { graceMs: graceElapsed(at) });
    diag('warn', 'reconnect grace ended', { reason: 'expired', graceMs: graceElapsed(at) });
    requestModeSwitch('browser', 'unreachable');
  }

  /** Writes that the paired server answered (at most once a minute). */
  function markSeen(at: number): void {
    if (lastSeenWriteAt !== null && at - lastSeenWriteAt < SEEN_WRITE_INTERVAL_MS) return;
    lastSeenWriteAt = at;
    store.setLastServerSeenAt(at);
    store.setLastMode('server');
  }

  // -- switching backend -------------------------------------------------------------------

  /**
   * Writes what the next page load decides its backend from (`boot.ts`) so that it picks
   * `target`. False when storage refused it: a reload would then come back to this backend.
   */
  function persistNextBackend(target: Backend): boolean {
    store.setLastMode(target);
    if (store.nextBootBackend(now()) === target) return true;
    // A full storage refuses even the few bytes of a new or longer value, but never a removal:
    // without both hints the next load starts on the browser (and on the server when it was
    // seen recently, which a connected probe has just written).
    store.setLastMode(null);
    if (target === 'browser') store.setLastServerSeenAt(null);
    return store.nextBootBackend(now()) === target;
  }

  function requestModeSwitch(target: Backend, reason: PendingSwitchReason): void {
    if (reloading || target === deps.backend || switchRequest !== null) return;
    switchRequest = { target, reason };
    switchDeferredReported = false;
    diag('info', 'backend switch requested', { target, reason });
    // Now too, in case this tab closes before the reload.
    persistNextBackend(target);
    wake();
    if (!deps.page.visible()) return reload(false);
    if (!deps.isBusy()) return reload(true);
    reportDeferred('busy');
    update({ pendingSwitch: switchRequest });
    pollUntilIdle();
  }

  /** The pending switch waits (once per switch): the page is busy, or storage refused the hints. */
  function reportDeferred(kind: 'busy' | 'hints-refused'): void {
    if (switchDeferredReported || switchRequest === null) return;
    switchDeferredReported = true;
    diag('info', 'backend switch deferred', { target: switchRequest.target, reason: switchRequest.reason, kind });
  }

  function pollUntilIdle(): void {
    if (busyTimer !== null) return;
    busyTimer = setTimer(() => {
      busyTimer = null;
      if (switchRequest === null || reloading || stopped) return;
      if (!deps.page.visible()) reload(false);
      else if (!deps.isBusy()) reload(true);
      if (!reloading) pollUntilIdle();
    }, BUSY_POLL_MS);
  }

  /** Withdraws a requested switch towards `target` (the reason for it went away before the reload). */
  function dropSwitch(target: Backend): void {
    if (switchRequest?.target !== target || reloading) return;
    diag('info', 'backend switch withdrawn', { target, reason: switchRequest.reason });
    switchRequest = null;
    clearTimer(busyTimer);
    busyTimer = null;
    update({ pendingSwitch: null });
    wake();
  }

  function haltTimers(): void {
    cancelSchedule();
    clearTimer(busyTimer);
    busyTimer = null;
    if (probe !== null) {
      clearTimer(probe.timeout);
      clearTimer(probe.wait);
    }
  }

  /**
   * Applies the requested switch: writes the hints again (other tabs and this page's own probes may
   * have changed them while it waited) and reloads (`announce`: the next load shows what
   * happened). Unless the user asked (`user`), only when the next load does start on the other
   * backend: otherwise the switch stays pending (Switch now) and the idle poll retries.
   */
  function reload(announce: boolean, user = false): void {
    if (reloading || switchRequest === null) return;
    const persisted = persistNextBackend(switchRequest.target);
    if (!persisted && !user) {
      reportDeferred('hints-refused');
      update({ pendingSwitch: switchRequest });
      return pollUntilIdle();
    }
    reloading = true;
    haltTimers();
    probe?.abort.abort();
    if (announce && persisted) writeItem(deps.sessionStorage, MODE_SWITCH_TOAST_KEY, `${switchRequest.target}:${switchRequest.reason}`);
    // Recorded (and stored) before the reload: the next page load shows it.
    diag('info', 'backend switch performed', { target: switchRequest.target, reason: switchRequest.reason, kind: user ? 'user' : announce ? 'idle' : 'hidden' });
    wake();
    deps.reload();
  }

  // -- events ------------------------------------------------------------------------------

  function onPageEvent(event: PageEvent): void {
    if (!running()) return;
    if (event === 'hidden') {
      // Nobody is looking: apply a waiting switch now.
      if (switchRequest !== null) reload(false);
      return;
    }
    if (event === 'visible' && switchRequest !== null && !deps.isBusy()) reload(true);
    if (reloading) return;
    backoffStep = 0;
    void kick('event');
  }

  function onPermissionChange(permission: LoopbackPermission): void {
    if (!running()) return;
    if (permission !== state.permission) diag('info', 'local network permission changed', { from: state.permission, to: permission });
    update({ permission });
    if (probe !== null) {
      // The probe in flight settles on its own (a denial fails it at once); once granted, it may time out.
      if (permission === 'granted' && probe.timeout === null) {
        clearTimer(probe.wait);
        probe.wait = null;
        armTimeout(probe);
      }
      return;
    }
    if (record === null) {
      if (permission === 'denied') update({ status: 'blocked' }, { reason: 'permission' });
      else if (state.status === 'blocked') update({ status: 'idle' }, { reason: 'permission' });
    }
    backoffStep = 0;
    void kick('change');
  }

  function onPairingChange(): void {
    if (!running()) return;
    const next = store.read();
    if (next?.token === record?.token && next?.instanceId === record?.instanceId) return;
    diag('info', 'pairing changed in another tab', { kind: next === null ? 'removed' : record === null ? 'added' : 'replaced' });
    record = next;
    update({ paired: record !== null });
    if (deps.backend === 'server') {
      // Another tab disconnected, or paired with another server: this page's data is not the right one.
      if (record === null) {
        update({ status: 'unpaired', unreachableReason: null }, { reason: 'pairing-removed' });
        return requestModeSwitch('browser', 'disconnected');
      }
      if (record.instanceId !== bootInstanceId) return requestModeSwitch('browser', 'other-server');
    } else if (record === null) {
      dropSwitch('server');
      if (state.status === 'connected' || state.status === 'other-server') update({ status: unpairedStatus() }, { reason: 'pairing-removed' });
    }
    backoffStep = 0;
    void kick('change');
  }

  // -- actions -----------------------------------------------------------------------------

  function checkNow(): void {
    if (!running()) return;
    backoffStep = 0;
    void kick('manual');
  }

  async function beginPairing(): Promise<void> {
    if (!running()) return;
    if (!healthyRecently() || !PAIRABLE_STATUSES.has(state.status)) await kick('manual');
    if (!running() || !healthyRecently() || !PAIRABLE_STATUSES.has(state.status)) return;
    diag('info', 'pairing started', { from: state.status });
    startPairing(validateAppUrl(state.server?.appUrl) ?? `${deps.origin}/`, {
      session: deps.sessionStorage,
      random: deps.random,
      assign: deps.assign,
    });
  }

  /**
   * Asks the paired server to forget `paired` (best effort, at most 3 s in all). Only when the
   * Homebase answering on the port right now is that server: another one never sees the token.
   */
  async function forgetOnServer(paired: PairingRecord): Promise<void> {
    const abort = new AbortController();
    const timer = setTimer(() => abort.abort(), DISCONNECT_TIMEOUT_MS);
    try {
      const health = await probeHealth(deps.origin, { fetch: deps.fetch, signal: abort.signal });
      if (health.kind !== 'ok' || health.health.instanceId !== paired.instanceId) return;
      const init: LoopbackRequestInit = { ...LOOPBACK_REQUEST_INIT, method: 'DELETE', cache: 'no-store', headers: pairedHeaders(paired.token), signal: abort.signal };
      await deps.fetch(`${deps.origin}/api/pairing`, init);
    } catch {
      // Best effort: the server's page lists and revokes pairings too.
    } finally {
      clearTimer(timer);
    }
  }

  /** The status of a page that is not paired (any more), until a probe says more. */
  function unpairedStatus(): LocalServerStatus {
    if (state.permission === 'denied') return 'blocked';
    return healthyRecently() ? 'unpaired' : 'idle';
  }

  async function disconnect(): Promise<void> {
    if (!active || reloading || stopped) return;
    const current = record;
    diag('info', 'disconnecting this browser', { reason: 'user' });
    if (current !== null) {
      await forgetOnServer(current);
      store.clear(current.token);
    }
    record = store.read();
    removeItem(deps.localStorage, deps.serverCacheKey);
    store.setLastMode('browser');
    update({ paired: record !== null });
    if (deps.backend === 'server') {
      // The user asked: reload now, busy or not.
      switchRequest = { target: 'browser', reason: 'disconnected' };
      diag('info', 'backend switch requested', { target: 'browser', reason: 'disconnected' });
      return reload(true, true);
    }
    dropSwitch('server');
    update({ status: unpairedStatus(), unreachableReason: null }, { reason: 'disconnected' });
    backoffStep = 0;
    void kick('change');
  }

  const actions: LocalServerActions = Object.freeze({
    checkNow,
    lookForServer: checkNow,
    startPairing: () => {
      void beginPairing();
    },
    disconnect,
    switchNow: () => reload(true, true),
  });

  // -- whenServerReady ---------------------------------------------------------------------

  function readiness(): 'ready' | 'wait' | 'ended' {
    if (deps.backend !== 'server' || stopped || reloading || switchRequest?.target === 'browser') return 'ended';
    if (state.status === 'connected') return 'ready';
    return WAITING_STATUSES.has(state.status) ? 'wait' : 'ended';
  }

  function whenServerReady(signal?: AbortSignal | null): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = (): boolean => {
        if (signal?.aborted) {
          reject(signal.reason ?? abortError());
          return true;
        }
        const verdict = readiness();
        if (verdict === 'wait') return false;
        if (verdict === 'ready') resolve();
        else reject(new ServerModeEndedError());
        return true;
      };
      if (done()) return;
      const check = (): void => {
        if (!done()) return;
        waiters.delete(check);
        signal?.removeEventListener('abort', check);
      };
      waiters.add(check);
      signal?.addEventListener('abort', check);
    });
  }

  // -- lifecycle ---------------------------------------------------------------------------

  function start(): void {
    if (started || stopped || !active) return;
    started = true;
    cleanups.push(deps.page.subscribe(onPageEvent), deps.subscribePairing(onPairingChange), deps.permission.subscribe(onPermissionChange));
    void deps.permission
      .query()
      .catch((): LoopbackPermission => 'unsupported')
      .then((permission) => {
        if (!running()) return;
        diag('debug', 'hybrid controller started', { permission, kind: record === null ? 'not-paired' : 'paired' });
        update({ permission });
        if (record === null && permission === 'denied') update({ status: 'blocked' }, { reason: 'permission' });
        void kick('boot');
      });
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    haltTimers();
    probe?.abort.abort();
    for (const cleanup of cleanups.splice(0)) cleanup();
    wake();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    actions,
    start,
    stop,
    whenServerReady,
    reportResponse() {
      if (deps.backend !== 'server' || !running()) return;
      const at = now();
      lastResponseAt = at;
      if (state.status === 'connected') markSeen(at);
      // Answers again: confirm it right away rather than at the next reconnect tick.
      else if (state.status === 'reconnecting') void kick('response');
    },
    reportNetworkFailure() {
      if (deps.backend !== 'server' || !running()) return;
      diag('debug', 'a request failed at the network level: probing', { reason: 'network' });
      backoffStep = 0;
      void kick('response');
    },
    reportUnpaired() {
      if (deps.backend !== 'server' || !running()) return;
      diag('debug', 'a request was refused: pairing required', { httpStatus: 401, reason: 'pairing_required' });
      // The refusal may come from another Homebase now on the port (which must not cost this browser
      // its pairing with the real one), or be for a token another tab has replaced meanwhile. Take
      // up such a change, then let a probe decide: `other-server` keeps the record, and only the
      // paired server refusing it (`revoked`) clears it.
      onPairingChange();
      backoffStep = 0;
      void kick('change');
    },
    token: () => record?.token ?? null,
  };
}

// ---------------------------------------------------------------------------
// The page's instance (set by boot.ts in the Pages build, hybrid mode on)
// ---------------------------------------------------------------------------

let appController: HybridController | null = null;

/** The page's controller, or null (server build, hybrid mode off, tests). */
export function getAppLocalServerController(): HybridController | null {
  return appController;
}

export function setAppLocalServerController(controller: HybridController | null): void {
  appController = controller;
}
