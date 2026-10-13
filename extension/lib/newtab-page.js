// @ts-check
/**
 * New-tab page controller (ARCHITECTURE §11). Reads the settings and works out where to go
 * (resolveNewTab: the "auto" default follows what Portly on this PC last said about its Pages
 * site), then:
 *
 * Pages site: asks the service worker to warm up Portly on this PC ({type: 'portly:warm-up'};
 * it starts Portly through the launcher when it isn't running and records what it says about
 * its Pages site), waits at most WARM_UP_ACK_TIMEOUT_MS for the acknowledgement and opens the
 * Pages site. The site itself finds Portly on this PC; this page never contacts it.
 *
 * Portly on this PC (the local target, and auto/pages while no Pages site is known): checks
 * /api/health on the configured port:
 *
 * - Portly answers → record what it says about its Pages site, then redirect to that site when
 *   it names one and the target isn't local, else to Portly itself.
 * - It doesn't, and the Portly launcher (native messaging) is available → ask the launcher to
 *   start it once, show "Starting Portly…" and poll /api/health every 400 ms for up to 30 s,
 *   then redirect. If the launcher can't help (not installed, ID mismatch, task missing, task
 *   failed to start) or Portly doesn't answer in time, show the fallback with what to do.
 * - Otherwise → the "Portly isn't running" fallback with a Google search box, Retry and a
 *   short automatic re-check.
 *
 * All DOM output uses textContent/attributes — never HTML strings. Dependencies are injected so
 * the controller runs against newtab.html in jsdom under `node --test`.
 */
import {
  DEFAULT_PORT,
  TARGET,
  WARM_UP_MESSAGE_TYPE,
  checkHealth,
  describeFailure,
  googleSearchUrl,
  portlyOrigin,
  newTabUrl,
  readSettings,
  rememberServerSite,
  resolveNewTab,
} from './portly.js';
import { forwardedHash } from './add-page.js';
import { PINNED_EXTENSION_ID, START_KIND, START_KINDS_THAT_STOP, isStaleExtensionId } from './launcher.js';

/**
 * Pages target: how long the tab waits for the service worker to acknowledge the warm-up request
 * before it opens the Pages site anyway.
 */
export const WARM_UP_ACK_TIMEOUT_MS = 300;

/** Automatic re-checks after a failure: every 5 s, at most 12 times (one minute). */
export const AUTO_RETRY_INTERVAL_MS = 5000;
export const AUTO_RETRY_MAX_ATTEMPTS = 12;

/** While the launcher starts Portly: poll every 400 ms, give up after 30 s. */
export const LAUNCH_POLL_INTERVAL_MS = 400;
export const LAUNCH_TIMEOUT_MS = 30000;
/** When the "Starting Portly…" text admits it is taking a while. */
export const LAUNCH_SLOW_AFTER_MS = 10000;

export const STATE = Object.freeze({
  checking: 'checking',
  starting: 'starting',
  offline: 'offline',
  redirecting: 'redirecting',
});

/** Which "how to start Portly" section the fallback shows (newtab.html `data-help`). */
export const HELP = Object.freeze({
  manual: 'manual',
  install: 'install',
  reinstall: 'reinstall',
  /** The extension still runs under its old ID: Remove + Load unpacked (the installer can't fix it). */
  reload: 'reload',
});

export const STARTING_TEXT = 'This usually takes a few seconds. This tab opens Portly as soon as it answers.';
export const STARTING_SLOW_TEXT = 'Still starting… This can take a little longer right after Windows starts.';

/**
 * @typedef {import('./launcher.js').StartOutcome} StartOutcome
 * @typedef {import('./portly.js').HealthFailure} HealthFailure
 *
 * @typedef {object} LaunchEnd why a start attempt ended without Portly answering
 * @property {'timeout' | 'launcher'} reason
 * @property {StartOutcome | null} outcome the launcher's answer, if it gave one
 */

/** "prefix: detail." or "prefix." */
function sentence(prefix, detail) {
  const text = (detail ?? '').trim().replace(/[.\s]+$/, '');
  return text === '' ? `${prefix}.` : `${prefix}: ${text}.`;
}

/**
 * The fallback's message and help section after a start attempt that did not bring Portly up.
 * @param {LaunchEnd} end
 * @param {number} [timeoutMs]
 * @param {string | null} [extensionId] chrome.runtime.id, to spot an extension still running
 *   under its pre-0.2.0 ID
 * @returns {{ message: string, help: string }}
 */
