/**
 * When launch pad sync runs (docs/design/launchpad-sync.md section 7), on the page's in-browser
 * backend only. There is no background job: a browser with no Portly tab open does nothing.
 *
 * - **Page load:** once the backend is up (the automatic re-sign-in has already happened by then).
 * - **Focus and becoming visible:** a check, skipped when any tab of this site checked in the last
 *   60 seconds (`checkedAt` in the sync state is shared).
 * - **While visible:** a check every 5 minutes. Hidden tabs don't check.
 * - **After local changes** (the commit hook): 5 s after the last such commit, at most 30 s after
 *   the first.
 * - **Coming back online,** when changes are waiting.
 * - **Sync now** ({@link LaunchpadSyncController.syncNow}): waits for the lock, ignores backoff.
 *
 * Tabs take turns with a Web Lock, `portly-static:<base>:launchpad-sync`; scheduled checks skip
 * when another tab holds it. Failures back off like the calendar sync: 15 minutes, doubling up to 6
 * hours, `Retry-After` honoured. A needed reconnect pauses sync until the account works again; a
 * GitHub token or repository GitHub refused pauses scheduled checks until new ones are saved.
 *
 * **One sync connection per browser** (design 6.10): a Microsoft connection with the Launch pad
 * sync service switched on, or the GitHub repository and token. With none, sync is off; with more
 * than one, nothing syncs (`several_sources`) until only one is left, so a launch pad is never
 * merged into a file the user did not mean.
 *
 * One store per page load and source (the GitHub one keeps the file's `ETag` and its private-
 * repository check), dropped when the source or its GitHub settings change. The lock and the
 * page's own queue mean one round at a time, and a round sends one request at a time, which GitHub
 * needs (it refuses simultaneous writes to a branch).
 */
import { recordClientEvent } from '../../diagnostics/clientLog.ts';
import type { StaticContext } from '../context.ts';
import { createGraphDriveStore } from '../providers/graphDrive.ts';
import { parseRepository } from '../providers/githubRepo.ts';
import { hasGitHubSync, openGitHubStore } from '../providers/githubSync.ts';
import { SLICE, getAccounts, getGitHubSync, getLaunchpadSync, type StoredAccount } from '../slices.ts';
import { runSyncRound, type FirstSyncChoice, type SyncRoundResult } from './engine.ts';
import { sha256Hex } from './format.ts';
import { SYNC_ORIGIN, launchpadCommitHook } from './hook.ts';
import { SyncStoreError, type SyncStore } from './store.ts';

export const CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const FOCUS_THROTTLE_MS = 60 * 1000;
export const CHANGE_DELAY_MS = 5 * 1000;
export const CHANGE_MAX_DELAY_MS = 30 * 1000;
export const SYNC_BACKOFF_BASE_MS = 15 * 60 * 1000;
export const SYNC_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export const LAUNCHPAD_SYNC_LOCK = `portly-static:${import.meta.env.BASE_URL}:launchpad-sync`;

export type SyncTrigger = 'load' | 'focus' | 'interval' | 'change' | 'online' | 'manual';

/** Backoff after `failures` consecutive failures. */
export function syncBackoffMs(failures: number): number {
  return Math.min(SYNC_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), SYNC_BACKOFF_MAX_MS);
}

/** Where this browser's launch pad syncs to. */
export type SyncSource =
  | { kind: 'onedrive'; id: string; account: StoredAccount }
  | { kind: 'github'; id: string; generation: number };

/** The sync connections set up in this browser: Microsoft ones with the service on, then GitHub. */
export async function syncSources(ctx: StaticContext): Promise<SyncSource[]> {
  const sources: SyncSource[] = getAccounts(ctx)
    .filter((a) => a.capabilities.includes('launchpadSync') && a.enabledCapabilities.includes('launchpadSync'))
    .map((account) => ({ kind: 'onedrive', id: `microsoft:${account.id}`, account }));
  const github = getGitHubSync(ctx);
  const repository = hasGitHubSync(ctx) ? parseRepository(github.repository ?? '') : null;
  if (repository) {
    // GitHub names are case-insensitive; the name itself stays in the github-sync slice.
    const hash = await sha256Hex(new TextEncoder().encode(`${repository.owner}/${repository.name}`.toLowerCase()));
    sources.push({ kind: 'github', id: `github:${hash}`, generation: github.generation });
  }
  return sources;
}

