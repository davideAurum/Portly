/**
 * URLs of the Homebase server's own page (hybrid mode). The server reports its page as `appUrl`
 * in `GET /api/health`, but whatever answers on the port is untrusted input: `validateAppUrl`
 * accepts only the root page of an http(s) loopback origin (pairing falls back to the build's
 * `LOCAL_SERVER_ORIGIN` otherwise).
 */
import { isSafeHttpUrl } from '@homebase/shared';
import { isLoopbackHost } from './origin.ts';

/**
 * The server's page URL when `raw` is the root page of an http(s) origin on a loopback host —
 * no credentials, path `/`, no query or fragment (not even an empty `?` or `#`) — normalized as
 * `<origin>/`; otherwise null.
 */
export function validateAppUrl(raw: unknown): string | null {
  if (!isSafeHttpUrl(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!isLoopbackHost(url.hostname)) return null;
  const root = `${url.origin}/`;
  // Rejects any path, query, fragment or credentials in one comparison.
  return url.href === root ? root : null;
}
