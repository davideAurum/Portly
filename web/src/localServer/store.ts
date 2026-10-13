/**
 * The local server controller as an external store for the UI. `main.tsx` (Pages build, hybrid
 * mode on) plugs the real controller in with `setLocalServerController`; until then — and always
 * in the server build and in tests — an inert default answers: status `disabled`, this page load's
 * backend from `getCapabilities()`, actions that do nothing. Components read the state with
 * `useLocalServer()` and act through `localServerActions`, so they never hold the controller.
 */
import { useSyncExternalStore } from 'react';
import { getCapabilities, type Backend } from '../capabilities.ts';
import type { LocalServerActions, LocalServerController, LocalServerState } from './types.ts';

let controller: LocalServerController | null = null;
let unsubscribeController: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Inert states, one per backend, so the snapshot stays the same object between reads. */
const inertStates = new Map<Backend, LocalServerState>();

function inertState(): LocalServerState {
  const backend = getCapabilities().backend;
  let state = inertStates.get(backend);
  if (state === undefined) {
    state = Object.freeze({
      backend,
      status: 'disabled',
      server: null,
      paired: false,
      checkedAt: null,
      pendingSwitch: null,
      permission: null,
      manual: false,
    });
    inertStates.set(backend, state);
  }
  return state;
}

/** Plugs a controller in (null: back to the inert default); subscribers are told either way. */
export function setLocalServerController(next: LocalServerController | null): void {
  unsubscribeController?.();
  unsubscribeController = null;
  controller = next;
  if (next !== null) unsubscribeController = next.subscribe(notify);
  notify();
}

export function getLocalServerState(): LocalServerState {
  return controller === null ? inertState() : controller.getState();
}

/** Calls `listener` after every state change (and when the controller is swapped); returns the unsubscribe function. */
export function subscribeLocalServer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The controller's state, following changes. */
export function useLocalServer(): LocalServerState {
  return useSyncExternalStore(subscribeLocalServer, getLocalServerState, getLocalServerState);
}

/** The controller's actions; each does nothing while no controller is plugged in. */
export const localServerActions: LocalServerActions = Object.freeze({
  checkNow: () => controller?.actions.checkNow(),
  lookForServer: () => controller?.actions.lookForServer(),
  startPairing: () => controller?.actions.startPairing(),
  disconnect: async () => {
    await controller?.actions.disconnect();
  },
  switchNow: () => controller?.actions.switchNow(),
});

/** Tests only (the vitest setup files call it after every test): unplugs the controller and drops every subscriber. */
export function resetLocalServerStoreForTests(): void {
  unsubscribeController?.();
  unsubscribeController = null;
  controller = null;
  listeners.clear();
}
