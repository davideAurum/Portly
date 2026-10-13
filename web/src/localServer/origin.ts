/**
 * Loopback origins of hybrid mode. Shared by the web app (`urls.ts` checks the `appUrl` a server
 * reports) and the build (`web/vite.config.ts` reads `PORTLY_STATIC_SERVER`, the origin the Pages
 * build looks for the Portly server on), so it uses no browser or Node globals besides `URL`.
 */

/** Where the Pages build looks for the Portly server when `PORTLY_STATIC_SERVER` is unset. */
export const DEFAULT_LOCAL_SERVER_ORIGIN = 'http://127.0.0.1:5757';

/** `PORTLY_STATIC_SERVER` value that turns hybrid mode off. */
export const LOCAL_SERVER_OFF = 'off';

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
