// @ts-check
/**
 * Options page controller. Three settings in chrome.storage.local:
 *
 * - what a new tab opens (whatever Portly on this PC is set up for, the default; the Pages
 *   site; or Portly on this PC), saved as soon as a choice is picked;
 * - the Pages site address (https, or http on a loopback host; empty = the address Portly on
 *   this PC reports), validated and saved like the port;
 * - the Portly port (integer 1024–65535).
 *
 * Plus "Test connection" (GET /api/health, which also records what Portly says about its Pages
 * site) and "Test launcher" (a ping to the native-messaging launcher) helpers. DOM output uses
 * textContent only.
 */
import {
  DEFAULT_PORT,
  DEFAULT_TARGET,
  MAX_PORT,
  MIN_PORT,
  TARGET,
  checkHealth,
  clearPagesUrl,
  describeFailure,
  portlyOrigin,
  isTarget,
  parsePagesUrl,
  parsePort,
  readSettings,
  rememberServerSite,
  serverSiteFor,
  writePagesUrl,
  writePort,
  writeTarget,
} from './portly.js';
import { LAUNCHER_PROTOCOL_VERSION, PING_STATUS, PINNED_EXTENSION_ID, isStaleExtensionId } from './launcher.js';

export const PORT_ERROR = `Enter a whole number from ${MIN_PORT} to ${MAX_PORT}.`;
export const PAGES_URL_ERROR =
  'Enter the full address of the site, starting with https:// (http:// only for localhost, 127.0.0.1 or [::1]), without "?" or "#".';

const INSTALL_COMMAND = 'scripts\\install-autostart.ps1';
const SETUP_DOC = 'docs\\setup\\autostart.md';
const RELOAD_STEPS =
  'On chrome://extensions (or edge://extensions), click Remove on Portly New Tab, then Load unpacked and select the extension folder again';

export const LAUNCHER_UNAVAILABLE =
  "Native messaging isn't available to this page, so the launcher can't be tested. Reload the extension on the extensions page and try again.";

/**
 * The warning shown next to the extension ID when the browser still runs the extension under its
 * pre-0.2.0 ID; '' when the ID is the pinned one (or unknown).
 * @param {string | null | undefined} extensionId
 */
export function describeExtensionId(extensionId) {
  if (!isStaleExtensionId(extensionId)) return '';
  return `This isn't the extension's fixed ID (${PINNED_EXTENSION_ID}): the browser still uses the ID from before version 0.2.0, and the launcher won't answer it. ${RELOAD_STEPS} (one time; it also resets the port to 5757).`;
}

/**
 * User-facing result of a launcher ping.
 * @param {import('./launcher.js').PingOutcome} result
 * @param {string} extensionId
 * @returns {{ message: string, tone: 'ok' | 'error' }}
 */
export function describePing(result, extensionId) {
  const stale = isStaleExtensionId(extensionId);
  if (stale && (result.status === PING_STATUS.mismatch || result.status === PING_STATUS.notInstalled)) {
    const install = result.status === PING_STATUS.notInstalled ? `, then run ${INSTALL_COMMAND}` : '';
    return {
      message: `The launcher only answers this extension's fixed ID (${PINNED_EXTENSION_ID}), but the browser still runs it under its old ID (${extensionId}). ${RELOAD_STEPS}${install}.`,
      tone: 'error',
    };
  }
  switch (result.status) {
    case PING_STATUS.installed:
      if (result.version !== LAUNCHER_PROTOCOL_VERSION) {
        return {
          message: `The launcher answered, but with protocol version ${result.version ?? 'unknown'} (this extension expects ${LAUNCHER_PROTOCOL_VERSION}). Run ${INSTALL_COMMAND} again from this copy of Portly.`,
          tone: 'error',
        };
      }
      return { message: 'The launcher is installed and answering. New tabs can start Portly.', tone: 'ok' };
    case PING_STATUS.notInstalled:
      return {
        message: `The launcher isn't installed. Run ${INSTALL_COMMAND} in your Portly folder (see ${SETUP_DOC}).`,
        tone: 'error',
      };
    case PING_STATUS.mismatch:
      return {
        message: `The launcher is installed but doesn't accept this extension's ID (${extensionId}). Run ${INSTALL_COMMAND} again so it allows this ID.`,
        tone: 'error',
      };
    default: {
      const detail = result.detail.trim().replace(/[.\s]+$/, '');
      return {
        message: `The launcher is installed but didn't answer properly${detail ? `: ${detail}` : ''}. Run ${INSTALL_COMMAND} again (see ${SETUP_DOC}).`,
        tone: 'error',
      };
    }
  }
}

