/**
 * Is this page load another PC's (the server build opened through the HTTPS reverse proxy on the
 * main PC, ARCHITECTURE §4.2 remote branch)? Decided once before the first render (`main.tsx`),
 * because what the page offers follows it (`capabilities.ts` `remoteClient`).
 *
 * The page asks `GET /api/health` (exempt, one small request), which says `remote: true` when
 * the server took the request as another PC's (it came in on the remote port). Otherwise the page
 * is this PC's own when the server names this very origin as its page (`appUrl`) or the address
 * is a loopback one (the dev server proxies to the server); any other address with
 * `remote: false` means the proxy points at the server's main port instead of its remote port
 * (`misrouted`: the connect screen says so and goes no further). A server that cannot be reached
 * or does not say counts as this PC's own on a loopback address and as another PC's elsewhere:
 * the app then shows its usual "can't reach" notices. The loopback address is never a shortcut
 * past the request, so a local proxy on another loopback port (`PORTLY_REMOTE_ORIGIN=
 * http://localhost:8443`, to try the flow on this PC) is seen as what the server says it is.
 */
import type { HealthResponse } from '@portly/shared';

export type ServerView = 'local' | 'remote' | 'misrouted';

/** How long the health check may take before the page goes on as a remote one. */
export const REMOTE_CHECK_TIMEOUT_MS = 5_000;

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** `localhost`, `*.localhost`, `127.0.0.1` or `[::1]` (the hosts the server treats as its own). */
export function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.trim().toLowerCase();
  return LOOPBACK_HOSTNAMES.has(name) || name.endsWith('.localhost');
}

export interface DetectRemoteClientDeps {
  /** `window.location.hostname` and `window.location.origin`. */
  hostname: string;
  origin: string;
  fetchHealth(signal: AbortSignal): Promise<HealthResponse>;
  timeoutMs?: number;
}

function originOf(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export interface ResolveRemoteClientDeps extends DetectRemoteClientDeps {
  /** `GET /api/device`: the connected device, or null when the server does not take this page as one. */
  fetchDeviceSelf(): Promise<unknown>;
  /** Marks this page load as another PC's (`capabilities.ts`). */
  setRemoteClient(remote: boolean): void;
}

/**
 * The whole decision `main.tsx` makes before the first render: how the server took this page
 * load and, for another PC's, whether it is a connected device. A server that cannot be reached
 * counts as connected (the app then shows its usual notices). The page is marked as another PC's
 * only after the device check: on a page that counts as one, any 401 reloads it (api/client.ts),
 * and the device check's own 401 is the one that must not.
 */
export async function resolveRemoteClient(deps: ResolveRemoteClientDeps): Promise<{ view: ServerView; connected: boolean }> {
  const view = await detectRemoteClient(deps);
  let connected = true;
  if (view === 'remote') {
    try {
      connected = (await deps.fetchDeviceSelf()) !== null;
    } catch {
      connected = true;
    }
  }
  deps.setRemoteClient(view === 'remote');
  return { view, connected };
}

export async function detectRemoteClient(deps: DetectRemoteClientDeps): Promise<ServerView> {
  const loopback = isLoopbackHostname(deps.hostname);
  let health: HealthResponse;
  try {
    health = await deps.fetchHealth(AbortSignal.timeout(deps.timeoutMs ?? REMOTE_CHECK_TIMEOUT_MS));
  } catch {
    return loopback ? 'local' : 'remote';
  }
  if (health.remote === true) return 'remote';
  if (originOf(health.appUrl) === deps.origin || loopback) return 'local';
  return health.remote === false ? 'misrouted' : 'remote';
}
