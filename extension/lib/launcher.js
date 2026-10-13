// @ts-check
/**
 * Client for the Homebase launcher, the native-messaging host `com.homebase.launcher` that
 * scripts\install-autostart.ps1 registers for Chrome and Edge (ARCHITECTURE §11–§12). The host
 * never runs Homebase itself: it asks Task Scheduler to run the "Homebase Server" task, so the
 * server is not tied to the browser's process tree.
 *
 * Contract (extension → host → extension, one message each way):
 *   {"action":"start","port":5757} → {"ok":true,"state":"running"}   Homebase already answers
 *                                  → {"ok":true,"state":"starting"}  the task was started
 *                                  → {"ok":false,"state":"error","error":"task_missing"|"schtasks_failed"|"bad_request"|"bad_origin","detail":"…"}
 *   {"action":"ping"}              → {"ok":true,"state":"pong","version":1}
 *
 * Browser-side failures arrive as runtime.lastError messages: "…host not found." (not installed),
 * "Access to the specified native messaging host is forbidden." (allowed_origins lacks this
 * extension ID), "Native host has exited." / "Failed to start native messaging host." (it may
 * well have started the task anyway — keep checking /api/health).
 *
 * Every function here resolves; none rejects. Dependencies are injected for `node --test`.
 */
import { isValidPort } from './homebase.js';

export const LAUNCHER_HOST = 'com.homebase.launcher';
export const LAUNCHER_PROTOCOL_VERSION = 1;
/**
 * The ID Chrome and Edge derive from manifest.json's "key" — the only ID the launcher accepts
 * (its allowed_origins). test/extension-id.test.mjs keeps it in sync with the key.
 */
export const PINNED_EXTENSION_ID = 'nbaolbakegefnefgojdokagajincnfjj';
/** How long the options page waits for a ping answer. */
export const PING_TIMEOUT_MS = 10000;
const MAX_DETAIL_LENGTH = 200;

/**
 * What a start request achieved.
 * - running / starting: the host answered; Homebase answers or is on its way.
 * - maybe: no usable answer (host exited, failed to start, odd reply). It may still have started
 *   the task, so callers keep checking /api/health.
 * - not_installed: the host is not registered for this browser.
 * - mismatch: the host does not accept this extension's origin (forbidden / bad_origin).
 * - task_missing: the host runs, but the "Homebase Server" task is not registered.
 * - failed: the host answered with an error (schtasks_failed, bad_request or an unknown code).
 */
export const START_KIND = Object.freeze({
  running: 'running',
  starting: 'starting',
  maybe: 'maybe',
  notInstalled: 'not_installed',
  mismatch: 'mismatch',
  taskMissing: 'task_missing',
  failed: 'failed',
});

/** Outcomes after which polling /api/health is pointless: nothing was started. */
export const START_KINDS_THAT_STOP = Object.freeze(
  new Set([START_KIND.notInstalled, START_KIND.mismatch, START_KIND.taskMissing, START_KIND.failed]),
);

export const PING_STATUS = Object.freeze({
  installed: 'installed',
  notInstalled: 'not_installed',
  mismatch: 'mismatch',
  broken: 'broken',
});

/**
 * @typedef {object} RuntimeLike
 * @property {(host: string, message: object, callback: (response: unknown) => void) => void} sendNativeMessage
 * @property {{ message?: string } | undefined | null} [lastError]
 * @property {string} [id]
 *
 * @typedef {{ response: unknown } | { error: string, timedOut?: boolean }} NativeReply
 *
 * @typedef {object} StartOutcome
 * @property {string} kind one of START_KIND
 * @property {string | null} code the host's error code or the browser's error category
 * @property {string} detail short, single-line text for humans ('' when there is nothing to add)
 *
 * @typedef {object} PingOutcome
 * @property {string} status one of PING_STATUS
 * @property {number | null} version the host's protocol version when it answered
 * @property {string} detail
 *
 * @typedef {object} TimerDeps
 * @property {(fn: () => void, ms: number) => unknown} [setTimeout]
 * @property {(handle: any) => void} [clearTimeout]
 */

/**
 * True when the browser runs this extension under an ID other than the pinned one. That is the
 * extension still registered under its pre-0.2.0, folder-derived ID (it was reloaded or kept
 * rather than removed and loaded unpacked again). The launcher refuses such an ID, and running
 * the installer again cannot fix it: only Remove + Load unpacked does.
 * @param {unknown} id chrome.runtime.id
 */
export function isStaleExtensionId(id) {
  return typeof id === 'string' && /^[a-p]{32}$/.test(id) && id !== PINNED_EXTENSION_ID;
}

/** The start request for a validated port. */
export function startRequest(port) {
  if (!isValidPort(port)) throw new RangeError(`Invalid port: ${String(port)}`);
  return { action: 'start', port };
}

export function pingRequest() {
  return { action: 'ping' };
}

/**
 * One line of at most 200 characters with control, line-separator and bidi-override characters
 * removed (so a detail can't reorder the sentence around it). Output always goes through
 * textContent, so this is about readability, not escaping.
 * @param {unknown} value
 */
export function cleanDetail(value) {
  if (typeof value !== 'string') return '';
  const text = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text;
}

function errorText(err) {
  if (err && typeof err === 'object' && typeof (/** @type {{message?: unknown}} */ (err).message) === 'string') {
    return /** @type {{message: string}} */ (err).message;
  }
  return String(err);
}

