/**
 * The GitHub status board's token (§4.6): vault secret `github:token`, write-only from the
 * client's point of view: the API only ever reports `{configured}`. It is a read-only
 * fine-grained token; classic tokens are refused (`gitHubTokenProblem`).
 */
import { cleanGitHubToken, gitHubTokenProblem } from '@portly/shared';
import { HttpError } from '../../lib/errors.ts';
import { VaultLockedError, type Vault } from '../../security/vault.ts';
import { notConnected } from './client.ts';

export const TOKEN_SECRET_ID = 'github:token';

/** Trims, drops a pasted prefix and checks the shape; throws 422 on anything else. */
export function normalizeToken(raw: string): string {
  const token = cleanGitHubToken(raw);
  const problem = gitHubTokenProblem(token);
  if (problem !== null) throw new HttpError(422, 'validation_failed', problem, [{ path: 'token', message: 'Invalid token format', code: 'invalid_format' }]);
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
