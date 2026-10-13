// @ts-check
/**
 * Service-worker warm-up (ARCHITECTURE §11): check /api/health once and, if Portly isn't
 * answering, ask the launcher to start it. One request, no polling. A healthy answer also records
 * what Portly says about its Pages site, which the "auto" new tab follows. It runs
 *
 * - when the browser starts (runtime.onStartup) or the extension is installed, updated or
 *   reloaded (runtime.onInstalled);
 * - when a new tab that opens the Pages site asks for it ({type: 'portly:warm-up'} through
 *   runtime.onMessage, only from this extension's own pages). The worker acknowledges at once,
 *   so the tab can navigate away, and then warms up at most once per WARM_UP_THROTTLE_MS: the
 *   time of the last warm-up is kept in chrome.storage.session, which outlives a stopped worker
 *   (and in memory when that storage area is unavailable).
 *
 * Errors are logged and swallowed — a failed warm-up only means the first new tab does the
 * starting (local target), or the Pages site uses this browser's copy until Portly runs.
 */
import { checkHealth, isWarmUpMessage, readPort, rememberServerSite } from './portly.js';
import { PINNED_EXTENSION_ID, START_KIND, createLauncher, isStaleExtensionId } from './launcher.js';

/** A new tab's warm-up request is ignored when a warm-up started less than this long ago. */
export const WARM_UP_THROTTLE_MS = 60000;
/** chrome.storage.session key holding when the last warm-up started (epoch ms). */
export const LAST_WARM_UP_KEY = 'lastWarmUpAt';
/** What the worker answers a warm-up request with, before doing any of the work. */
export const WARM_UP_ACK = Object.freeze({ ok: true });

/**
 * @typedef {(level: 'info' | 'warn', message: string) => void} Log
 *
 * @typedef {object} WarmUpDeps
 * @property {import('./portly.js').StorageAreaLike | null | undefined} storage
 * @property {typeof fetch} fetch
 * @property {import('./launcher.js').Launcher | null} launcher
 * @property {Log} [log]
 * @property {(fn: () => void, ms: number) => unknown} [setTimeout]
 * @property {(handle: any) => void} [clearTimeout]
 * @property {string} [trigger] what caused the warm-up, for the log
 * @property {string | null} [extensionId] chrome.runtime.id, to explain a refused launcher
 *
 * @typedef {object} WarmUpResult
 * @property {number | null} port
 * @property {'already-running' | 'requested-start' | 'no-launcher' | 'error'} action
 * @property {import('./launcher.js').StartOutcome | null} outcome
 */

const noop = () => {};

/**
 * Runs one warm-up. Never rejects.
 * @param {WarmUpDeps} deps
 * @returns {Promise<WarmUpResult>}
 */
export async function warmUp(deps) {
  const log = deps.log ?? noop;
  const trigger = deps.trigger ? ` (${deps.trigger})` : '';
  /** @type {number | null} */
  let port = null;
  try {
    port = await readPort(deps.storage);
    const health = await checkHealth(port, {
      fetch: deps.fetch,
      setTimeout: deps.setTimeout,
      clearTimeout: deps.clearTimeout,
    });
    if (health.ok) {
      log('info', `Portly already answers on port ${port}${trigger}.`);
      await rememberServerSite(deps.storage, port, health);
      return { port, action: 'already-running', outcome: null };
    }
    if (!deps.launcher) {
      log('warn', `Portly isn't answering on port ${port} and native messaging is unavailable${trigger}.`);
      return { port, action: 'no-launcher', outcome: null };
    }
    const outcome = await deps.launcher.start(port);
    const detail = outcome.detail ? `: ${outcome.detail}` : '';
    const level = outcome.kind === START_KIND.running || outcome.kind === START_KIND.starting ? 'info' : 'warn';
    const stale =
      (outcome.kind === START_KIND.mismatch || outcome.kind === START_KIND.notInstalled) && isStaleExtensionId(deps.extensionId)
        ? ` (this extension still runs under its old ID ${deps.extensionId}, not ${PINNED_EXTENSION_ID}: Remove it and Load unpacked again)`
        : '';
    log(level, `Asked the launcher to start Portly on port ${port}${trigger} → ${outcome.kind}${detail}${stale}`);
    return { port, action: 'requested-start', outcome };
  } catch (err) {
    log('warn', `Warm-up failed${trigger}: ${err instanceof Error ? err.message : String(err)}`);
    return { port, action: 'error', outcome: null };
  }
}

/**
 * True when `stamp` (epoch ms) lies less than WARM_UP_THROTTLE_MS before `now`. A stamp in the
 * future (the clock was set back) does not count, so a changed clock can't block warm-ups.
 * @param {unknown} stamp
 * @param {number} now
 */
