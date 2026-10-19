import type { Account, OAuthClientInfo, OAuthStartResponse } from '@portly/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryLogger } from '../../lib/logger.ts';
import { testRequest } from '../../testing/test-request.ts';
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  MICROSOFT_CLIENT_ID,
  MICROSOFT_SCOPES,
  MICROSOFT_TOKEN_ENDPOINT,
  configureClients,
  createAccountsHarness,
  deferred,
  formsSentTo,
  googleIdToken,
  microsoftIdToken,
  route,
  seedAccount,
  storedRefreshToken,
  tokenError,
  tokenOk,
  type AccountsHarness,
} from './__fixtures__/oauth.ts';
import { OAUTH_STATES_PURGE_JOB } from './index.ts';
import { pkceChallenge } from './oauth/states.ts';

const APP = 'http://localhost:5757';
const CAL = 'https://www.googleapis.com/auth/calendar.events';
const CAL_LIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const GMAIL = 'https://www.googleapis.com/auth/gmail.modify';
const ALL_GOOGLE = GOOGLE_SCOPES.join(' ');

let h: AccountsHarness;

beforeEach(() => {
  h = createAccountsHarness();
});
afterEach(async () => {
  await h.core.settle();
  h.ctx.close();
});

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function start(provider: string, body: Record<string, unknown> = {}): Promise<URL> {
  const res = await testRequest(h.app, 'POST', `/api/oauth/${provider}/start`, { body });
  expect(res.status).toBe(200);
  return new URL((await json<OAuthStartResponse>(res)).authorizeUrl);
}

/** Simulates the provider redirecting the browser back (a cross-site top-level navigation). */
function callback(provider: string, query: string): Promise<Response> {
  return testRequest(h.app, 'GET', `/api/oauth/${provider}/callback?${query}`, {
    headers: { 'X-Portly': null, 'Sec-Fetch-Site': 'cross-site' },
  });
}

function stateCount(): number {
  return h.ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM oauth_states')?.n ?? -1;
}

function accounts(): Account[] {
  return h.service.list();
}

function googleTokenRoute(fields: Record<string, unknown> = {}): void {
  h.fake.add(
    route(GOOGLE_TOKEN_ENDPOINT, () =>
      tokenOk({ access_token: 'g-at', refresh_token: 'g-rt', scope: ALL_GOOGLE, id_token: googleIdToken(h.clock.now), ...fields }),
    ),
  );
}

function microsoftTokenRoute(fields: Record<string, unknown> = {}): void {
  h.fake.add(
    route(MICROSOFT_TOKEN_ENDPOINT, () =>
      tokenOk({
        access_token: 'm-at',
        refresh_token: 'm-rt',
        scope: 'openid profile email https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read',
        id_token: microsoftIdToken(h.clock.now),
        ...fields,
      }),
    ),
  );
}

