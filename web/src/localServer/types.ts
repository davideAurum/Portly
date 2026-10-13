/**
 * Types of the local server controller (hybrid mode): the Pages build looks for the Homebase
 * server on this PC, pairs with it once, and uses it as this page load's backend while it answers.
 * The controller (`controller.ts`) owns the state; the UI reads it through `store.ts`
 * (`useLocalServer()`) and acts through `localServerActions`.
 */
import type { VaultState } from '@homebase/shared';
import type { Backend } from '../capabilities.ts';

/**
 * Where the controller stands:
 * - `disabled`: hybrid mode is off (server build, or a Pages build without a local server origin);
 * - `framed`: the page runs inside a frame, which never uses the local server;
 * - `idle`: not checked yet (not paired and the browser's local network permission not granted);
 * - `checking`: a probe is in flight;
 * - `absent`: nothing (or not Homebase) answers on this PC;
 * - `blocked`: the browser's local network permission is denied;
 * - `waiting-permission`: a probe waits for the user to answer the browser's permission prompt;
 * - `unpaired`: Homebase answers but this browser is not paired with it;
 * - `revoked`: the server no longer accepts this browser's pairing;
 * - `other-server`: a different Homebase than the one this browser paired with answers;
 * - `incompatible`: the server speaks another API version (one of them needs an update);
 * - `connected`: the paired server answers;
 * - `reconnecting`: the paired server stopped answering on a server-backend page (grace period).
 */
export const LOCAL_SERVER_STATUSES = [
  'disabled',
  'framed',
  'idle',
  'checking',
  'absent',
  'blocked',
  'waiting-permission',
  'unpaired',
  'revoked',
  'other-server',
  'incompatible',
  'connected',
  'reconnecting',
] as const;
export type LocalServerStatus = (typeof LOCAL_SERVER_STATUSES)[number];

/** What the last healthy probe learned about the server (untrusted input: `appUrl` is validated). */
export interface LocalServerInfo {
  version: string;
  instanceId: string | null;
  /** The server's own page, validated by `validateAppUrl` (null when missing or refused). */
  appUrl: string | null;
  apiVersion: number | null;
  vault: VaultState;
}

/**
 * What the last probe learned beyond "nothing usable answers" (`absent`, or `reconnecting` on a
 * server-backend page):
 * - `answers-without-cors`: something answers on the port, but not to this site's CORS requests —
 *   Homebase on this PC does not have this site as its `HOMEBASE_PAGES_URL` (or is too old for
 *   hybrid mode). Settings → Diagnostics explains how to fix it.
 */
export type LocalServerUnreachableReason = 'answers-without-cors';

/** Why this page load should switch backend (it reloads to do so). */
export type PendingSwitchReason = 'connected' | 'unreachable' | 'revoked' | 'other-server' | 'incompatible' | 'blocked' | 'disconnected';

/** A backend switch waiting for the page to be idle (a dialog is open, edit mode, a field has focus). */
export interface PendingSwitch {
  target: Backend;
  reason: PendingSwitchReason;
}

/** The browser's local network access permission for this origin (`unsupported`: no such permission). */
export type LoopbackPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

export interface LocalServerState {
  /** This page load's backend (fixed for the page load). */
  backend: Backend;
  status: LocalServerStatus;
  /** The server as last seen by a healthy probe, or null. */
  server: LocalServerInfo | null;
  /** This browser holds a pairing record. */
  paired: boolean;
  /** When the last probe finished (epoch ms), or null before the first one. */
  checkedAt: number | null;
  pendingSwitch: PendingSwitch | null;
  /** Null until queried. */
  permission: LoopbackPermission | null;
  /** The last check was started by the user (Look for it / Check again), not in the background. */
  manual: boolean;
  /**
   * Set while the status is `absent` or `reconnecting` (or `checking` again from one of them)
   * because of what the last probe found; null otherwise (the controller clears it on every other
   * status). Optional: states built without it (the store's inert default, tests) mean null.
   */
  unreachableReason?: LocalServerUnreachableReason | null;
}

export interface LocalServerActions {
  /** Probes now (Check again); resets the backoff. */
  checkNow(): void;
  /** Probes now even before the permission is granted (a user gesture: Look for Homebase on this PC). */
  lookForServer(): void;
  /** Sends this tab to the server's own page to approve pairing. */
  startPairing(): void;
  /** Forgets the pairing (also on the server, best effort) and reloads on the browser backend. */
  disconnect(): Promise<void>;
  /** Applies a pending switch now (reloads). */
  switchNow(): void;
}

export interface LocalServerController {
  /** The current state: the same object until the state changes (a `useSyncExternalStore` snapshot). */
  getState(): LocalServerState;
  /** Calls `listener` after every state change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  actions: LocalServerActions;
}
