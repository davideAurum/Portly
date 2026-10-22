/**
 * One page: Portly's own page on this PC forwards to the Pages site when one is configured
 * (`PORTLY_PAGES_URL`), keeping the address's query and hash route (e.g. the `?oauth=` result of
 * a sign-in, whose callback lands here). Server build only, before the first render.
 *
 * It stays here:
 * - on `#/pair`, where a browser on the Pages site is approved (the trust starts on this page);
 * - on `#/settings/devices`, where another PC is approved, for the same reason: the Pages site may
 *   not approve one, and on a PC with a Pages site this is the only way to reach that section;
 * - on `#/settings/diagnostics`, so that Portly's full diagnostics on this PC can always be
 *   opened here (the Pages site links to it), even when the Pages site or its connection to this
 *   server is what is broken;
 * - on another PC's page load (`remoteClient`: through the reverse proxy on the main PC, where
 *   the Pages site would look for a server on that PC's own loopback and find none);
 * - in a frame, or when no Pages site is configured or its address is unusable;
 * - when the Pages site can't be reached (offline): this page is the fallback, and says so.
 */
import { isSafeHttpUrl } from '@portly/shared';
import { fetchPairings } from '../api/pairing.ts';
import { parseHash } from './router.ts';

/** How long the Pages site may take to answer before this page is used instead. */
export const PAGES_PROBE_TIMEOUT_MS = 3000;

export type PagesForwardResult = 'forwarded' | 'stay' | 'offline';

export interface PagesForwardDeps {
  location: Pick<Location, 'hash' | 'search' | 'replace'>;
  framed: boolean;
  /** This page load is another PC's (ARCHITECTURE §4.2 remote branch): it stays here. */
  remoteClient?: boolean;
  /** The configured Pages address (`GET /api/pairings`). */
  pagesUrl?: (signal: AbortSignal) => Promise<string | null>;
  /** Resolves when the Pages site answers, rejects when it can't be reached. */
  probe?: (url: string, signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
}

function defaultPagesUrl(signal: AbortSignal): Promise<string | null> {
  return fetchPairings(signal).then((r) => r.pagesUrl);
}

/** An opaque (`no-cors`) answer is enough: it only has to show that the site can be reached. */
function defaultProbe(url: string, signal: AbortSignal): Promise<unknown> {
  return fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
}

/** `https:`, or `http:` on a loopback host (a Pages build served on this PC), like the server's own check. */
function usablePagesUrl(raw: string | null): string | null {
  if (raw === null || !isSafeHttpUrl(raw)) return null;
  const url = new URL(raw);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  if (url.search !== '' || url.hash !== '') return null;
  return url.href;
}

/** Routes that always stay on this page: pairing approval, the devices section and the diagnostics page. */
function staysHere(hash: string): boolean {
  const route = parseHash(hash);
  return route.name === 'pair' || (route.name === 'settings' && (route.section === 'diagnostics' || route.section === 'devices'));
}

export async function forwardToPages(deps: PagesForwardDeps): Promise<PagesForwardResult> {
  const { location, framed } = deps;
  if (framed || deps.remoteClient === true || staysHere(location.hash)) return 'stay';
  const timeoutMs = deps.timeoutMs ?? PAGES_PROBE_TIMEOUT_MS;

  let pagesUrl: string | null;
  try {
    pagesUrl = usablePagesUrl(await (deps.pagesUrl ?? defaultPagesUrl)(AbortSignal.timeout(timeoutMs)));
  } catch {
    return 'stay';
  }
  if (pagesUrl === null) return 'stay';

  try {
    await (deps.probe ?? defaultProbe)(pagesUrl, AbortSignal.timeout(timeoutMs));
  } catch {
    return 'offline';
  }
  location.replace(`${pagesUrl}${location.search}${location.hash}`);
  return 'forwarded';
}
