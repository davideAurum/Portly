/**
 * Static backend: Outlook.com accounts with the browser as the OAuth client. Port of the
 * Microsoft parts of server/src/modules/accounts (oauth.test.ts, service.test.ts,
 * accounts.test.ts): client setup, the PKCE round trip through the site's own address,
 * reconnects, token refresh with rotation and failure statuses, connection test, rename/toggle/
 * delete — plus the browser twists: the 24-hour single-page-app session and the automatic
 * `prompt=none` re-sign-in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, OAuthClientInfo } from '@homebase/shared';
import { finishSignIn, planAutomaticSignIn } from '../oauthRedirect.ts';
import { createFakeFetch, type FakeFetch, type FakeFetchRoute } from '../providers/__fixtures__/fakeFetch.ts';
import { MICROSOFT_CLIENT_ID, OTHER_SUBJECT, formOf, microsoftIdToken, tokenError, tokenOk } from '../providers/__fixtures__/microsoft.ts';
import { MICROSOFT_TOKEN_ENDPOINT, SPA_SESSION_MS, pkceChallenge } from '../providers/microsoftAuth.ts';
import { SLICE, getAccountTokens, getAccounts, getOAuthStates } from '../slices.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import * as accounts from './accounts.ts';
import { MESSAGES, SILENT_RENEW_BEFORE_MS, SILENT_RETRY_MS, STATE_TTL_MS, getAccessToken } from './accounts.ts';

type ErrorBody = { error: { code: string; message: string; details?: { path: string; message: string }[]; accountId?: string } };

const APP_URL = 'http://localhost:5173/';
const T0 = 1_700_000_000_000;

let t: TestBackend;
let fake: FakeFetch;

afterEach(() => {
  vi.unstubAllGlobals();
  t?.close();
});

async function setup(routes: FakeFetchRoute[] = [], options: { client?: boolean } = {}) {
  fake = createFakeFetch(routes);
  vi.stubGlobal('fetch', fake.fetch);
  t = await createTestBackend([accounts], { appUrl: APP_URL, startAt: T0 });
  if (options.client ?? true) expect((await t.json('PUT', '/api/oauth-clients/microsoft', { clientId: MICROSOFT_CLIENT_ID })).status).toBe(200);
  return t;
}

function tokenRoute(respond: FakeFetchRoute['respond'], times?: number): FakeFetchRoute {
  return { match: MICROSOFT_TOKEN_ENDPOINT, method: 'POST', respond, ...(times === undefined ? {} : { times }) };
}

/** Starts a sign-in through the API and returns Microsoft's URL. */
async function start(body: Record<string, unknown> = { returnTo: '#/settings/accounts' }): Promise<URL> {
  const res = await t.json<{ authorizeUrl: string }>('POST', '/api/oauth/microsoft/start', body);
  expect(res.status).toBe(200);
  return new URL(res.body.authorizeUrl);
}

/** The page address Microsoft sends the browser back to. */
function callback(state: string, extra: Record<string, string> = { code: 'auth-code' }): string {
  const url = new URL(APP_URL);
  for (const [key, value] of Object.entries({ ...extra, state })) url.searchParams.set(key, value);
  return url.href;
}

/** A full interactive sign-in answered by `respond` at the token endpoint; returns the page address afterwards. */
async function signIn(respond: FakeFetchRoute['respond'], body?: Record<string, unknown>): Promise<string | null> {
  fake.add(tokenRoute(respond, 1));
  const url = await start(body);
  return finishSignIn(t.ctx, callback(url.searchParams.get('state')!));
}

const grant = (overrides: Record<string, unknown> = {}, claims: Record<string, unknown> = {}) =>
  tokenOk({ access_token: 'AT1', refresh_token: 'RT1', scope: 'openid profile email offline_access User.Read Calendars.ReadWrite', id_token: microsoftIdToken(T0, claims), ...overrides });

async function list(): Promise<Account[]> {
  return (await t.json<Account[]>('GET', '/api/accounts')).body;
}

