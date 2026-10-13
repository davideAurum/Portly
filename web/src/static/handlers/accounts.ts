/**
 * Accounts module of the static backend: Outlook.com (Microsoft personal accounts) only. A port of
 * server/src/modules/accounts (routes.ts, oauth/flow.ts, the token side of service.ts,
 * operations.ts) where the browser is the OAuth client: PKCE, the code exchange and refreshes go
 * from the page straight to login.microsoftonline.com (see providers/microsoftAuth.ts).
 *
 * Routes (same shapes as the server):
 * - `GET  /api/oauth-clients/microsoft` → `{clientId, hasSecret: false, redirectUri}` (the redirect
 *   URI is this site's own address; register it as a *Single-page application*)
 * - `PUT  /api/oauth-clients/microsoft {clientId}` (a secret is refused: public client)
 * - `POST /api/oauth/microsoft/start {accountId?, returnTo?}` → `{authorizeUrl}`
 * - `GET /api/accounts`, `PATCH /api/accounts/:id`, `DELETE /api/accounts/:id`,
 *   `POST /api/accounts/:id/test` (forces a token refresh)
 * Google answers `409 not_configured`; app-password accounts stay in handlers/unavailable.ts.
 *
 * Microsoft sends the browser back to the site itself (`<appUrl>?code&state`), not to an API
 * route: main.tsx hands that address to {@link completeAuthorization} before the app renders and
 * then shows the server's `?oauth=<result>` toast.
 *
 * Diagnostics (ARCHITECTURE §17): a sign-in that fails here is this browser's `provider` event (the
 * OAuth `error` code Microsoft answered, or which identity check failed) or `backend` event (it
 * crashed), next to its console line; failed token requests are recorded by `requestToken`. Never a
 * code, token, state or address.
 *
 * Tokens: refresh and access tokens live in the `account-tokens` slice (this browser only, never
 * exported, not encrypted). Refreshes run under a Web Lock per account, re-reading the slice
 * first, so tabs never race on Microsoft's rotating refresh tokens. A single-page app's sign-in
 * ends 24 hours after it was made; {@link planSilentReauth} renews it at page load with
 * `prompt=none` before (or once) it runs out, and when that cannot work the account shows
 * "Reconnect needed" as on the server.
 */
import {
  AccountUpdateSchema,
  CAPABILITIES,
  DEFAULT_OAUTH_RETURN_TO,
  EntityId,
  OAUTH_RETURN_TO_REGEX,
  OAuthClientUpdateSchema,
  OAuthStartSchema,
  isOAuthProvider,
  normalizeHexColor,
  type Account,
  type AccountTestResult,
  type Capability,
  type OAuthClientInfo,
  type OAuthResult,
  type OAuthStartResponse,
  type ProbeResult,
  type ValidationIssue,
} from '@homebase/shared';
import { recordClientEvent } from '../../diagnostics/clientLog.ts';
import type { StaticContext } from '../context.ts';
import { newToken } from '../lib/ids.ts';
import { parseJsonBody } from '../lib/validate.ts';
import {
  CLIENT_ID_REGEX,
  MICROSOFT_DEFAULT_LABEL,
  MICROSOFT_DISPLAY_NAME,
  MICROSOFT_STATIC_SCOPES,
  MICROSOFT_TOKEN_ENDPOINT,
  SPA_SESSION_MS,
  authorizeUrl,
  capabilitiesOf,
  decodeJwtClaims,
  grantedScopes,
  microsoftIdentity,
  pkceChallenge,
  requestToken,
  type TokenFailure,
  type TokenSet,
} from '../providers/microsoftAuth.ts';
import { errorName, hostOf, recordProviderFailure } from '../providers/diagnostics.ts';
import { StaticApiError, json, noContent } from '../respond.ts';
import type { StaticRouter } from '../router.ts';
import {
  SLICE,
  getAccountTokens,
  getAccounts,
  getOAuthClients,
  getOAuthStates,
  type StoredAccount,
  type StoredAccountTokens,
} from '../slices.ts';

