/**
 * Accounts & OAuth module (§4.7, §6, §7 Accounts, §8).
 *
 * - `createAccountService(deps)` builds the AccountService handed to every module through
 *   `AppContext.accounts` (bootstrap, before the app is created).
 * - `register(app, ctx)` mounts `/api/accounts`, `/api/oauth-clients` and `/api/oauth` and schedules
 *   the hourly purge of expired `oauth_states`.
 *
 * The routes work on the internals of the service in `ctx.accounts`. When a context carries a
 * different AccountService (e.g. the FakeAccountService of other modules' tests), the routes get
 * their own real service over the same database, vault and fetch.
 */
import type { Hono } from 'hono';
import type { AccountService, AppContext, AppEnv } from '../../context.ts';
import { purgeExpiredStates } from './oauth/states.ts';
import { registerAccountsRoutes } from './routes.ts';
import { accountsCoreOf, createAccountService, type AccountServiceDeps, type AccountsCore } from './service.ts';

export { accountsCoreOf, createAccountService, reauthRequired } from './service.ts';
export type { AccountServiceDeps, AccountsCore } from './service.ts';

export const prefixes = ['/api/accounts', '/api/oauth-clients', '/api/oauth'] as const;

export const OAUTH_STATES_PURGE_JOB = 'accounts:oauth-states-purge';
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const PURGE_INITIAL_DELAY_MS = 60 * 1000;

function coreFor(ctx: AppContext): AccountsCore {
  const existing = accountsCoreOf(ctx.accounts);
  if (existing) return existing;
  ctx.log.debug('accounts: ctx.accounts is not the module service; routes use their own instance');
  const deps: AccountServiceDeps = { config: ctx.config, db: ctx.db, vault: ctx.vault, log: ctx.log, fetch: ctx.fetch, health: ctx.health };
  const service: AccountService = createAccountService(deps);
  return accountsCoreOf(service) as AccountsCore;
}

export function register(app: Hono<AppEnv>, ctx: AppContext): void {
  const core = coreFor(ctx);
  registerAccountsRoutes(app, core);
  ctx.scheduler.every(
    OAUTH_STATES_PURGE_JOB,
    PURGE_INTERVAL_MS,
    () => {
      const purged = purgeExpiredStates(core.db, core.now());
      if (purged > 0) core.log.debug('expired oauth states purged', { count: purged });
    },
    { initialDelayMs: PURGE_INITIAL_DELAY_MS },
  );
}
