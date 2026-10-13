// Must stay the first import: sets zod `jitless` before any schema is built (§4.3 CSP, no eval).
import './zodConfig.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import './styles/tokens.css';
import './styles/base.css';
import { App } from './app/App.tsx';
import { prepareFirstRender } from './app/boot.ts';
import { forwardToPages } from './app/pagesForward.ts';
import { AppProviders, LOCAL_SERVER_QUERY_CACHE_KEY, createQueryClient, persistOptionsFor, persistOptionsOf, type QueryPersistOptions } from './app/providers.tsx';
import { queryKeysForSlices } from './app/staticStatus.ts';
import type { Backend } from './capabilities.ts';
import { recordClientEvent } from './diagnostics/clientLog.ts';
import { HYBRID_ENABLED } from './localServer/config.ts';
import { isFramed } from './localServer/page.ts';
import { browserLocalStorage, browserSessionStorage, consumePairingReturn, createPairingStore, type PairingReturnResult } from './localServer/pairing.ts';
import { applyPersistedTheme, firstPaintSnapshot } from './theme/persistedTheme.ts';
import { recordAppError } from './ui/ErrorBoundary.tsx';

/**
 * Uncaught errors and unhandled rejections become this browser's `app` error events (ARCHITECTURE
 * §17), beside the console's own report of them. Installed before anything renders, so start-up
 * failures count.
 */
function recordUncaughtErrors(): void {
  window.addEventListener('error', (event) => {
    // A layout notice some browsers raise as an error (nothing failed).
    if (/^ResizeObserver loop/.test(event.message)) return;
    // A cross-origin script's error has no Error object ("Script error.").
    recordAppError('window', event.error ?? { name: 'Error', message: event.message });
  });
  window.addEventListener('unhandledrejection', (event) => {
    recordAppError('promise', event.reason);
  });
}

// Pages build: the server's redirect back after pairing carries the token in the address. Save it
// (when the nonce matches) and take it out of the address before anything else happens.
const pairingReturn: PairingReturnResult = __HOMEBASE_STATIC__
  ? consumePairingReturn({
      location: window.location,
      history: window.history,
      local: browserLocalStorage(),
      session: browserSessionStorage(),
      now: () => Date.now(),
      accept: HYBRID_ENABLED && !isFramed(),
    })
  : 'none';

recordUncaughtErrors();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
const root = container;

const queryClient = createQueryClient();

function render(persist: QueryPersistOptions): void {
  createRoot(root).render(
    <StrictMode>
      <AppProviders client={queryClient} persist={persist}>
        <App />
      </AppProviders>
    </StrictMode>,
  );
}

/** sessionStorage key: when this tab last reloaded because a code chunk was missing. */
const PRELOAD_RELOAD_KEY = 'homebase:reloaded-after-preload-error';
/**
 * At most one such reload per tab in this window. Long enough to outlast a static host's cached
 * index.html after a deploy (GitHub Pages: 10 minutes), so a still-stale page cannot loop, short
 * enough that the next deploy can recover the same long-lived tab again.
 */
const PRELOAD_RELOAD_WINDOW_MS = 15 * 60 * 1000;

/** Static hosts cache index.html after a deploy, so a tab may ask for chunks that no longer exist. */
function reloadOnMissingChunks(): void {
  window.addEventListener('vite:preloadError', (event) => {
    try {
      const last = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY));
      if (Number.isFinite(last) && last > 0 && Date.now() - last < PRELOAD_RELOAD_WINDOW_MS) return;
      sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(Date.now()));
    } catch {
      // No sessionStorage: still try the reload.
    }
    event.preventDefault();
    window.location.reload();
  });
}

/**
 * A page load whose backend is the Homebase server sends this browser's diagnostic events there
 * (`diagnostics/upload.ts`, loaded on demand: the Pages site on its browser backend never needs it).
 */
function uploadClientEvents(): void {
  import('./diagnostics/upload.ts')
    .then((upload) => {
      upload.startClientEventUpload();
    })
    .catch((err: unknown) => {
      console.error('[Homebase] Could not start sending diagnostic events to Homebase', err);
    });
}