export const STATE_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_STATES = 20;
/** Shape of the states we generate (32 bytes → 43 base64url chars); anything else is never looked up. */
export const STATE_PARAM_REGEX = /^[A-Za-z0-9_-]{43}$/;
const MAX_CODE_LENGTH = 4096;

/** Refresh an access token this long before it expires (or halfway, for short lifetimes). */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Renew the sign-in automatically at page load when it ends within this. */
export const SILENT_RENEW_BEFORE_MS = 2 * 60 * 60 * 1000;
/** At most one automatic sign-in attempt per account in this window (no redirect loops). */
export const SILENT_RETRY_MS = 6 * 60 * 60 * 1000;

export const MESSAGES = Object.freeze({
  grantExpired: 'Access expired or was revoked; reconnect the account',
  sessionEnded: 'The Microsoft sign-in in this browser ended (it lasts 24 hours); reconnect the account',
  noCredentials: 'No stored credentials; reconnect the account',
});

const NOT_IN_STATIC = 'Google accounts are not available in the browser-only build.';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function iso(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}

/** API shape of a stored account (the server's `toAccount`). */
export function toAccount(row: StoredAccount): Account {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    email: row.email,
    color: normalizeHexColor(row.color),
    capabilities: [...row.capabilities],
    enabledCapabilities: row.enabledCapabilities.filter((c) => row.capabilities.includes(c)),
    status: row.status,
    statusMessage: row.statusMessage,
    sort: row.sort,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt ?? row.createdAt),
  };
}

