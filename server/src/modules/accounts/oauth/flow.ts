/**
 * OAuth authorization flow (§4.7): start (state + PKCE, authorize URL) and callback (atomic state
 * consumption, code exchange, id_token identity, upsert by `(kind, external_id)`).
 *
 * The callback never throws and never reflects provider text: it only ever produces one of the
 * fixed {@link OAuthResult} values plus the `returnTo` route stored with the state. A connected
 * account's status is set through `applyAccountStatus` after the upsert (logged, recorded ok on
 * `account:<id>`); the code exchange of a reconnect runs in that account's log context.
 */
import {
  DEFAULT_OAUTH_RETURN_TO,
  OAUTH_RETURN_TO_REGEX,
  isOAuthProvider,
  type Capability,
  type OAuthProvider,
  type OAuthResult,
  type OAuthStart,
} from '@homebase/shared';
import { HttpError } from '../../../lib/errors.ts';
import { newId } from '../../../lib/ids.ts';
import { withLogContext } from '../../../lib/log-context.ts';
import { errorFields } from '../../../lib/logger.ts';
import { VaultLockedError } from '../../../security/vault.ts';
import type { AccountsCore } from '../service.ts';
import {
  accountNotFound,
  accountSecretId,
  applyAccountStatus,
  findAccountByExternalId,
  getAccountRow,
  insertAccountRow,
  mergeEnabledCapabilities,
  parseCapabilities,
  refreshTokenSecret,
  serializeCapabilities,
  type AccountRow,
} from '../store.ts';
import { decodeJwtClaims } from './id-token.ts';
import { isClientConfigured, loadOAuthClient } from './clients.ts';
import { providerSpec } from './providers.ts';
import { STATE_PARAM_REGEX, consumeOAuthState, createOAuthState, createPkcePair } from './states.ts';
import { requestToken } from './token-endpoint.ts';
import type { OAuthIdentity, OAuthProviderSpec } from './types.ts';

/** Authorization codes are opaque; anything longer than this is not one we will send anywhere. */
const MAX_CODE_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/** `POST /api/oauth/:provider/start` → authorize URL (the SPA navigates to it in the same tab). */
export function startAuthorization(core: AccountsCore, provider: OAuthProvider, input: OAuthStart): string {
  const spec = providerSpec(provider);
  const { db, vault, config } = core;
  if (!isClientConfigured({ db, vault }, provider)) {
    throw new HttpError(409, 'not_configured', `Set up the ${spec.displayName} OAuth client first`);
  }
  // The callback must be able to store the refresh token.
  if (vault.state !== 'ready') throw new VaultLockedError();

  let accountId: string | null = null;
  if (input.accountId !== undefined) {
    const row = getAccountRow(db, input.accountId);
    if (!row) throw accountNotFound();
    if (row.kind !== provider) throw new HttpError(400, 'bad_request', `This account is not a ${spec.displayName} account`);
    accountId = row.id;
  }
  const client = loadOAuthClient({ db, vault }, provider);
  if (!client) throw new HttpError(409, 'not_configured', `Set up the ${spec.displayName} OAuth client first`);

  const pkce = createPkcePair();
  const state = createOAuthState(db, {
    provider,
    codeVerifier: pkce.verifier,
    accountId,
    returnTo: input.returnTo ?? DEFAULT_OAUTH_RETURN_TO,
    now: core.now(),
  });
  const url = new URL(spec.authorizeEndpoint);
  const params = spec.authorizeParams({
    clientId: client.clientId,
    redirectUri: config.redirectUris[provider],
    state,
    codeChallenge: pkce.challenge,
  });
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  core.log.info('oauth authorization started', { provider, reconnect: accountId !== null });
  return url.href;
}

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

export interface CallbackQuery {
  /** `undefined` when absent, `null` when repeated (ambiguous → rejected). */
  code: string | null | undefined;
  state: string | null | undefined;
  error: string | null | undefined;
}