type StaticBackendModule = typeof import('./static/backend.ts');

/**
 * Pages build, browser backend: open the in-browser backend first so stored images resolve to
 * object URLs on the very first paint, and refresh what another tab of this site changed.
 * `preloaded` is the module's import when `start()` already began it. (The literal
 * `__HOMEBASE_STATIC__` at the call sites keeps the static backend out of the server build's
 * bundle.)
 */
async function startStaticBackend(preloaded: Promise<StaticBackendModule> | null): Promise<void> {
  try {
    const backend = await (preloaded ?? import('./static/backend.ts'));
    let watching = false;
    const watchOtherTabs = (): void => {
      if (watching) return;
      watching = true;
      void backend.subscribeStaticChanges((keys) => {
        const prefixes = queryKeysForSlices(keys);
        if (prefixes === null) void queryClient.invalidateQueries();
        else for (const queryKey of prefixes) void queryClient.invalidateQueries({ queryKey });
      });
    };
    // A start that failed is retried (with backoff) by later API calls; once one succeeds,
    // refetch what failed meanwhile and start following other tabs.
    let failed = false;
    backend.subscribeStaticBackendStatus((next) => {
      if (next.state === 'failed') failed = true;
      if (next.state !== 'ready' || !failed) return;
      failed = false;
      watchOtherTabs();
      void queryClient.invalidateQueries();
    });
    await backend.ensureStaticBackend();
    watchOtherTabs();
  } catch (err) {
    // Reported by the backend status (the shell shows a banner).
    console.error('[Homebase] The in-browser backend could not start', err);
  }
}

/**
 * Pages build, browser backend: Outlook.com signs in from this browser (static/handlers/accounts.ts).
 * Back from Microsoft's sign-in (`?code&state`), finish it before anything renders and show the
 * result the way the server does (`?oauth=`, read by App.tsx). Otherwise, when an Outlook.com
 * sign-in has ended or is about to, renew it with a quick round trip to Microsoft instead of asking
 * for a click (at most once per account every few hours). Returns true when the page is leaving
 * for that round trip.
 */
async function finishOutlookSignIn(preloaded: Promise<StaticBackendModule> | null): Promise<boolean> {
  try {
    const backend = await (preloaded ?? import('./static/backend.ts'));
    const afterSignIn = await backend.staticFinishSignIn(window.location.href);
    if (afterSignIn !== null) {
      window.history.replaceState(window.history.state, '', afterSignIn);
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      return false;
    }
    if (isFramed() || navigator.onLine === false) return false;
    const automatic = await backend.staticAutomaticSignIn(window.location.href);
    if (automatic === null) return false;
    window.location.replace(automatic);
    return true;
  } catch (err) {
    console.error('[Homebase] The Outlook.com sign-in in this browser could not be completed', err);
    return false;
  }
}

/**
 * Pages build, server backend: a Microsoft answer meant for this browser's own Outlook.com sign-in
 * arrived while the page uses Homebase on this PC. It cannot be completed here (the pending
 * sign-in lives in this browser's copy); keep the code out of the address bar and the history.
 */
