/**
 * Says when the server a page uses is older than the site (ARCHITECTURE §16): the site moves with
 * each publish, the server when that PC updates.
 *
 * The server's version is untrusted input (§16): one that can't be read makes this say no, so such
 * text never reaches the page.
 */
import { isNewerVersion } from '@portly/shared';

/** What a server reports when it could not read its own version (`appVersion()`). */
const UNKNOWN_SERVER_VERSION = '0.0.0';

/** True only when both versions can be read and the server's is older than the site's. */
export function isServerBehind(serverVersion: string, siteVersion: string): boolean {
  return serverVersion !== UNKNOWN_SERVER_VERSION && isNewerVersion(siteVersion, serverVersion);
}
