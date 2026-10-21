/**
 * Pairing module (hybrid mode, shared/src/pairing.ts): pairs browsers on the configured Pages site
 * (`PORTLY_PAGES_URL`) with this server, and lets either side remove a pairing.
 *
 * Routes and responses (every one `samePc()`: Portly's own page and the paired Pages site, both
 * on this PC; another PC has no pairing token and no say over pairings):
 * - `GET /api/pairing` → `PairingStatusResponse` for the token the request presents
 *   (`X-Portly-Token`; none → 409 `not_configured`, unknown → 401 `pairing_required`)
 * - `DELETE /api/pairing` → 204 (the presenting browser unpairs itself)
 * - `GET /api/pairings` → `PairingsResponse`
 * - `POST /api/pairings {nonce}` → 201 `{redirectUrl}` (own page only; 409 `not_configured` without
 *   a Pages URL). The redirect goes to the configured Pages URL with the new token, the nonce and
 *   the instance id in the fragment; it is built from config only, never from request headers.
 * - `DELETE /api/pairings/:id` → 204, or 404
 *
 * The gate (security/gate.ts) has already checked a Pages request's token against its origin; the
 * handlers here look the token up again so the server's own page gets the same answers.
 *
 * Logs `info 'pairing created' {pairingId, label}` and `info 'pairing removed' {pairingId, by}`
 * (`by`: `revoked` here, `unpaired-itself` by the browser); the store keeps the same reason as the
 * removed token's tombstone, so the gate can say why that browser is refused later.
 */
import type { Context, Hono } from 'hono';
import {
  PAIRING_TOKEN_HEADER,
  PairingCreateSchema,
  buildPairingReturnUrl,
  type PairingCreateResponse,
  type PairingStatusResponse,
  type PairingSummary,
  type PairingsResponse,
} from '@portly/shared';
import type { AppContext, AppEnv } from '../../context.ts';
import { msToIso, msToIsoStrict } from '../../db/helpers.ts';
import { HttpError } from '../../lib/errors.ts';
import { samePc } from '../../lib/routes.ts';
import { userAgentSummary } from '../../lib/user-agent.ts';
import { parseBody } from '../../lib/validate.ts';
import type { PairingRecord } from '../../security/pairing.ts';

export const prefixes = ['/api/pairing', '/api/pairings'] as const;

/** "<Browser> on <OS>" from a User-Agent header, for the list of paired browsers. */
export const pairingLabel = userAgentSummary;

export function register(app: Hono<AppEnv>, ctx: AppContext): void {
  const log = ctx.log.child({ module: 'pairing' });
  const { config, pairing } = ctx;

  /** The presenting token, or 409 when the request has none. */
  const presentedToken = (c: Context<AppEnv>): string => {
    const token = c.req.header(PAIRING_TOKEN_HEADER);
    if (token === undefined) throw HttpError.of('not_configured', 'This request carries no pairing token');
    return token;
  };

  const summary = (record: PairingRecord): PairingSummary => ({
    id: record.id,
    label: record.label,
    origin: record.origin,
    createdAt: msToIsoStrict(record.createdAt),
    lastUsedAt: msToIso(record.lastUsedAt),
    current: record.origin === config.pagesOrigin,
  });

  // ---- the presenting browser (Pages site) ---------------------------------

  app.get('/api/pairing', samePc(), (c) => {
    const record = pairing.verify(presentedToken(c));
    if (!record) throw HttpError.of('pairing_required');
    const body: PairingStatusResponse = {
      paired: true,
      pairingId: record.id,
      instanceId: pairing.instanceId(),
      label: record.label,
      createdAt: msToIsoStrict(record.createdAt),
    };
    return c.json(body);
  });

  app.delete('/api/pairing', samePc(), (c) => {
    const token = presentedToken(c);
    const record = pairing.verify(token);
    if (!record || !pairing.revokeByToken(token, 'unpaired-itself')) throw HttpError.of('pairing_required');
    log.info('pairing removed', { pairingId: record.id, by: 'unpaired-itself' });
    return c.body(null, 204);
  });

  // ---- managing paired browsers ---------------------------------------------
  // Listing and revoking are open to the paired Pages site too (never to another PC); approving a
  // new pairing (POST) stays with Portly's own page, where the trust starts.

  app.get('/api/pairings', samePc(), (c) => {
    const body: PairingsResponse = {
      pagesUrl: config.pagesUrl,
      instanceId: pairing.instanceId(),
      pairings: pairing.list().map(summary),
    };
    return c.json(body);
  });

  app.post('/api/pairings', async (c) => {
    const { pagesUrl, pagesOrigin } = config;
    if (pagesUrl === null || pagesOrigin === null) {
      throw HttpError.of('not_configured', 'Set PORTLY_PAGES_URL to the Pages site address first');
    }
    const { nonce } = await parseBody(c, PairingCreateSchema);
    const { token, record } = pairing.create({ label: pairingLabel(c.req.header('user-agent')), origin: pagesOrigin });
    log.info('pairing created', { pairingId: record.id, label: record.label });
    const body: PairingCreateResponse = {
      redirectUrl: buildPairingReturnUrl(pagesUrl, { token, nonce, instanceId: pairing.instanceId() }),
    };
    return c.json(body, 201);
  });

  app.delete('/api/pairings/:id', samePc(), (c) => {
    const id = c.req.param('id');
    if (!pairing.revoke(id, 'revoked')) throw new HttpError(404, 'not_found', 'Pairing not found');
    log.info('pairing removed', { pairingId: id, by: 'revoked' });
    return c.body(null, 204);
  });
}
