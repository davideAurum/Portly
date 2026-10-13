/**
 * OAuth client configuration (`oauth_clients` + vault `oauth-client:<provider>`, §4.6/§7).
 * The client secret (Google only) lives in the vault and is never returned: the API reports
 * `{clientId, hasSecret, redirectUri}` where `redirectUri` is the exact value to register.
 */
import type { OAuthClientInfo, OAuthClientUpdate, OAuthProvider, ValidationIssue } from '@portly/shared';
import type { Config } from '../../../config.ts';
import type { Db } from '../../../db/open.ts';
import { HttpError } from '../../../lib/errors.ts';
import type { Vault } from '../../../security/vault.ts';
import { providerSpec } from './providers.ts';
import type { OAuthClient } from './types.ts';

interface ClientRow {
  client_id: string;
  has_secret: number;
}

export function clientSecretId(provider: OAuthProvider): string {
  return `oauth-client:${provider}`;
}

function readClientRow(db: Db, provider: OAuthProvider): ClientRow | undefined {
  return db.get<ClientRow>('SELECT client_id, has_secret FROM oauth_clients WHERE provider = ?', [provider]);
}

/** True when a usable secret is stored (row flag and vault entry agree; works while the vault is locked). */
function hasStoredSecret(vault: Vault, provider: OAuthProvider, row: ClientRow | undefined): boolean {
  return row !== undefined && row.has_secret === 1 && vault.has(clientSecretId(provider));
}

export function oauthClientInfo(deps: { db: Db; vault: Vault; config: Config }, provider: OAuthProvider): OAuthClientInfo {
  const row = readClientRow(deps.db, provider);
  return {
    clientId: row?.client_id ?? null,
    hasSecret: hasStoredSecret(deps.vault, provider, row),
    redirectUri: deps.config.registrationRedirectUris[provider],
  };
}

/** True when the provider can be used: a client id, plus the secret for confidential clients. */
export function isClientConfigured(deps: { db: Db; vault: Vault }, provider: OAuthProvider): boolean {
  const row = readClientRow(deps.db, provider);
  if (!row) return false;
  return !providerSpec(provider).usesClientSecret || hasStoredSecret(deps.vault, provider, row);
}

/**
 * The configured client with its secret, or null when not configured.
 * Throws VaultLockedError (409) when a secret is needed while the vault is locked.
 */
export function loadOAuthClient(deps: { db: Db; vault: Vault }, provider: OAuthProvider): OAuthClient | null {
  const row = readClientRow(deps.db, provider);
  if (!row) return null;
  if (!providerSpec(provider).usesClientSecret) return { provider, clientId: row.client_id, clientSecret: null };
  if (row.has_secret !== 1) return null;
  const secret = deps.vault.get(clientSecretId(provider));
  return secret ? { provider, clientId: row.client_id, clientSecret: secret } : null;
}

function invalid(path: string, message: string): HttpError {
  const issues: ValidationIssue[] = [{ path, message, code: 'custom' }];
  return new HttpError(422, 'validation_failed', message, issues);
}

/**
 * Saves the client id (and Google's secret). Google needs a secret on first setup and whenever
 * the client id changes; an omitted secret otherwise keeps the stored one. Microsoft is a public
 * client and refuses a secret.
 */
export function saveOAuthClient(deps: { db: Db; vault: Vault; now: number }, provider: OAuthProvider, update: OAuthClientUpdate): void {
  const spec = providerSpec(provider);
  const { db, vault, now } = deps;
  if (!spec.isValidClientId(update.clientId)) {
    throw invalid(
      'clientId',
      provider === 'google'
        ? 'Google client IDs end with .apps.googleusercontent.com'
        : 'Microsoft application (client) IDs are GUIDs',
    );
  }

  const existing = readClientRow(db, provider);
  let secretToStore: string | null = null;
  if (spec.usesClientSecret) {
    const keepsSecret = existing !== undefined && existing.client_id === update.clientId && hasStoredSecret(vault, provider, existing);
    if (update.clientSecret !== undefined) secretToStore = update.clientSecret;
    else if (!keepsSecret) throw invalid('clientSecret', 'The client secret is required');
  } else if (update.clientSecret !== undefined) {
    throw invalid('clientSecret', `${spec.displayName} uses a public client; do not enter a client secret`);
  }

  db.tx(() => {
    db.run(
      `INSERT INTO oauth_clients (provider, client_id, has_secret, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (provider) DO UPDATE SET client_id = excluded.client_id, has_secret = excluded.has_secret,
         updated_at = excluded.updated_at`,
      [provider, update.clientId, spec.usesClientSecret ? 1 : 0, now],
    );
    if (secretToStore !== null) vault.put(clientSecretId(provider), secretToStore);
  });
}
