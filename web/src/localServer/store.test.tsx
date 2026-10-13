/**
 * The local server store: the inert default (status `disabled`, this page load's backend, actions
 * that do nothing), plugging a controller in and out, forwarding its changes to subscribers and
 * `useLocalServer`, and delegating the actions.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import {
  getLocalServerState,
  localServerActions,
  resetLocalServerStoreForTests,
  setLocalServerController,
  subscribeLocalServer,
  useLocalServer,
} from './store.ts';
import type { LocalServerActions, LocalServerController, LocalServerState } from './types.ts';

const CONNECTED: LocalServerState = {
  backend: 'server',
  status: 'connected',
  server: { version: '0.1.0', instanceId: 'instance-1', appUrl: 'http://localhost:5757/', apiVersion: 1, vault: 'ready' },
  paired: true,
  checkedAt: 1_700_000_000_000,
  pendingSwitch: null,
  permission: 'granted',
  manual: false,
};

/** A controller whose state the test sets; `actions` are spies. */
function fakeController(initial: LocalServerState = CONNECTED) {
  let state = initial;
  const listeners = new Set<() => void>();
  const actions = {
    checkNow: vi.fn(),
    lookForServer: vi.fn(),
    startPairing: vi.fn(),
    disconnect: vi.fn(async () => {}),
    switchNow: vi.fn(),
  } satisfies LocalServerActions;
  const controller: LocalServerController = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    actions,
  };
  return {
    controller,
    actions,
    listeners,
    set(next: Partial<LocalServerState>) {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
  };
}

describe('inert default', () => {
  it('is disabled, on this page load’s backend, and stays the same object between reads', () => {
    const state = getLocalServerState();
    expect(state).toEqual({
      backend: 'server',
      status: 'disabled',
      server: null,
      paired: false,
      checkedAt: null,
      pendingSwitch: null,
      permission: null,
      manual: false,
    });
    expect(getLocalServerState()).toBe(state);
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    expect(getLocalServerState()).toMatchObject({ backend: 'browser', status: 'disabled' });
    expect(getLocalServerState()).toBe(getLocalServerState());
  });

  it('has actions that do nothing', async () => {
    expect(() => {
      localServerActions.checkNow();
      localServerActions.lookForServer();
      localServerActions.startPairing();
      localServerActions.switchNow();
    }).not.toThrow();
    await expect(localServerActions.disconnect()).resolves.toBeUndefined();
  });
});

describe('with a controller', () => {
  it('reads the controller’s state and tells subscribers when it is plugged in, changes and is unplugged', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLocalServer(listener);
    const fake = fakeController();

    setLocalServerController(fake.controller);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getLocalServerState()).toBe(CONNECTED);

    fake.set({ status: 'reconnecting' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getLocalServerState().status).toBe('reconnecting');

    setLocalServerController(null);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(fake.listeners.size).toBe(0);
    expect(getLocalServerState().status).toBe('disabled');

    unsubscribe();
    setLocalServerController(fake.controller);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('stops listening to a controller it replaced', () => {
    const first = fakeController();
    const second = fakeController({ ...CONNECTED, status: 'absent', backend: 'browser' });
    const listener = vi.fn();
    subscribeLocalServer(listener);
    setLocalServerController(first.controller);
    setLocalServerController(second.controller);
    expect(first.listeners.size).toBe(0);
    listener.mockClear();
    first.set({ status: 'reconnecting' });
    expect(listener).not.toHaveBeenCalled();
    expect(getLocalServerState().status).toBe('absent');
  });

  it('delegates the actions to the controller plugged in when they are called', async () => {
    const fake = fakeController();
    setLocalServerController(fake.controller);
    localServerActions.checkNow();
    localServerActions.lookForServer();
    localServerActions.startPairing();
    localServerActions.switchNow();
    await localServerActions.disconnect();
    expect(fake.actions.checkNow).toHaveBeenCalledTimes(1);
    expect(fake.actions.lookForServer).toHaveBeenCalledTimes(1);
    expect(fake.actions.startPairing).toHaveBeenCalledTimes(1);
    expect(fake.actions.switchNow).toHaveBeenCalledTimes(1);
    expect(fake.actions.disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnect waits for the controller', async () => {
    const fake = fakeController();
    let finish = () => {};
    fake.actions.disconnect.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    setLocalServerController(fake.controller);
    let done = false;
    const pending = localServerActions.disconnect().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    finish();
    await pending;
    expect(done).toBe(true);
  });

  it('resetLocalServerStoreForTests unplugs the controller and drops subscribers', () => {
    const fake = fakeController();
    const listener = vi.fn();
    subscribeLocalServer(listener);
    setLocalServerController(fake.controller);
    resetLocalServerStoreForTests();
    expect(fake.listeners.size).toBe(0);
    expect(getLocalServerState().status).toBe('disabled');
    listener.mockClear();
    setLocalServerController(fakeController().controller);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('useLocalServer', () => {
  it('follows the controller', () => {
    const { result } = renderHook(() => useLocalServer());
    expect(result.current.status).toBe('disabled');

    const fake = fakeController({ ...CONNECTED, status: 'checking' });
    act(() => setLocalServerController(fake.controller));
    expect(result.current.status).toBe('checking');

    act(() => fake.set({ status: 'connected', checkedAt: 1_700_000_030_000 }));
    expect(result.current).toMatchObject({ status: 'connected', checkedAt: 1_700_000_030_000 });

    act(() => setLocalServerController(null));
    expect(result.current.status).toBe('disabled');
  });
});
