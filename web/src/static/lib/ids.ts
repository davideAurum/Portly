/**
 * Id and token helpers for the static backend (port of server/src/lib/ids.ts without node:crypto).
 * Entity ids come from `ctx.newId()` (UUIDv4, injectable in tests); this module only checks ids
 * and makes random opaque tokens (import preview ids).
 */
import { encodeBase64 } from './base64.ts';

/** Any RFC 9562 UUID (versions 1–8), case-insensitive. */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** UUID version 4 only (upload and icon ids). */
export const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_REGEX.test(value);
}

/** Standard base64 → base64url (RFC 4648 §5, unpadded). */
export function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Random URL-safe token with `bytes` of entropy, base64url-encoded: 24 bytes → 32 characters
 * matching `^[A-Za-z0-9_-]{32}$` (the import preview id format).
 */
export function newToken(bytes = 24): string {
  if (!Number.isInteger(bytes) || bytes < 0) throw new RangeError(`newToken bytes must be a non-negative integer (got ${bytes})`);
  const random = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(random);
  return toBase64Url(encodeBase64(random));
}