function orderedAccounts(ctx: StaticContext): StoredAccount[] {
  return [...getAccounts(ctx)].sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function findAccount(ctx: StaticContext, id: string): StoredAccount | undefined {
  return getAccounts(ctx).find((a) => a.id === id);
}

function accountNotFound(): StaticApiError {
  return new StaticApiError('not_found', 'Account not found');
}

function orderCapabilities(list: readonly Capability[]): Capability[] {
  return CAPABILITIES.filter((c) => list.includes(c));
}

/** Newly granted capabilities start enabled; ones the user switched off stay off (server's rule). */
function mergeEnabledCapabilities(previousCapabilities: readonly Capability[], previousEnabled: readonly Capability[], next: readonly Capability[]): Capability[] {
  return orderCapabilities(next.filter((c) => previousEnabled.includes(c) || !previousCapabilities.includes(c)));
}

function setStatus(row: StoredAccount, status: StoredAccount['status'], message: string | null, now: number): boolean {
  if (row.status === status && row.statusMessage === message) return false;
  row.status = status;
  row.statusMessage = message;
  row.updatedAt = now;
  return true;
}

function reauthRequired(accountId: string, message: string = MESSAGES.grantExpired): StaticApiError {
  return new StaticApiError('reauth_required', message, undefined, accountId);
}

function invalid(path: string, message: string): StaticApiError {
  const issues: ValidationIssue[] = [{ path, message, code: 'custom' }];
  return new StaticApiError('validation_failed', message, issues);
}

// ---------------------------------------------------------------------------
// OAuth client
// ---------------------------------------------------------------------------

/** The provider route parameter: Microsoft, a "not here" for Google, 404 for anything else. */
function microsoftParam(value: string | undefined): 'microsoft' {
  if (!isOAuthProvider(value)) throw new StaticApiError('not_found', 'Unknown OAuth provider');
  if (value !== 'microsoft') throw new StaticApiError('not_configured', NOT_IN_STATIC);
  return value;
}

function clientInfo(ctx: StaticContext): OAuthClientInfo {
  return { clientId: getOAuthClients(ctx).microsoft?.clientId ?? null, hasSecret: false, redirectUri: ctx.appUrl };
}

function requireClientId(ctx: StaticContext, accountId?: string): string {
  const client = getOAuthClients(ctx).microsoft;
  if (!client) throw new StaticApiError('not_configured', `Set up the ${MICROSOFT_DISPLAY_NAME} OAuth client first`, undefined, accountId);
  return client.clientId;
}

// ---------------------------------------------------------------------------
// Authorization: start
// ---------------------------------------------------------------------------

export interface StartInput {
  accountId?: string | undefined;
  returnTo?: string | undefined;
  /** Automatic re-sign-in (`prompt=none`). */
  silent?: boolean;
  loginHint?: string | null;
}

/** Stores a pending authorization (PKCE verifier, account, route) and returns Microsoft's sign-in URL. */
export async function startAuthorization(ctx: StaticContext, input: StartInput): Promise<string> {
  const clientId = requireClientId(ctx);
  let accountId: string | null = null;
  if (input.accountId !== undefined) {
    if (!findAccount(ctx, input.accountId)) throw accountNotFound();
    accountId = input.accountId;
  }
  const codeVerifier = newToken(32);
  const codeChallenge = await pkceChallenge(codeVerifier);
  const state = newToken(32);
  const now = ctx.now();
  const returnTo = input.returnTo !== undefined && OAUTH_RETURN_TO_REGEX.test(input.returnTo) ? input.returnTo : DEFAULT_OAUTH_RETURN_TO;

  const pending = getOAuthStates(ctx).filter((s) => s.expiresAt > now);
  pending.push({ state, provider: 'microsoft', codeVerifier, accountId, returnTo, silent: input.silent === true, createdAt: now, expiresAt: now + STATE_TTL_MS });
  ctx.state.set(SLICE.oauthStates, pending.slice(-MAX_PENDING_STATES));
  await ctx.state.commit(SLICE.oauthStates);

  return authorizeUrl({ clientId, redirectUri: ctx.appUrl, state, codeChallenge, silent: input.silent, loginHint: input.loginHint });
}

// ---------------------------------------------------------------------------
// Authorization: callback (the site's own address with `?code&state`)
// ---------------------------------------------------------------------------

export interface CallbackQuery {
  /** `undefined` when absent, `null` when repeated (ambiguous → rejected). */
  code: string | null | undefined;
  state: string | null | undefined;
  error: string | null | undefined;
}

export interface CallbackOutcome {
  /** The toast to show (`?oauth=`), or null for an automatic sign-in that needs no message. */
  result: OAuthResult | null;
  /** App route (`#/…`) to return to. */
  returnTo: string;
}

/** Microsoft's sign-in host, all a diagnostic event keeps of its addresses. */
const SIGN_IN_HOST = hostOf(MICROSOFT_TOKEN_ENDPOINT);

/** A sign-in that could not finish because of this browser's own state (storage, a crash). */
function recordSignInCrash(msg: string, err: unknown): void {
  recordClientEvent('error', 'backend', msg, { errName: errorName(err), op: 'microsoft sign-in' });
}

/** Completes a sign-in; never throws and never reflects provider text. */
export async function completeAuthorization(ctx: StaticContext, query: CallbackQuery): Promise<CallbackOutcome> {
  const fallback: CallbackOutcome = { result: 'error', returnTo: DEFAULT_OAUTH_RETURN_TO };
  const { state } = query;
  if (typeof state !== 'string' || !STATE_PARAM_REGEX.test(state)) return fallback;

  // Consumed before the exchange: a state can be used at most once.
  let consumed;
  try {
    await ctx.state.reload([SLICE.oauthStates]);
    const states = getOAuthStates(ctx);
    const now = ctx.now();
    consumed = states.find((s) => s.state === state && s.expiresAt > now);
    ctx.state.set(
      SLICE.oauthStates,
      states.filter((s) => s.state !== state && s.expiresAt > now),
    );
    await ctx.state.commit(SLICE.oauthStates);
  } catch (err) {
    console.error('[Homebase] Could not read the pending sign-in', err);
    recordSignInCrash('could not read the pending Microsoft sign-in', err);
    return fallback;
  }
  if (!consumed) return { result: 'expired', returnTo: DEFAULT_OAUTH_RETURN_TO };
  const returnTo = OAUTH_RETURN_TO_REGEX.test(consumed.returnTo) ? consumed.returnTo : DEFAULT_OAUTH_RETURN_TO;
  const quiet = (result: OAuthResult): CallbackOutcome => ({ result: consumed.silent ? null : result, returnTo });

  if (query.error !== undefined) {
    // From the address: kept only when it is a registered-looking OAuth code. An automatic
    // re-sign-in answering `login_required` (or the user declining) is expected now and then.
    const code = typeof query.error === 'string' && /^[a-z_]{1,64}$/.test(query.error) ? query.error : 'error';
    recordProviderFailure('microsoft', SIGN_IN_HOST, { code }, consumed.silent || code === 'access_denied' ? 'info' : 'warn');
    return quiet(query.error === 'access_denied' ? 'denied' : 'error');
  }
  if (typeof query.code !== 'string' || query.code.length === 0 || query.code.length > MAX_CODE_LENGTH) return quiet('error');

  try {
    const result = await connect(ctx, query.code, consumed.codeVerifier, consumed.accountId);
    // A quiet renewal of the same account needs no message; anything else is worth one.
    return consumed.silent && result === 'reconnected' ? { result: null, returnTo } : { result, returnTo };
  } catch (err) {
    console.error('[Homebase] The Microsoft sign-in could not be completed', err);
    recordSignInCrash('the Microsoft sign-in could not be completed', err);
    return quiet('error');
  }
}

function sessionEnd(now: number, tokens: TokenSet, fallback: number): number {
  return tokens.refreshExpiresInSec !== null ? now + tokens.refreshExpiresInSec * 1000 : fallback;
}

async function connect(ctx: StaticContext, code: string, codeVerifier: string, reconnectId: string | null): Promise<OAuthResult> {
  const clientId = getOAuthClients(ctx).microsoft?.clientId;
  if (!clientId) return 'error';

  const exchange = await requestToken({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: ctx.appUrl,
    code_verifier: codeVerifier,
    scope: MICROSOFT_STATIC_SCOPES.join(' '),
  });
  if (!exchange.ok) {
    console.warn('[Homebase] Microsoft refused the sign-in code', { failure: exchange.failure, status: exchange.status });
    return 'error';
  }
  const tokens = exchange.tokens;
  const claims = decodeJwtClaims(tokens.idToken);
  if (!claims) return 'error';
  const now = ctx.now();
  const verdict = microsoftIdentity(claims, clientId, now);
  if (!verdict.ok) {
    console.warn('[Homebase] The Microsoft sign-in was rejected', { reason: verdict.reason });
    recordProviderFailure('microsoft', SIGN_IN_HOST, { code: `id_token_${verdict.reason}` });
    return 'error';
  }
  const granted = grantedScopes(tokens.scope);
  const capabilities = capabilitiesOf(granted);
  if (capabilities.length === 0) return 'denied';
  if (tokens.refreshToken === null) return 'error';

  // Another tab may have changed accounts since this page loaded.
  await ctx.state.reload([SLICE.accounts, SLICE.accountTokens]);
  const accounts = getAccounts(ctx);
  const { identity } = verdict;
  const target = reconnectId === null ? undefined : accounts.find((a) => a.id === reconnectId);
  const reconnecting = target !== undefined;
  const existing = reconnecting && target.externalId === identity.subject ? target : accounts.find((a) => a.externalId === identity.subject);

  let accountId: string;
  let result: OAuthResult;
  if (existing) {
    existing.email = identity.email ?? existing.email;
    existing.enabledCapabilities = mergeEnabledCapabilities(existing.capabilities, existing.enabledCapabilities, capabilities);
    existing.capabilities = capabilities;
    existing.grantedScopes = granted;
    existing.status = 'ok';
    existing.statusMessage = null;
    existing.updatedAt = now;
    accountId = existing.id;
    result = !reconnecting || existing.id === target.id ? 'reconnected' : 'different_account';
  } else {
    accountId = ctx.newId();
    accounts.push({
      id: accountId,
      kind: 'microsoft',
      label: identity.email ?? MICROSOFT_DEFAULT_LABEL,
      email: identity.email,
      externalId: identity.subject,
      color: null,
      capabilities,
      enabledCapabilities: capabilities,
      grantedScopes: granted,
      status: 'ok',
      statusMessage: null,
      sort: accounts.reduce((max, a) => Math.max(max, a.sort + 1), 0),
      createdAt: now,
      updatedAt: now,
    });
    result = reconnecting ? 'different_account' : 'connected';
  }

  getAccountTokens(ctx)[accountId] = {
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessRefreshAt: refreshAt(now, tokens.expiresInSec),
    sessionExpiresAt: sessionEnd(now, tokens, now + SPA_SESSION_MS),
    silentAttemptAt: null,
  };
  await ctx.state.commit(SLICE.accounts, SLICE.accountTokens);
  return result;
}

// ---------------------------------------------------------------------------
// Automatic re-sign-in
// ---------------------------------------------------------------------------

/**
 * The sign-in URL for an automatic (`prompt=none`) renewal when an account's sign-in has ended or
 * ends within {@link SILENT_RENEW_BEFORE_MS}, else null. At most one attempt per account per
 * {@link SILENT_RETRY_MS} (recorded before the redirect), so a failing renewal never loops: the
 * account then simply shows "Reconnect needed".
 */
export async function planSilentReauth(ctx: StaticContext, returnTo: string): Promise<string | null> {
  if (!getOAuthClients(ctx).microsoft) return null;
  const now = ctx.now();
  const tokens = getAccountTokens(ctx);
  for (const account of orderedAccounts(ctx)) {
    const record = tokens[account.id];
    if (!record) continue;
    const due = account.status === 'reauth' || record.sessionExpiresAt - now < SILENT_RENEW_BEFORE_MS;
    if (!due) continue;
    if (record.silentAttemptAt !== null && now - record.silentAttemptAt < SILENT_RETRY_MS) continue;
    record.silentAttemptAt = now;
    await ctx.state.commit(SLICE.accountTokens);
    return startAuthorization(ctx, { accountId: account.id, returnTo, silent: true, loginHint: account.email });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

const lockChains = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` exclusively for `name`: across tabs with a Web Lock when the browser has them, and
 * always within this page (so the fallback still serializes this tab's own callers).
 */
export function withAccountLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  const run = (): Promise<T> => (locks?.request ? locks.request(name, () => fn()) : fn());
  const previous = lockChains.get(name) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  lockChains.set(name, settled);
  void settled.then(() => {
    if (lockChains.get(name) === settled) lockChains.delete(name);
  });
  return next;
}

function lockName(accountId: string): string {
  return `homebase-static:${import.meta.env.BASE_URL}:microsoft-token:${accountId}`;
}

function freshToken(record: StoredAccountTokens, now: number): string | null {
  return record.accessToken !== null && now < record.accessRefreshAt ? record.accessToken : null;
}

/** When to refresh a token of `lifetimeSec` obtained at `now`. */
function refreshAt(now: number, lifetimeSec: number): number {
  const lifetimeMs = lifetimeSec * 1000;
  return now + lifetimeMs - Math.min(REFRESH_MARGIN_MS, lifetimeMs / 2);
}

export interface AccessTokenOptions {
  /** Refresh even when the stored token looks fresh (connection test). */
  force?: boolean;
  /** Graph refused this token: refresh unless another caller already replaced it. */
  rejected?: string;
}

/**
 * A usable Graph access token for the account: the stored one while fresh, else a refresh under
 * the account's lock. `409 reauth_required` once the sign-in is dead.
 */
export async function getAccessToken(ctx: StaticContext, accountId: string, options: AccessTokenOptions = {}): Promise<string> {
  const account = findAccount(ctx, accountId);
  if (!account) throw accountNotFound();
  if (account.status === 'reauth' && !options.force) throw reauthRequired(accountId, account.statusMessage ?? MESSAGES.grantExpired);
  if (!options.force && options.rejected === undefined) {
    const record = getAccountTokens(ctx)[accountId];
    const fresh = record ? freshToken(record, ctx.now()) : null;
    if (fresh !== null) return fresh;
  }
  return withAccountLock(lockName(accountId), async () => {
    // Another tab may have refreshed (and rotated the refresh token) meanwhile.
    await ctx.state.reload([SLICE.accounts, SLICE.accountTokens]);
    const current = findAccount(ctx, accountId);
    if (!current) throw accountNotFound();
    const record = getAccountTokens(ctx)[accountId];
    if (!record) {
      if (setStatus(current, 'reauth', MESSAGES.noCredentials, ctx.now())) await ctx.state.commit(SLICE.accounts);
      throw reauthRequired(accountId, MESSAGES.noCredentials);
    }
    const fresh = freshToken(record, ctx.now());
    if (fresh !== null && !options.force && fresh !== options.rejected) return fresh;
    return refresh(ctx, current, record);
  });
}

async function refresh(ctx: StaticContext, account: StoredAccount, record: StoredAccountTokens, attempt = 0): Promise<string> {
  const id = account.id;
  const clientId = requireClientId(ctx, id);
  const used = record.refreshToken;
  const result = await requestToken({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: used,
    scope: MICROSOFT_STATIC_SCOPES.join(' '),
  });
  // Re-read after the request: a reload (another tab's change) replaces the slice objects.
  const now = ctx.now();
  const current = findAccount(ctx, id);
  const stored = getAccountTokens(ctx)[id];
  if (!current || !stored) throw accountNotFound();
  const replaced = stored.refreshToken !== used;

  if (!result.ok) {
    if (result.failure === 'invalid_grant' && replaced) {
      // Reconnected while this refresh was in flight: the new grant is authoritative.
      const fresh = freshToken(stored, now);
      if (fresh !== null) return fresh;
      if (attempt === 0) return refresh(ctx, current, stored, attempt + 1);
    }
    return refreshFailure(ctx, current, stored, result.failure, now);
  }

  const { accessToken, expiresInSec, refreshToken: rotated } = result.tokens;
  // Superseded by a reconnect: this token works, but the reconnect's grant stays stored.
  if (replaced) return accessToken;
  stored.refreshToken = rotated ?? used;
  stored.accessToken = accessToken;
  stored.accessRefreshAt = refreshAt(now, expiresInSec);
  stored.sessionExpiresAt = sessionEnd(now, result.tokens, stored.sessionExpiresAt);
  setStatus(current, 'ok', null, now);
  await ctx.state.commit(SLICE.accounts, SLICE.accountTokens);
  return accessToken;
}

/** `status = 'error'` unless the account needs reauth (an error must never hide a reauth). */
function markError(account: StoredAccount, message: string, now: number): boolean {
  return account.status !== 'reauth' && setStatus(account, 'error', message, now);
}

async function refreshFailure(ctx: StaticContext, account: StoredAccount, record: StoredAccountTokens, failure: TokenFailure, now: number): Promise<never> {
  const name = MICROSOFT_DISPLAY_NAME;
  const id = account.id;
  const fail = async (changed: boolean, error: StaticApiError): Promise<never> => {
    if (changed) await ctx.state.commit(SLICE.accounts, SLICE.accountTokens);
    throw error;
  };
  switch (failure) {
    case 'invalid_grant': {
      const message = now >= record.sessionExpiresAt ? MESSAGES.sessionEnded : MESSAGES.grantExpired;
      record.accessToken = null;
      record.accessRefreshAt = 0;
      setStatus(account, 'reauth', message, now);
      return fail(true, reauthRequired(id, message));
    }
    case 'rate_limited':
      throw new StaticApiError('rate_limited', `${name} is rate limiting token refreshes; try again shortly`, undefined, id);
    case 'client_rejected': {
      const message = `${name} rejected the OAuth client; check its settings and reconnect`;
      return fail(markError(account, message, now), new StaticApiError('provider_error', message, undefined, id));
    }
    case 'rejected': {
      const message = `${name} refused to refresh access; try reconnecting the account`;
      return fail(markError(account, message, now), new StaticApiError('provider_error', message, undefined, id));
    }
    case 'timeout': {
      const message = `${name} did not respond while refreshing access`;
      return fail(markError(account, message, now), new StaticApiError('upstream_timeout', message, undefined, id));
    }
    case 'unreachable': {
      const message = `Could not reach ${name} to refresh access`;
      return fail(markError(account, message, now), new StaticApiError('provider_error', message, undefined, id));
    }
    case 'server_error':
    case 'bad_response': {
      const message = `${name} could not refresh access right now`;
      return fail(markError(account, message, now), new StaticApiError('provider_error', message, undefined, id));
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function accountIdParam(params: Readonly<Record<string, string>>): string {
  const parsed = EntityId.safeParse(params.id);
  if (!parsed.success) throw accountNotFound();
  return parsed.data;
}

function failureOf(err: unknown): ProbeResult {
  if (err instanceof StaticApiError) return { ok: false, code: err.code, message: err.message };
  return { ok: false, code: 'internal', message: 'The connection test failed' };
}

export function register(router: StaticRouter): void {
  router.get('/api/oauth-clients/:provider', (ctx, { params }) => {
    microsoftParam(params.provider);
    return json(clientInfo(ctx));
  });

  router.put('/api/oauth-clients/:provider', async (ctx, { req, params }) => {
    microsoftParam(params.provider);
    const body = await parseJsonBody(req, OAuthClientUpdateSchema);
    if (!CLIENT_ID_REGEX.test(body.clientId)) throw invalid('clientId', 'Microsoft application (client) IDs are GUIDs');
    if (body.clientSecret !== undefined) throw invalid('clientSecret', `${MICROSOFT_DISPLAY_NAME} uses a public client; do not enter a client secret`);
    getOAuthClients(ctx).microsoft = { clientId: body.clientId, updatedAt: ctx.now() };
    await ctx.state.commit(SLICE.oauthClients);
    return json(clientInfo(ctx));
  });

  router.post('/api/oauth/:provider/start', async (ctx, { req, params }) => {
    microsoftParam(params.provider);
    const body = await parseJsonBody(req, OAuthStartSchema);
    const response: OAuthStartResponse = { authorizeUrl: await startAuthorization(ctx, body) };
    return json(response);
  });

  router.get('/api/accounts', (ctx) => json(orderedAccounts(ctx).map(toAccount)));

  router.patch('/api/accounts/:id', async (ctx, { req, params }) => {
    const id = accountIdParam(params);
    const patch = await parseJsonBody(req, AccountUpdateSchema);
    const row = findAccount(ctx, id);
    if (!row) throw accountNotFound();
    if (patch.enabledCapabilities !== undefined) {
      const unsupported = patch.enabledCapabilities.filter((c) => !row.capabilities.includes(c));
      if (unsupported.length > 0) {
        const issues: ValidationIssue[] = unsupported.map((c) => ({
          path: 'enabledCapabilities',
          message: `${c === 'calendar' ? 'Calendar' : 'Mail'} is not available for this account`,
          code: 'custom',
        }));
        throw new StaticApiError('validation_failed', 'Capabilities not available for this account', issues);
      }
    }
    let changed = false;
    if (patch.label !== undefined) {
      row.label = patch.label;
      changed = true;
    }
    if (patch.color !== undefined) {
      row.color = patch.color === null ? null : normalizeHexColor(patch.color);
      changed = true;
    }
    if (patch.enabledCapabilities !== undefined) {
      row.enabledCapabilities = orderCapabilities(patch.enabledCapabilities);
      changed = true;
    }
    if (patch.sort !== undefined) {
      row.sort = patch.sort;
      changed = true;
    }
    if (changed) {
      row.updatedAt = ctx.now();
      await ctx.state.commit(SLICE.accounts);
    }
    return json(toAccount(row));
  });

  router.delete('/api/accounts/:id', async (ctx, { params }) => {
    const id = accountIdParam(params);
    const accounts = getAccounts(ctx);
    const index = accounts.findIndex((a) => a.id === id);
    if (index === -1) throw accountNotFound();
    accounts.splice(index, 1);
    // Microsoft has no token revocation endpoint: the stored tokens are simply forgotten.
    delete getAccountTokens(ctx)[id];
    await ctx.state.commit(SLICE.accounts, SLICE.accountTokens);
    return noContent();
  });

  router.post('/api/accounts/:id/test', async (ctx, { params }) => {
    const id = accountIdParam(params);
    const row = findAccount(ctx, id);
    if (!row) throw accountNotFound();
    let result: ProbeResult;
    try {
      await getAccessToken(ctx, id, { force: true });
      result = { ok: true };
    } catch (err) {
      result = failureOf(err);
    }
    const results: AccountTestResult['results'] = {};
    for (const capability of row.capabilities) results[capability] = result;
    return json({ results } satisfies AccountTestResult);
  });
}