describe('OAuth clients', () => {
  it('GET reports nothing configured and the redirect URI to register (from config)', async () => {
    expect(await json(await testRequest(h.app, 'GET', '/api/oauth-clients/google'))).toEqual({
      clientId: null,
      hasSecret: false,
      redirectUri: 'http://localhost:5757/api/oauth/google/callback',
    });
    const ms = await json<OAuthClientInfo>(await testRequest(h.app, 'GET', '/api/oauth-clients/microsoft'));
    expect(ms.redirectUri).toBe('http://localhost/api/oauth/microsoft/callback');
    expect((await testRequest(h.app, 'GET', '/api/oauth-clients/yahoo')).status).toBe(404);
  });

  it('PUT google stores the secret in the vault only and never returns it', async () => {
    const missing = await testRequest(h.app, 'PUT', '/api/oauth-clients/google', { body: { clientId: GOOGLE_CLIENT_ID } });
    expect(missing.status).toBe(422);

    const res = await testRequest(h.app, 'PUT', '/api/oauth-clients/google', { body: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(GOOGLE_CLIENT_SECRET);
    expect(JSON.parse(text)).toEqual({ clientId: GOOGLE_CLIENT_ID, hasSecret: true, redirectUri: `${APP}/api/oauth/google/callback` });
    expect(h.ctx.vault.get('oauth-client:google')).toBe(GOOGLE_CLIENT_SECRET);
    expect(JSON.stringify(h.ctx.db.all('SELECT * FROM oauth_clients'))).not.toContain(GOOGLE_CLIENT_SECRET);

    // Same client id without a secret keeps the stored secret; a new client id needs a new secret.
    expect((await testRequest(h.app, 'PUT', '/api/oauth-clients/google', { body: { clientId: GOOGLE_CLIENT_ID } })).status).toBe(200);
    expect(h.ctx.vault.get('oauth-client:google')).toBe(GOOGLE_CLIENT_SECRET);
    const other = '999-other.apps.googleusercontent.com';
    expect((await testRequest(h.app, 'PUT', '/api/oauth-clients/google', { body: { clientId: other } })).status).toBe(422);
  });

  it('PUT validates client id formats and refuses a Microsoft secret (public client)', async () => {
    const bad = await testRequest(h.app, 'PUT', '/api/oauth-clients/google', { body: { clientId: 'not-a-client', clientSecret: 'x' } });
    expect(bad.status).toBe(422);
    expect((await testRequest(h.app, 'PUT', '/api/oauth-clients/microsoft', { body: { clientId: 'nope' } })).status).toBe(422);
    const secret = await testRequest(h.app, 'PUT', '/api/oauth-clients/microsoft', { body: { clientId: MICROSOFT_CLIENT_ID, clientSecret: 's' } });
    expect(secret.status).toBe(422);
    const ok = await testRequest(h.app, 'PUT', '/api/oauth-clients/microsoft', { body: { clientId: MICROSOFT_CLIENT_ID } });
    expect(await json(ok)).toEqual({ clientId: MICROSOFT_CLIENT_ID, hasSecret: false, redirectUri: 'http://localhost/api/oauth/microsoft/callback' });
    expect((await testRequest(h.app, 'PUT', '/api/oauth-clients/google', { body: { clientId: GOOGLE_CLIENT_ID, extra: 1 } })).status).toBe(422);
  });

  it('is behind the gate (no X-Portly → 403)', async () => {
    const res = await testRequest(h.app, 'GET', '/api/oauth-clients/google', { headers: { 'X-Portly': null } });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/oauth/:provider/start', () => {
  it('409 not_configured until a client is set up', async () => {
    const res = await testRequest(h.app, 'POST', '/api/oauth/google/start', { body: {} });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: { code: 'not_configured' } });
    expect((await testRequest(h.app, 'POST', '/api/oauth/github/start', { body: {} })).status).toBe(404);
  });

  it('Google: exact scopes/params, S256 challenge of the stored verifier, state row with 10 min expiry', async () => {
    configureClients(h);
    const url = await start('google');
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = Object.fromEntries(url.searchParams);
    expect(p).toEqual({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: `${APP}/api/oauth/google/callback`,
      response_type: 'code',
      scope: `openid email profile ${CAL} ${CAL_LIST} ${GMAIL}`,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge: expect.any(String),
      code_challenge_method: 'S256',
    });
    const row = h.ctx.db.get<{ provider: string; code_verifier: string; account_id: string | null; return_to: string; created_at: number; expires_at: number }>(
      'SELECT * FROM oauth_states WHERE state = ?',
      [p.state as string],
    );
    expect(row).toMatchObject({ provider: 'google', account_id: null, return_to: '#/settings/accounts', created_at: h.clock.now, expires_at: h.clock.now + 600_000 });
    expect(row?.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkceChallenge(row?.code_verifier ?? '')).toBe(p.code_challenge);
    expect(url.href).not.toContain(GOOGLE_CLIENT_SECRET);
  });

  it('Microsoft: consumers authority, exact scopes, query response mode, no secret', async () => {
    configureClients(h);
    const url = await start('microsoft', { returnTo: '#/settings/calendars' });
    expect(`${url.origin}${url.pathname}`).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: MICROSOFT_CLIENT_ID,
      response_type: 'code',
      redirect_uri: `${APP}/api/oauth/microsoft/callback`,
      response_mode: 'query',
      scope: MICROSOFT_SCOPES.join(' '),
      state: expect.any(String),
      code_challenge: expect.any(String),
      code_challenge_method: 'S256',
    });
    expect(MICROSOFT_SCOPES.join(' ')).toBe('openid profile email offline_access User.Read Calendars.ReadWrite Mail.ReadWrite');
    expect(h.ctx.db.get('SELECT return_to FROM oauth_states')).toEqual({ return_to: '#/settings/calendars' });
  });

  it('validates returnTo and the account being reconnected; refuses while the vault is locked', async () => {
    configureClients(h);
    for (const returnTo of ['https://evil.example/', '#/Settings', '//evil', '#/a?b']) {
      expect((await testRequest(h.app, 'POST', '/api/oauth/google/start', { body: { returnTo } })).status, returnTo).toBe(422);
    }
    seedAccount(h, { id: 'm1', kind: 'microsoft', refreshToken: 'rt' });
    expect((await testRequest(h.app, 'POST', '/api/oauth/google/start', { body: { accountId: 'm1' } })).status).toBe(400);
    expect((await testRequest(h.app, 'POST', '/api/oauth/google/start', { body: { accountId: 'nope' } })).status).toBe(404);
    await start('microsoft', { accountId: 'm1' });
    expect(h.ctx.db.get('SELECT account_id FROM oauth_states')).toEqual({ account_id: 'm1' });

    h.ctx.vault.setState('locked');
    const locked = await testRequest(h.app, 'POST', '/api/oauth/microsoft/start', { body: {} });
    expect(locked.status).toBe(409);
    expect(await json(locked)).toMatchObject({ error: { code: 'reauth_required' } });
  });

  it('asks only for the scopes of the services picked, and records them with the state', async () => {
    configureClients(h);
    const google = await start('google', { capabilities: ['calendar'] });
    expect(google.searchParams.get('scope')).toBe(`openid email profile ${CAL} ${CAL_LIST}`);
    expect(google.searchParams.get('include_granted_scopes')).toBe('true');
    h.clock.advance(1);
    const ms = await start('microsoft', { capabilities: ['mail'] });
    expect(ms.searchParams.get('scope')).toBe('openid profile email offline_access User.Read Mail.ReadWrite');
    expect(h.ctx.db.all('SELECT provider, capabilities FROM oauth_states ORDER BY created_at')).toEqual([
      { provider: 'google', capabilities: '["calendar"]' },
      { provider: 'microsoft', capabilities: '["mail"]' },
    ]);
    // Named in any order, the scopes keep the provider's order; no list at all asks for every service.
    expect((await start('google', { capabilities: ['mail', 'calendar'] })).searchParams.get('scope')).toBe(ALL_GOOGLE);
    expect((await start('google')).searchParams.get('scope')).toBe(ALL_GOOGLE);
  });

  it('a reconnect asks for the services the account was granted plus the ones added (incremental consent)', async () => {
    configureClients(h);
    seedAccount(h, { id: 'm1', kind: 'microsoft', capabilities: ['calendar'], refreshToken: 'rt' });
    expect((await start('microsoft', { accountId: 'm1' })).searchParams.get('scope')).toBe('openid profile email offline_access User.Read Calendars.ReadWrite');
    expect((await start('microsoft', { accountId: 'm1', capabilities: ['mail'] })).searchParams.get('scope')).toBe(MICROSOFT_SCOPES.join(' '));
    seedAccount(h, { id: 'g1', kind: 'google', capabilities: ['mail'], refreshToken: 'rt' });
    expect((await start('google', { accountId: 'g1', capabilities: ['calendar'] })).searchParams.get('scope')).toBe(ALL_GOOGLE);
  });

  it('refuses an empty or unknown list of services', async () => {
    configureClients(h);
    for (const capabilities of [[], ['contacts'], 'calendar']) {
      const res = await testRequest(h.app, 'POST', '/api/oauth/google/start', { body: { capabilities } });
      expect(res.status, JSON.stringify(capabilities)).toBe(422);
    }
    expect(stateCount()).toBe(0);
  });

  it('keeps at most 20 pending states (oldest deleted)', async () => {
    configureClients(h);
    const first = (await start('google')).searchParams.get('state');
    for (let i = 0; i < 21; i++) {
      h.clock.advance(1);
      await start('google');
    }
    expect(stateCount()).toBe(20);
    expect(h.ctx.db.get('SELECT 1 AS x FROM oauth_states WHERE state = ?', [first ?? ''])).toBeUndefined();
  });
});

