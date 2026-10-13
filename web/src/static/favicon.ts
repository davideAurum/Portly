/**
 * Bookmark icons in the static build. The server stores fetched favicons under random ids; the
 * browser-only build cannot fetch pages, so an "auto" icon is a synthetic id `fav:<host>` that
 * the asset resolver turns into DuckDuckGo's icon service URL for `<img src>`. Hosts that look
 * local (IP literals, single-label names, .local, …, also spelled with a trailing dot) never get
 * one: the server has the same rule (§4.8) so private hostnames are never sent to a third party.
 *
 * DuckDuckGo answers a host it has no icon for with HTTP 404 *and* a generic 48x48 PNG, so the
 * `<img>` fires `load`, not `error`, and the placeholder cannot be told apart from a real icon
 * (no CORS headers, so neither the status nor the pixels are readable). In this build the letter
 * tile therefore appears only for local-looking hosts, with automatic icons off, in letter mode,
 * or when the image really fails to load (offline, blocked); a public site DuckDuckGo does not
 * know shows DuckDuckGo's placeholder.
 */

export const FAVICON_ID_PREFIX = 'fav:';

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const LOCAL_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.localhost', '.localdomain'];

/**
 * Host without port, IPv6 brackets or trailing dots, lower-cased (`NAS.:8080` → `nas`; the
 * server's `stripTrailingDots`, so a fully-qualified spelling of a local name stays local).
 */
export function hostnameOf(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h.slice(1) : h.slice(1, end);
  }
  const colon = h.lastIndexOf(':');
  if (colon !== -1 && !h.includes(']')) h = h.slice(0, colon);
  return h.replace(/\.+$/, '');
}

/** True for hosts that must never be looked up with an outside service. */
export function isLocalLookingHost(host: string): boolean {
  const name = hostnameOf(host);
  if (name === '' || name === 'localhost') return true;
  if (IPV4.test(name) || name.includes(':')) return true; // IPv4 or IPv6 literal
  if (!name.includes('.')) return true; // single label (intranet names)
  if (LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  // All-numeric labels (decimal, octal or hex forms) are IPv4 literals in disguise.
  if (name.split('.').every((label) => /^(?:0x[0-9a-f]*|\d+)$/.test(label))) return true;
  return false;
}

/** Lower-cased `host[:port]` of a URL (the server's hostKey), or null when unparsable. */
export function hostKeyOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.host ? parsed.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Synthetic favicon id for a bookmark URL, or null for local-looking hosts and bad URLs. */
export function faviconIdFor(url: string): string | null {
  const key = hostKeyOf(url);
  if (key === null || isLocalLookingHost(key)) return null;
  return FAVICON_ID_PREFIX + key;
}

export function isFaviconId(id: string): boolean {
  return id.startsWith(FAVICON_ID_PREFIX) && id.length > FAVICON_ID_PREFIX.length;
}

/** The https URL an `<img>` loads for a synthetic favicon id (DuckDuckGo's icon service). */
export function faviconServiceUrl(id: string): string | null {
  if (!isFaviconId(id)) return null;
  // Judge the stored key itself (not the stripped name, which a second ':port' would get past).
  const key = id.slice(FAVICON_ID_PREFIX.length);
  if (isLocalLookingHost(key)) return null;
  const hostname = hostnameOf(key);
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(hostname)}.ico`;
}
