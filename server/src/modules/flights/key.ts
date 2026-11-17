/**
 * The FlightAware AeroAPI key (§4.6): vault secret `flightaware:key`, write-only from the client's
 * point of view: the API only ever reports `{configured}`.
 */
import { FLIGHTAWARE_KEY_RE, cleanFlightAwareKey } from '@portly/shared';
import { HttpError } from '../../lib/errors.ts';
import { VaultLockedError, type Vault } from '../../security/vault.ts';
import { notConnected } from './aeroapi.ts';

export const KEY_SECRET_ID = 'flightaware:key';

/** Trims, drops a pasted `x-apikey:` prefix and checks the shape; throws 422 on nonsense. */
export function normalizeKey(raw: string): string {
  const key = cleanFlightAwareKey(raw);
  if (!FLIGHTAWARE_KEY_RE.test(key)) {
    throw new HttpError(422, 'validation_failed', "That doesn't look like an AeroAPI key. Copy it from the API keys page of your FlightAware account, without spaces.", [
      { path: 'key', message: 'Invalid key format', code: 'invalid_format' },
    ]);
  }
  return key;
}

/** The stored key. Missing → 409 `not_configured`; stored but the vault is locked → 409 `reauth_required`. */
export function requireKey(vault: Vault): string {
  if (!vault.has(KEY_SECRET_ID)) throw notConnected();
  if (vault.state === 'locked') throw new VaultLockedError();
  const key = vault.get(KEY_SECRET_ID);
  if (!key) throw notConnected();
  return key;
}