describe('accounts: OAuth client', () => {
  it('reports this site as the redirect URI and stores a GUID client id (never a secret)', async () => {
    await setup([], { client: false });
    expect((await t.json<OAuthClientInfo>('GET', '/api/oauth-clients/microsoft')).body).toEqual({ clientId: null, hasSecret: false, redirectUri: APP_URL });

    const notGuid = await t.json<ErrorBody>('PUT', '/api/oauth-clients/microsoft', { clientId: 'not-a-guid' });
    expect(notGuid.status).toBe(422);
    expect(notGuid.body.error.details).toEqual([{ path: 'clientId', message: 'Microsoft application (client) IDs are GUIDs', code: 'custom' }]);
    const secret = await t.json<ErrorBody>('PUT', '/api/oauth-clients/microsoft', { clientId: MICROSOFT_CLIENT_ID, clientSecret: 's' });
    expect(secret.status).toBe(422);
    expect(secret.body.error.details?.[0]?.path).toBe('clientSecret');

    const saved = await t.json<OAuthClientInfo>('PUT', '/api/oauth-clients/microsoft', { clientId: MICROSOFT_CLIENT_ID });
    expect(saved.body).toEqual({ clientId: MICROSOFT_CLIENT_ID, hasSecret: false, redirectUri: APP_URL });
  });

  it('answers Google with "not in this build" and unknown providers with 404', async () => {
    await setup([], { client: false });
    const google = await t.json<ErrorBody>('GET', '/api/oauth-clients/google');
    expect(google.status).toBe(409);
    expect(google.body.error).toEqual({ code: 'not_configured', message: 'Google accounts are not available in the browser-only build.' });
    expect((await t.json('POST', '/api/oauth/google/start', {})).status).toBe(409);
    expect((await t.json('GET', '/api/oauth-clients/yahoo')).status).toBe(404);
  });

  it('refuses to start a sign-in before the client is set up', async () => {
    await setup([], { client: false });
    const res = await t.json<ErrorBody>('POST', '/api/oauth/microsoft/start', {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_configured');
  });
});

describe('accounts: sign-in', () => {
  it('connects an account: PKCE round trip through the site address, tokens stored, ?oauth=connected', async () => {
    await setup();
    fake.add(tokenRoute(grant({ refresh_token_expires_in: 86_000 }), 1));
    const url = await start();
    const state = url.searchParams.get('state')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('redirect_uri')).toBe(APP_URL);
    expect(url.searchParams.has('prompt')).toBe(false);
    expect(getOAuthStates(t.ctx)).toHaveLength(1);

    const after = await finishSignIn(t.ctx, callback(state));
    expect(after).toBe('http://localhost:5173/?oauth=connected#/settings/accounts');

    // The exchange: public client (no secret), the stored verifier, this site as redirect URI.
    const form = formOf(fake.calls[0]!);
    expect(form).toMatchObject({ client_id: MICROSOFT_CLIENT_ID, grant_type: 'authorization_code', code: 'auth-code', redirect_uri: APP_URL });
    expect(form.client_secret).toBeUndefined();
    expect(form.scope).not.toContain('Mail');
    expect(await pkceChallenge(form.code_verifier!)).toBe(url.searchParams.get('code_challenge'));

    const [account] = await list();
    expect(account).toMatchObject({
      kind: 'microsoft',
      label: 'bob@outlook.com',
      email: 'bob@outlook.com',
      capabilities: ['calendar'],
      enabledCapabilities: ['calendar'],
      status: 'ok',
      statusMessage: null,
      sort: 0,
    });
    expect(getAccountTokens(t.ctx)[account!.id]).toEqual({
      refreshToken: 'RT1',
      accessToken: 'AT1',
      accessRefreshAt: T0 + 3599 * 1000 - 5 * 60 * 1000,
      sessionExpiresAt: T0 + 86_000 * 1000,
      silentAttemptAt: null,
    });
    // Tokens are never part of an API answer.
    expect(JSON.stringify(await list())).not.toContain('RT1');
    expect(getOAuthStates(t.ctx)).toEqual([]);
  });

  it('assumes the 24-hour single-page-app session when Microsoft does not say', async () => {
    await setup();
    await signIn(grant());
    expect(Object.values(getAccountTokens(t.ctx))[0]!.sessionExpiresAt).toBe(T0 + SPA_SESSION_MS);
  });

  it('uses a state once, expires it after 10 minutes and ignores malformed ones', async () => {
    await setup([tokenRoute(grant(), 1)]);
    const state = (await start()).searchParams.get('state')!;
    expect(await finishSignIn(t.ctx, callback(state))).toContain('oauth=connected');
    expect(await finishSignIn(t.ctx, callback(state))).toBe('http://localhost:5173/?oauth=expired#/settings/accounts');

    const late = (await start()).searchParams.get('state')!;
    t.tick(STATE_TTL_MS + 1);
    expect(await finishSignIn(t.ctx, callback(late))).toContain('oauth=expired');
    expect(await finishSignIn(t.ctx, callback('short'))).toBe('http://localhost:5173/?oauth=error#/settings/accounts');
    expect(fake.calls).toHaveLength(1);
  });

  it('is not a sign-in answer without state and code/error', async () => {
    await setup();
    expect(await finishSignIn(t.ctx, 'http://localhost:5173/#/settings')).toBeNull();
    expect(await finishSignIn(t.ctx, 'http://localhost:5173/?code=x')).toBeNull();
  });

  it('reports a refusal as denied, other errors as error, and never calls the token endpoint for them', async () => {
    await setup();
    const denied = (await start()).searchParams.get('state')!;
    expect(await finishSignIn(t.ctx, callback(denied, { error: 'access_denied', error_description: '<b>nope</b>' }))).toContain('oauth=denied');
    const failed = (await start()).searchParams.get('state')!;
    expect(await finishSignIn(t.ctx, callback(failed, { error: 'server_error' }))).toContain('oauth=error');
    expect(fake.calls).toHaveLength(0);
    expect(await list()).toEqual([]);
  });

  it.each([
    ['an id_token from a work account', grant({}, { tid: '72f988bf-86f1-41af-91ab-2d7cd011db47' }), 'error'],
    ['no id_token', grant({ id_token: undefined }), 'error'],
    ['no refresh token', grant({ refresh_token: undefined }), 'error'],
    ['no calendar scope', grant({ scope: 'openid User.Read' }), 'denied'],
    ['a refused code', tokenError('invalid_grant'), 'error'],
  ] as const)('stores nothing for %s', async (_what, respond, result) => {
    await setup();
    expect(await signIn(respond)).toContain(`oauth=${result}`);
    expect(await list()).toEqual([]);
    expect(getAccountTokens(t.ctx)).toEqual({});
  });

  it('reconnects the same account in place and keeps a switched-off capability off', async () => {
    await setup();
    await signIn(grant());
    const [account] = await list();
    await t.json('PATCH', `/api/accounts/${account!.id}`, { enabledCapabilities: [], label: 'Mine' });

    fake.add(tokenRoute(grant({ access_token: 'AT2', refresh_token: 'RT2' }), 1));
    const url = await start({ accountId: account!.id, returnTo: '#/settings/accounts' });
    expect(await finishSignIn(t.ctx, callback(url.searchParams.get('state')!))).toContain('oauth=reconnected');
    const after = await list();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: account!.id, label: 'Mine', enabledCapabilities: [], status: 'ok' });
    expect(getAccountTokens(t.ctx)[account!.id]!.refreshToken).toBe('RT2');
  });

  it('adds a different person as a new account when reconnecting with another sign-in', async () => {
    await setup();
    await signIn(grant());
    const [first] = await list();
    fake.add(tokenRoute(grant({ refresh_token: 'RT-other' }, { oid: OTHER_SUBJECT, preferred_username: 'eve@outlook.com' }), 1));
    const url = await start({ accountId: first!.id });
    expect(await finishSignIn(t.ctx, callback(url.searchParams.get('state')!))).toContain('oauth=different_account');
    expect((await list()).map((a) => [a.email, a.sort])).toEqual([
      ['bob@outlook.com', 0],
      ['eve@outlook.com', 1],
    ]);
    expect(getAccountTokens(t.ctx)[first!.id]!.refreshToken).toBe('RT1');
  });

  it('returns to the route the sign-in started from, falling back to Accounts', async () => {
    await setup();
    expect(await signIn(grant(), { returnTo: '#/settings/calendars' })).toBe('http://localhost:5173/?oauth=connected#/settings/calendars');
    const res = await t.json<ErrorBody>('POST', '/api/oauth/microsoft/start', { returnTo: 'https://evil.example/' });
    expect(res.status).toBe(422);
  });
});

