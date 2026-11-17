/**
 * Flight tracker module (§7 Flights, §8 FlightAware): the status of flights by number and date,
 * from FlightAware AeroAPI with the user's own key. Read-only.
 *
 * Routes (all declared `paired()`: the paired Pages site may use them too):
 * - `GET    /api/flights/key`               → `{configured}` (the key is never returned)
 * - `PUT    /api/flights/key {key}`         → `{configured: true}`; the shape is checked, then the free
 *                                             `/account/usage` call, before it is stored in the vault
 *                                             as `flightaware:key`
 * - `DELETE /api/flights/key`               → `{configured: false}`
 * - `GET    /api/flights/status?ident=&date=` → `FlightStatus`
 *
 * Every AeroAPI call costs money, so answers are kept in memory (`ctx.memo`: travel plans are not
 * written to disk) for as long as `flightRefreshMs` says, shared by every widget and tab, and
 * concurrent requests for one flight share one call.
 *
 * Errors: no key → 409 `not_configured`; key stored but vault locked → 409 `reauth_required`;
 * upstream failures as documented in `aeroapi.ts`. A 429 answer carries `Retry-After`.
 *
 * Diagnostics (§17, health key `flightaware`, area `flights`, on demand so never stale): every
 * call made with the stored key records its outcome; a request refused by our own cooldown or a
 * locked vault is a skipped check, an answer from the cache is no check. Flight numbers are never
 * logged.
 */
import type { Hono } from 'hono';
import { FlightStatusQuerySchema, FlightsKeyUpdateSchema, flightRefreshMs, type FlightStatus, type FlightsKeyStatus } from '@portly/shared';
import type { AppContext, AppEnv } from '../../context.ts';
import { outcomeFromError, type HealthSubject, type Outcome } from '../../lib/health.ts';
import { withLogContext } from '../../lib/log-context.ts';
import { paired } from '../../lib/routes.ts';
import { parseBody, parseQuery } from '../../lib/validate.ts';
import { VaultLockedError } from '../../security/vault.ts';
import { FlightsRateLimitError, FlightsUpstreamError, createFlightsClient, type FlightsClient } from './aeroapi.ts';
import { KEY_SECRET_ID, normalizeKey, requireKey } from './key.ts';

export { KEY_SECRET_ID } from './key.ts';

export const prefixes = ['/api/flights'] as const;

export const FLIGHTS_HEALTH: HealthSubject = { key: 'flightaware', area: 'flights', label: 'FlightAware', expectEveryMs: null };

const MEMO_PREFIX = 'flights:';

export interface FlightsModuleOptions {
  client?: FlightsClient;
  now?: () => number;
}

export function register(app: Hono<AppEnv>, ctx: AppContext, options: FlightsModuleOptions = {}): void {
  const log = ctx.log.child({ module: 'flights' });
  const now = options.now ?? Date.now;
  const client = options.client ?? createFlightsClient({ fetch: ctx.fetch, log, now });

  let keyGeneration = 0;
  const inFlight = new Map<string, Promise<FlightStatus>>();
  const forgetCachedData = () => {
    keyGeneration += 1;
    ctx.memo.delPrefix(MEMO_PREFIX);
    inFlight.clear();
    client.resetCooldown();
  };

  app.use('/api/flights/*', async (c, next) => {
    await next();
    const err = c.error;
    if (err instanceof FlightsRateLimitError) c.header('Retry-After', String(err.retryAfterSeconds));
  });

  const storedKey = (): string => {
    try {
      return requireKey(ctx.vault);
    } catch (err) {
      if (err instanceof VaultLockedError) ctx.health.touch(FLIGHTS_HEALTH, { skipped: 'vault_locked' });
      throw err;
    }
  };

  const recordFailure = (err: unknown, ms: number): void => {
    if (err instanceof FlightsRateLimitError && err.httpStatus === null) {
      ctx.health.touch(FLIGHTS_HEALTH, { skipped: 'backoff', nextAttemptAt: client.cooldownUntil() || null });
      return;
    }
    // A flight number FlightAware won't take says nothing about the connection.
    if (err instanceof FlightsUpstreamError && err.httpStatus === 400) return;
    const extra: Partial<Outcome> = { ms };
    if (err instanceof FlightsRateLimitError) extra.nextAttemptAt = client.cooldownUntil() || null;
    if (err instanceof FlightsUpstreamError && err.httpStatus < 300) extra.code = 'parse_error';
    ctx.health.record(FLIGHTS_HEALTH, outcomeFromError(err, extra));
  };

  app.get('/api/flights/key', paired(), (c) => {
    const body: FlightsKeyStatus = { configured: ctx.vault.has(KEY_SECRET_ID) };
    return c.json(body);
  });

  app.put('/api/flights/key', paired(), async (c) => {
    const { key: raw } = await parseBody(c, FlightsKeyUpdateSchema);
    const key = normalizeKey(raw);
    if (ctx.vault.state === 'locked') throw new VaultLockedError();
    client.resetCooldown();
    const started = now();
    await withLogContext({ area: 'flights', op: 'validate' }, () => client.checkKey(key));
    ctx.vault.put(KEY_SECRET_ID, key);
    forgetCachedData();
    ctx.health.record(FLIGHTS_HEALTH, { ok: true, ms: now() - started });
    log.info('flightaware key saved');
    const body: FlightsKeyStatus = { configured: true };
    return c.json(body);
  });

  app.delete('/api/flights/key', paired(), (c) => {
    ctx.vault.delete(KEY_SECRET_ID);
    forgetCachedData();
    ctx.health.forget(FLIGHTS_HEALTH.key);
    log.info('flightaware key removed');
    const body: FlightsKeyStatus = { configured: false };
    return c.json(body);
  });

  app.get('/api/flights/status', paired(), async (c) => {
    const { ident, date } = parseQuery(c, FlightStatusQuerySchema);
    const key = storedKey();
    const generation = keyGeneration;
    const cacheKey = `${MEMO_PREFIX}${generation}:${ident}:${date}`;
    const cached = ctx.memo.get<FlightStatus>(cacheKey);
    if (cached !== undefined) return c.json(cached);

    let pending = inFlight.get(cacheKey);
    if (pending === undefined) {
      pending = withLogContext({ area: 'flights', op: 'status' }, async () => {
        const started = now();
        try {
          const status = await client.status(key, ident, date);
          // Dates outside AeroAPI's range are answered without a call: no check to record.
          if (generation === keyGeneration && (status.state === 'found' || status.state === 'not_found')) {
            ctx.health.record(FLIGHTS_HEALTH, { ok: true, ms: now() - started });
          }
          if (generation === keyGeneration) ctx.memo.set(cacheKey, status, flightRefreshMs(status, now()));
          return status;
        } catch (err) {
          if (generation === keyGeneration) recordFailure(err, now() - started);
          throw err;
        }
      }).finally(() => inFlight.delete(cacheKey));
      inFlight.set(cacheKey, pending);
    }
    return c.json((await pending) satisfies FlightStatus);
  });
}
