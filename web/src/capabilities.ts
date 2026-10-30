/**
 * What this page load can do. Two things decide it:
 *
 * - the **build**: the server build (served by Portly itself) or the Pages build
 *   (`vite build --mode static`, the browser-only site, `STATIC_BUILD`);
 * - the **backend** of this page load: `server` (the Portly server answers `/api/*`) or
 *   `browser` (the in-browser backend in `src/static/` answers them, over IndexedDB). The server
 *   build is always `server`. A Pages page load picks one before the first render
 *   (`setPageBackend`, from `main.tsx`) and keeps it: when the right backend changes, the page
 *   reloads instead of switching in place, so capabilities are constants for the page load.
 *
 * A Pages page load on the `server` backend (hybrid mode: paired with the Portly server on this
 * PC) has every server feature, account setup included. A `browser` backend has no server, so anything
 * that needs one — Google and app-password accounts, mail, ICS subscriptions, feeds, the credential
 * vault, fetching third-party pages — is off. Outlook.com accounts and their calendars work there
 * too: the browser signs in to Microsoft and reads the calendars from Graph itself
 * (`src/static/handlers/accounts.ts`, `calendar.ts`), so the Calendar widget is there as well.
 *
 * A third thing decides a little more: whether the server build was opened from **another PC**,
 * through the HTTPS reverse proxy on the main PC (ARCHITECTURE §4.2 remote branch; decided before
 * the first render by `app/remoteClient.ts`, `setRemoteClient`). Such a page load has every
 * server feature except what stays on the main PC: signing in with Google or Microsoft (the OAuth
 * redirect lands on the main PC), the vault reset, importing the main PC's browser bookmarks,
 * approving devices and pairings, and the diagnostics report. The Pages build on its server
 * backend counts the same way when that server is Portly on another PC (the browser connected to
 * it from the Pages site, ARCHITECTURE §20; decided by `localServer/boot.ts`).
 *
 * UI code reads {@link getCapabilities} at render or call time, never at module top level, and
 * "the data lives in this browser" means `backend === 'browser'`, not `STATIC_BUILD`. Tests drive
 * it with {@link setCapabilitiesForTests} (reset after every test by the vitest setup files).
 */

/** True in the Pages (browser-only) build, whatever its backend. Build-level only. */
export const STATIC_BUILD: boolean = __PORTLY_STATIC__;

/** Where this page load's data lives. */
export type Backend = 'server' | 'browser';

export interface Capabilities {
  /** The Pages (browser-only) build, whatever its backend. */
  pagesBuild: boolean;
  /** Where this page load's data lives (fixed for the page load). */
  backend: Backend;
  /** The Pages build talking to the Portly server on this PC (`pagesBuild && backend === 'server'`). */
  remoteServer: boolean;
  /**
   * This page load uses Portly on another PC (the server build opened through the reverse proxy on
   * the main PC, or the Pages build connected to it): what only the main PC can do is off.
   */
  remoteClient: boolean;
  /** The Accounts section: every kind on the server, Outlook.com alone on the `browser` backend. */
  accounts: boolean;
  /** Google accounts and their sign-in (the server keeps the client secret). */
  googleAccounts: boolean;
  /** Yahoo, CalDAV and IMAP accounts (passwords in the server's vault). */
  appPasswordAccounts: boolean;
  /** Calendar widget and calendar sync: every account kind on the server, Outlook.com on the `browser` backend. */
  calendar: boolean;
  /** ICS / webcal subscriptions (feeds are cross-origin: the server fetches them). */
  icsSubscriptions: boolean;
  /** Mail widget. */
  mail: boolean;
  /** RSS / Atom feeds widget (feeds are cross-origin: the server fetches them). */
  feeds: boolean;
  /** The credential vault (and its lock/reset banner). */
  vault: boolean;
  /** Importing bookmarks straight from the Chrome/Edge profile files on this PC. */
  browserBookmarkImport: boolean;
  /** Fetching a page to read its title and icon (needs a server: cross-origin). */
  siteMetaFetch: boolean;
  /** Search suggestions from providers that only a server can call (Google, DuckDuckGo, Bing). */
  serverSearchSuggestions: boolean;
  /** The in-browser pre-import backups (browser backend only). */
  browserBackups: boolean;
  /**
   * Launch pad sync through the OneDrive app folder (a service of a Microsoft connection): only
   * where the launch pad lives in this browser. The server's launch pad is never synced.
   */
  launchpadSync: boolean;
  /** The server resolves bookmark icons in the background, so the UI polls for them. */
  iconPolling: boolean;
}