export interface CallbackOutcome {
  result: OAuthResult;
  /** SPA route (`#/…`) to return to. */
  returnTo: string;
}

/** `${appOrigin}/?oauth=<result><returnTo>` */
export function callbackRedirectUrl(appOrigin: string, outcome: CallbackOutcome): string {
  const returnTo = OAUTH_RETURN_TO_REGEX.test(outcome.returnTo) ? outcome.returnTo : DEFAULT_OAUTH_RETURN_TO;
  return `${appOrigin}/?oauth=${outcome.result}${returnTo}`;
}

interface UpsertOutcome {
  accountId: string;
  created: boolean;
  result: OAuthResult;
}

/** Handles `GET /api/oauth/:provider/callback`; never throws. */
export async function completeAuthorization(core: AccountsCore, providerParam: string | undefined, query: CallbackQuery): Promise<CallbackOutcome> {
  const fallback: CallbackOutcome = { result: 'error', returnTo: DEFAULT_OAUTH_RETURN_TO };
  if (!isOAuthProvider(providerParam)) return fallback;
  const provider = providerParam;
  const { state } = query;
  if (typeof state !== 'string' || !STATE_PARAM_REGEX.test(state)) {
    core.log.warn('oauth callback without a usable state', { provider });
    return fallback;
  }

  let consumed;
  try {
    consumed = consumeOAuthState(core.db, { state, provider, now: core.now() });
  } catch (err) {
    core.log.error('oauth state lookup failed', { provider, ...errorFields(err) });
    return fallback;
  }
  if (!consumed) {
    core.log.info('oauth callback with an unknown or expired state', { provider });
    return { result: 'expired', returnTo: DEFAULT_OAUTH_RETURN_TO };
  }
  const returnTo = OAUTH_RETURN_TO_REGEX.test(consumed.returnTo) ? consumed.returnTo : DEFAULT_OAUTH_RETURN_TO;

  if (query.error !== undefined) {
    const denied = query.error === 'access_denied';
    core.log.info('oauth authorization not granted', { provider, result: denied ? 'denied' : 'error' });
    return { result: denied ? 'denied' : 'error', returnTo };
  }
  if (typeof query.code !== 'string' || query.code.length === 0 || query.code.length > MAX_CODE_LENGTH) {
    core.log.warn('oauth callback without a usable code', { provider });
    return { result: 'error', returnTo };
  }

  const code = query.code;
  const { codeVerifier, accountId } = consumed;
  try {
    const result = await withLogContext({ area: 'accounts', accountId: accountId ?? undefined }, () =>
      connect(core, providerSpec(provider), code, codeVerifier, accountId),
    );
    return { result, returnTo };
  } catch (err) {
    core.log.error('oauth callback failed', { provider, ...errorFields(err) });
    return { result: 'error', returnTo };
  }
}