/**
 * @typedef {object} OptionsEnv
 * @property {Document} document
 * @property {import('./portly.js').StorageAreaLike} storage
 * @property {typeof fetch} fetch
 * @property {import('./launcher.js').Launcher | null} [launcher]
 * @property {string | null} [extensionId] chrome.runtime.id
 * @property {(fn: () => void, ms: number) => unknown} [setTimeout]
 * @property {(handle: any) => void} [clearTimeout]
 */

/** @param {OptionsEnv} env */
export function createOptionsPage(env) {
  const doc = env.document;
  const launcher = env.launcher ?? null;
  const extensionId = env.extensionId || 'unknown';

  /** @param {string} id */
  function byId(id) {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`options.html is missing #${id}`);
    return node;
  }

  const els = {
    targetForm: /** @type {HTMLFormElement} */ (byId('target-form')),
    pagesForm: /** @type {HTMLFormElement} */ (byId('pages-form')),
    pagesInput: /** @type {HTMLInputElement} */ (byId('pages-url')),
    pagesError: byId('pages-url-error'),
    pagesReset: /** @type {HTMLButtonElement} */ (byId('pages-reset')),
    newTabStatus: byId('newtab-status'),
    form: /** @type {HTMLFormElement} */ (byId('port-form')),
    input: /** @type {HTMLInputElement} */ (byId('port')),
    error: byId('port-error'),
    test: /** @type {HTMLButtonElement} */ (byId('test')),
    reset: /** @type {HTMLButtonElement} */ (byId('reset')),
    status: byId('status'),
    extensionId: byId('extension-id'),
    extensionIdNote: byId('extension-id-note'),
    testLauncher: /** @type {HTMLButtonElement} */ (byId('test-launcher')),
    launcherStatus: byId('launcher-status'),
  };

  /** @param {string} value one of TARGET */
  function targetInput(value) {
    const node = els.targetForm.querySelector(`input[type="radio"][name="target"][value="${value}"]`);
    if (!node) throw new Error(`options.html is missing the "${value}" choice`);
    return /** @type {HTMLInputElement} */ (node);
  }
  const targetInputs = Object.values(TARGET).map(targetInput);

  let savedPort = DEFAULT_PORT;
  /** @type {string} one of TARGET */
  let savedTarget = DEFAULT_TARGET;
  /** @type {string | null} the stored Pages site address; null: use the one Portly reports */
  let savedPagesUrl = null;
  /** @type {import('./portly.js').ServerSite | null} what Portly last said (on whichever port) */
  let serverSite = null;

  /** The Pages site Portly on the saved port reported; null when none (or not known). */
  function reportedPagesUrl() {
    return serverSiteFor({ port: savedPort, serverSite })?.pagesUrl ?? null;
  }

  /** The address the Pages site choice opens; null when there is none yet. */
  function pagesDestination() {
    return savedPagesUrl ?? reportedPagesUrl();
  }

  /** Where the "auto" choice sends new tabs, in words. */
  function describeAuto() {
    const site = serverSiteFor({ port: savedPort, serverSite });
    const origin = portlyOrigin(savedPort);
    if (site === null) return `Portly itself, ${origin}, until it answers this browser`;
    return site.pagesUrl === null ? `Portly itself, ${origin}` : `its Pages site, ${site.pagesUrl}`;
  }

  function renderSavedPort() {
    const origin = portlyOrigin(savedPort);
    for (const node of doc.querySelectorAll('[data-portly-url]')) node.textContent = origin;
  }

  /** Checks the saved choice and shows the summary that goes with it. */
  function renderSavedTarget() {
    for (const input of targetInputs) input.checked = input.value === savedTarget;
    for (const node of doc.querySelectorAll('[data-summary]')) {
      /** @type {HTMLElement} */ (node).hidden = node.getAttribute('data-summary') !== savedTarget;
    }
  }

  /** The Pages address in the summaries and the field's placeholder, and the "auto" summary. */
  function renderDestinations() {
    const pages = pagesDestination();
    for (const node of doc.querySelectorAll('[data-pages-url]')) {
      node.textContent = pages ?? 'not set yet (enter it below); until then new tabs open Portly on this PC';
    }
    for (const node of doc.querySelectorAll('[data-server-site]')) node.textContent = describeAuto();
    els.pagesInput.placeholder = reportedPagesUrl() ?? '';
  }

  /**
   * @param {HTMLInputElement} input
   * @param {HTMLElement} errorNode
   * @param {string | null} message
   */
  function showFieldError(input, errorNode, message) {
    if (message === null) {
      errorNode.textContent = '';
      errorNode.hidden = true;
      input.removeAttribute('aria-invalid');
      return;
    }
    errorNode.textContent = message;
    errorNode.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  }

  function showError(/** @type {string | null} */ message) {
    showFieldError(els.input, els.error, message);
  }

  /**
   * @param {HTMLElement} node
   * @param {string} message
   * @param {'ok' | 'error' | null} tone
   */
  function showMessage(node, message, tone) {
    node.textContent = message;
    node.classList.toggle('status-ok', tone === 'ok');
    node.classList.toggle('status-error', tone === 'error');
  }

  function showStatus(/** @type {string} */ message, /** @type {'ok' | 'error' | null} */ tone = null) {
    showMessage(els.status, message, tone);
  }

  function showNewTabStatus(/** @type {string} */ message, /** @type {'ok' | 'error' | null} */ tone = null) {
    showMessage(els.newTabStatus, message, tone);
  }

  /** @param {unknown} err */
  function reason(err) {
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * Saves what a new tab opens. A failed write puts the previous choice back.
   * @param {unknown} value
   * @returns {Promise<string | null>} the saved target, or null when invalid/failed
   */
  async function saveTarget(value) {
    if (!isTarget(value)) {
      renderSavedTarget();
      return null;
    }
    try {
      savedTarget = await writeTarget(env.storage, value);
    } catch (err) {
      renderSavedTarget();
      showNewTabStatus(`Couldn't save what new tabs open: ${reason(err)}`, 'error');
      return null;
    }
    renderSavedTarget();
    showNewTabStatus(describeSavedTarget(), 'ok');
    return savedTarget;
  }

  /** The confirmation for the saved choice of what a new tab opens. */
  function describeSavedTarget() {
    if (savedTarget === TARGET.local) return `Saved. New tabs will open Portly on this PC, ${portlyOrigin(savedPort)}.`;
    if (savedTarget === TARGET.auto) return `Saved. New tabs will follow Portly on this PC: ${describeAuto()}.`;
    const pages = pagesDestination();
    return pages === null
      ? 'Saved. Enter the Pages site address below; until then new tabs open Portly on this PC.'
      : `Saved. New tabs will open the Pages site, ${pages}.`;
  }

  /**
   * Validates the Pages address field; shows the error and returns null when invalid. An empty
   * field is valid and yields '' (use the address Portly reports).
   */
  function inputPagesUrl() {
    if (els.pagesInput.value.trim() === '') {
      showFieldError(els.pagesInput, els.pagesError, null);
      return '';
    }
    const url = parsePagesUrl(els.pagesInput.value);
    if (url === null) {
      showFieldError(els.pagesInput, els.pagesError, PAGES_URL_ERROR);
      els.pagesInput.focus();
      return null;
    }
    showFieldError(els.pagesInput, els.pagesError, null);
    return url;
  }

  /**
   * Saves the Pages address field; an empty field forgets the stored address.
   * @returns {Promise<string | null>} the saved (normalised) address, '' when it was cleared, or
   *   null when invalid/failed
   */
  async function savePagesUrl() {
    const url = inputPagesUrl();
    if (url === null) return null;
    try {
      if (url === '') await clearPagesUrl(env.storage);
      else await writePagesUrl(env.storage, url);
    } catch (err) {
      showNewTabStatus(`Couldn't save the Pages site address: ${reason(err)}`, 'error');
      return null;
    }
    savedPagesUrl = url === '' ? null : url;
    els.pagesInput.value = url;
    renderDestinations();
    if (savedTarget === TARGET.pages) showNewTabStatus(describeSavedTarget(), 'ok');
    else if (url === '') showNewTabStatus('Saved. "The Pages site" will use the address Portly on this PC reports.', 'ok');
    else showNewTabStatus('Saved. New tabs use this address once you choose "The Pages site" above.', 'ok');
    return url;
  }

  async function resetPagesUrl() {
    els.pagesInput.value = '';
    return savePagesUrl();
  }

  /** Validates the input field; shows the error and returns null when invalid. */
  function inputPort() {
    const port = parsePort(els.input.value);
    if (port === null) {
      showError(PORT_ERROR);
      els.input.focus();
      return null;
    }
    showError(null);
    return port;
  }

  /** @returns {Promise<number | null>} the saved port, or null when invalid/failed */
  async function save() {
    const port = inputPort();
    if (port === null) return null;
    try {
      savedPort = await writePort(env.storage, port);
    } catch (err) {
      showStatus(`Couldn't save the port: ${reason(err)}`, 'error');
      return null;
    }
    els.input.value = String(savedPort);
    renderSavedPort();
    renderDestinations();
    const origin = portlyOrigin(savedPort);
    showStatus(
      savedTarget === TARGET.local
        ? `Saved. New tabs will open ${origin}.`
        : `Saved. The extension looks for Portly on this PC at ${origin}.`,
      'ok',
    );
    return savedPort;
  }

  /**
   * What a healthy Portly said about its Pages site, as a sentence for the connection status
   * ('' when it said nothing).
   * @param {import('./portly.js').HealthOk} result
   */
  function describeReportedSite(result) {
    if (result.pagesUrl === undefined) return '';
    return result.pagesUrl === null
      ? ' It has no Pages site (PORTLY_PAGES_URL is not set).'
      : ` Its Pages site: ${result.pagesUrl}.`;
  }

  /** Checks the port currently in the field (saved or not). */
  async function test() {
    const port = inputPort();
    if (port === null) return null;
    els.test.disabled = true;
    showStatus(`Checking ${portlyOrigin(port)}…`);
    try {
      const result = await checkHealth(port, {
        fetch: env.fetch,
        setTimeout: env.setTimeout,
        clearTimeout: env.clearTimeout,
      });
      if (result.ok) {
        const version = result.version ? ` (version ${result.version})` : '';
        const vault =
          result.vault === 'locked' ? ' Its credential vault is locked; open Settings → Accounts in Portly.' : '';
        showStatus(`Portly is running on port ${port}${version}.${describeReportedSite(result)}${vault}`, 'ok');
        if (result.pagesUrl !== undefined) {
          serverSite = await rememberServerSite(env.storage, port, result, serverSite);
          renderDestinations();
        }
      } else {
        showStatus(describeFailure(result, port), 'error');
      }
      return result;
    } finally {
      els.test.disabled = false;
    }
  }

  /**
   * Pings the launcher and reports installed / not installed / ID mismatch / broken.
   * @returns {Promise<import('./launcher.js').PingOutcome | null>} null when unavailable or busy
   */
  async function testLauncher() {
    if (launcher === null) {
      showMessage(els.launcherStatus, LAUNCHER_UNAVAILABLE, 'error');
      return null;
    }
    if (els.testLauncher.disabled) return null;
    els.testLauncher.disabled = true;
    showMessage(els.launcherStatus, 'Asking the launcher…', null);
    try {
      const result = await launcher.ping();
      const { message, tone } = describePing(result, extensionId);
      showMessage(els.launcherStatus, message, tone);
      return result;
    } finally {
      els.testLauncher.disabled = false;
    }
  }

  async function reset() {
    els.input.value = String(DEFAULT_PORT);
    return save();
  }

  /** @param {Event} event */
  function onSubmit(event) {
    event.preventDefault();
    void save();
  }
  function onTest() {
    void test();
  }
  function onReset() {
    void reset();
  }
  function onTestLauncher() {
    void testLauncher();
  }
  function onInput() {
    if (els.input.getAttribute('aria-invalid') === 'true' && parsePort(els.input.value) !== null) showError(null);
  }
  /** @param {Event} event */
  function onTargetChange(event) {
    const input = /** @type {HTMLInputElement | null} */ (event.target);
    if (input && input.name === 'target' && input.checked) void saveTarget(input.value);
  }
  /** @param {Event} event */
  function onTargetSubmit(event) {
    event.preventDefault();
  }
  /** @param {Event} event */
  function onPagesSubmit(event) {
    event.preventDefault();
    void savePagesUrl();
  }
  function onPagesReset() {
    void resetPagesUrl();
  }
  function onPagesInput() {
    if (els.pagesInput.getAttribute('aria-invalid') === 'true' && parsePagesUrl(els.pagesInput.value) !== null) {
      showFieldError(els.pagesInput, els.pagesError, null);
    }
  }

  async function init() {
    els.targetForm.addEventListener('change', onTargetChange);
    els.targetForm.addEventListener('submit', onTargetSubmit);
    els.pagesForm.addEventListener('submit', onPagesSubmit);
    els.pagesReset.addEventListener('click', onPagesReset);
    els.pagesInput.addEventListener('input', onPagesInput);
    els.form.addEventListener('submit', onSubmit);
    els.test.addEventListener('click', onTest);
    els.reset.addEventListener('click', onReset);
    els.input.addEventListener('input', onInput);
    els.testLauncher.addEventListener('click', onTestLauncher);
    els.extensionId.textContent = extensionId;
    const idNote = describeExtensionId(env.extensionId);
    els.extensionIdNote.textContent = idNote;
    els.extensionIdNote.hidden = idNote === '';
    if (launcher === null) {
      els.testLauncher.disabled = true;
      showMessage(els.launcherStatus, LAUNCHER_UNAVAILABLE, null);
    }
    const settings = await readSettings(env.storage);
    savedPort = settings.port;
    savedTarget = settings.target;
    savedPagesUrl = settings.pagesUrl;
    serverSite = settings.serverSite;
    els.input.value = String(savedPort);
    els.pagesInput.value = savedPagesUrl ?? '';
    renderSavedPort();
    renderSavedTarget();
    renderDestinations();
  }

  function destroy() {
    els.targetForm.removeEventListener('change', onTargetChange);
    els.targetForm.removeEventListener('submit', onTargetSubmit);
    els.pagesForm.removeEventListener('submit', onPagesSubmit);
    els.pagesReset.removeEventListener('click', onPagesReset);
    els.pagesInput.removeEventListener('input', onPagesInput);
    els.form.removeEventListener('submit', onSubmit);
    els.test.removeEventListener('click', onTest);
    els.reset.removeEventListener('click', onReset);
    els.input.removeEventListener('input', onInput);
    els.testLauncher.removeEventListener('click', onTestLauncher);
  }

  return {
    init,
    save,
    saveTarget,
    savePagesUrl,
    resetPagesUrl,
    test,
    testLauncher,
    reset,
    destroy,
    get savedPort() {
      return savedPort;
    },
    get savedTarget() {
      return savedTarget;
    },
    get savedPagesUrl() {
      return savedPagesUrl;
    },
  };
}
