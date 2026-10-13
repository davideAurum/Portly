/**
 * id_token claim decoding. The token comes straight from the provider's token endpoint over TLS
 * (never from the browser), so the signature is not verified (OIDC Core §3.1.3.7 item 6); the
 * issuer, audience, expiry (and Microsoft tenant) are still validated by the provider spec.
 */

const MAX_ID_TOKEN_LENGTH = 16 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Allowed clock skew when checking `exp`. */
export const ID_TOKEN_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Payload claims of a compact JWS, or null when it is not a well-formed JWT with an object payload. */
export function decodeJwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_ID_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload] = parts;
  if (!header || !payload || !BASE64URL.test(header) || !BASE64URL.test(payload)) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `aud` is the client id (string form, or an array containing it). */
export function audienceMatches(aud: unknown, clientId: string): boolean {
  if (typeof aud === 'string') return aud === clientId;
  return Array.isArray(aud) && aud.length > 0 && aud.every((a) => typeof a === 'string') && aud.includes(clientId);
}

/** `exp` (seconds since epoch) is in the future, allowing {@link ID_TOKEN_CLOCK_SKEW_MS}. */
export function notExpired(exp: unknown, nowMs: number): boolean {
  return typeof exp === 'number' && Number.isFinite(exp) && exp * 1000 + ID_TOKEN_CLOCK_SKEW_MS > nowMs;
}

/** Non-empty string claim (bounded), else null. */
export function stringClaim(value: unknown, max = 320): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}