/** Which store a source's settings open: a new one when this changes. */
function storeKey(source: SyncSource): string {
  return source.kind === 'onedrive' ? source.id : `github:${source.generation}`;
}

function defaultStoreFor(ctx: StaticContext, source: SyncSource): SyncStore | null {
  return source.kind === 'onedrive' ? createGraphDriveStore(ctx, source.account.id) : openGitHubStore(ctx);
}

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LaunchpadSyncDeps {
  /** The store for a source (default: the account's OneDrive app folder, or the GitHub repository). Called once per source and settings. */
  storeFor?: (ctx: StaticContext, source: SyncSource) => SyncStore | null;
  timers?: Timers;
  /** Web Locks (default `navigator.locks`; null: this page only). */
  locks?: LockManager | null;
  /** Where focus, visibility and online events come from (default the page's; null in tests that drive it). */
  page?: { document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>; window: Pick<Window, 'addEventListener' | 'removeEventListener'> } | null;
}

export interface LaunchpadSyncController {
  /** Runs now: waits for the lock and ignores backoff and throttle. `choice` answers a first-sync question. */
  syncNow(choice?: FirstSyncChoice): Promise<SyncRoundResult | null>;
  /** A local change was committed (the commit hook calls it). */
  localChange(): void;
  /** One scheduled run, as a trigger would start it (tests). */
  run(trigger: SyncTrigger): Promise<SyncRoundResult | null>;
  stop(): void;
}

function defaultLocks(): LockManager | null {
  return (globalThis.navigator as { locks?: LockManager } | undefined)?.locks ?? null;
}

