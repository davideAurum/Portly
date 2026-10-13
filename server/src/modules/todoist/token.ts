/**
 * The Todoist API token (§4.6): vault secret `todoist:token`, write-only from the client's point
 * of view — the API only ever reports `{configured}`.
 */
import { HttpError } from '../../lib/errors.ts';
import { VaultLockedError, type Vault } from '../../security/vault.ts';
import { notConnected } from './client.ts';

export const TOKEN_SECRET_ID = 'todoist:token';

/**
 * Todoist personal API tokens are 40 hex characters; OAuth tokens are similar. The check is a
 * sanity check against paste mistakes (spaces, quotes, a URL, half a token), not a format lock-in.
 */
export const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{20,200}$/;

/** Trims, drops a pasted `Bearer ` prefix and checks the shape; throws 422 on nonsense. */
export function normalizeToken(raw: string): string {
  const token = raw.trim().replace(/^bearer\s+/i, '');
  if (!TOKEN_PATTERN.test(token)) {
    throw new HttpError(
      422,
      'validation_failed',
      "That doesn't look like a Todoist API token. It is a long string of letters and digits (40 characters) without spaces.",
      [{ path: 'token', message: 'Invalid token format', code: 'invalid_format' }],
    );
  }
  return token;
}

/**
 * The stored token. Missing → 409 `not_configured`; stored but the vault is locked →
 * {@link VaultLockedError} (409 `reauth_required`).
 */
export function requireToken(vault: Vault): string {
  if (!vault.has(TOKEN_SECRET_ID)) throw notConnected();
  if (vault.state === 'locked') throw new VaultLockedError();
  const token = vault.get(TOKEN_SECRET_ID);
  if (!token) throw notConnected();
  return token;
}