/**
 * Sends one message to the launcher with the callback form of runtime.sendNativeMessage (works
 * in every Chromium MV3 version; lastError is read inside the callback so it never surfaces as
 * "Unchecked runtime.lastError"). Never rejects.
 * @param {RuntimeLike} runtime
 * @param {object} message
 * @param {TimerDeps & { timeoutMs?: number }} [options]
 * @returns {Promise<NativeReply>}
 */
export function sendNative(runtime, message, options = {}) {
  const setTimer = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  return new Promise((resolve) => {
    let settled = false;
    /** @type {unknown} */
    let timer = null;
    /** @param {NativeReply} reply */
    const finish = (reply) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimer(timer);
      resolve(reply);
    };
    if (options.timeoutMs !== undefined) {
      timer = setTimer(() => finish({ error: 'The launcher did not answer in time.', timedOut: true }), options.timeoutMs);
    }
    try {
      runtime.sendNativeMessage(LAUNCHER_HOST, message, (response) => {
        const lastError = runtime.lastError;
        if (lastError) finish({ error: errorText(lastError) });
        else finish({ response });
      });
    } catch (err) {
      finish({ error: errorText(err) });
    }
  });
}

/**
 * Maps a browser-side native-messaging error message to a START_KIND.
 * @param {string} message
 */
export function classifyNativeError(message) {
  const text = String(message).toLowerCase();
  if (text.includes('not found')) return START_KIND.notInstalled;
  if (text.includes('forbidden')) return START_KIND.mismatch;
  // "Native host has exited.", "Failed to start native messaging host.", I/O errors, timeouts.
  return START_KIND.maybe;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {NativeReply} reply
 * @returns {StartOutcome}
 */
export function interpretStartReply(reply) {
  if ('error' in reply) {
    const kind = classifyNativeError(reply.error);
    const code = reply.timedOut ? 'timeout' : kind === START_KIND.maybe ? 'host_error' : kind;
    return { kind, code, detail: cleanDetail(reply.error) };
  }
  const response = /** @type {Record<string, unknown>} */ (reply.response);
  if (isObject(response)) {
    if (response.ok === true && response.state === 'running') return { kind: START_KIND.running, code: null, detail: '' };
    if (response.ok === true && response.state === 'starting') return { kind: START_KIND.starting, code: null, detail: '' };
    if (response.ok === false) {
      const detail = cleanDetail(response.detail);
      const code = typeof response.error === 'string' ? cleanDetail(response.error) : 'unknown';
      if (code === 'task_missing') return { kind: START_KIND.taskMissing, code, detail };
      if (code === 'bad_origin') return { kind: START_KIND.mismatch, code, detail };
      return { kind: START_KIND.failed, code: code === '' ? 'unknown' : code, detail };
    }
  }
  return { kind: START_KIND.maybe, code: 'unexpected_reply', detail: 'The launcher sent an unexpected reply.' };
}

/**
 * @param {NativeReply} reply
 * @returns {PingOutcome}
 */
export function interpretPingReply(reply) {
  if ('error' in reply) {
    const kind = classifyNativeError(reply.error);
    const status =
      kind === START_KIND.notInstalled ? PING_STATUS.notInstalled : kind === START_KIND.mismatch ? PING_STATUS.mismatch : PING_STATUS.broken;
    return { status, version: null, detail: cleanDetail(reply.error) };
  }
  const response = /** @type {Record<string, unknown>} */ (reply.response);
  if (isObject(response)) {
    if (response.ok === true && response.state === 'pong') {
      const version = typeof response.version === 'number' && Number.isInteger(response.version) ? response.version : null;
      return { status: PING_STATUS.installed, version, detail: '' };
    }
    if (response.ok === false && response.error === 'bad_origin') {
      return { status: PING_STATUS.mismatch, version: null, detail: cleanDetail(response.detail) };
    }
    if (response.ok === false) {
      const code = typeof response.error === 'string' ? cleanDetail(response.error) : 'error';
      const detail = cleanDetail(response.detail);
      return { status: PING_STATUS.broken, version: null, detail: detail === '' ? code : `${code}: ${detail}` };
    }
  }
  return { status: PING_STATUS.broken, version: null, detail: 'The launcher sent an unexpected reply.' };
}

/**
 * @typedef {object} Launcher
 * @property {(port: number) => Promise<StartOutcome>} start
 * @property {() => Promise<PingOutcome>} ping
 */

/**
 * A launcher bound to chrome.runtime, or null when native messaging is unavailable (no
 * permission, not an extension context, tests without a runtime).
 * @param {RuntimeLike | null | undefined} runtime
 * @param {TimerDeps & { pingTimeoutMs?: number, startTimeoutMs?: number }} [options]
 * @returns {Launcher | null}
 */
export function createLauncher(runtime, options = {}) {
  if (!runtime || typeof runtime.sendNativeMessage !== 'function') return null;
  const timers = { setTimeout: options.setTimeout, clearTimeout: options.clearTimeout };
  return {
    async start(port) {
      if (!isValidPort(port)) return { kind: START_KIND.failed, code: 'bad_request', detail: `Invalid port ${String(port)}.` };
      const reply = await sendNative(runtime, startRequest(port), { ...timers, timeoutMs: options.startTimeoutMs });
      return interpretStartReply(reply);
    },
    async ping() {
      const reply = await sendNative(runtime, pingRequest(), { ...timers, timeoutMs: options.pingTimeoutMs ?? PING_TIMEOUT_MS });
      return interpretPingReply(reply);
    },
  };
}