/** Starts launch pad sync for this page's backend and installs its commit hook. */
export function startLaunchpadSync(ctx: StaticContext, deps: LaunchpadSyncDeps = {}): LaunchpadSyncController {
  const storeFor = deps.storeFor ?? defaultStoreFor;
  const timers: Timers = deps.timers ?? { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (h) => globalThis.clearTimeout(h as number) };
  const locks = deps.locks === undefined ? defaultLocks() : deps.locks;
  const page =
    deps.page === undefined ? (typeof document !== 'undefined' && typeof window !== 'undefined' ? { document, window } : null) : deps.page;

  let stopped = false;
  const abort = new AbortController();
  let chain: Promise<unknown> = Promise.resolve();
  let intervalTimer: unknown = null;
  let changeTimer: unknown = null;
  let firstChangeAt: number | null = null;
  let current: { key: string; store: SyncStore | null } | null = null;

  const visible = (): boolean => !page || page.document.visibilityState === 'visible';

  /** Serializes within this page, and across tabs with the Web Lock (skipping when busy unless `wait`). */
  function exclusive<T>(wait: boolean, fn: () => Promise<T>): Promise<T | null> {
    const run = (): Promise<T | null> => {
      if (!locks?.request) return fn();
      return locks.request(LAUNCHPAD_SYNC_LOCK, { ifAvailable: !wait }, (lock) => (lock ? fn() : null)) as Promise<T | null>;
    };
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next;
  }

  async function record(status: 'off' | 'paused_reauth' | 'several_sources'): Promise<null> {
    const state = getLaunchpadSync(ctx);
    if (state.status === status) return null;
    state.status = status;
    state.problem = null;
    await ctx.state.commitWith([SLICE.launchpadSync], { origin: SYNC_ORIGIN });
    return null;
  }

  async function failed(source: SyncSource, err: unknown): Promise<null> {
    const state = getLaunchpadSync(ctx);
    const now = ctx.now();
    state.checkedAt = now;
    if (err instanceof SyncStoreError && err.code === 'reauth_required') {
      state.status = 'paused_reauth';
      state.problem = null;
      // A Microsoft connection's own status says when it works again; GitHub's settings must change.
      if (source.kind === 'github') state.pausedFor = storeKey(source);
    } else {
      state.failures += 1;
      const retryAfter = err instanceof SyncStoreError ? (err.retryAfterMs ?? 0) : 0;
      state.retryAt = now + Math.max(syncBackoffMs(state.failures), retryAfter);
      state.status = 'error';
      state.problem = err instanceof SyncStoreError ? err.code : 'internal';
      if (!(err instanceof SyncStoreError)) {
        console.error('[Portly] Launch pad sync failed', err);
        recordClientEvent('error', 'backend', 'launch pad sync failed', { op: 'launchpad sync', errName: err instanceof Error ? err.name : typeof err });
      }
    }
    await ctx.state.commitWith([SLICE.launchpadSync], { origin: SYNC_ORIGIN });
    return null;
  }

  async function attempt(trigger: SyncTrigger, choice?: FirstSyncChoice): Promise<SyncRoundResult | null> {
    if (stopped) return null;
    await ctx.state.reload([SLICE.accounts, SLICE.githubSync, SLICE.launchpadSync]);
    const sources = await syncSources(ctx);
    const source = sources.length === 1 ? sources[0]! : null;
    if (!source) {
      current = null;
      return record(sources.length === 0 ? 'off' : 'several_sources');
    }
    const key = storeKey(source);
    if (current?.key !== key) current = { key, store: storeFor(ctx, source) };
    const store = current.store;
    if (!store) return record('off');
    if (source.kind === 'onedrive' && source.account.status === 'reauth') return record('paused_reauth');
    const state = getLaunchpadSync(ctx);
    if (trigger !== 'manual' && state.pausedFor === key) return record('paused_reauth');
    const now = ctx.now();
    // A new source is tried at once: the backoff was the old one's (the round resets it).
    if (trigger !== 'manual' && state.sourceId === source.id) {
      if (now < state.retryAt) return null;
      if (trigger === 'focus' && state.checkedAt !== null && now - state.checkedAt < FOCUS_THROTTLE_MS) return null;
    }
    if (state.pausedFor !== null) {
      // Sync now, or new settings: try again (the round reloads the sync state, so commit it first).
      state.pausedFor = null;
      await ctx.state.commitWith([SLICE.launchpadSync], { origin: SYNC_ORIGIN });
    }
    try {
      const result = await runSyncRound(ctx, store, { sourceId: source.id, signal: abort.signal, ...(choice ? { choice } : {}) });
      if (result.status === 'busy') {
        const busy = getLaunchpadSync(ctx);
        busy.failures += 1;
        busy.retryAt = ctx.now() + syncBackoffMs(busy.failures);
        await ctx.state.commitWith([SLICE.launchpadSync], { origin: SYNC_ORIGIN });
      }
      return result;
    } catch (err) {
      if (abort.signal.aborted) return null;
      return failed(source, err);
    }
  }

  function run(trigger: SyncTrigger, choice?: FirstSyncChoice): Promise<SyncRoundResult | null> {
    return exclusive(trigger === 'manual', () => attempt(trigger, choice)).catch((err: unknown) => {
      console.error('[Portly] Launch pad sync could not run', err);
      return null;
    });
  }

  function scheduleInterval(): void {
    if (stopped) return;
    if (intervalTimer !== null) timers.clearTimeout(intervalTimer);
    intervalTimer = timers.setTimeout(() => {
      intervalTimer = null;
      if (visible()) void run('interval');
      scheduleInterval();
    }, CHECK_INTERVAL_MS);
  }

  function localChange(): void {
    if (stopped) return;
    const now = ctx.now();
    firstChangeAt ??= now;
    if (changeTimer !== null) timers.clearTimeout(changeTimer);
    const delay = Math.max(0, Math.min(CHANGE_DELAY_MS, firstChangeAt + CHANGE_MAX_DELAY_MS - now));
    changeTimer = timers.setTimeout(() => {
      changeTimer = null;
      firstChangeAt = null;
      void run('change');
    }, delay);
  }

  const onVisible = (): void => {
    if (visible()) void run('focus');
  };
  const onOnline = (): void => {
    if (getLaunchpadSync(ctx).waiting) void run('online');
  };

  ctx.state.setCommitHook(launchpadCommitHook(ctx, localChange));
  if (page) {
    page.document.addEventListener('visibilitychange', onVisible);
    page.window.addEventListener('focus', onVisible);
    page.window.addEventListener('online', onOnline);
  }
  scheduleInterval();
  void run('load');

  return {
    syncNow: (choice) => run('manual', choice),
    localChange,
    run: (trigger) => run(trigger),
    stop() {
      stopped = true;
      abort.abort();
      ctx.state.setCommitHook(null);
      if (intervalTimer !== null) timers.clearTimeout(intervalTimer);
      if (changeTimer !== null) timers.clearTimeout(changeTimer);
      if (page) {
        page.document.removeEventListener('visibilitychange', onVisible);
        page.window.removeEventListener('focus', onVisible);
        page.window.removeEventListener('online', onOnline);
      }
    },
  };
}