describe('accounts: access tokens', () => {
  async function connected(): Promise<string> {
    await setup();
    await signIn(grant());
    return (await list())[0]!.id;
  }

  it('serves the stored access token while it is fresh', async () => {
    const id = await connected();
    expect(await getAccessToken(t.ctx, id)).toBe('AT1');
    expect(fake.calls).toHaveLength(1);
  });

  it('refreshes near expiry, stores the rotated refresh token, and runs one refresh for concurrent callers', async () => {
    const id = await connected();
    fake.add(tokenRoute(tokenOk({ access_token: 'AT2', refresh_token: 'RT2' }), 1));
    t.tick(3599 * 1000 - 60_000);
    const [a, b] = await Promise.all([getAccessToken(t.ctx, id), getAccessToken(t.ctx, id)]);
    expect([a, b]).toEqual(['AT2', 'AT2']);
    const refreshes = fake.calls.slice(1).map(formOf);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'RT1', client_id: MICROSOFT_CLIENT_ID });
    expect(getAccountTokens(t.ctx)[id]).toMatchObject({ refreshToken: 'RT2', accessToken: 'AT2' });
    // Persisted, not only in memory.
    expect(await t.storage.getJson(`slice:${SLICE.accountTokens}`)).toMatchObject({ [id]: { refreshToken: 'RT2' } });
  });

  it('picks up another tab\'s refresh instead of spending the rotated-away refresh token', async () => {
    const id = await connected();
    const other = await createTestBackend([accounts], { appUrl: APP_URL, startAt: T0, storage: t.storage });
    try {
      // Both tabs loaded RT1; this one refreshes first and rotates it to RT2.
      t.tick(3600 * 1000);
      other.tick(3600 * 1000);
      fake.add(tokenRoute(tokenOk({ access_token: 'AT2', refresh_token: 'RT2' }), 1));
      expect(await getAccessToken(t.ctx, id)).toBe('AT2');
      // The other tab still has RT1 in memory, but re-reads storage under the lock.
      expect(getAccountTokens(other.ctx)[id]!.refreshToken).toBe('RT1');
      expect(await getAccessToken(other.ctx, id)).toBe('AT2');
      expect(fake.calls.slice(1).map((c) => formOf(c).refresh_token)).toEqual(['RT1']);
    } finally {
      other.close();
    }
  });

  it('refreshes again when Graph refused the stored token', async () => {
    const id = await connected();
    fake.add(tokenRoute(tokenOk({ access_token: 'AT2' }), 1));
    expect(await getAccessToken(t.ctx, id, { rejected: 'AT1' })).toBe('AT2');
    expect(getAccountTokens(t.ctx)[id]!.refreshToken).toBe('RT1');
  });

  it('needs reauth when the grant is dead, and says so when the 24-hour sign-in ran out', async () => {
    const id = await connected();
    fake.add(tokenRoute(tokenError('invalid_grant'), 1));
    t.tick(SPA_SESSION_MS + 1);
    await expect(getAccessToken(t.ctx, id)).rejects.toMatchObject({ code: 'reauth_required', message: MESSAGES.sessionEnded, accountId: id });
    expect((await list())[0]).toMatchObject({ status: 'reauth', statusMessage: MESSAGES.sessionEnded });
    // No further refresh attempts while it needs reauth.
    await expect(getAccessToken(t.ctx, id)).rejects.toMatchObject({ code: 'reauth_required' });
    expect(fake.calls).toHaveLength(2);
  });

  it('marks transient failures as errors without hiding a reauth', async () => {
    const id = await connected();
    t.tick(3600 * 1000);
    fake.add(tokenRoute({ status: 503, text: 'down' }, 1));
    await expect(getAccessToken(t.ctx, id)).rejects.toMatchObject({ code: 'provider_error' });
    expect((await list())[0]).toMatchObject({ status: 'error', statusMessage: 'Microsoft could not refresh access right now' });

    fake.add(tokenRoute(tokenOk({ access_token: 'AT3' }), 1));
    expect(await getAccessToken(t.ctx, id)).toBe('AT3');
    expect((await list())[0]).toMatchObject({ status: 'ok', statusMessage: null });
  });

  it('runs the connection test as a forced refresh and reports per capability', async () => {
    const id = await connected();
    fake.add(tokenRoute(tokenOk({ access_token: 'AT2' }), 1));
    expect((await t.json('POST', `/api/accounts/${id}/test`)).body).toEqual({ results: { calendar: { ok: true } } });
    fake.add(tokenRoute(tokenError('invalid_grant'), 1));
    expect((await t.json('POST', `/api/accounts/${id}/test`)).body).toEqual({
      results: { calendar: { ok: false, code: 'reauth_required', message: MESSAGES.grantExpired } },
    });
    expect((await t.json('POST', '/api/accounts/nope/test')).status).toBe(404);
  });
});

