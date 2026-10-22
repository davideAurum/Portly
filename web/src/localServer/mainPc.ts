/**
 * Portly on the main PC, for the Pages build on another PC (ARCHITECTURE §20): one address
 * for every PC. A browser that has no Portly of its own can remember the main PC's address for
 * other PCs (`PORTLY_REMOTE_ORIGIN`, e.g. `https://<pc>.<tailnet>.ts.net`), and the Pages site then
 * forwards there on load instead of opening this browser's copy.
 *
 * - The address is typed by the user in Settings → Devices and kept in this browser's
 *   localStorage only (`portly:main-pc:<base>`): never in the published site, never from a link
 *   (a link could plant a look-alike page as the target).
 * - The forward happens only when this browser is not paired with a Portly on its own PC (a
 *   paired browser is on a PC that runs Portly: the main PC itself, or one with its own install),
 *   not in a frame, and the address carries no query (a sign-in answer or a pairing return
 *   belongs to this page). Unpaired, the Pages site never probes this PC on its own (that waits
 *   for "Look for Portly on this PC"), so pairing is what tells whether Portly runs here.
 * - `?here` in the address keeps that one page load here (the escape hatch when the main PC is
 *   off), and is taken out of the address.
 * - No reachability check first: the Pages CSP would need `connect-src https:` for an address
 *   known only at run time. When the main PC is off, the browser shows its own error, and
 *   `?here` opens this browser's copy.
 */
import { createPairingStore, readItem, removeItem, writeItem, type StorageLike } from './pairing.ts';
import { isLoopbackHost } from './origin.ts';

/** Query parameter that keeps one page load here instead of forwarding to the main PC. */
export const STAY_HERE_PARAM = 'here';

/** localStorage key of the main PC's address for a Pages base path (default: this build's). */
export function mainPcKey(base: string = import.meta.env.BASE_URL): string {
  return `portly:main-pc:${base}`;
}

/**
 * The origin of a main PC address the user typed, or null when it can't be one: `https:` only
 * (what a reverse proxy such as Tailscale Serve gives), no credentials, not this PC's loopback
 * (that is Portly on this PC, which pairs instead) and not the Pages site itself. A path, query
 * or fragment is dropped: Portly's address for other PCs is an origin.
 */
export function parseMainPcOrigin(raw: string, pagesOrigin: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (isLoopbackHost(url.hostname)) return null;
  if (url.origin === pagesOrigin) return null;
  return url.origin;
}

export interface MainPcStore {
  /** The saved origin (checked again on read: storage is not trusted), or null. */
  read(): string | null;
  /** Saves a valid address (as its origin); false when it is not one or storage refused it. */
  save(raw: string): boolean;
  clear(): void;
}

export function createMainPcStore(storage: StorageLike | null, pagesOrigin: string, base?: string): MainPcStore {
  const key = mainPcKey(base);
  return {
    read: () => {
      const raw = readItem(storage, key);
      return raw === null ? null : parseMainPcOrigin(raw, pagesOrigin);
    },
    save: (raw) => {
      const origin = parseMainPcOrigin(raw, pagesOrigin);
      return origin !== null && writeItem(storage, key, origin);
    },
    clear: () => removeItem(storage, key),
  };
}

export interface MainPcRedirectInput {
  location: Pick<Location, 'href' | 'origin' | 'search' | 'hash'>;
  history: Pick<History, 'replaceState' | 'state'>;
  storage: StorageLike | null;
  framed: boolean;
  base?: string;
}

/**
 * Where this page load forwards to (the main PC's address with this page's hash route), or null
 * to stay. A `?here` in the address is taken out (it keeps this load here).
 */
export function mainPcRedirect({ location, history, storage, framed, base }: MainPcRedirectInput): string | null {
  const url = new URL(location.href);
  if (url.searchParams.has(STAY_HERE_PARAM)) {
    url.searchParams.delete(STAY_HERE_PARAM);
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    return null;
  }
  if (framed || location.search !== '') return null;
  if (createPairingStore(storage, base).read() !== null) return null;
  const origin = createMainPcStore(storage, location.origin, base).read();
  return origin === null ? null : `${origin}/${location.hash}`;
}
