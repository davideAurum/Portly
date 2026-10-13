// @ts-check
/**
 * Shared logic for the Homebase new-tab extension (ARCHITECTURE §11): the settings in
 * chrome.storage.local (what a new tab opens, the Pages site address, the port and what Homebase
 * on this PC last said about its Pages site), the health check, the warm-up message and URL
 * builders. Pure functions with injected dependencies so they run unchanged in Chrome/Edge and
 * under `node --test` with fakes.
 */

export const DEFAULT_PORT = 5757;
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;
export const HEALTH_TIMEOUT_MS = 1500;
/** chrome.storage.local key holding the port number. */
export const PORT_KEY = 'port';
/** chrome.storage.local key holding what a new tab opens (one of TARGET). */
export const TARGET_KEY = 'target';
/** chrome.storage.local key holding the Pages site address (a normalised URL string). */
export const PAGES_URL_KEY = 'pagesUrl';
/**
 * chrome.storage.local key holding what Homebase on this PC last reported about its Pages site
 * (`pagesUrl` in /api/health, the server's HOMEBASE_PAGES_URL): `{port, pagesUrl}` (a ServerSite).
 */
export const SERVER_SITE_KEY = 'serverSite';

/**
 * What a new tab opens.
 * - auto (the default): whatever Homebase on this PC is set up for — its Pages site when the
 *   server reports one (HOMEBASE_PAGES_URL), otherwise Homebase itself (as `local`).
 * - pages: the Homebase Pages site (the browser-only build) at the stored address, or the one the
 *   server reports when none is stored. It uses Homebase on this PC when that runs and the browser
 *   is paired with it, and its own in-browser copy otherwise.
 * - local: Homebase on this PC (http://localhost:<port>), with the "isn't running" fallback.
 */
export const TARGET = Object.freeze({ auto: 'auto', pages: 'pages', local: 'local' });
export const DEFAULT_TARGET = TARGET.auto;

export const MAX_PAGES_URL_LENGTH = 2048;
/** The only hosts a plain-http Pages address may use (a build served on this PC, for testing). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The message a new tab sends the service worker before it opens the Pages site, so Homebase on
 * this PC is started when it isn't running (lib/warm-up.js answers it).
 */
export const WARM_UP_MESSAGE_TYPE = 'homebase:warm-up';

/** @param {unknown} message */
export function isWarmUpMessage(message) {
  return (
    typeof message === 'object' &&
    message !== null &&
    /** @type {{type?: unknown}} */ (message).type === WARM_UP_MESSAGE_TYPE
  );
}