describe('accounts: automatic re-sign-in', () => {
  async function connected(): Promise<string> {
    await setup();
    await signIn(grant());
    return (await list())[0]!.id;
  }

  it('does nothing while the sign-in has hours left', async () => {
    await connected();
    t.tick(SPA_SESSION_MS - SILENT_RENEW_BEFORE_MS - 60_000);
    expect(await planAutomaticSignIn(t.ctx, 'http://localhost:5173/#/')).toBeNull();
  });

  it('renews quietly shortly before the sign-in ends, at most once per account in a while', async () => {
    const id = await connected();
    t.tick(SPA_SESSION_MS - SILENT_RENEW_BEFORE_MS + 60_000);
    const plan = await planAutomaticSignIn(t.ctx, 'http://localhost:5173/#/settings');
    const url = new URL(plan!);
    expect(url.searchParams.get('prompt')).toBe('none');
    expect(url.searchParams.get('login_hint')).toBe('bob@outlook.com');
    expect(getAccountTokens(t.ctx)[id]!.silentAttemptAt).toBe(t.ctx.now());
    // No loop: the next page load does not try again for a while.
    expect(await planAutomaticSignIn(t.ctx, 'http://localhost:5173/#/')).toBeNull();

    // Microsoft answers with a code: renewed without a message, back on the same route.
    fake.add(tokenRoute(grant({ access_token: 'AT9', refresh_token: 'RT9' }, { exp: Math.floor(t.ctx.now() / 1000) + 3600 }), 1));
    expect(await finishSignIn(t.ctx, callback(url.searchParams.get('state')!))).toBe('http://localhost:5173/#/settings');
    expect(getAccountTokens(t.ctx)[id]).toMatchObject({ refreshToken: 'RT9', silentAttemptAt: null, sessionExpiresAt: t.ctx.now() + SPA_SESSION_MS });
  });

  it('stays quiet when Microsoft needs a click, and leaves "Reconnect needed" to the user', async () => {
    const id = await connected();
    getAccounts(t.ctx)[0]!.status = 'reauth';
    await t.ctx.state.commit(SLICE.accounts);
    const url = new URL((await planAutomaticSignIn(t.ctx, 'http://localhost:5173/#/'))!);
    expect(await finishSignIn(t.ctx, callback(url.searchParams.get('state')!, { error: 'login_required' }))).toBe('http://localhost:5173/#/');
    expect((await list())[0]!.status).toBe('reauth');
    t.tick(SILENT_RETRY_MS - 1);
    expect(await planAutomaticSignIn(t.ctx, 'http://localhost:5173/#/')).toBeNull();
    t.tick(2);
    expect(await planAutomaticSignIn(t.ctx, 'http://localhost:5173/#/')).not.toBeNull();
    expect(id).toBeTruthy();
  });

  it('never plans one right after a sign-in or without a client', async () => {
    await connected();
    t.tick(SPA_SESSION_MS);
    expect(await planAutomaticSignIn(t.ctx, 'http://localhost:5173/?oauth=connected#/')).toBeNull();
    await t.ctx.state.set(SLICE.oauthClients, { microsoft: null });
    expect(await planAutomaticSignIn(t.ctx, 'http://localhost:5173/#/')).toBeNull();
  });
});