const cache = new Map<string, Capabilities>();

/**
 * The capabilities of a build/backend combination (frozen; the same object for the same
 * combination), `remoteClient` for a page load that uses Portly on another PC.
 */
export function capabilitiesFor(pagesBuild: boolean, backend: Backend, remoteClient = false): Capabilities {
  const key = `${pagesBuild ? 'pages' : 'server'}:${backend}:${remoteClient ? 'remote' : 'here'}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const server = backend === 'server';
  const remoteServer = pagesBuild && server;
  // What needs the server *and* this PC (another PC's page load leaves it to the main PC).
  const mainPc = server && !remoteClient;
  const caps: Capabilities = Object.freeze({
    pagesBuild,
    backend,
    remoteServer,
    remoteClient,
    accounts: true,
    googleAccounts: mainPc,
    appPasswordAccounts: server,
    calendar: true,
    icsSubscriptions: server,
    mail: server,
    feeds: server,
    vault: server,
    browserBookmarkImport: mainPc,
    siteMetaFetch: server,
    serverSearchSuggestions: server,
    browserBackups: !server,
    launchpadSync: !server,
    iconPolling: server,
  });
  cache.set(key, caps);
  return caps;
}

/** The Pages build's backend for this page load; `browser` until `main.tsx` decides. */
let pageBackend: Backend = 'browser';
/** This page load uses Portly on another PC; false until `main.tsx` (or the Pages boot) decides. */
let remoteClient = false;
let testOverride: Capabilities | null = null;

/** The capabilities of this page load. Read it at render or call time, never at module top level. */
export function getCapabilities(): Capabilities {
  if (testOverride !== null) return testOverride;
  // The Pages build's browser backend uses no server at all, so no other PC's either.
  return STATIC_BUILD ? capabilitiesFor(true, pageBackend, pageBackend === 'server' && remoteClient) : capabilitiesFor(false, 'server', remoteClient);
}

/** Sets the Pages build's backend for this page load (`main.tsx`, before the first render). No-op in the server build. */
export function setPageBackend(backend: Backend): void {
  if (!STATIC_BUILD) return;
  pageBackend = backend;
}

/**
 * Marks this page load as using Portly on another PC, before the first render: `main.tsx` in the
 * server build, `localServer/boot.ts` in the Pages build (with its server backend).
 */
export function setRemoteClient(remote: boolean): void {
  remoteClient = remote;
}

/**
 * Tests only: makes {@link getCapabilities} return `caps` (build and backend included), e.g.
 * `setCapabilitiesForTests(capabilitiesFor(true, 'browser'))` for the Pages build on its in-browser
 * backend. `null` restores the build's own capabilities and the default page backend.
 */
export function setCapabilitiesForTests(caps: Capabilities | null): void {
  testOverride = caps;
  if (caps === null) {
    pageBackend = 'browser';
    remoteClient = false;
  }
}

/** Widget types that may need the server; each one needs the capability of the same name. */
const SERVER_WIDGET_TYPES = ['calendar', 'mail', 'feeds'] as const;

const unavailableCache = new WeakMap<Capabilities, ReadonlySet<string>>();

/** Widget types that cannot work with these capabilities (default: this page load's). The same set for the same capabilities. */
export function unavailableWidgetTypes(caps: Capabilities = getCapabilities()): ReadonlySet<string> {
  const cached = unavailableCache.get(caps);
  if (cached !== undefined) return cached;
  const types: ReadonlySet<string> = new Set(SERVER_WIDGET_TYPES.filter((type) => !caps[type]));
  unavailableCache.set(caps, types);
  return types;
}

/** True when a widget type works with these capabilities (default: this page load's). */
export function isWidgetTypeAvailable(type: string, caps: Capabilities = getCapabilities()): boolean {
  return !unavailableWidgetTypes(caps).has(type);
}

/** Widget types the in-browser backend cannot serve (`mail`, `feeds`), for the static handlers. */
export const BROWSER_UNAVAILABLE_WIDGET_TYPES: ReadonlySet<string> = unavailableWidgetTypes(capabilitiesFor(true, 'browser'));