async function connect(
  core: AccountsCore,
  spec: OAuthProviderSpec,
  code: string,
  codeVerifier: string,
  reconnectId: string | null,
): Promise<OAuthResult> {
  const { db, vault, log, config } = core;
  const provider = spec.provider;
  if (vault.state !== 'ready') {
    log.warn('oauth callback while the vault is locked', { provider });
    return 'error';
  }
  const client = loadOAuthClient({ db, vault }, provider);
  if (!client) {
    log.warn('oauth callback for an unconfigured client', { provider });
    return 'error';
  }

  const exchange = await requestToken({
    fetch: core.fetch,
    log,
    spec,
    grant: 'authorization_code',
    params: {
      client_id: client.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUris[provider],
      code_verifier: codeVerifier,
      ...spec.tokenParams(client),
    },
  });
  if (!exchange.ok) return 'error';
  const tokens = exchange.tokens;

  const claims = decodeJwtClaims(tokens.idToken);
  if (!claims) {
    log.warn('oauth token response without a usable id_token', { provider });
    return 'error';
  }
  const verdict = spec.identity(claims, client.clientId, core.now());
  if (!verdict.ok) {
    log.warn('oauth id_token rejected', { provider, reason: verdict.reason });
    return 'error';
  }
  const granted = spec.grantedScopes(tokens.scope);
  if (granted === null) {
    log.warn('oauth token response without granted scopes', { provider });
    return 'error';
  }
  const capabilities = spec.capabilities(granted);
  if (capabilities.length === 0) {
    log.info('oauth grant covers no capability', { provider });
    return 'denied';
  }
  if (tokens.refreshToken === null) {
    log.warn('oauth token response without a refresh token', { provider });
    return 'error';
  }

  const refreshToken = tokens.refreshToken;
  const outcome = db.tx(() =>
    upsertOAuthAccount(core, spec, { identity: verdict.identity, capabilities, granted, refreshToken, reconnectId }),
  );
  core.forgetAccessToken(outcome.accountId);
  core.seedAccessToken(outcome.accountId, tokens.accessToken, tokens.expiresInSec);
  // A fresh grant: ok (a new row already is; an updated one is reset), and recorded as such.
  applyAccountStatus(core, outcome.accountId, 'ok', null, { reason: outcome.created ? 'connected' : 'reconnected', source: 'accounts' });
  log.info('oauth account connected', { provider, accountId: outcome.accountId, result: outcome.result });
  core.emit({ type: outcome.created ? 'created' : 'updated', accountId: outcome.accountId });
  return outcome.result;
}

interface UpsertInput {
  identity: OAuthIdentity;
  capabilities: Capability[];
  granted: string[];
  refreshToken: string;
  reconnectId: string | null;
}

/**
 * Runs inside a transaction. Reconnecting an account updates it only when the subject matches;
 * a different subject is stored as (or updates) its own account and never overwrites the original.
 */
function upsertOAuthAccount(core: AccountsCore, spec: OAuthProviderSpec, input: UpsertInput): UpsertOutcome {
  const { db, vault } = core;
  const now = core.now();
  const { identity } = input;

  const target = input.reconnectId === null ? undefined : getAccountRow(db, input.reconnectId);
  const reconnecting = target !== undefined && target.kind === spec.provider;
  const existing =
    reconnecting && target.external_id === identity.subject ? target : findAccountByExternalId(db, spec.provider, identity.subject);

  const secret = refreshTokenSecret(input.refreshToken);
  if (existing) {
    updateGrant(core, existing, input, now);
    vault.put(accountSecretId(existing.id), secret);
    const sameAccount = !reconnecting || existing.id === target.id;
    return { accountId: existing.id, created: false, result: sameAccount ? 'reconnected' : 'different_account' };
  }

  const id = newId();
  insertAccountRow(db, {
    id,
    kind: spec.provider,
    label: identity.email ?? spec.defaultLabel,
    email: identity.email,
    externalId: identity.subject,
    config: {},
    capabilities: input.capabilities,
    grantedScopes: input.granted,
    statusMessage: null,
    now,
  });
  vault.put(accountSecretId(id), secret);
  return { accountId: id, created: true, result: reconnecting ? 'different_account' : 'connected' };
}

/** The grant of an existing account; its status is reset by the caller after the transaction. */
function updateGrant(core: AccountsCore, row: AccountRow, input: UpsertInput, now: number): void {
  const previous = parseCapabilities(row.capabilities);
  const enabled = mergeEnabledCapabilities(previous, parseCapabilities(row.enabled_capabilities), input.capabilities);
  core.db.run(
    `UPDATE accounts SET email = COALESCE(?, email), capabilities = ?, enabled_capabilities = ?, granted_scopes = ?, updated_at = ?
     WHERE id = ?`,
    [
      input.identity.email,
      serializeCapabilities(input.capabilities),
      serializeCapabilities(enabled),
      JSON.stringify(input.granted),
      now,
      row.id,
    ],
  );
}