/** True for an integer in [1024, 65535] (numbers only — strings go through parsePort). */
export function isValidPort(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

/**
 * Parses user input into a port. Accepts only plain decimal digits (surrounding whitespace is
 * ignored) — no signs, exponents, decimals or hex — within [1024, 65535].
 * @param {unknown} input
 * @returns {number | null}
 */
export function parsePort(input) {
  if (typeof input === 'number') return isValidPort(input) ? input : null;
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return isValidPort(port) ? port : null;
}

/**
 * @typedef {object} StorageAreaLike
 * @property {(keys: string | string[] | Record<string, unknown>) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} [remove]
 */

/**
 * Reads the configured port; anything missing, invalid or unreadable yields the default.
 * @param {StorageAreaLike | undefined | null} storage
 * @returns {Promise<number>}
 */
export async function readPort(storage) {
  if (!storage) return DEFAULT_PORT;
  try {
    const items = await storage.get(PORT_KEY);
    const stored = items ? items[PORT_KEY] : undefined;
    return isValidPort(stored) ? /** @type {number} */ (stored) : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/**
 * Persists a validated port. Throws a RangeError for invalid input so callers never store junk.
 * @param {StorageAreaLike} storage
 * @param {unknown} input
 * @returns {Promise<number>} the stored port
 */
export async function writePort(storage, input) {
  const port = parsePort(input);
  if (port === null) throw new RangeError(`Port must be a whole number from ${MIN_PORT} to ${MAX_PORT}.`);
  await storage.set({ [PORT_KEY]: port });
  return port;
}

/** @param {unknown} value */
export function isTarget(value) {
  return value === TARGET.auto || value === TARGET.pages || value === TARGET.local;
}

/**
 * Reads what a new tab opens; anything missing, invalid or unreadable yields the default.
 * @param {StorageAreaLike | undefined | null} storage
 * @returns {Promise<string>} one of TARGET
 */
export async function readTarget(storage) {
  if (!storage) return DEFAULT_TARGET;
  try {
    const items = await storage.get(TARGET_KEY);
    const stored = items ? items[TARGET_KEY] : undefined;
    return isTarget(stored) ? /** @type {string} */ (stored) : DEFAULT_TARGET;
  } catch {
    return DEFAULT_TARGET;
  }
}

/**
 * Persists what a new tab opens. Throws a RangeError for anything but a TARGET value.
 * @param {StorageAreaLike} storage
 * @param {unknown} input
 * @returns {Promise<string>} the stored target
 */
export async function writeTarget(storage, input) {
  if (!isTarget(input)) throw new RangeError(`New tabs open "${TARGET.auto}", "${TARGET.pages}" or "${TARGET.local}".`);
  const target = /** @type {string} */ (input);
  await storage.set({ [TARGET_KEY]: target });
  return target;
}

/**
 * Parses user input into a Pages site address, normalised to `<origin><path>` with the path
 * ending in "/" (one is added when missing). Accepts only an absolute `https:` URL, or `http:`
 * on a loopback host (localhost, 127.0.0.1, [::1]) for a build served on this PC; no user name
 * or password, no "?" query and no "#" fragment. Anything else yields null.
 * @param {unknown} input
 * @returns {string | null}
 */
export function parsePagesUrl(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed === '' || trimmed.length > MAX_PAGES_URL_LENGTH) return null;
  // The scheme must be typed: no bare host names, scheme-relative or other-scheme URLs. No inner
  // whitespace or control characters either (the URL parser would silently drop some of them).
  if (!/^https?:\/\//i.test(trimmed) || /[?#]/.test(trimmed)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;
  /** @type {URL} */
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
  } else if (url.protocol !== 'https:') {
    return null;
  }
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  const normalised = `${url.origin}${path}`;
  return normalised.length > MAX_PAGES_URL_LENGTH ? null : normalised;
}

/**
 * Reads the stored Pages site address; null when none is stored (or it is invalid or unreadable):
 * the address Homebase on this PC reports is used then.
 * @param {StorageAreaLike | undefined | null} storage
 * @returns {Promise<string | null>}
 */
export async function readPagesUrl(storage) {
  if (!storage) return null;
  try {
    const items = await storage.get(PAGES_URL_KEY);
    return parsePagesUrl(items ? items[PAGES_URL_KEY] : undefined);
  } catch {
    return null;
  }
}

/**
 * Persists a validated, normalised Pages site address. Throws a RangeError for invalid input so
 * callers never store junk.
 * @param {StorageAreaLike} storage
 * @param {unknown} input
 * @returns {Promise<string>} the stored address
 */
export async function writePagesUrl(storage, input) {
  const url = parsePagesUrl(input);
  if (url === null) throw new RangeError('Not a valid Pages site address.');
  await storage.set({ [PAGES_URL_KEY]: url });
  return url;
}

/**
 * Forgets the stored Pages site address, so the one Homebase on this PC reports is used.
 * @param {StorageAreaLike} storage
 * @returns {Promise<void>}
 */
export async function clearPagesUrl(storage) {
  if (typeof storage.remove === 'function') await storage.remove(PAGES_URL_KEY);
  else await storage.set({ [PAGES_URL_KEY]: null });
}

/**
 * What Homebase on this PC said about its Pages site: the address it answers (HOMEBASE_PAGES_URL,
 * normalised like a stored address), or null when it has none (hybrid mode off). `port` is the
 * port that Homebase answered on; the record means nothing for another port.
 * @typedef {object} ServerSite
 * @property {number} port
 * @property {string | null} pagesUrl
 */

/**
 * Validates a stored ServerSite; null for anything else.
 * @param {unknown} value
 * @returns {ServerSite | null}
 */
export function parseServerSite(value) {
  if (typeof value !== 'object' || value === null) return null;
  const { port, pagesUrl } = /** @type {{port?: unknown, pagesUrl?: unknown}} */ (value);
  if (!isValidPort(port)) return null;
  if (pagesUrl === null) return { port: /** @type {number} */ (port), pagesUrl: null };
  const url = parsePagesUrl(pagesUrl);
  return url === null ? null : { port: /** @type {number} */ (port), pagesUrl: url };
}

/**
 * @typedef {object} Settings
 * @property {string} target one of TARGET
 * @property {string | null} pagesUrl the stored Pages site address, or null when none is stored
 * @property {number} port
 * @property {ServerSite | null} serverSite what Homebase last said about its Pages site (on
 *   whichever port it was), or null when it hasn't said anything yet
 */

/**
 * Reads every setting in one storage call (a new tab opens a little sooner); each missing,
 * invalid or unreadable value yields its default.
 * @param {StorageAreaLike | undefined | null} storage
 * @returns {Promise<Settings>}
 */
export async function readSettings(storage) {
  /** @type {Record<string, unknown>} */
  let items = {};
  if (storage) {
    try {
      items = (await storage.get([TARGET_KEY, PAGES_URL_KEY, PORT_KEY, SERVER_SITE_KEY])) ?? {};
    } catch {
      items = {};
    }
  }
  const target = items[TARGET_KEY];
  const port = items[PORT_KEY];
  return {
    target: isTarget(target) ? /** @type {string} */ (target) : DEFAULT_TARGET,
    pagesUrl: parsePagesUrl(items[PAGES_URL_KEY]),
    port: isValidPort(port) ? /** @type {number} */ (port) : DEFAULT_PORT,
    serverSite: parseServerSite(items[SERVER_SITE_KEY]),
  };
}

/**
 * What Homebase on the configured port last said about its Pages site; null when it hasn't said
 * anything (or said it on another port).
 * @param {Pick<Settings, 'port' | 'serverSite'>} settings
 * @returns {ServerSite | null}
 */
export function serverSiteFor(settings) {
  const site = settings.serverSite;
  return site !== null && site.port === settings.port ? site : null;
}

/**
 * Where a new tab goes, from the settings alone: the Pages site at `url`, or Homebase on this PC
 * (`local`, which checks /api/health first and may still end up on the Pages site the answer
 * names, see newtab-page.js).
 * - local → local.
 * - pages → the stored address, else the one the server reported, else local.
 * - auto → the address the server reported, else local (it reported none, or hasn't answered yet).
 * @param {Settings} settings
 * @returns {{ opens: 'pages', url: string } | { opens: 'local', url: null }}
 */
export function resolveNewTab(settings) {
  if (settings.target === TARGET.local) return { opens: 'local', url: null };
  const reported = serverSiteFor(settings)?.pagesUrl ?? null;
  const url = settings.target === TARGET.pages ? (settings.pagesUrl ?? reported) : reported;
  return url === null ? { opens: 'local', url: null } : { opens: 'pages', url };
}

/**
 * Records what a healthy Homebase on `port` said about its Pages site, when it said anything and
 * that differs from `known` (the stored record; pass undefined to read it first). Never throws.
 * Whatever answers on the port is trusted here as it is for the redirect itself (ARCHITECTURE
 * §4.1 accepts port squatting); the address it names still passes parsePagesUrl.
 * @param {StorageAreaLike | undefined | null} storage
 * @param {number} port
 * @param {HealthResult} health
 * @param {ServerSite | null} [known]
 * @returns {Promise<ServerSite | null>} the record for this port now, null when none
 */
export async function rememberServerSite(storage, port, health, known) {
  if (!health.ok || health.pagesUrl === undefined) return known && known.port === port ? known : null;
  /** @type {ServerSite} */
  const site = { port, pagesUrl: health.pagesUrl };
  if (!storage) return site;
  try {
    let current = known;
    if (current === undefined) {
      const items = await storage.get(SERVER_SITE_KEY);
      current = parseServerSite(items ? items[SERVER_SITE_KEY] : undefined);
    }
    if (current !== null && current.port === site.port && current.pagesUrl === site.pagesUrl) return current;
    await storage.set({ [SERVER_SITE_KEY]: site });
  } catch {
    // Unreadable or full storage: the next healthy answer tries again.
  }
  return site;
}

/** `http://localhost:<port>` (no trailing slash). */
export function homebaseOrigin(port) {
  return `http://localhost:${port}`;
}

/** The URL a new tab redirects to once Homebase answers. */
export function newTabUrl(port) {
  return `${homebaseOrigin(port)}/?src=newtab`;
}

export function healthUrl(port) {
  return `${homebaseOrigin(port)}/api/health`;
}

/**
 * Google search URL for the fallback search box; the query is always encodeURIComponent-ed.
 * @param {string} query
 */
export function googleSearchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * @typedef {object} HealthOk
 * @property {true} ok
 * @property {string | null} version
 * @property {'ready' | 'locked' | null} vault
 * @property {string | null} [pagesUrl] the Pages site the server answers (HOMEBASE_PAGES_URL), null
 *   when it has none; absent when the server didn't say (an older Homebase) or named an address
 *   this extension wouldn't open
 *
 * @typedef {object} HealthFailure
 * @property {false} ok
 * @property {'timeout' | 'unreachable' | 'http' | 'unexpected'} reason
 * @property {number} [status] HTTP status when reason is 'http'
 *
 * @typedef {HealthOk | HealthFailure} HealthResult
 */

/**
 * @typedef {object} HealthDeps
 * @property {typeof fetch} fetch
 * @property {number} [timeoutMs]
 * @property {(fn: () => void, ms: number) => unknown} [setTimeout]
 * @property {(handle: any) => void} [clearTimeout]
 */

/**
 * GET http://localhost:<port>/api/health with a hard timeout covering headers *and* body.
 * Success requires a 2xx JSON body with `ok: true` (so some other service squatting on the port
 * does not get the redirect). Never throws.
 * @param {number} port
 * @param {HealthDeps} deps
 * @returns {Promise<HealthResult>}
 */
export async function checkHealth(port, deps) {
  const timeoutMs = deps.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const setTimer = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = deps.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimer(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await deps.fetch(healthUrl(port), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: 'http', status: response.status };
    /** @type {unknown} */
    const body = await response.json();
    if (typeof body !== 'object' || body === null || /** @type {{ok?: unknown}} */ (body).ok !== true) {
      return { ok: false, reason: 'unexpected' };
    }
    const { version, vault, pagesUrl } = /** @type {{version?: unknown, vault?: unknown, pagesUrl?: unknown}} */ (body);
    /** @type {HealthOk} */
    const result = {
      ok: true,
      version: typeof version === 'string' ? version : null,
      vault: vault === 'ready' || vault === 'locked' ? vault : null,
    };
    if (pagesUrl === null) result.pagesUrl = null;
    else if (typeof pagesUrl === 'string') {
      const url = parsePagesUrl(pagesUrl);
      if (url !== null) result.pagesUrl = url;
    }
    return result;
  } catch (err) {
    if (timedOut) return { ok: false, reason: 'timeout' };
    // A body that is not JSON means something other than Homebase answered.
    if (err instanceof SyntaxError) return { ok: false, reason: 'unexpected' };
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimer(timer);
  }
}

/**
 * One-line, user-facing explanation of a failed health check.
 * @param {HealthFailure} result
 * @param {number} port
 * @param {number} [timeoutMs]
 */
export function describeFailure(result, port, timeoutMs = HEALTH_TIMEOUT_MS) {
  const origin = homebaseOrigin(port);
  switch (result.reason) {
    case 'timeout':
      // Also what a closed port looks like: Windows takes ~2 s to report a refused connection.
      return `Couldn't reach ${origin} (no answer within ${timeoutMs / 1000} seconds).`;
    case 'http':
      return `Something answered on ${origin}, but it isn't Homebase (HTTP ${result.status ?? '?'}).`;
    case 'unexpected':
      return `Something answered on ${origin}, but it doesn't look like Homebase.`;
    default:
      return `Nothing is answering on ${origin}.`;
  }
}
