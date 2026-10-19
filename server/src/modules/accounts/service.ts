/**
 * AccountService (§4.7, §6): account rows, OAuth access tokens, app-password secrets, statuses,
 * capability probes and change events.
 *
 * Access tokens (google/microsoft):
 * - live only in memory; refreshed 5 min before expiry (or halfway for very short lifetimes);
 * - single-flight per account: concurrent callers share one refresh request, which runs in
 *   `withLogContext({area: 'accounts', accountId})` so the token endpoint's lines carry the account;
 * - a rotated refresh token is persisted (vault `account:<id>`) *before* the refresh resolves,
 *   and only while the refresh token that was used is still the stored one — a reconnect that
 *   happened meanwhile always wins, and a deleted account is never resurrected;
 * - `invalid_grant` sets `reauth` only if the refresh token used is still the stored one;
 *   otherwise the refresh is retried once with the new grant;
 * - network failures / 5xx set `status='error'` (never `reauth`, never downgrading a `reauth`).
 *
 * Status changes are persisted but do not emit change events (events mean the account's
 * identity, capabilities or settings changed); feature modules call `setStatus` freely.
 *
 * Diagnostics (§17): every status goes through `applyAccountStatus` (store.ts), which logs changes
 * and records the health subject `account:<id>` — refresh successes (ok), token endpoint refusals
 * (failing with the classified reason: `invalid_grant`, `client_rejected`, `refresh_unreachable` …),
 * missing credentials, a provider rejecting a freshly refreshed token (`token_rejected`). A 429
 * leaves the status alone but is recorded with its Retry-After. An OAuth client that is not
 * configured or a locked vault leaves the status alone too: warned once per account and reason,
 * and recorded as a refusal. Neither is recorded for an account that needs reauth (its reason stays).
 */
import {
  ACCOUNT_CONFIG_SCHEMAS,
  ACCOUNT_STATUSES,
  type AccountConfigByKind,
  type AccountKind,
  type AccountStatus,
} from '@portly/shared';
import type { Config } from '../../config.ts';
import type { AccountChangeEvent, AccountService } from '../../context.ts';
import type { Db } from '../../db/open.ts';
import { HttpError, ProviderUnauthorizedError } from '../../lib/errors.ts';
import { outcomeFromError, type DetailValue, type HealthRecorder, type Outcome } from '../../lib/health.ts';
import { getLogContext, withLogContext } from '../../lib/log-context.ts';
import { errorFields, type Logger } from '../../lib/logger.ts';
import type { SafeFetch } from '../../security/safe-fetch.ts';
import { VaultLockedError, type Vault } from '../../security/vault.ts';
import type { LookupFn } from './net.ts';
import { loadOAuthClient } from './oauth/clients.ts';
import { scopesFor, specForKind } from './oauth/providers.ts';
import { requestToken, type TokenEndpointFailure } from './oauth/token-endpoint.ts';
import type { OAuthClient, OAuthProviderSpec } from './oauth/types.ts';
import { ProbeRegistry } from './probes.ts';
import {
  VAULT_LOCKED_MESSAGE,
  accountHealthSubject,
  accountNotFound,
  accountSecretId,
  applyAccountStatus,
  getAccountRow,
  isAppPasswordKind,
  listAccountRows,
  parseCapabilities,
  parsePasswordSecret,
  parseRefreshTokenSecret,
  refreshTokenSecret,
  toAccount,
  type AccountStatusDeps,
  type AccountStatusMeta,
} from './store.ts';

export interface AccountServiceDeps {
  config: Config;
  db: Db;
  vault: Vault;
  log: Logger;
  fetch: SafeFetch;
  /** Health tracker for `account:<id>` (Settings → Diagnostics); optional in tests. */
  health?: HealthRecorder;
  /** Clock in epoch ms (tests). Default `Date.now`. */
  now?: () => number;
  /** DNS lookup for the CalDAV private-address check (tests). Default `dns.promises.lookup`. */
  lookup?: LookupFn;
}

