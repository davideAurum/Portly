/**
 * When launch pad sync runs: the commit hook (changes waiting, stamps for the synced settings,
 * sync's own commits left alone) and the scheduler (page load, the 60 s focus throttle, the 5 s /
 * 30 s change delay, the 5-minute check while visible, backoff, a needed reconnect, no service,
 * the Web Lock), with a fake store and timers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bookmarks from '../handlers/bookmarks.ts';
import * as settings from '../handlers/settings.ts';
import { SLICE, getAccounts, getLaunchpadSync, getSettings, type StoredAccount } from '../slices.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import { SYNC_ORIGIN, launchpadCommitHook } from './hook.ts';
import { CHANGE_DELAY_MS, CHANGE_MAX_DELAY_MS, CHECK_INTERVAL_MS, FOCUS_THROTTLE_MS, SYNC_BACKOFF_BASE_MS, startLaunchpadSync, type LaunchpadSyncController } from './scheduler.ts';
import { SyncStoreError, type SyncFileVersion, type SyncStore } from './store.ts';

const T0 = 1_700_000_000_000;

let t: TestBackend;
let controller: LaunchpadSyncController | null = null;

afterEach(() => {
  controller?.stop();
  controller = null;
  t?.close();
});

function account(extra: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: 'acc-1',
    kind: 'microsoft',
    label: 'me@outlook.com',
    email: 'me@outlook.com',
    externalId: 'subject-1',
    color: null,
    capabilities: ['calendar', 'launchpadSync'],
    enabledCapabilities: ['calendar', 'launchpadSync'],
    grantedScopes: [],
    requestedScopes: [],
    status: 'ok',
    statusMessage: null,
    sort: 0,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

/** A store whose file never changes after the first write, counting reads. */
function memoryStore(fail?: () => SyncStoreError | null): SyncStore & { reads: number } {
  let file: SyncFileVersion | null = null;
  const store = {
    kind: 'github' as const,
    reads: 0,
    async readMain() {
      store.reads++;
      const err = fail?.();
      if (err) throw err;
      return file;
    },
    async writeMain(text: string) {
      file = { text, version: `v${store.reads}` };
      return { ok: true as const, version: file.version };
    },
    readIcon: async () => null,
    writeIcon: async () => undefined,
    deleteIcon: async () => undefined,
  };
  return store;
}

/** Timers driven by hand. */
function manualTimers() {
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    setTimeout(fn: () => void, ms: number) {
      pending.set(next, { at: now + ms, fn });
      return next++;
    },
    clearTimeout(handle: unknown) {
      pending.delete(handle as number);
    },
    /** Runs every timer due within `ms`. */
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now) {
          pending.delete(id);
          timer.fn();
        }
      }
    },
  };
}

async function setup(options: { account?: StoredAccount | null; store?: SyncStore & { reads: number }; visible?: boolean } = {}) {
  t = await createTestBackend([settings, bookmarks], { startAt: T0 });
  if (options.account !== null) getAccounts(t.ctx).push(options.account ?? account());
  await t.ctx.state.commit(SLICE.accounts);
  const store = options.store ?? memoryStore();
  const timers = manualTimers();
  const listeners = new Map<string, () => void>();
  const page = {
    document: {
      visibilityState: (options.visible ?? true) ? 'visible' : 'hidden',
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    },
    window: { addEventListener: (type: string, fn: () => void) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type) },
  } as unknown as NonNullable<Parameters<typeof startLaunchpadSync>[1]>['page'];
  const settled = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  // One store per run: counts how often a round started.
  const runs = { count: 0 };
  controller = startLaunchpadSync(t.ctx, {
    storeFor: () => {
      runs.count++;
      return store;
    },
    timers,
    locks: null,
    page,
  });
  await settled();
  return { store, timers, listeners, settled, runs };
}

