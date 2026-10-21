/**
 * The two cookies of other PCs (shared/src/devices.ts): their `Set-Cookie` values and reading
 * them from a request. Both carry the `__Host-` prefix, so browsers only accept them from an
 * https page, for the whole origin (`Path=/`) and without a `Domain`; `HttpOnly` keeps them from
 * page script and `SameSite=Strict` keeps other sites from sending them.
 */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';

/** `Set-Cookie` value that stores `value` for `maxAgeMs` (rounded down to whole seconds). */
export function cookieHeader(name: string, value: string, maxAgeMs: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`;
}

/** `Set-Cookie` value that removes the cookie. */
export function clearCookieHeader(name: string): string {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** The request's cookie of that name, or undefined (an empty value counts as absent). */
export function readCookie(c: Context, name: string): string | undefined {
  const value = getCookie(c, name);
  return value === undefined || value === '' ? undefined : value;
}
