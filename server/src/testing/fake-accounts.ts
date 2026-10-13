/**
 * FakeAccountService (§13): canned accounts, configs, access tokens and app-password secrets,
 * with the §4.7/§6 semantics the real service has (reauth errors, withToken retry-once on
 * ProviderUnauthorizedError, status updates, probes, change events).
 */
import type {
  Account,
  AccountConfigByKind,
  AccountKind,
  Capability,
} from '@homebase/shared';
import type { AccountChangeEvent, AccountProbe, AccountService } from '../context.ts';
import { HttpError, ProviderUnauthorizedError } from '../lib/errors.ts';

export interface FakeAccountSeed {
  id: string;
  kind: AccountKind;
  label?: string;
  email?: string | null;
  color?: string | null;
  capabilities?: Capability[];
  enabledCapabilities?: Capability[];
  status?: Account['status'];
  statusMessage?: string | null;
  sort?: number;
  config?: Record<string, unknown>;
  /** Access token for google/microsoft accounts (missing → reauth_required). */
  token?: string;
  /** Tokens returned by successive forced refreshes (after a ProviderUnauthorizedError). */
  refreshedTokens?: string[];
  /** App password for yahoo/caldav/imap accounts. */
  password?: string;
}

export interface FakeAccountService extends AccountService {
  /** Adds or replaces an account. */
  add(seed: FakeAccountSeed): Account;
  remove(id: string): void;
  /** Emits a change event to `onChange` subscribers. */
  emit(event: AccountChangeEvent): void;
  readonly probes: { capability: Capability; kinds: AccountKind[]; probe: AccountProbe }[];
  /** Every `setStatus` call; `meta` only when the caller gave one. */
  readonly statusChanges: { id: string; status: Account['status']; message?: string; meta?: { reason?: string; source?: string } }[];
  /** Number of forced refreshes per account. */
  readonly refreshes: Map<string, number>;
}

const EPOCH = '2026-01-01T00:00:00.000Z';

export function createFakeAccountService(seeds: FakeAccountSeed[] = []): FakeAccountService {
  const accounts = new Map<string, { account: Account; seed: FakeAccountSeed }>();
  const listeners = new Set<(e: AccountChangeEvent) => void>();
  const probes: FakeAccountService['probes'] = [];
  const statusChanges: FakeAccountService['statusChanges'] = [];
  const refreshes = new Map<string, number>();

  const mustGet = (id: string): { account: Account; seed: FakeAccountSeed } => {
    const entry = accounts.get(id);
    if (!entry) throw new HttpError(404, 'not_found', 'Account not found');
    return entry;
  };

  const reauth = (id: string): HttpError => new HttpError(409, 'reauth_required', { message: 'Reconnect required', accountId: id });

  const service: FakeAccountService = {
    add(seed) {
      const capabilities = seed.capabilities ?? [];
      const account: Account = {
        id: seed.id,
        kind: seed.kind,
        label: seed.label ?? `${seed.kind} account`,
        email: seed.email ?? null,
        color: seed.color ?? null,
        capabilities,
        enabledCapabilities: seed.enabledCapabilities ?? capabilities,
        status: seed.status ?? 'ok',
        statusMessage: seed.statusMessage ?? null,
        sort: seed.sort ?? accounts.size,
        createdAt: EPOCH,
        updatedAt: EPOCH,
      };
      accounts.set(seed.id, { account, seed: { ...seed } });
      return account;
    },
    remove(id) {
      accounts.delete(id);
    },
    emit(event) {
      for (const cb of listeners) cb(event);
    },
    probes,
    statusChanges,
    refreshes,

    list(filter = {}) {
      return [...accounts.values()]
        .map((e) => e.account)
        .filter((a) => (filter.kind ? a.kind === filter.kind : true))
        .filter((a) =>
          filter.capability ? a.capabilities.includes(filter.capability) && a.enabledCapabilities.includes(filter.capability) : true,
        )
        .sort((a, b) => a.sort - b.sort);
    },
    get(id) {
      return accounts.get(id)?.account ?? null;
    },
    getConfig<K extends AccountKind>(id: string): AccountConfigByKind[K] {
      return (mustGet(id).seed.config ?? {}) as AccountConfigByKind[K];
    },
    async getAccessToken(id) {
      const { account, seed } = mustGet(id);
      if (account.kind !== 'google' && account.kind !== 'microsoft') {
        throw new HttpError(400, 'bad_request', 'Account does not use OAuth');
      }
      if (account.status === 'reauth' || !seed.token) throw reauth(id);
      return seed.token;
    },
    async withToken(id, fn) {
      const token = await service.getAccessToken(id);
      try {
        return await fn(token);
      } catch (err) {
        if (!(err instanceof ProviderUnauthorizedError)) throw err;
        const entry = mustGet(id);
        refreshes.set(id, (refreshes.get(id) ?? 0) + 1);
        const next = entry.seed.refreshedTokens?.shift();
        if (!next) {
          service.setStatus(id, 'reauth');
          throw reauth(id);
        }
        entry.seed.token = next;
        try {
          return await fn(next);
        } catch (retryErr) {
          if (retryErr instanceof ProviderUnauthorizedError) {
            service.setStatus(id, 'reauth');
            throw reauth(id);
          }
          throw retryErr;
        }
      }
    },
    async getSecret(id) {
      const { account, seed } = mustGet(id);
      if (account.kind === 'google' || account.kind === 'microsoft') {
        throw new HttpError(400, 'bad_request', 'Account does not use an app password');
      }
      if (seed.password === undefined) {
        // Like the real service: a missing password marks the account for reauth.
        service.setStatus(id, 'reauth', 'The stored password is missing; add the account again');
        throw reauth(id);
      }
      return { password: seed.password };
    },
    setStatus(id, status, message, meta) {
      const entry = accounts.get(id);
      const change: FakeAccountService['statusChanges'][number] = message === undefined ? { id, status } : { id, status, message };
      if (meta !== undefined) change.meta = { ...meta };
      statusChanges.push(change);
      if (entry) {
        entry.account = { ...entry.account, status, statusMessage: message ?? null };
      }
    },
    registerProbe(capability, kinds, probe) {
      probes.push({ capability, kinds: [...kinds], probe });
    },
    onChange(cb) {
      listeners.add(cb);
    },
  };

  for (const seed of seeds) service.add(seed);
  return service;
}
