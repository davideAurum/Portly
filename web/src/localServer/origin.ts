/**
 * Origins of hybrid mode. Shared by the web app (`urls.ts` checks the `appUrl` a server reports)
 * and the build (`web/vite.config.ts` reads `PORTLY_STATIC_SERVER`, the origin the Pages build
 * looks for the Portly server on, and allows the address of Portly on another PC), so it uses no
 * browser or Node globals besides `URL`.
 */

/** Where the Pages build looks for the Portly server when `PORTLY_STATIC_SERVER` is unset. */
export const DEFAULT_LOCAL_SERVER_ORIGIN = 'http://127.0.0.1:5757';

/** `PORTLY_STATIC_SERVER` value that turns hybrid mode off. */
export const LOCAL_SERVER_OFF = 'off';

/**
 * A page of Portly's own site on this PC (`<origin>/#/<route>`), for the routes that never forward
 * to the Pages site (`app/pagesForward.ts`: pairing, diagnostics, devices). An empty origin means
 * the default one.
 */
export function localServerPageUrl(route: string, origin: string): string {
  return `${origin === '' ? DEFAULT_LOCAL_SERVER_ORIGIN : origin.replace(/\/+$/, '')}/#/${route}`;
}

/**
 * Portly on another PC (the main PC, ARCHITECTURE §20) is reached through Tailscale Serve, whose
 * addresses are `https://<pc>.<tailnet>.ts.net`. The Pages build's CSP allows exactly this source
 * (`web/vite.config.ts`), and {@link parseRemoteServerAddress} accepts only such hosts, so the
 * public site names no PC and no tailnet: each browser is told the address once.
 */
export const REMOTE_SERVER_HOST_SUFFIX = '.ts.net';
export const REMOTE_SERVER_CSP_SOURCE = `https://*${REMOTE_SERVER_HOST_SUFFIX}`;

/** One DNS label as `URL.hostname` spells it. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The origin of Portly on another PC from what the user typed (`dg.tail1234.ts.net`,
 * `https://dg.tail1234.ts.net/`), or null: https only (added when no scheme is given), no
 * credentials, port, path, query or fragment, and a host under {@link REMOTE_SERVER_HOST_SUFFIX}
 * with at least two labels before it (the PC and the tailnet).
 */
export function parseRemoteServerAddress(raw: string): string | null {
  const value = raw.trim();
  if (value === '' || /\s/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  if (url.href !== `${url.origin}/`) return null;
  const host = url.hostname;
  if (!host.endsWith(REMOTE_SERVER_HOST_SUFFIX)) return null;
  const labels = host.slice(0, -REMOTE_SERVER_HOST_SUFFIX.length).split('.');
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label))) return null;
  return url.origin;
}

/** `<label>.localhost` as `URL.hostname` spells it (lowercase, punycode). */
const LOCALHOST_SUBDOMAIN = /^(?:[a-z0-9-]+\.)+localhost$/;

/** `localhost`, `*.localhost`, `127.0.0.1` and `[::1]` (as `URL.hostname` spells them). */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || LOCALHOST_SUBDOMAIN.test(hostname);
}

/**
 * The origin (no trailing slash) the Pages build uses for the Portly server on this PC, from the
 * `PORTLY_STATIC_SERVER` build setting: unset or empty → {@link DEFAULT_LOCAL_SERVER_ORIGIN};
 * `off` → `''` (hybrid mode off); otherwise an http(s) origin on a loopback host, with no
 * credentials, path, query or fragment (a lone trailing `/` is accepted). Throws on anything else,
 * so a typo fails the build instead of shipping a page that talks to the wrong place.
 */
export function parseLocalServerOrigin(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (value === '') return DEFAULT_LOCAL_SERVER_ORIGIN;
  if (value.toLowerCase() === LOCAL_SERVER_OFF) return '';
  const invalid = (why: string) => new Error(`PORTLY_STATIC_SERVER must be "off" or an http(s) origin on this PC such as ${DEFAULT_LOCAL_SERVER_ORIGIN} (got "${value}": ${why})`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('not http or https');
  if (url.username !== '' || url.password !== '') throw invalid('credentials are not allowed');
  if (!isLoopbackHost(url.hostname)) throw invalid('the host must be localhost, 127.0.0.1 or [::1]');
  // Rejects any path, query or fragment (even an empty `?` or `#`) in one comparison.
  if (url.href !== `${url.origin}/`) throw invalid('only an origin is allowed, without path, query or fragment');
  return url.origin;
}