function dropMicrosoftAnswer(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('state') || (!url.searchParams.has('code') && !url.searchParams.has('error'))) return;
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.hash || '#/settings/accounts'}`);
}

/** What to tell the user once the page is up (Pages build): a pairing that just completed, or the backend switch the reload applied. */
interface StartNotices {
  pairing: PairingReturnResult;
  modeSwitch: { tone: 'success' | 'info'; message: string } | null;
}

function showNotices({ pairing, modeSwitch }: StartNotices): void {
  if (pairing === 'paired') toast.success('This browser is now paired with Homebase on this PC');
  else if (pairing === 'refused') toast.error('Pairing with Homebase on this PC didn’t complete. Try again from Settings → About.');
  if (modeSwitch?.tone === 'success') toast.success(modeSwitch.message);
  else if (modeSwitch !== null) toast.info(modeSwitch.message);
}

async function start(): Promise<void> {
  let persist: QueryPersistOptions = persistOptionsOf(queryClient);
  let backend: Backend = __HOMEBASE_STATIC__ ? 'browser' : 'server';
  let startLocalServer = (): void => {};
  const notices: StartNotices = { pairing: pairingReturn, modeSwitch: null };
  let offlineFallback = false;
  if (!__HOMEBASE_STATIC__) {
    // One page: Homebase's own page forwards to the Pages site, unless that can't be reached.
    const forward = await forwardToPages({ location: window.location, framed: isFramed() });
    if (forward === 'forwarded') return;
    offlineFallback = forward === 'offline';
  }
  if (__HOMEBASE_STATIC__) {
    // Before the first dynamic import, which is itself a chunk that may be gone after a deploy.
    reloadOnMissingChunks();
    // A page load that will stay on this browser's copy (hybrid mode off, framed, or the hints say
    // so: boot.ts decides from the same ones) fetches the in-browser backend's code alongside the
    // boot chunk rather than after it. Loading the module opens nothing; its failure is reported
    // where startStaticBackend awaits it.
    const staysInBrowser = !HYBRID_ENABLED || isFramed() || createPairingStore(browserLocalStorage()).nextBootBackend(Date.now()) === 'browser';
    const staticBackend = staysInBrowser ? import('./static/backend.ts') : null;
    void staticBackend?.catch(() => undefined);
    // Decide this page load's backend before anything reads data, and keep it: the Homebase server
    // on this PC when paired and recently seen (hybrid mode), else this browser's copy. Also drops
    // the server backend's leftovers when this browser is not paired (even with hybrid mode off).
    try {
      const hybrid = await import('./localServer/boot.ts');
      const boot = hybrid.bootPagesBackend({ serverCacheKey: LOCAL_SERVER_QUERY_CACHE_KEY });
      backend = boot.backend;
      persist = persistOptionsFor(boot.backend, boot.instanceId);
      startLocalServer = boot.start;
      notices.modeSwitch = hybrid.takeModeSwitchNotice(boot.backend);
    } catch (err) {
      // This page load stays on the in-browser backend.
      console.error('[Homebase] Could not look for Homebase on this PC', err);
    }
    // Recorded once this page load's backend is known (the events carry it).
    if (pairingReturn === 'paired') recordClientEvent('info', 'hybrid', 'pairing completed');
    else if (pairingReturn === 'refused') recordClientEvent('warn', 'hybrid', 'pairing answer refused (not the one this tab asked for, or not saved)');
    // The server backend never opens the in-browser database in this page load.
    if (backend === 'browser') {
      await startStaticBackend(staticBackend);
      if (await finishOutlookSignIn(staticBackend)) return;
    } else {
      dropMicrosoftAnswer();
    }
    // Ask the browser to keep this origin's data out of storage eviction (answered silently;
    // Chromium/Safari decide from engagement, Firefox asks). Once, after the first interaction.
    const keep = () => {
      window.removeEventListener('pointerdown', keep);
      void navigator.storage?.persist?.().catch(() => undefined);
    };
    window.addEventListener('pointerdown', keep, { once: true });
  }
  // Paint with the last-known theme of this backend immediately (the in-browser backend's once its
  // images resolve to object URLs, never to /api paths on the Pages host); settings refetch and
  // re-apply right after.
  applyPersistedTheme(firstPaintSnapshot(persist, backend));
  // Restore the persisted cache and load the visible widgets' code first, so the first frame
  // shows last-known content rather than skeletons (bounded: the widget preload waits at most
  // 150 ms).
  await prepareFirstRender(queryClient, persist).catch(() => undefined);
  render(persist);
  if (offlineFallback) toast.info('Your Pages site can’t be reached right now, so this is the copy on this PC.');
  if (__HOMEBASE_STATIC__) {
    // Toasts raised before the Toaster mounts are shown once it subscribes.
    showNotices(notices);
    // Probing starts once the page is up (it may show the browser's permission prompt).
    startLocalServer();
  }
  if (backend === 'server') uploadClientEvents();
}

void start();