/** Internals shared with the module's routes (never exposed through `AppContext`). */
export interface AccountsCore {
  readonly service: AccountService;
  readonly config: Config;
  readonly db: Db;
  readonly vault: Vault;
  readonly log: Logger;
  readonly fetch: SafeFetch;
  /** Health tracker (undefined when the service was created without one). */
  readonly health: HealthRecorder | undefined;
  readonly lookup: LookupFn | undefined;
  readonly probes: ProbeRegistry;
  now(): number;
  emit(event: AccountChangeEvent): void;
  /** Caches an access token obtained by the OAuth callback. */
  seedAccessToken(accountId: string, token: string, lifetimeSec: number): void;
  /** Drops the cached access token (account deleted or credentials replaced). */
  forgetAccessToken(accountId: string): void;
  /** A deleted account: drops its cached token, the warnings given about it and its health subjects. */
  forgetAccount(accountId: string): void;
  /** Refreshes now, ignoring the cache and a stored `reauth` status (connection test). */
  refreshNow(accountId: string): Promise<string>;
  /** Keeps a best-effort background task (e.g. token revocation) observable by {@link settle}. */
  track(task: Promise<unknown>, what: string): void;
  /** Resolves when every tracked background task finished (tests, shutdown). */
  settle(): Promise<void>;
}

export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const MAX_STATUS_MESSAGE = 500;

export const MESSAGES = Object.freeze({
  grantExpired: 'Access expired or was revoked; reconnect the account',
  noCredentials: 'No stored credentials; reconnect the account',
  tokenRejected: 'The provider rejected fresh access; reconnect the account',
  noPassword: 'The stored password is missing; add the account again',
});

export function reauthRequired(accountId: string, message: string = MESSAGES.grantExpired): HttpError {
  return new HttpError(409, 'reauth_required', { message, accountId });
}

interface CachedToken {
  token: string;
  expiresAt: number;
  /** Refresh this long before expiry. */
  marginMs: number;
}

/** Reasons an OAuth account cannot refresh that are not the account's fault (its status is left alone). */
type Refusal = 'not_configured' | 'vault_locked';

const REFUSAL_LINES: Readonly<Record<Refusal, string>> = Object.freeze({
  not_configured: 'account cannot refresh access: its OAuth client is not configured',
  vault_locked: 'account cannot refresh access: the credential vault is locked',
});

/** Dead-grant `error` codes kept as the reauth reason (`login_required` means the same as `interaction_required`). */
function deadGrantReason(error: string | null): string {
  if (error === 'interaction_required' || error === 'login_required') return 'interaction_required';
  if (error === 'consent_required') return 'consent_required';
  return 'invalid_grant';
}

/** What the caller of `withToken` was doing, from its log context (`calendar`, `mail.list` …). */
function callerPurpose(): string | null {
  const context = getLogContext();
  const area = typeof context?.area === 'string' && context.area !== '' ? context.area : null;
  const op = typeof context?.op === 'string' && context.op !== '' ? context.op : null;
  if (area === null) return op;
  return op === null ? area : `${area}.${op}`;
}

const cores = new WeakMap<AccountService, AccountsCore>();

/** The module internals behind a service created by {@link createAccountService} (undefined for fakes). */
export function accountsCoreOf(service: AccountService): AccountsCore | undefined {
  return cores.get(service);
}

