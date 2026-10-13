/**
 * Web origins that called the API but are not the configured Pages site (§17). The gate notes
 * them; the diagnostics summary shows the named ones, which is how a missing or wrong
 * `HOMEBASE_PAGES_URL` becomes visible ("a page at <origin> tried to use this server").
 *
 * Only origins worth naming are kept ({@link isNamedForeignOrigin}: `*.github.io`, loopback, or
 * the Pages site's own registrable domain, which on a shared host such as `pages.dev` or under a
 * country suffix such as `co.uk` takes a third label); every other foreign request is only
 * counted, so third-party sites the user happened to visit are never recorded. At most {@link MAX_NAMED}
 * origins, least recently seen dropped first; origins are truncated to {@link MAX_ORIGIN_LENGTH}
 * characters. {@link webOrigin} says which `Origin` headers count at all (http/https origins;
 * browser-extension origins and `null` do not).
 */
import { isIP } from 'node:net';

export const MAX_NAMED = 5;
export const MAX_ORIGIN_LENGTH = 100;

export interface ForeignOriginEntry {
  origin: string;
  /** Epoch ms. */
  firstAt: number;
  /** Epoch ms. */
  lastAt: number;
  count: number;
}

export interface ForeignOriginSnapshot {
  /** Named origins, most recently seen first. */
  origins: ForeignOriginEntry[];
  /** Foreign requests from origins that were only counted (not named). */
  requests: number;
}

export interface ForeignOriginTracker {
  /** Records a request from a foreign web origin: named (kept in the list) or only counted. */
  note(origin: string, opts: { named: boolean }, now?: number): void;
  snapshot(): ForeignOriginSnapshot;
  /** Forgets everything (tests). */
  reset(): void;
}

export function createForeignOriginTracker(): ForeignOriginTracker {
  // Map insertion order doubles as recency order (re-inserted on every hit).
  const named = new Map<string, ForeignOriginEntry>();
  let requests = 0;

  return {
    note(origin, opts, now = Date.now()) {
      if (!opts.named) {
        requests++;
        return;
      }
      const key = origin.slice(0, MAX_ORIGIN_LENGTH);
      const existing = named.get(key);
      named.delete(key);
      named.set(key, existing ? { ...existing, lastAt: now, count: existing.count + 1 } : { origin: key, firstAt: now, lastAt: now, count: 1 });
      while (named.size > MAX_NAMED) {
        const oldest = named.keys().next().value;
        if (oldest === undefined) break;
        named.delete(oldest);
      }
    },
    snapshot() {
      return { origins: [...named.values()].reverse().map((e) => ({ ...e })), requests };
    },
    reset() {
      named.clear();
      requests = 0;
    },
  };
}

/**
 * A well-formed web origin from an `Origin` header (`https:`/`http:`, exactly `scheme://host[:port]`,
 * cut to {@link MAX_ORIGIN_LENGTH} characters), or null: extension origins (`chrome-extension:` …),
 * `null`, and anything that is not a serialized origin.
 */
export function webOrigin(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.origin === raw.toLowerCase() ? url.origin.slice(0, MAX_ORIGIN_LENGTH) : null;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  return host === '::1';
}

/**
 * Two-label suffixes under which unrelated people's sites live: static hosts that give every site
 * its own subdomain. Under one of these (or a country suffix, {@link isCountrySuffix}) the Pages
 * site's registrable domain takes a third label, so another site on the same host is not named.
 */
const SHARED_SUFFIXES: ReadonlySet<string> = new Set([
  'github.io',
  'gitlab.io',
  'pages.dev',
  'workers.dev',
  'netlify.app',
  'vercel.app',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'onrender.com',
  'fly.dev',
  'surge.sh',
  'codeberg.page',
  'azurestaticapps.net',
  'amplifyapp.com',
]);

/**
 * `co.uk`, `com.au`, `org.nz`…: a two-letter country TLD under a label of at most three letters.
 * Rough on purpose: a real domain like `abc.de` is then read as a suffix, which only names fewer
 * origins.
 */
function isCountrySuffix(labels: readonly string[]): boolean {
  const tld = labels.at(-1) ?? '';
  const second = labels.at(-2) ?? '';
  return /^[a-z]{2}$/.test(tld) && second !== '' && second.length <= 3;
}

/**
 * The registrable domain of a DNS name: its last two labels (`a.b.example.org` → `example.org`), or
 * three under a shared or country suffix (`home.pages.dev`, `www.example.co.uk` → `example.co.uk`);
 * null for IPs, single labels and a bare suffix.
 */
function registrableDomain(hostname: string): string | null {
  if (hostname.startsWith('[') || isIP(hostname) !== 0) return null;
  const labels = hostname.toLowerCase().split('.').filter((l) => l !== '');
  if (labels.length < 2) return null;
  const shared = SHARED_SUFFIXES.has(labels.slice(-2).join('.')) || isCountrySuffix(labels);
  const size = shared ? 3 : 2;
  return labels.length >= size ? labels.slice(-size).join('.') : null;
}

/**
 * A foreign web origin worth naming in logs and the summary: a GitHub Pages site (`*.github.io`), a
 * loopback origin (a Pages build previewed on this PC), or one sharing the registrable domain
 * ({@link registrableDomain}) of the configured Pages site. Anything else is only counted.
 */
export function isNamedForeignOrigin(origin: string, pagesOrigin: string | null): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (hostname === 'github.io' || hostname.endsWith('.github.io')) return true;
  if (isLoopbackHost(hostname)) return true;
  if (pagesOrigin === null) return false;
  let pagesHost: string;
  try {
    pagesHost = new URL(pagesOrigin).hostname;
  } catch {
    return false;
  }
  const domain = registrableDomain(pagesHost);
  return domain !== null && (hostname === domain || hostname.endsWith(`.${domain}`));
}

/** The process-wide tracker the gate writes and the diagnostics summary reads. */
export const foreignOrigins: ForeignOriginTracker = createForeignOriginTracker();