export function isRecentWarmUp(stamp, now) {
  if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return false;
  const age = now - stamp;
  return age >= 0 && age < WARM_UP_THROTTLE_MS;
}

/**
 * @typedef {{ addListener(listener: (...args: any[]) => void): void }} EventLike
 *
 * @typedef {object} MessageSender the part of chrome.runtime.MessageSender checked here
 * @property {string} [id] the ID of the extension that sent the message
 *
 * @typedef {object} ChromeLike
 * @property {import('./launcher.js').RuntimeLike & { onStartup: EventLike, onInstalled: EventLike, onMessage?: EventLike }} runtime
 * @property {{ local?: import('./portly.js').StorageAreaLike, session?: import('./portly.js').StorageAreaLike }} [storage]
 */

/**
 * Registers the onStartup, onInstalled and onMessage listeners. Call it synchronously from the
 * service worker's top level so the listeners exist before Chrome dispatches the event that woke
 * the worker. Overlapping triggers (onStartup and onInstalled can both fire at browser start, a
 * new tab can ask meanwhile) share one warm-up.
 * @param {ChromeLike} chromeApi
 * @param {{ fetch: typeof fetch, log?: Log, setTimeout?: WarmUpDeps['setTimeout'], clearTimeout?: WarmUpDeps['clearTimeout'], now?: () => number }} deps
 */
export function registerWarmUp(chromeApi, deps) {
  const runtime = chromeApi.runtime;
  const session = chromeApi.storage?.session ?? null;
  const now = deps.now ?? Date.now;
  /** @type {Promise<WarmUpResult> | null} */
  let inFlight = null;
  /**
   * When the last warm-up started, as this worker instance knows it. Checked (and claimed) before
   * any await, so two requests arriving together can't both pass the throttle; storage.session
   * covers a worker that was stopped and started again.
   * @type {number | null}
   */
  let lastStartedAt = null;

  /** @param {number} at */
  function recordStart(at) {
    lastStartedAt = at;
    if (!session) return;
    try {
      void Promise.resolve(session.set({ [LAST_WARM_UP_KEY]: at })).catch(noop);
    } catch {
      // storage.session unavailable: the in-memory stamp still throttles this worker instance.
    }
  }

  /** @returns {Promise<number | null>} */
  async function readLastStart() {
    if (!session) return null;
    try {
      const items = await session.get(LAST_WARM_UP_KEY);
      const stored = items ? items[LAST_WARM_UP_KEY] : undefined;
      return typeof stored === 'number' ? stored : null;
    } catch {
      return null;
    }
  }

  /**
   * Runs a warm-up now (browser start, install/update/reload), or joins the one in flight.
   * @param {string} trigger
   */
  function run(trigger) {
    if (inFlight) return inFlight;
    recordStart(now());
    inFlight = warmUp({
      storage: chromeApi.storage?.local ?? null,
      fetch: deps.fetch,
      launcher: createLauncher(runtime, { setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout }),
      log: deps.log,
      setTimeout: deps.setTimeout,
      clearTimeout: deps.clearTimeout,
      trigger,
      extensionId: runtime.id ?? null,
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /**
   * A new tab's request: joins a warm-up in flight, skips one when the last started less than
   * WARM_UP_THROTTLE_MS ago, else runs one.
   * @param {string} trigger
   * @returns {Promise<WarmUpResult | null>} null when throttled
   */
  async function runIfDue(trigger) {
    if (inFlight) return inFlight;
    const at = now();
    if (isRecentWarmUp(lastStartedAt, at)) return null;
    // Claim the slot before awaiting storage, so a second request arriving meanwhile is skipped.
    lastStartedAt = at;
    const stored = await readLastStart();
    if (isRecentWarmUp(stored, at)) {
      lastStartedAt = stored;
      return null;
    }
    return run(trigger);
  }

  runtime.onStartup.addListener(() => {
    void run('browser start');
  });
  runtime.onInstalled.addListener((/** @type {{ reason?: string } | undefined} */ details) => {
    void run(`extension ${details?.reason ?? 'installed'}`);
  });
  runtime.onMessage?.addListener(
    (
      /** @type {unknown} */ message,
      /** @type {MessageSender | undefined} */ sender,
      /** @type {(response: unknown) => void} */ sendResponse,
    ) => {
      // Only this extension's own pages (it has no content scripts and accepts no external
      // messages, so that means its new tab page).
      const ownId = runtime.id;
      if (!isWarmUpMessage(message) || typeof ownId !== 'string' || ownId === '' || sender?.id !== ownId) return false;
      // Acknowledge synchronously: the tab waits for this, then navigates away.
      sendResponse(WARM_UP_ACK);
      void runIfDue('new tab');
      return false;
    },
  );

  return { run, runIfDue };
}
