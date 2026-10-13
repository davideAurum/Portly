/**
 * "Does this input look like a URL?" (§10.8 Search). Recognized:
 * - an explicit http(s) URL (`https://example.com/x`);
 * - a dotted host name without spaces, optionally with port and path (`example.com`,
 *   `docs.example.co.uk/guide?x=1`, `bücher.de`) → `https://…`;
 * - `localhost:port` (optionally with a path), IPv4 literals and bracketed IPv6 → `http://…`.
 * Everything else is a search. The result always passes `safeHref` (never `javascript:` etc.).
 *
 * A bare dotted word whose last label is not a real top-level domain (`next.js`, `index.html`,
 * `file.txt`) is only a *possible* address: {@link detectUrl} returns null for it (Enter
 * searches) and {@link addressCandidate} returns the address to offer second. With a port or a
 * path (`intranet.corp/wiki`, `nas.home:8080`) it is still taken as an address.
 */
import { safeHref } from '../../lib/openUrl.ts';
import { KNOWN_TLDS } from './tlds.ts';

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL = /^(?:localhost(?::\d{1,5})(?:[/?#]\S*)?|localhost\/\S*|\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:[/?#]\S*)?|\[[0-9a-f:.]+\](?::\d{1,5})?(?:[/?#]\S*)?)$/i;
const DOTTED =
  /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:\p{L}[\p{L}\p{N}-]{0,62}|xn--[a-z0-9-]{1,59})\.?(?::\d{1,5})?(?:[/?#]\S*)?$/iu;

/** Private-use names people give machines on their own network (`nas.lan`, `printer.local`). */
const LOCAL_TLDS: ReadonlySet<string> = new Set(['localhost', 'lan', 'local', 'home', 'internal', 'localdomain', 'intranet', 'corp', 'private']);

interface Detection {
  url: string;
  /** False for a bare dotted word with an unknown last label: offer it, but search on Enter. */
  confident: boolean;
}

function detect(input: string): Detection | null {
  const text = input.trim();
  if (text === '' || /\s/.test(text) || (text.includes('@') && !SCHEME.test(text))) return null;
  if (SCHEME.test(text)) {
    const url = /^https?:\/\//i.test(text) ? (safeHref(text, { allowAppRoutes: false }) ?? null) : null;
    return url ? { url, confident: true } : null;
  }
  if (LOCAL.test(text)) {
    const url = safeHref(`http://${text}`, { allowAppRoutes: false }) ?? null;
    return url ? { url, confident: true } : null;
  }
  if (DOTTED.test(text)) {
    const match = /\.([^./:?#]+)\.?((?::\d+)?(?:[/?#].*)?)$/u.exec(text);
    const tld = match?.[1] ?? '';
    // A final label of one character or only digits ("v1.2", "3.14") is not a host name.
    if (tld.length < 2 || /^\d+$/.test(tld)) return null;
    const url = safeHref(`https://${text}`, { allowAppRoutes: false }) ?? null;
    if (!url) return null;
    const hasPortOrPath = (match?.[2] ?? '') !== '';
    const label = tld.toLowerCase();
    return { url, confident: hasPortOrPath || KNOWN_TLDS.has(label) || LOCAL_TLDS.has(label) };
  }
  return null;
}

/** The URL to navigate to for `input`, or null when the input should be searched. */
export function detectUrl(input: string): string | null {
  const found = detect(input);
  return found?.confident ? found.url : null;
}

/**
 * The address a bare dotted word *might* be (`next.js` → `https://next.js/`), offered after the
 * search; null when {@link detectUrl} already navigates or the input is no address at all.
 */
export function addressCandidate(input: string): string | null {
  const found = detect(input);
  return found && !found.confident ? found.url : null;
}

/** Normalizes a bookmark URL typed by the user (`example.com` → `https://example.com/`), or null. */
export function normalizeTypedUrl(input: string): string | null {
  const text = input.trim();
  if (text === '') return null;
  if (/^https?:\/\//i.test(text)) return safeHref(text, { allowAppRoutes: false }) ?? null;
  // Any other scheme (`javascript:`, `mailto:`, `ftp://`) is refused; `host:port` is not a scheme.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return null;
  // Typed into an address field: any host-like text is meant as an address.
  return detect(text)?.url ?? null;
}