export function describeLaunchEnd(end, timeoutMs = LAUNCH_TIMEOUT_MS, extensionId = null) {
  const outcome = end.outcome;
  if (
    end.reason === 'launcher' &&
    isStaleExtensionId(extensionId) &&
    (outcome?.kind === START_KIND.mismatch || outcome?.kind === START_KIND.notInstalled)
  ) {
    return {
      message:
        "New tabs can't start Portly: the browser still runs this extension under its old ID, and the launcher only answers the extension's fixed ID.",
      help: HELP.reload,
    };
  }
  if (end.reason === 'timeout') {
    const seconds = Math.round(timeoutMs / 1000);
    if (outcome && outcome.kind === START_KIND.running) {
      return {
        message: `The launcher says Portly is running, but this page couldn't reach it within ${seconds} seconds.`,
        help: HELP.manual,
      };
    }
    let message = `Portly didn't answer within ${seconds} seconds of being started.`;
    if (outcome && outcome.kind === START_KIND.maybe && outcome.detail) {
      message += ` ${sentence('The launcher reported', outcome.detail)}`;
    }
    return { message, help: HELP.manual };
  }
  switch (outcome?.kind) {
    case START_KIND.notInstalled:
      return { message: "New tabs can't start Portly yet: the Portly launcher isn't installed.", help: HELP.install };
    case START_KIND.mismatch:
      return {
        message: "New tabs can't start Portly: the launcher is installed but doesn't accept this extension's ID.",
        help: HELP.reinstall,
      };
    case START_KIND.taskMissing:
      return {
        message: "New tabs can't start Portly: the Portly Server scheduled task isn't registered.",
        help: HELP.install,
      };
    default: {
      const prefix =
        outcome?.code === 'schtasks_failed'
          ? "Windows couldn't start the Portly Server task"
          : outcome?.code === 'bad_request'
            ? 'The launcher rejected the start request'
            : "The launcher couldn't start Portly";
      return { message: sentence(prefix, outcome?.detail), help: HELP.manual };
    }
  }
}

/**
 * @typedef {object} NewTabEnv
 * @property {Document} document
 * @property {{ replace(url: string): void, assign(url: string): void }} location
 * @property {import('./portly.js').StorageAreaLike | null | undefined} storage
 * @property {typeof fetch} fetch
 * @property {import('./launcher.js').Launcher | null} [launcher] null/absent: never try to start Portly
 * @property {((message: object) => unknown) | null} [sendMessage] chrome.runtime.sendMessage (the
 *   promise form), to ask the service worker for a warm-up; null/absent: open the Pages site at once
 * @property {string | null} [extensionId] chrome.runtime.id, shown in the ID-mismatch help
 * @property {string} [hash] this page's location.hash: an add-bookmark request (the toolbar
 *   button, lib/add-page.js) is passed on to Portly; anything else is dropped
 * @property {(fn: () => void, ms: number) => unknown} [setTimeout]
 * @property {(handle: any) => void} [clearTimeout]
 * @property {number} [autoRetryIntervalMs]
 * @property {number} [autoRetryMaxAttempts]
 * @property {number} [launchPollIntervalMs]
 * @property {number} [launchTimeoutMs]
 * @property {number} [launchSlowAfterMs]
 * @property {number} [warmUpAckTimeoutMs]
 */