export function createAccountService(deps: AccountServiceDeps): AccountService {
  const { config, db, vault, log, fetch } = deps;
  const now = deps.now ?? Date.now;
  const probes = new ProbeRegistry();
  const listeners = new Set<(e: AccountChangeEvent) => void>();
  const tokens = new Map<string, CachedToken>();
  const inflight = new Map<string, Promise<string>>();
  const background = new Set<Promise<void>>();
  /** `<accountId>\n<refusal>` already warned about (until the account refreshes again). */
  const refusalsWarned = new Set<string>();
  const statusDeps: AccountStatusDeps = { db, log, health: deps.health, now };

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const emit = (event: AccountChangeEvent): void => {
    for (const cb of [...listeners]) {
      try {
        const result: unknown = cb(event);
        if (result instanceof Promise) {
          result.catch((err: unknown) => log.error('account change listener failed', { type: event.type, ...errorFields(err) }));
        }
      } catch (err) {
        log.error('account change listener failed', { type: event.type, ...errorFields(err) });
      }
    }
  };

  /** A status decided by this module. */
  const setAccountStatus = (id: string, status: AccountStatus, message: string | null, meta: AccountStatusMeta): void => {
    applyAccountStatus(statusDeps, id, status, message, { source: 'accounts', ...meta });
  };

  /** `status='error'` unless the account needs reauth (an error must never hide a reauth). */
  const markError = (id: string, message: string, meta: AccountStatusMeta): void => {
    setAccountStatus(id, 'error', message, { ...meta, keepReauth: true });
  };

  /**
   * An outcome of `account:<id>` that does not change the status (refusals, rate limits); existing
   * accounts only. An account that needs reauth keeps its reason (as `keepReauth`: a locked vault
   * or a 429 must never hide that the account needs reconnecting).
   */
  const recordOutcome = (id: string, outcome: Outcome): void => {
    if (!deps.health) return;
    const row = getAccountRow(db, id);
    if (!row || row.status === 'reauth') return;
    deps.health.record(accountHealthSubject(id), { ...outcome, detail: { ...outcome.detail, source: 'accounts' } });
  };

  /**
   * An OAuth account that cannot refresh for a reason outside it: warns once per account and
   * reason, records the refusal (at info: the warning is the line) and returns `err` to throw.
   */
  const refused = (id: string, kind: AccountKind, reason: Refusal, err: HttpError): HttpError => {
    const key = `${id}\n${reason}`;
    if (!refusalsWarned.has(key)) {
      refusalsWarned.add(key);
      log.warn(REFUSAL_LINES[reason], { accountId: id, kind, reason });
    }
    recordOutcome(id, { ok: false, code: reason, message: err.message, severity: 'info' });
    return err;
  };

  const clearRefusals = (id: string): void => {
    for (const key of refusalsWarned) if (key.startsWith(`${id}\n`)) refusalsWarned.delete(key);
  };

  const readRefreshToken = (id: string, kind: AccountKind): string | null => {
    if (vault.state !== 'ready') throw refused(id, kind, 'vault_locked', reauthRequired(id, VAULT_LOCKED_MESSAGE));
    try {
      return parseRefreshTokenSecret(vault.get(accountSecretId(id)));
    } catch (err) {
      if (err instanceof VaultLockedError) throw refused(id, kind, 'vault_locked', reauthRequired(id, VAULT_LOCKED_MESSAGE));
      throw err;
    }
  };

  const loadClient = (spec: OAuthProviderSpec, id: string): OAuthClient => {
    let client: OAuthClient | null;
    try {
      client = loadOAuthClient({ db, vault }, spec.provider);
    } catch (err) {
      if (err instanceof VaultLockedError) throw refused(id, spec.provider, 'vault_locked', reauthRequired(id, VAULT_LOCKED_MESSAGE));
      throw err;
    }
    if (!client) {
      const err = new HttpError(409, 'not_configured', { message: `The ${spec.displayName} OAuth client is not configured`, accountId: id });
      throw refused(id, spec.provider, 'not_configured', err);
    }
    return client;
  };

  const cacheToken = (id: string, token: string, lifetimeSec: number): void => {
    const lifetimeMs = lifetimeSec * 1000;
    tokens.set(id, { token, expiresAt: now() + lifetimeMs, marginMs: Math.min(REFRESH_MARGIN_MS, lifetimeMs / 2) });
  };

  /** Cached token that is not due for refresh (and whose credentials still exist). */
  const freshCachedToken = (id: string): string | null => {
    const cached = tokens.get(id);
    if (!cached) return null;
    if (now() < cached.expiresAt - cached.marginMs && vault.has(accountSecretId(id))) return cached.token;
    tokens.delete(id);
    return null;
  };

  // -------------------------------------------------------------------------
  // Refresh
  // -------------------------------------------------------------------------

  const refreshFailure = async (
    id: string,
    spec: OAuthProviderSpec,
    used: string,
    result: TokenEndpointFailure,
    attempt: number,
    ms: number,
  ): Promise<string> => {
    const name = spec.displayName;
    const detail: Record<string, DetailValue> = { provider: spec.provider, failure: result.failure };
    if (result.error !== null) detail.oauthError = result.error;
    // Transport failures: the cause chain's codes (`causeCode` ENOTFOUND, `errReason` timeout …) and host.
    if (result.cause !== undefined) Object.assign(detail, outcomeFromError(result.cause).detail);
    const meta: AccountStatusMeta = { httpStatus: result.status, detail, ms };
    const cause = result.cause;

    switch (result.failure) {
      case 'invalid_grant': {
        if (!getAccountRow(db, id)) throw accountNotFound();
        const stored = readRefreshToken(id, spec.provider);
        if (stored === null || stored === used) {
          tokens.delete(id);
          setAccountStatus(id, 'reauth', MESSAGES.grantExpired, { ...meta, reason: deadGrantReason(result.error) });
          throw reauthRequired(id, MESSAGES.grantExpired);
        }
        // Reconnected while this refresh was in flight: the new grant is authoritative.
        log.debug('refresh token replaced during the refresh; using the new grant', { accountId: id, attempt });
        const cached = freshCachedToken(id);
        if (cached !== null) return cached;
        if (attempt === 0) return refreshAccessToken(id, attempt + 1);
        throw reauthRequired(id, MESSAGES.grantExpired);
      }
      case 'rate_limited': {
        const message = `${name} is rate limiting token refreshes; try again shortly`;
        const nextAttemptAt = result.retryAfterSeconds === null ? null : now() + result.retryAfterSeconds * 1000;
        recordOutcome(id, { ok: false, code: 'rate_limited', status: result.status ?? undefined, message, ms, detail, nextAttemptAt });
        throw new HttpError(429, 'rate_limited', { message, accountId: id });
      }
      case 'client_rejected': {
        const message = `${name} rejected the OAuth client; check its settings and reconnect`;
        markError(id, message, { ...meta, reason: 'client_rejected' });
        throw new HttpError(502, 'provider_error', { message, accountId: id });
      }
      case 'rejected': {
        const message = `${name} refused to refresh access; try reconnecting the account`;
        markError(id, message, { ...meta, reason: 'http_4xx' });
        throw new HttpError(502, 'provider_error', { message, accountId: id });
      }
      case 'timeout': {
        const message = `${name} did not respond while refreshing access`;
        markError(id, message, { ...meta, reason: 'timeout' });
        throw new HttpError(504, 'upstream_timeout', { message, accountId: id, cause });
      }
      case 'unreachable': {
        const message = `Could not reach ${name} to refresh access`;
        markError(id, message, { ...meta, reason: 'refresh_unreachable' });
        throw new HttpError(502, 'provider_error', { message, accountId: id, cause });
      }
      case 'server_error':
      case 'bad_response': {
        const message = `${name} could not refresh access right now`;
        markError(id, message, { ...meta, reason: result.failure === 'server_error' ? 'http_5xx' : 'parse_error' });
        throw new HttpError(502, 'provider_error', { message, accountId: id });
      }
    }
  };

  async function refreshAccessToken(id: string, attempt = 0): Promise<string> {
    const row = getAccountRow(db, id);
    if (!row) throw accountNotFound();
    const spec = specForKind(row.kind);
    const used = readRefreshToken(id, row.kind);
    if (used === null) {
      tokens.delete(id);
      setAccountStatus(id, 'reauth', MESSAGES.noCredentials, { reason: 'no_credentials' });
      throw reauthRequired(id, MESSAGES.noCredentials);
    }
    const client = loadClient(spec, id);

    const startedAt = Date.now();
    const result = await requestToken({
      fetch,
      log,
      spec,
      grant: 'refresh_token',
      // Only the granted services' scopes: Microsoft refuses a refresh for more than was consented to.
      params: {
        client_id: client.clientId,
        grant_type: 'refresh_token',
        refresh_token: used,
        ...spec.tokenParams(client, scopesFor(spec, parseCapabilities(row.capabilities))),
      },
    });
    const ms = Date.now() - startedAt;
    if (!result.ok) return refreshFailure(id, spec, used, result, attempt, ms);

    const { accessToken, expiresInSec, refreshToken: rotated } = result.tokens;
    const outcome = db.tx(() => {
      const current = getAccountRow(db, id);
      if (!current) return { kind: 'gone' as const };
      if (readRefreshToken(id, row.kind) !== used) return { kind: 'superseded' as const };
      if (rotated !== null && rotated !== used) vault.put(accountSecretId(id), refreshTokenSecret(rotated));
      // An account that is already ok keeps its message.
      return { kind: 'current' as const, message: current.status === 'ok' ? current.status_message : null };
    });
    if (outcome.kind === 'gone') throw accountNotFound();
    if (outcome.kind === 'current') {
      cacheToken(id, accessToken, expiresInSec);
      clearRefusals(id);
      setAccountStatus(id, 'ok', outcome.message, { reason: 'token_refreshed', ms });
      log.debug('access token refreshed', { accountId: id, provider: spec.provider, rotated: rotated !== null && rotated !== used, ms });
    }
    // 'superseded': the token is valid, but the reconnect's grant (and cache) stay authoritative.
    return accessToken;
  }

  const singleFlight = (id: string): Promise<string> => {
    const pending = inflight.get(id);
    if (pending) return pending;
    // The shared body runs in the first caller's context: name the account for every line it writes.
    const promise: Promise<string> = withLogContext({ area: 'accounts', accountId: id }, () => refreshAccessToken(id)).finally(() => {
      if (inflight.get(id) === promise) inflight.delete(id);
    });
    inflight.set(id, promise);
    return promise;
  };

  // -------------------------------------------------------------------------
  // AccountService
  // -------------------------------------------------------------------------

  const service: AccountService = {
    list(filter = {}) {
      const state = vault.state;
      const accounts = listAccountRows(db, filter.kind).map((row) => toAccount(row, state));
      const cap = filter.capability;
      return cap === undefined ? accounts : accounts.filter((a) => a.capabilities.includes(cap) && a.enabledCapabilities.includes(cap));
    },

    get(id) {
      const row = getAccountRow(db, id);
      return row ? toAccount(row, vault.state) : null;
    },

    getConfig<K extends AccountKind>(id: string): AccountConfigByKind[K] {
      const row = getAccountRow(db, id);
      if (!row) throw accountNotFound();
      let data: unknown;
      try {
        data = JSON.parse(row.config);
      } catch {
        data = undefined;
      }
      const parsed = ACCOUNT_CONFIG_SCHEMAS[row.kind].safeParse(data);
      if (!parsed.success) {
        log.error('stored account config is invalid', { accountId: id, kind: row.kind, issues: parsed.error.issues.length });
        throw new HttpError(500, 'internal', { message: 'The stored account settings are invalid; remove and re-add the account', accountId: id });
      }
      return parsed.data as AccountConfigByKind[K];
    },

    async getAccessToken(id) {
      const row = getAccountRow(db, id);
      if (!row) throw accountNotFound();
      specForKind(row.kind);
      if (vault.state !== 'ready') throw refused(id, row.kind, 'vault_locked', reauthRequired(id, VAULT_LOCKED_MESSAGE));
      if (row.status === 'reauth') throw reauthRequired(id, row.status_message ?? MESSAGES.grantExpired);
      return freshCachedToken(id) ?? singleFlight(id);
    },

    async withToken(id, fn) {
      const token = await service.getAccessToken(id);
      try {
        return await fn(token);
      } catch (err) {
        if (!(err instanceof ProviderUnauthorizedError)) throw err;
      }

      // The provider refused the token: force one refresh (unless another caller already did) and retry once.
      const purpose = callerPurpose();
      const cached = tokens.get(id);
      if (cached?.token === token) tokens.delete(id);
      log.info('provider rejected the access token; refreshing', { accountId: id, purpose });
      const fresh = await service.getAccessToken(id);
      try {
        return await fn(fresh);
      } catch (err) {
        if (!(err instanceof ProviderUnauthorizedError)) throw err;
        if (tokens.get(id)?.token === fresh) tokens.delete(id);
        log.warn('provider rejected a freshly refreshed token', { accountId: id, purpose });
        // The warning is the line: the health transition is info.
        setAccountStatus(id, 'reauth', MESSAGES.tokenRejected, { reason: 'token_rejected', severity: 'info' });
        throw reauthRequired(id, MESSAGES.tokenRejected);
      }
    },

    async getSecret(id) {
      const row = getAccountRow(db, id);
      if (!row) throw accountNotFound();
      if (!isAppPasswordKind(row.kind)) throw new HttpError(400, 'bad_request', 'This account does not use an app password');
      if (vault.state !== 'ready') throw reauthRequired(id, VAULT_LOCKED_MESSAGE);
      let raw: string | null;
      try {
        raw = vault.get(accountSecretId(id));
      } catch (err) {
        if (err instanceof VaultLockedError) throw reauthRequired(id, VAULT_LOCKED_MESSAGE);
        throw err;
      }
      const password = parsePasswordSecret(raw);
      if (password === null) {
        setAccountStatus(id, 'reauth', MESSAGES.noPassword, { reason: 'no_credentials' });
        throw reauthRequired(id, MESSAGES.noPassword);
      }
      return { password };
    },

    setStatus(id, status, message, meta) {
      if (!(ACCOUNT_STATUSES as readonly string[]).includes(status)) throw new TypeError(`Invalid account status "${String(status)}"`);
      const text = typeof message === 'string' && message.length > 0 ? message.slice(0, MAX_STATUS_MESSAGE) : null;
      // The caller's meta only (reason and deciding module); applyAccountStatus drops anything that is not a machine token.
      applyAccountStatus(statusDeps, id, status, text, { reason: meta?.reason, source: meta?.source });
      if (status === 'reauth') tokens.delete(id);
    },

    registerProbe(capability, kinds, probe) {
      probes.register(capability, kinds, probe);
    },

    onChange(cb) {
      listeners.add(cb);
    },
  };

  const core: AccountsCore = {
    service,
    config,
    db,
    vault,
    log,
    fetch,
    health: deps.health,
    lookup: deps.lookup,
    probes,
    now,
    emit,
    seedAccessToken(id, token, lifetimeSec) {
      cacheToken(id, token, lifetimeSec);
      // A completed code exchange: the client is configured and the vault works.
      clearRefusals(id);
    },
    forgetAccessToken(id) {
      tokens.delete(id);
    },
    forgetAccount(id) {
      tokens.delete(id);
      clearRefusals(id);
      deps.health?.forgetAccount(id);
    },
    refreshNow(id) {
      tokens.delete(id);
      return singleFlight(id);
    },
    track(task, what) {
      const tracked: Promise<void> = task
        .then(
          () => undefined,
          (err: unknown) => log.warn('background task failed', { task: what, ...errorFields(err) }),
        )
        .finally(() => background.delete(tracked));
      background.add(tracked);
    },
    async settle() {
      while (background.size > 0) await Promise.allSettled([...background]);
    },
  };
  cores.set(service, core);
  return service;
}