describe('GET /api/oauth/:provider/callback', () => {
  beforeEach(() => configureClients(h));

  it('Google happy path: exchanges with secret + verifier, creates the account, stores only the refresh token, 302 no-store', async () => {
    googleTokenRoute();
    const url = await start('google');
    const state = url.searchParams.get('state') ?? '';
    const verifier = h.ctx.db.get<{ code_verifier: string }>('SELECT code_verifier FROM oauth_states')?.code_verifier;

    const res = await callback('google', `code=auth-code-1&state=${state}&scope=ignored`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${APP}/?oauth=connected#/settings/accounts`);
    expect(res.headers.get('cache-control')).toBe('no-store');

    expect(formsSentTo(h.fake, GOOGLE_TOKEN_ENDPOINT)).toEqual([
      {
        client_id: GOOGLE_CLIENT_ID,
        grant_type: 'authorization_code',
        code: 'auth-code-1',
        redirect_uri: `${APP}/api/oauth/google/callback`,
        code_verifier: verifier,
        client_secret: GOOGLE_CLIENT_SECRET,
      },
    ]);
    const [account] = accounts();
    expect(account).toMatchObject({
      kind: 'google',
      label: 'alice@gmail.com',
      email: 'alice@gmail.com',
      capabilities: ['calendar', 'mail'],
      enabledCapabilities: ['calendar', 'mail'],
      status: 'ok',
    });
    const row = h.ctx.db.get<{ external_id: string; granted_scopes: string }>('SELECT external_id, granted_scopes FROM accounts');
    expect(row?.external_id).toBe('google-subject-1');
    expect(JSON.parse(row?.granted_scopes ?? '[]')).toContain(GMAIL);
    expect(storedRefreshToken(h, account?.id ?? '')).toBe('g-rt');
    expect(JSON.stringify(h.ctx.db.all('SELECT * FROM accounts'))).not.toContain('g-at');
    // The exchanged access token is cached: no refresh needed for the first API call.
    expect(await h.service.getAccessToken(account?.id ?? '')).toBe('g-at');
    expect(h.fake.calls).toHaveLength(1);
    expect(stateCount()).toBe(0);
  });

  it('a state can be used once; reuse → expired without another token exchange', async () => {
    googleTokenRoute();
    const state = (await start('google')).searchParams.get('state') ?? '';
    await callback('google', `code=c1&state=${state}`);
    const again = await callback('google', `code=c1&state=${state}`);
    expect(again.headers.get('location')).toBe(`${APP}/?oauth=expired#/settings/accounts`);
    expect(h.fake.calls).toHaveLength(1);
    expect(accounts()).toHaveLength(1);
  });

  it('concurrent callbacks with the same state: exactly one token exchange', async () => {
    const gate = deferred<void>();
    h.fake.add(
      route(GOOGLE_TOKEN_ENDPOINT, async () => {
        await gate.promise;
        return tokenOk({ access_token: 'g-at', refresh_token: 'g-rt', scope: ALL_GOOGLE, id_token: googleIdToken(h.clock.now) });
      }),
    );
    const state = (await start('google')).searchParams.get('state') ?? '';
    const pending = [callback('google', `code=c1&state=${state}`), callback('google', `code=c2&state=${state}`)];
    await new Promise((r) => setTimeout(r, 10));
    gate.resolve();
    const locations = (await Promise.all(pending)).map((r) => r.headers.get('location'));
    expect(locations.sort()).toEqual([`${APP}/?oauth=connected#/settings/accounts`, `${APP}/?oauth=expired#/settings/accounts`]);
    expect(h.fake.calls).toHaveLength(1);
    expect(accounts()).toHaveLength(1);
  });

  it('accepts real-world codes: a percent-encoded "/" in the query passes the gate and is sent decoded', async () => {
    googleTokenRoute();
    const state = (await start('google')).searchParams.get('state') ?? '';
    const res = await callback('google', `state=${state}&code=4%2F0AVMBsJiR-example_code&scope=${encodeURIComponent(ALL_GOOGLE)}&authuser=0&prompt=consent`);
    expect(res.headers.get('location')).toBe(`${APP}/?oauth=connected#/settings/accounts`);
    expect(formsSentTo(h.fake, GOOGLE_TOKEN_ENDPOINT)[0]?.code).toBe('4/0AVMBsJiR-example_code');
  });

  it('an expired state → expired (no exchange)', async () => {
    const state = (await start('google', { returnTo: '#/settings/calendars' })).searchParams.get('state') ?? '';
    h.clock.advance(10 * 60 * 1000);
    const res = await callback('google', `code=c1&state=${state}`);
    expect(res.headers.get('location')).toBe(`${APP}/?oauth=expired#/settings/accounts`);
    expect(h.fake.calls).toHaveLength(0);
  });

  it('a state issued for another provider → expired and the state is not consumed', async () => {
    const state = (await start('google')).searchParams.get('state') ?? '';
    const res = await callback('microsoft', `code=c1&state=${state}`);
    expect(res.headers.get('location')).toBe(`${APP}/?oauth=expired#/settings/accounts`);
    expect(stateCount()).toBe(1);
    expect(h.fake.calls).toHaveLength(0);
  });

  it('provider errors: access_denied → denied, anything else → error; never reflects provider text', async () => {
    const s1 = (await start('google', { returnTo: '#/settings/calendars' })).searchParams.get('state') ?? '';
    const denied = await callback('google', `error=access_denied&error_description=%3Cscript%3E&state=${s1}`);
    expect(denied.headers.get('location')).toBe(`${APP}/?oauth=denied#/settings/calendars`);
    const s2 = (await start('google')).searchParams.get('state') ?? '';
    const other = await callback('google', `error=server_error&error_description=Something%20evil&state=${s2}`);
    expect(other.headers.get('location')).toBe(`${APP}/?oauth=error#/settings/accounts`);
    expect(stateCount()).toBe(0);
    expect(h.fake.calls).toHaveLength(0);
  });

  it('missing, malformed or repeated parameters → error', async () => {
    const state = (await start('google')).searchParams.get('state') ?? '';
    for (const q of ['code=c1', `code=c1&state=${state}x`, `code=c1&state=${state}&state=${state}`, 'state=%00']) {
      const res = await callback('google', q);
      expect(res.status, q).toBe(302);
      expect(res.headers.get('location'), q).toBe(`${APP}/?oauth=error#/settings/accounts`);
    }
    expect(stateCount()).toBe(1);
    const noCode = await callback('google', `state=${state}`);
    expect(noCode.headers.get('location')).toBe(`${APP}/?oauth=error#/settings/accounts`);
    expect(stateCount()).toBe(0);
    const unknownProvider = await callback('github', `code=c&state=${state}`);
    expect(unknownProvider.headers.get('location')).toBe(`${APP}/?oauth=error#/settings/accounts`);
  });

  it('a refused code exchange → error (provider text never reflected)', async () => {
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, tokenError('invalid_grant')));
    const state = (await start('google')).searchParams.get('state') ?? '';
    const res = await callback('google', `code=c1&state=${state}`);
    expect(res.headers.get('location')).toBe(`${APP}/?oauth=error#/settings/accounts`);
    expect(accounts()).toHaveLength(0);
  });

  it.each([
    ['wrong audience', { aud: 'someone-else.apps.googleusercontent.com' }],
    ['wrong issuer', { iss: 'https://evil.example' }],
    ['expired', { exp: Math.floor(Date.parse('2026-09-25T11:00:00Z') / 1000) }],
    ['missing subject', { sub: undefined }],
  ])('rejects a Google id_token with %s', async (_name, overrides) => {
    googleTokenRoute({ id_token: googleIdToken(h.clock.now, overrides) });
    const state = (await start('google')).searchParams.get('state') ?? '';
    const res = await callback('google', `code=c1&state=${state}`);
    expect(res.headers.get('location')).toBe(`${APP}/?oauth=error#/settings/accounts`);
    expect(accounts()).toHaveLength(0);
  });

  it('rejects responses without an id_token or refresh token', async () => {
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, tokenOk({ access_token: 'a', refresh_token: 'r', scope: ALL_GOOGLE }), { times: 1 }));
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, tokenOk({ access_token: 'a', scope: ALL_GOOGLE, id_token: googleIdToken(h.clock.now) })));
    for (let i = 0; i < 2; i++) {
      const state = (await start('google')).searchParams.get('state') ?? '';
      expect((await callback('google', `code=c${i}&state=${state}`)).headers.get('location')).toBe(`${APP}/?oauth=error#/settings/accounts`);
    }
    expect(accounts()).toHaveLength(0);
  });

  it('partial Google grants: capabilities follow the granted scopes; no capability scope → denied', async () => {
    googleTokenRoute({ scope: `openid email profile ${CAL}` });
    const s1 = (await start('google')).searchParams.get('state') ?? '';
    expect((await callback('google', `code=c1&state=${s1}`)).headers.get('location')).toBe(`${APP}/?oauth=connected#/settings/accounts`);
    expect(accounts()[0]).toMatchObject({ capabilities: ['calendar'], enabledCapabilities: ['calendar'] });

    const h2 = createAccountsHarness();
    configureClients(h2);
    h2.fake.add(
      route(GOOGLE_TOKEN_ENDPOINT, () =>
        tokenOk({ access_token: 'a', refresh_token: 'r', scope: 'openid email profile', id_token: googleIdToken(h2.clock.now) }),
      ),
    );
    const res = await testRequest(h2.app, 'POST', '/api/oauth/google/start', { body: {} });
    const s2 = new URL((await json<OAuthStartResponse>(res)).authorizeUrl).searchParams.get('state') ?? '';
    const denied = await testRequest(h2.app, 'GET', `/api/oauth/google/callback?code=c2&state=${s2}`, { headers: { 'X-Portly': null } });
    expect(denied.headers.get('location')).toBe(`${APP}/?oauth=denied#/settings/accounts`);
    expect(h2.service.list()).toHaveLength(0);
    expect(h2.ctx.vault.list('account:')).toEqual([]);
    h2.ctx.close();
  });

  it('Microsoft happy path: public client exchange (no secret), oid subject, rotated grant stored', async () => {
    microsoftTokenRoute();
    const state = (await start('microsoft')).searchParams.get('state') ?? '';
    const res = await callback('microsoft', `code=m-code&state=${state}`);
    expect(res.headers.get('location')).toBe(`${APP}/?oauth=connected#/settings/accounts`);
    const [form] = formsSentTo(h.fake, MICROSOFT_TOKEN_ENDPOINT);
    expect(form).toMatchObject({ client_id: MICROSOFT_CLIENT_ID, grant_type: 'authorization_code', code: 'm-code', scope: MICROSOFT_SCOPES.join(' ') });
    expect(form).not.toHaveProperty('client_secret');
    expect(accounts()[0]).toMatchObject({ kind: 'microsoft', email: 'bob@outlook.com', capabilities: ['calendar', 'mail'] });
    expect(h.ctx.db.get('SELECT external_id FROM accounts')).toEqual({ external_id: '00000000-0000-0000-aaaa-bbbbccccdddd' });
    expect(storedRefreshToken(h, accounts()[0]?.id ?? '')).toBe('m-rt');
  });

  it.each([
    ['a work/school tenant', { tid: '72f988bf-86f1-41af-91ab-2d7cd011db47' }],
    ['no tenant', { tid: undefined }],
    ['a wrong issuer', { iss: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0' }],
    ['a wrong audience', { aud: '11111111-2222-3333-4444-555555555555' }],
    ['no oid', { oid: undefined }],
  ])('rejects a Microsoft id_token from %s', async (_name, overrides) => {
    microsoftTokenRoute({ id_token: microsoftIdToken(h.clock.now, overrides) });
    const state = (await start('microsoft')).searchParams.get('state') ?? '';
    const res = await callback('microsoft', `code=c1&state=${state}`);
    expect(res.headers.get('location')).toBe(`${APP}/?oauth=error#/settings/accounts`);
    expect(accounts()).toHaveLength(0);
  });

  it('reconnecting the same subject updates the account (status reset, new grant, enabled capabilities kept)', async () => {
    seedAccount(h, { id: 'g1', kind: 'google', externalId: 'google-subject-1', capabilities: ['calendar'], refreshToken: 'old-rt', label: 'Personal' });
    h.service.setStatus('g1', 'reauth', 'Reconnect');
    h.ctx.db.run(`UPDATE accounts SET enabled_capabilities = '[]' WHERE id = 'g1'`);
    googleTokenRoute();
    const url = await start('google', { accountId: 'g1', capabilities: ['mail'] });
    expect(url.searchParams.get('scope')).toBe(ALL_GOOGLE);
    const res = await callback('google', `code=c1&state=${url.searchParams.get('state') ?? ''}`);
    expect(res.headers.get('location')).toBe(`${APP}/?oauth=reconnected#/settings/accounts`);
    expect(accounts()).toHaveLength(1);
    // calendar stays disabled (user choice); mail is newly granted and was asked for → enabled.
    expect(h.service.get('g1')).toMatchObject({ label: 'Personal', status: 'ok', statusMessage: null, capabilities: ['calendar', 'mail'], enabledCapabilities: ['mail'] });
    expect(storedRefreshToken(h, 'g1')).toBe('g-rt');
    expect(await h.service.getAccessToken('g1')).toBe('g-at');
  });

  it('redeems the code with the requested scopes; services granted earlier but not asked for start switched off', async () => {
    // Microsoft returns every scope the user has ever consented to for this app.
    microsoftTokenRoute();
    const state = (await start('microsoft', { capabilities: ['calendar'] })).searchParams.get('state') ?? '';
    expect((await callback('microsoft', `code=c1&state=${state}`)).headers.get('location')).toBe(`${APP}/?oauth=connected#/settings/accounts`);
    expect(formsSentTo(h.fake, MICROSOFT_TOKEN_ENDPOINT)[0]?.scope).toBe('openid profile email offline_access User.Read Calendars.ReadWrite');
    expect(accounts()[0]).toMatchObject({ capabilities: ['calendar', 'mail'], enabledCapabilities: ['calendar'] });
  });

  it('Microsoft without a scope in the token response: the requested services are granted', async () => {
    microsoftTokenRoute({ scope: undefined });
    const state = (await start('microsoft', { capabilities: ['calendar'] })).searchParams.get('state') ?? '';
    await callback('microsoft', `code=c1&state=${state}`);
    expect(accounts()[0]).toMatchObject({ capabilities: ['calendar'], enabledCapabilities: ['calendar'] });
  });

  it('a grant that covers none of the requested services → denied, nothing stored', async () => {
    googleTokenRoute({ scope: `openid email profile ${CAL}` });
    const state = (await start('google', { capabilities: ['mail'] })).searchParams.get('state') ?? '';
    expect((await callback('google', `code=c1&state=${state}`)).headers.get('location')).toBe(`${APP}/?oauth=denied#/settings/accounts`);
    expect(accounts()).toHaveLength(0);
    expect(h.ctx.vault.list('account:')).toEqual([]);
  });

  it('a plain reconnect leaves a service granted elsewhere listed but switched off', async () => {
    seedAccount(h, { id: 'm1', kind: 'microsoft', externalId: '00000000-0000-0000-aaaa-bbbbccccdddd', capabilities: ['calendar'], refreshToken: 'old' });
    microsoftTokenRoute();
    const state = (await start('microsoft', { accountId: 'm1' })).searchParams.get('state') ?? '';
    expect((await callback('microsoft', `code=c1&state=${state}`)).headers.get('location')).toBe(`${APP}/?oauth=reconnected#/settings/accounts`);
    expect(h.service.get('m1')).toMatchObject({ capabilities: ['calendar', 'mail'], enabledCapabilities: ['calendar'] });
  });

  it('a pending sign-in stored before services were recorded asks for every service', async () => {
    microsoftTokenRoute();
    const state = (await start('microsoft', { capabilities: ['calendar'] })).searchParams.get('state') ?? '';
    h.ctx.db.run('UPDATE oauth_states SET capabilities = NULL');
    await callback('microsoft', `code=c1&state=${state}`);
    expect(formsSentTo(h.fake, MICROSOFT_TOKEN_ENDPOINT)[0]?.scope).toBe(MICROSOFT_SCOPES.join(' '));
    expect(accounts()[0]).toMatchObject({ capabilities: ['calendar', 'mail'], enabledCapabilities: ['calendar', 'mail'] });
  });

  it('reconnecting with a different subject creates a new account and never touches the original', async () => {
    seedAccount(h, { id: 'g1', kind: 'google', externalId: 'someone-else', refreshToken: 'original-rt', label: 'Work' });
    h.service.setStatus('g1', 'reauth', 'Reconnect');
    googleTokenRoute();
    const state = (await start('google', { accountId: 'g1' })).searchParams.get('state') ?? '';
    const res = await callback('google', `code=c1&state=${state}`);
    expect(res.headers.get('location')).toBe(`${APP}/?oauth=different_account#/settings/accounts`);
    expect(accounts()).toHaveLength(2);
    expect(h.service.get('g1')).toMatchObject({ label: 'Work', status: 'reauth' });
    expect(storedRefreshToken(h, 'g1')).toBe('original-rt');
    const created = accounts().find((a) => a.id !== 'g1');
    expect(created).toMatchObject({ email: 'alice@gmail.com', status: 'ok' });
  });

  it('connecting an already-connected subject updates that account (reconnected), never duplicates it', async () => {
    googleTokenRoute();
    for (let i = 0; i < 2; i++) {
      const state = (await start('google')).searchParams.get('state') ?? '';
      const res = await callback('google', `code=c${i}&state=${state}`);
      expect(res.headers.get('location')).toBe(`${APP}/?oauth=${i === 0 ? 'connected' : 'reconnected'}#/settings/accounts`);
    }
    expect(accounts()).toHaveLength(1);
  });

  it('emits created/updated change events', async () => {
    const events: string[] = [];
    h.service.onChange((e) => events.push(e.type));
    googleTokenRoute();
    for (let i = 0; i < 2; i++) {
      const state = (await start('google')).searchParams.get('state') ?? '';
      await callback('google', `code=c${i}&state=${state}`);
    }
    expect(events).toEqual(['created', 'updated']);
  });

  it('never logs tokens, codes, verifiers or the client secret', async () => {
    const log = createMemoryLogger();
    h.ctx.close();
    h = createAccountsHarness({ log });
    configureClients(h);
    googleTokenRoute();
    const state = (await start('google')).searchParams.get('state') ?? '';
    const verifier = h.ctx.db.get<{ code_verifier: string }>('SELECT code_verifier FROM oauth_states')?.code_verifier ?? '';
    await callback('google', `code=secret-code-123&state=${state}`);
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, tokenError('invalid_grant')));
    const id = accounts()[0]?.id ?? '';
    await h.core.refreshNow(id).catch(() => {});
    const text = JSON.stringify(log.lines);
    for (const secret of ['secret-code-123', 'g-at', 'g-rt', verifier, GOOGLE_CLIENT_SECRET, state, '<script>']) {
      expect(text).not.toContain(secret);
    }
    expect(log.lines.some((l) => l.message === 'oauth account connected')).toBe(true);
  });
});

describe('oauth_states purge job', () => {
  it('is scheduled hourly and deletes expired states only', async () => {
    configureClients(h);
    await start('google');
    h.clock.advance(11 * 60 * 1000);
    await start('google');
    // createOAuthState itself trims expired rows; insert an expired one behind its back.
    h.ctx.db.run(
      `INSERT INTO oauth_states (state, provider, code_verifier, account_id, return_to, created_at, expires_at)
       VALUES ('stale', 'google', 'v', NULL, '#/settings/accounts', 0, 1)`,
    );
    const job = h.ctx.scheduler.jobs().find((j) => j.name === OAUTH_STATES_PURGE_JOB);
    expect(job?.intervalMs).toBe(60 * 60 * 1000);
    await h.ctx.scheduler.runAll();
    expect(stateCount()).toBe(1);
  });
});
