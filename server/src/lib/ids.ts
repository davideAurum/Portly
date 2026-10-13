/**
 * Id and token generation. All ids are random (never sequential or derived from content),
 * except where a contract defines a deterministic id (e.g. calendar event ids).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Random UUIDv4 (entity ids, upload/icon ids). */
export function newId(): string {
  return randomUUID();
}

/** Random URL-safe token (`bytes` of entropy, base64url), e.g. OAuth `state` (32 bytes). */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_REGEX.test(value);
}

/** Hex SHA-1 (used only for deterministic, non-secret ids such as event ids). */
export function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}