/** @param {NewTabEnv} env */
export function createNewTabPage(env) {
  const doc = env.document;
  const setTimer = env.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = env.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const retryIntervalMs = env.autoRetryIntervalMs ?? AUTO_RETRY_INTERVAL_MS;
  const retryMaxAttempts = env.autoRetryMaxAttempts ?? AUTO_RETRY_MAX_ATTEMPTS;
  const pollIntervalMs = env.launchPollIntervalMs ?? LAUNCH_POLL_INTERVAL_MS;
  const launchTimeoutMs = env.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;
  const slowAfterMs = env.launchSlowAfterMs ?? LAUNCH_SLOW_AFTER_MS;
  const ackTimeoutMs = env.warmUpAckTimeoutMs ?? WARM_UP_ACK_TIMEOUT_MS;
  const launcher = env.launcher ?? null;
  const passOn = forwardedHash(env.hash);

  /** @param {string} id */
  function byId(id) {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`newtab.html is missing #${id}`);
    return node;
  }

  const els = {
    detail: byId('status-detail'),
    launchStatus: byId('launch-status'),
    launch: /** @type {HTMLButtonElement} */ (byId('launch')),
    retry: /** @type {HTMLButtonElement} */ (byId('retry')),
    retryNote: byId('retry-note'),
    startingDetail: byId('starting-detail'),
    form: /** @type {HTMLFormElement} */ (byId('search-form')),
    query: /** @type {HTMLInputElement} */ (byId('search-query')),
  };
  for (const help of Object.values(HELP)) {
    if (!doc.querySelector(`[data-help="${help}"]`)) throw new Error(`newtab.html is missing [data-help="${help}"]`);
  }

  let port = DEFAULT_PORT;
  /** @type {string | null} the configured target (one of TARGET), once the settings are read */
  let target = null;
  /** @type {'pages' | 'local' | null} where this tab went or is checking, once decided */
  let opens = null;
  /** @type {import('./portly.js').ServerSite | null} the stored record of the server's Pages site */
  let knownSite = null;
  let checking = false;
  let redirected = false;
  let destroyed = false;
  let autoAttempts = 0;
  /** @type {unknown} */
  let retryTimer = null;

  // Start attempts (one launcher request each).
  let launching = false;
  let launchSeq = 0;
  let launchCount = 0;
  let deadlinePassed = false;
  /** Sequence number of the launch whose poll is in flight, if any. */
  let pollInFlightFor = 0;
  /** @type {unknown} */
  let pollTimer = null;
  /** @type {unknown} */
  let deadlineTimer = null;
  /** @type {unknown} */
  let slowTimer = null;
  /** @type {StartOutcome | null} */
  let hostOutcome = null;
  /** @type {LaunchEnd | null} */
  let lastLaunchEnd = null;
  /** @type {HealthFailure | null} */
  let lastFailure = null;

  function setState(/** @type {string} */ state) {
    doc.documentElement.dataset.state = state;
  }

  function renderPort() {
    const origin = portlyOrigin(port);
    for (const node of doc.querySelectorAll('[data-portly-url]')) node.textContent = origin;
  }

  function renderExtensionId() {
    const id = env.extensionId || 'unknown';
    for (const node of doc.querySelectorAll('[data-extension-id]')) node.textContent = id;
    for (const node of doc.querySelectorAll('[data-pinned-id]')) node.textContent = PINNED_EXTENSION_ID;
  }

  function setBusy(/** @type {boolean} */ busy) {
    els.retry.disabled = busy;
    els.retry.textContent = busy ? 'Checking…' : 'Retry';
    els.retry.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function showHelp(/** @type {string} */ kind) {
    for (const node of doc.querySelectorAll('[data-help]')) {
      /** @type {HTMLElement} */ (node).hidden = node.getAttribute('data-help') !== kind;
    }
  }

  function renderLaunchEnd() {
    if (lastLaunchEnd === null) {
      els.launchStatus.textContent = '';
      els.launchStatus.hidden = true;
      showHelp(HELP.manual);
      return;
    }
    const { message, help } = describeLaunchEnd(lastLaunchEnd, launchTimeoutMs, env.extensionId ?? null);
    els.launchStatus.textContent = message;
    els.launchStatus.hidden = false;
    showHelp(help);
  }

  function cancelAutoRetry() {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  function clearLaunchTimers() {
    for (const timer of [pollTimer, deadlineTimer, slowTimer]) if (timer !== null) clearTimer(timer);
    pollTimer = null;
    deadlineTimer = null;
    slowTimer = null;
  }

  /** The user is typing a search: never yank the page away from under them. */
  function userIsSearching() {
    return els.query.value.trim() !== '' || doc.activeElement === els.query;
  }

  function scheduleAutoRetry() {
    cancelAutoRetry();
    if (autoAttempts >= retryMaxAttempts) {
      els.retryNote.textContent = 'Stopped checking automatically. Press Retry once Portly is running.';
      return;
    }
    els.retryNote.textContent = `Checking again automatically every ${retryIntervalMs / 1000} seconds…`;
    retryTimer = setTimer(onAutoRetry, retryIntervalMs);
  }

  function onAutoRetry() {
    retryTimer = null;
    if (redirected || launching) return;
    if (userIsSearching()) {
      retryTimer = setTimer(onAutoRetry, retryIntervalMs);
      return;
    }
    autoAttempts += 1;
    void check();
  }

  /**
   * Portly answered: records what it said about its Pages site, then opens that site (unless the
   * target is local) or Portly itself.
   * @param {import('./portly.js').HealthOk} health
   * @returns {Promise<void>}
   */
  async function redirect(health) {
    redirected = true;
    launching = false;
    clearLaunchTimers();
    cancelAutoRetry();
    setState(STATE.redirecting);
    const pagesUrl = target !== TARGET.local && typeof health.pagesUrl === 'string' ? health.pagesUrl : null;
    if (pagesUrl !== null) opens = TARGET.pages;
    knownSite = await rememberServerSite(env.storage, port, health, knownSite);
    if (destroyed) return;
    env.location.replace(pagesUrl !== null ? `${pagesUrl}${passOn}` : `${newTabUrl(port)}${passOn}`);
  }

  /** Shows the "Portly isn't running" card (with the last start attempt's outcome, if any). */
  function showOffline() {
    setBusy(false);
    if (lastFailure) els.detail.textContent = describeFailure(lastFailure, port);
    doc.title = "Portly isn't running";
    renderLaunchEnd();
    els.launch.hidden = launcher === null;
    els.retry.classList.toggle('primary', launcher === null);
    setState(STATE.offline);
    scheduleAutoRetry();
  }

  /**
   * One health check; redirects on success. On failure it either starts Portly (first check
   * of the page, launcher available) or shows the fallback.
   * @param {{manual?: boolean, launch?: boolean}} [options]
   * @returns {Promise<import('./portly.js').HealthResult | null>} null when skipped
   */
  async function check(options = {}) {
    if (redirected || destroyed) return null;
    if (checking) {
      // A Retry click during a background check joins it: show it as busy (the running check
      // resets the button when it finishes) and restart the automatic retries afterwards.
      if (options.manual) {
        autoAttempts = 0;
        setBusy(true);
      }
      return null;
    }
    checking = true;
    cancelAutoRetry();
    // Only a Retry click shows "Checking…"; background re-checks stay quiet.
    if (options.manual) {
      autoAttempts = 0;
      setBusy(true);
    }
    let result;
    try {
      result = await checkHealth(port, { fetch: env.fetch, setTimeout: setTimer, clearTimeout: clearTimer });
    } finally {
      checking = false;
    }
    if (redirected || destroyed) return result;
    if (result.ok) {
      await redirect(result);
      return result;
    }
    lastFailure = result;
    if (launching) return result; // a start attempt began meanwhile and owns the page
    if (options.launch && launcher !== null) {
      void launch();
      return result;
    }
    showOffline();
    return result;
  }

  /** @param {number} seq */
  function isCurrentLaunch(seq) {
    return launching && seq === launchSeq && !redirected;
  }

  /**
   * Ends the current start attempt without Portly answering and shows the fallback.
   * @param {LaunchEnd['reason']} reason
   */
  function endLaunch(reason) {
    launching = false;
    clearLaunchTimers();
    lastLaunchEnd = { reason, outcome: hostOutcome };
    autoAttempts = 0;
    showOffline();
  }

  /** @param {number} seq */
  function schedulePoll(seq) {
    pollTimer = setTimer(() => {
      pollTimer = null;
      void poll(seq);
    }, pollIntervalMs);
  }

  /** @param {number} seq */
  async function poll(seq) {
    if (!isCurrentLaunch(seq)) return;
    pollInFlightFor = seq;
    let result;
    try {
      result = await checkHealth(port, { fetch: env.fetch, setTimeout: setTimer, clearTimeout: clearTimer });
    } finally {
      if (pollInFlightFor === seq) pollInFlightFor = 0;
    }
    if (redirected || destroyed) return;
    // Portly answering is all that matters, even if this attempt has ended meanwhile (the
    // launcher said "not installed" while this check was in flight, and the user had started
    // Portly by hand).
    if (result.ok) {
      await redirect(result);
      return;
    }
    if (!isCurrentLaunch(seq)) return;
    lastFailure = result;
    if (deadlinePassed) {
      endLaunch('timeout');
      return;
    }
    schedulePoll(seq);
  }

  /** @param {number} seq */
  function onDeadline(seq) {
    deadlineTimer = null;
    if (!isCurrentLaunch(seq)) return;
    deadlinePassed = true;
    // A check still in flight gets to finish (it may be the one that succeeds).
    if (pollInFlightFor !== seq) endLaunch('timeout');
  }

  /** @param {number} seq */
  function onSlow(seq) {
    slowTimer = null;
    if (isCurrentLaunch(seq)) els.startingDetail.textContent = STARTING_SLOW_TEXT;
  }

  /**
   * Asks the launcher to start Portly (one request) and polls /api/health until it answers,
   * the launcher says it can't help, or the time is up. Ignored while an attempt is running.
   * @returns {Promise<StartOutcome | null>} the launcher's answer; null when skipped
   */
  async function launch() {
    if (redirected || destroyed || launching || launcher === null) return null;
    launching = true;
    launchSeq += 1;
    launchCount += 1;
    const seq = launchSeq;
    deadlinePassed = false;
    hostOutcome = null;
    cancelAutoRetry();
    clearLaunchTimers();
    els.startingDetail.textContent = STARTING_TEXT;
    doc.title = 'Starting Portly…';
    setState(STATE.starting);
    deadlineTimer = setTimer(() => onDeadline(seq), launchTimeoutMs);
    slowTimer = setTimer(() => onSlow(seq), slowAfterMs);
    schedulePoll(seq);

    /** @type {StartOutcome} */
    let outcome;
    try {
      outcome = await launcher.start(port);
    } catch (err) {
      outcome = { kind: START_KIND.maybe, code: 'host_error', detail: err instanceof Error ? err.message : String(err) };
    }
    if (!isCurrentLaunch(seq)) return outcome;
    hostOutcome = outcome;
    // Nothing was started: stop waiting. Otherwise ("running", "starting", or no clear answer)
    // keep polling — /api/health is the source of truth.
    if (START_KINDS_THAT_STOP.has(outcome.kind)) endLaunch('launcher');
    return outcome;
  }

  /** @param {Event} event */
  function onSubmit(event) {
    event.preventDefault();
    const query = els.query.value.trim();
    if (query === '') {
      els.query.focus();
      return;
    }
    cancelAutoRetry();
    env.location.assign(googleSearchUrl(query));
  }

  function onRetryClick() {
    void check({ manual: true });
  }

  function onLaunchClick() {
    void launch();
  }

  function bind() {
    els.form.addEventListener('submit', onSubmit);
    els.retry.addEventListener('click', onRetryClick);
    els.launch.addEventListener('click', onLaunchClick);
  }

  function destroy() {
    destroyed = true;
    cancelAutoRetry();
    clearLaunchTimers();
    launching = false;
    launchSeq += 1;
    els.form.removeEventListener('submit', onSubmit);
    els.retry.removeEventListener('click', onRetryClick);
    els.launch.removeEventListener('click', onLaunchClick);
  }

  /**
   * Asks the service worker to warm up Portly on this PC. Resolves when it acknowledges, when
   * the request fails (no worker listening, extension reloaded) or after ackTimeoutMs, whichever
   * comes first. Never rejects.
   * @returns {Promise<void>}
   */
  function requestWarmUp() {
    const send = env.sendMessage;
    if (typeof send !== 'function') return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve();
      };
      const timer = setTimer(finish, ackTimeoutMs);
      try {
        Promise.resolve(send({ type: WARM_UP_MESSAGE_TYPE })).then(finish, finish);
      } catch {
        finish();
      }
    });
  }

  /**
   * Pages target: asks for a warm-up (waiting briefly for the acknowledgement), then replaces this
   * tab with the Pages site.
   * @param {string} url the validated Pages site address
   */
  async function openPagesSite(url) {
    redirected = true;
    setState(STATE.redirecting);
    await requestWarmUp();
    if (destroyed) return;
    env.location.replace(`${url}${passOn}`);
  }

  /**
   * Reads the settings, then opens the Pages site or (Portly on this PC) runs the first check,
   * which may start Portly.
   * @returns {Promise<import('./portly.js').HealthResult | null>} the first health check's
   *   result; null when it opens the Pages site (this page checks nothing there)
   */
  async function start() {
    bind();
    setState(STATE.checking);
    renderExtensionId();
    const settings = await readSettings(env.storage);
    port = settings.port;
    target = settings.target;
    knownSite = settings.serverSite;
    renderPort();
    if (destroyed) return null;
    const plan = resolveNewTab(settings);
    opens = plan.opens;
    if (plan.opens === TARGET.pages) {
      await openPagesSite(plan.url);
      return null;
    }
    return check({ launch: true });
  }

  return {
    start,
    check,
    launch,
    destroy,
    get port() {
      return port;
    },
    /** The configured target (one of TARGET), or null before start() has read the settings. */
    get target() {
      return target;
    },
    /** Where this tab goes: 'pages' or 'local' (Portly on this PC), null before start(). */
    get opens() {
      return opens;
    },
    get autoAttempts() {
      return autoAttempts;
    },
    /** How many start requests this page has sent to the launcher. */
    get launchCount() {
      return launchCount;
    },
    get launching() {
      return launching;
    },
  };
}