describe('the commit hook', () => {
  it('marks changes waiting with the commit that makes them, and stamps a changed synced setting', async () => {
    t = await createTestBackend([settings, bookmarks], { startAt: T0 });
    const heard = vi.fn();
    t.ctx.state.setCommitHook(launchpadCommitHook(t.ctx, heard));
    const res = await t.json<{ id: string }>('POST', '/api/bookmark-groups', { name: 'Work' });
    expect(getLaunchpadSync(t.ctx)).toMatchObject({ waiting: true, changes: 1 });
    expect(await t.storage.getJson(`slice:${SLICE.launchpadSync}`)).toMatchObject({ waiting: true, changes: 1 });
    expect(heard).toHaveBeenCalledTimes(1);

    t.tick(1000);
    await t.json('PATCH', '/api/settings', { bookmarks: { defaultGroupId: res.body.id } });
    expect(getLaunchpadSync(t.ctx).pointers.defaultGroupId).toEqual({ value: res.body.id, at: T0 + 1000 });
    // Any other setting is not the launch pad's.
    await t.json('PATCH', '/api/settings', { general: { clock24h: true } });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('leaves sync own commits alone', async () => {
    t = await createTestBackend([settings, bookmarks], { startAt: T0 });
    const heard = vi.fn();
    t.ctx.state.setCommitHook(launchpadCommitHook(t.ctx, heard));
    await t.ctx.state.commitWith([SLICE.bookmarks], { origin: SYNC_ORIGIN });
    expect(getLaunchpadSync(t.ctx).waiting).toBe(false);
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('the scheduler', () => {
  it('syncs at page load, and every 5 minutes while visible', async () => {
    const { store, timers, settled } = await setup();
    expect(store.reads).toBe(1);
    timers.advance(CHECK_INTERVAL_MS);
    await settled();
    expect(store.reads).toBe(2);
  });

  it('skips the 5-minute check while hidden', async () => {
    const { store, timers, settled } = await setup({ visible: false });
    timers.advance(CHECK_INTERVAL_MS);
    await settled();
    expect(store.reads).toBe(1);
  });

  it('checks on focus, at most once a minute across tabs', async () => {
    const { store, listeners, settled } = await setup();
    listeners.get('focus')!();
    await settled();
    expect(store.reads).toBe(1);
    t.tick(FOCUS_THROTTLE_MS);
    listeners.get('focus')!();
    await settled();
    expect(store.reads).toBe(2);
  });

  it('syncs 5 s after the last local change, at most 30 s after the first', async () => {
    const { timers, settled, runs } = await setup();
    const group = await t.json<{ id: string }>('POST', '/api/bookmark-groups', { name: 'Work' });
    for (let i = 0; i < 8; i++) {
      t.tick(4000);
      timers.advance(4000);
      await t.json('PATCH', `/api/bookmark-groups/${group.body.id}`, { name: `Work ${i}` });
      await settled();
    }
    // Changes every 4 s keep pushing it back, but not past 30 s after the first.
    expect(runs.count).toBe(2);
    expect(CHANGE_MAX_DELAY_MS).toBe(30_000);
    t.tick(CHANGE_DELAY_MS);
    timers.advance(CHANGE_DELAY_MS);
    await settled();
    expect(runs.count).toBe(3);
  });

  it('backs off after a failure, and Sync now ignores the backoff', async () => {
    let failing = true;
    const store = memoryStore(() => (failing ? new SyncStoreError('unavailable', 'down') : null));
    const { listeners, settled } = await setup({ store });
    expect(getLaunchpadSync(t.ctx)).toMatchObject({ status: 'error', problem: 'unavailable', failures: 1, retryAt: T0 + SYNC_BACKOFF_BASE_MS });
    t.tick(FOCUS_THROTTLE_MS);
    listeners.get('focus')!();
    await settled();
    expect(store.reads).toBe(1);
    failing = false;
    expect(await controller!.syncNow()).toMatchObject({ status: 'up_to_date' });
    expect(getLaunchpadSync(t.ctx)).toMatchObject({ status: 'up_to_date', failures: 0, retryAt: 0 });
  });

  it('pauses while the account needs reconnecting', async () => {
    const store = memoryStore();
    await setup({ account: account({ status: 'reauth' }), store });
    expect(store.reads).toBe(0);
    expect(getLaunchpadSync(t.ctx).status).toBe('paused_reauth');
  });

  it('does nothing without a connection that has the service on', async () => {
    const store = memoryStore();
    await setup({ account: account({ enabledCapabilities: ['calendar'] }), store });
    expect(store.reads).toBe(0);
    expect(getLaunchpadSync(t.ctx).status).toBe('off');
  });

  it('lets one tab sync at a time: a scheduled check skips while another holds the lock', async () => {
    t = await createTestBackend([settings, bookmarks], { startAt: T0 });
    getAccounts(t.ctx).push(account());
    await t.ctx.state.commit(SLICE.accounts);
    const store = memoryStore();
    const request = vi.fn((_name: string, options: LockOptions, fn: (lock: Lock | null) => unknown) => Promise.resolve(fn(options.ifAvailable ? null : ({ name: 'x', mode: 'exclusive' } as Lock))));
    controller = startLaunchpadSync(t.ctx, { storeFor: () => store, timers: manualTimers(), locks: { request } as unknown as LockManager, page: null });
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledWith(expect.stringMatching(/:launchpad-sync$/), { ifAvailable: true }, expect.any(Function));
    expect(store.reads).toBe(0);
    await controller.syncNow();
    expect(request).toHaveBeenLastCalledWith(expect.any(String), { ifAvailable: false }, expect.any(Function));
    expect(store.reads).toBe(1);
    expect(getSettings(t.ctx).bookmarks.defaultGroupId).toBeNull();
  });
});