describe('accounts: list, update, delete', () => {
  it('renames, recolors, toggles and reorders; refuses capabilities the account does not have', async () => {
    await setup();
    await signIn(grant());
    const id = (await list())[0]!.id;
    const res = await t.json<Account>('PATCH', `/api/accounts/${id}`, { label: 'Outlook', color: '#AABBCC', enabledCapabilities: [], sort: 5 });
    expect(res.body).toMatchObject({ label: 'Outlook', color: '#aabbcc', enabledCapabilities: [], sort: 5 });
    const mail = await t.json<ErrorBody>('PATCH', `/api/accounts/${id}`, { enabledCapabilities: ['mail'] });
    expect(mail.status).toBe(422);
    expect(mail.body.error.details?.[0]?.message).toBe('Mail is not available for this account');
    expect((await t.json('PATCH', '/api/accounts/missing', { label: 'x' })).status).toBe(404);
  });

  it('deletes the account and forgets its tokens', async () => {
    await setup();
    await signIn(grant());
    const id = (await list())[0]!.id;
    expect((await t.call('DELETE', `/api/accounts/${id}`)).status).toBe(204);
    expect(await list()).toEqual([]);
    expect(getAccountTokens(t.ctx)).toEqual({});
    await expect(getAccessToken(t.ctx, id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await t.call('DELETE', `/api/accounts/${id}`)).status).toBe(404);
  });
});
