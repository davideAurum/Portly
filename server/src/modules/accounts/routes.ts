/**
 * HTTP routes of the accounts module (§7 Accounts). All routes are non-exempt JSON routes except
 * the OAuth callback (`exempt('oauth-callback')`: a top-level navigation from the provider).
 *
 * Every route except the callback is declared `paired()`: the paired Pages site (hybrid mode) sets up
 * OAuth clients, connects accounts (OAuth start, app-password accounts) and manages them, like
 * Portly's own page. The callback lands on Portly's own page, which forwards to the Pages site.
 */
import type { Context, Hono } from 'hono';
import {
  AccountUpdateSchema,
  CaldavAccountCreateSchema,
  EntityId,
  ImapAccountCreateSchema,
  OAuthClientUpdateSchema,
  OAuthStartSchema,
  YahooAccountCreateSchema,
  type OAuthStartResponse,
} from '@portly/shared';
import type { AppEnv } from '../../context.ts';
import { exempt, paired } from '../../lib/routes.ts';
import { parseBody } from '../../lib/validate.ts';
import { prepareCaldav, prepareImap, prepareYahoo, type PreparedAccount } from './app-password.ts';
import { oauthClientInfo, saveOAuthClient } from './oauth/clients.ts';
import { callbackRedirectUrl, completeAuthorization, startAuthorization } from './oauth/flow.ts';
import { providerParam } from './oauth/providers.ts';
import { deleteAccount, saveAppPasswordAccount, testAccount, updateAccount } from './operations.ts';
import type { AccountsCore } from './service.ts';
import { accountNotFound } from './store.ts';

/** The `:id` path parameter (anything that cannot be an account id is simply not found). */
function accountIdParam(c: Context<AppEnv>): string {
  const parsed = EntityId.safeParse(c.req.param('id'));
  if (!parsed.success) throw accountNotFound();
  return parsed.data;
}

/** A callback query parameter: `undefined` when absent, `null` when repeated. */
function singleParam(params: URLSearchParams, name: string): string | null | undefined {
  const values = params.getAll(name);
  if (values.length === 0) return undefined;
  return values.length === 1 ? (values[0] as string) : null;
}

export function registerAccountsRoutes(app: Hono<AppEnv>, core: AccountsCore): void {
  const { service, log } = core;

  // --- OAuth clients -------------------------------------------------------

  app.get('/api/oauth-clients/:provider', paired(), (c) => {
    const provider = providerParam(c.req.param('provider'));
    return c.json(oauthClientInfo(core, provider));
  });

  app.put('/api/oauth-clients/:provider', paired(), async (c) => {
    const provider = providerParam(c.req.param('provider'));
    const body = await parseBody(c, OAuthClientUpdateSchema);
    saveOAuthClient({ db: core.db, vault: core.vault, now: core.now() }, provider, body);
    log.info('oauth client saved', { provider, secretUpdated: body.clientSecret !== undefined });
    return c.json(oauthClientInfo(core, provider));
  });

  // --- OAuth flow ----------------------------------------------------------

  app.post('/api/oauth/:provider/start', paired(), async (c) => {
    const provider = providerParam(c.req.param('provider'));
    const body = await parseBody(c, OAuthStartSchema);
    const response: OAuthStartResponse = { authorizeUrl: startAuthorization(core, provider, body) };
    return c.json(response);
  });

  // Reads only `code`, `state` and `error`; always a 302 to the app with a fixed result value.
  app.get('/api/oauth/:provider/callback', exempt('oauth-callback'), async (c) => {
    const params = new URL(c.req.url).searchParams;
    const outcome = await completeAuthorization(core, c.req.param('provider'), {
      code: singleParam(params, 'code'),
      state: singleParam(params, 'state'),
      error: singleParam(params, 'error'),
    });
    return new Response(null, {
      status: 302,
      headers: { Location: callbackRedirectUrl(core.config.appOrigin, outcome), 'Cache-Control': 'no-store' },
    });
  });

  // --- Accounts ------------------------------------------------------------

  app.get('/api/accounts', paired(), (c) => c.json(service.list()));

  const create = async (c: Context<AppEnv>, prepared: PreparedAccount): Promise<Response> => {
    const { created, body } = await saveAppPasswordAccount(core, prepared);
    return c.json(body, created ? 201 : 200);
  };

  app.post('/api/accounts/yahoo', paired(), async (c) => create(c, prepareYahoo(await parseBody(c, YahooAccountCreateSchema))));
  app.post('/api/accounts/caldav', paired(), async (c) =>
    create(c, await prepareCaldav(await parseBody(c, CaldavAccountCreateSchema), core.lookup)),
  );
  app.post('/api/accounts/imap', paired(), async (c) => create(c, prepareImap(await parseBody(c, ImapAccountCreateSchema))));

  app.patch('/api/accounts/:id', paired(), async (c) => {
    const id = accountIdParam(c);
    const patch = await parseBody(c, AccountUpdateSchema);
    return c.json(updateAccount(core, id, patch));
  });

  app.delete('/api/accounts/:id', paired(), (c) => {
    deleteAccount(core, accountIdParam(c));
    return c.body(null, 204);
  });

  app.post('/api/accounts/:id/test', paired(), async (c) => c.json(await testAccount(core, accountIdParam(c))));
}
