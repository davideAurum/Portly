/**
 * Test doubles for hybrid mode (the Pages build using the Portly server on this PC), for UI tests
 * that run as `setCapabilitiesForTests(capabilitiesFor(true, 'server'))` or that show what the
 * local server controller says:
 *
 * - `manualAssetSource()`: a `ServerAssetSource` whose image loads the test finishes by hand
 *   (`finish(url, 'blob:…')`); plug it in with `setServerAssetSource(fake.source)`.
 * - `fakeLocalServer(state)`: a `LocalServerController` with spy actions and a settable state;
 *   plug it in with `setLocalServerController(fake.controller)`.
 *
 * Unplug the asset source in an `afterEach` (`setServerAssetSource(null)`); the vitest setup
 * unplugs the controller after every test.
 */
import { vi, type Mock } from 'vitest';
import type { ServerAssetSource } from '../static/assets.ts';
import type { LocalServerController, LocalServerState } from '../localServer/types.ts';

export interface ManualAssetSource {
  source: ServerAssetSource;
  load: Mock<(url: string) => Promise<string | null>>;
  /** Completes the load of `url` (null: the server has no such image) and tells subscribers. */
  finish(url: string, value: string | null): void;
}

export function manualAssetSource(): ManualAssetSource {
  const loaded = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  const pending = new Map<string, (value: string | null) => void>();
  const load = vi.fn(
    (url: string) =>
      new Promise<string | null>((resolve) => {
        pending.set(url, resolve);
      }),
  );
  const source: ServerAssetSource = {
    get: (url) => loaded.get(url) ?? null,
    load,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    source,
    load,
    finish(url, value) {
      loaded.set(url, value);
      pending.get(url)?.(value);
      for (const listener of [...listeners]) listener();
    },
  };
}

export interface FakeLocalServer {
  controller: LocalServerController;
  actions: {
    checkNow: Mock<() => void>;
    lookForServer: Mock<() => void>;
    startPairing: Mock<() => void>;
    disconnect: Mock<() => Promise<void>>;
    switchNow: Mock<() => void>;
  };
  /** Merges `patch` into the state and tells subscribers. */
  set(patch: Partial<LocalServerState>): void;
}

/** A controller on a browser-backend page that has not checked yet (status `idle`), unless `state` says otherwise. */
export function fakeLocalServer(state: Partial<LocalServerState> = {}): FakeLocalServer {
  let current: LocalServerState = {
    backend: 'browser',
    status: 'idle',
    server: null,
    paired: false,
    checkedAt: null,
    pendingSwitch: null,
    permission: 'prompt',
    manual: false,
    ...state,
  };
  const listeners = new Set<() => void>();
  const actions = {
    checkNow: vi.fn<() => void>(),
    lookForServer: vi.fn<() => void>(),
    startPairing: vi.fn<() => void>(),
    disconnect: vi.fn<() => Promise<void>>(async () => {}),
    switchNow: vi.fn<() => void>(),
  };
  return {
    controller: {
      getState: () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      actions,
    },
    actions,
    set(patch) {
      current = { ...current, ...patch };
      for (const listener of [...listeners]) listener();
    },
  };
}
