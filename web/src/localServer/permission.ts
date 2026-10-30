/**
 * The browser's "Local Network Access" permission for this origin (hybrid mode). Chrome 142+,
 * Edge 143+ and Firefox 153+ gate requests from a public site to a loopback address behind it: the
 * prompt appears only once a connection to the port succeeded, a request waits while it is open,
 * and a denied permission looks like an ordinary network `TypeError`. The permission is named
 * `loopback-network` (Chrome 142–144 also answer to `local-network-access`); `permissions.query`
 * throws for names a browser does not know, which reads as `unsupported`.
 *
 * A page that is itself served from a loopback host (the Pages build previewed on `localhost`)
 * reaches a loopback server without that permission, and Chrome reports it as `denied` on any
 * `http:` page; {@link pageLoopbackPermissionSource} therefore answers `granted` there.
 *
 * Portly on another PC is reached at a tailnet address (100.64.0.0/10), which Chromium counts as
 * the local network: that permission is `local-network` (Chrome 142–144: `local-network-access`
 * for both), {@link LOCAL_NETWORK_PERMISSION_NAMES}.
 */
import { isLoopbackHost } from './origin.ts';
import type { LoopbackPermission } from './types.ts';

/** Names to query, newest first. */
export const LOOPBACK_PERMISSION_NAMES: readonly string[] = Object.freeze(['loopback-network', 'local-network-access']);
/** The same for the local network (Portly on another PC, through its tailnet address). */
export const LOCAL_NETWORK_PERMISSION_NAMES: readonly string[] = Object.freeze(['local-network', 'local-network-access']);

export interface LoopbackPermissionSource {
  /** The current state (`unsupported` when the browser has no such permission). */
  query(): Promise<LoopbackPermission>;
  /** Calls `listener` with the new state whenever the permission changes; returns the unsubscribe function. */
  subscribe(listener: (state: LoopbackPermission) => void): () => void;
}

type PermissionsLike = Pick<Permissions, 'query'>;

async function queryStatus(permissions: PermissionsLike | undefined, names: readonly string[]): Promise<PermissionStatus | null> {
  if (permissions === undefined) return null;
  for (const name of names) {
    try {
      // Not in TypeScript's PermissionName list yet.
      return await permissions.query({ name } as unknown as PermissionDescriptor);
    } catch {
      // Unknown name in this browser: try the next one.
    }
  }
  return null;
}

function stateOf(status: PermissionStatus | null): LoopbackPermission {
  const state = status?.state;
  return state === 'granted' || state === 'denied' || state === 'prompt' ? state : 'unsupported';
}

/** The permission's current state, once (`unsupported` when the browser has none by either name). */
export async function queryLoopbackPermission(
  permissions: PermissionsLike | undefined = browserPermissions(),
  names: readonly string[] = LOOPBACK_PERMISSION_NAMES,
): Promise<LoopbackPermission> {
  return stateOf(await queryStatus(permissions, names));
}

/**
 * A source that queries the permission once, then follows its `change` events. Without such a
 * permission the state stays `unsupported` and listeners are never called.
 */
export function createLoopbackPermissionSource(
  permissions: PermissionsLike | undefined = browserPermissions(),
  names: readonly string[] = LOOPBACK_PERMISSION_NAMES,
): LoopbackPermissionSource {
  const listeners = new Set<(state: LoopbackPermission) => void>();
  let status: Promise<PermissionStatus | null> | null = null;

  const watch = (): Promise<PermissionStatus | null> => {
    status ??= queryStatus(permissions, names).then((found) => {
      found?.addEventListener('change', () => {
        const state = stateOf(found);
        for (const listener of [...listeners]) listener(state);
      });
      return found;
    });
    return status;
  };

  return {
    query: async () => stateOf(await watch()),
    subscribe(listener) {
      listeners.add(listener);
      void watch();
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** A source that always answers `granted` (loopback pages are not gated). */
const ALWAYS_GRANTED: LoopbackPermissionSource = Object.freeze({
  query: async (): Promise<LoopbackPermission> => 'granted',
  subscribe: () => () => {},
});

/**
 * The permission source for a page on `pageHostname` (as `URL.hostname` spells it): always
 * `granted` when the page itself is on a loopback host, otherwise the browser's permission —
 * the loopback one, or the local network one for Portly on another PC (`names`).
 */
export function pageLoopbackPermissionSource(
  pageHostname: string,
  permissions: PermissionsLike | undefined = browserPermissions(),
  names: readonly string[] = LOOPBACK_PERMISSION_NAMES,
): LoopbackPermissionSource {
  return isLoopbackHost(pageHostname) ? ALWAYS_GRANTED : createLoopbackPermissionSource(permissions, names);
}

function browserPermissions(): PermissionsLike | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.permissions;
}
