/**
 * Static backend: Spotify accounts with the browser as the OAuth client. Port of
 * server/src/modules/accounts/oauth-spotify.test.ts: client setup, the PKCE round trip through the
 * site's own address, the identity from `GET /me`, reconnects, refreshes — plus what differs from
 * the browser's Outlook.com sign-in: no id_token, no scope at the token endpoint, a six-month
 * sign-in and no automatic renewal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, OAuthClientInfo } from '@portly/shared';
import { getClientEvents } from '../../diagnostics/clientLog.ts';
import { finishSignIn, planAutomaticSignIn } from '../oauthRedirect.ts';
import { createFakeFetch, type FakeFetch, type FakeFetchRoute } from '../providers/__fixtures__/fakeFetch.ts';
import { formOf, tokenError } from '../providers/__fixtures__/microsoft.ts';
import { SPOTIFY_CLIENT_ID, SPOTIFY_SUBJECT, profileRoute, spotifyGrant, spotifyProfile, tokenRoute } from '../providers/__fixtures__/spotify.ts';
import { pkceChallenge } from '../providers/oauthToken.ts';
import { SPOTIFY_AUTHORIZE_ENDPOINT, SPOTIFY_SCOPES, SPOTIFY_SESSION_MS } from '../providers/spotifyAuth.ts';
import { SLICE, getAccountTokens, getAccounts, getOAuthClients, getOAuthStates } from '../slices.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import * as accounts from './accounts.ts';
import { MESSAGES, getAccessToken } from './accounts.ts';

type ErrorBody = { error: { code: string; message: string; details?: { path: string; message: string }[]; accountId?: string } };

const APP_URL = 'https://portly.example.github.io/';
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
  if (options.client ?? true) expect((await t.json('PUT', '/api/oauth-clients/spotify', { clientId: SPOTIFY_CLIENT_ID })).status).toBe(200);
  return t;
}

async function start(body: Record<string, unknown> = { returnTo: '#/settings/accounts' }): Promise<URL> {
  const res = await t.json<{ authorizeUrl: string }>('POST', '/api/oauth/spotify/start', body);
  expect(res.status).toBe(200);
  return new URL(res.body.authorizeUrl);
}

/** The page address Spotify sends the browser back to. */
function callback(state: string, extra: Record<string, string> = { code: 'auth-code' }): string {
  const url = new URL(APP_URL);
  for (const [key, value] of Object.entries({ ...extra, state })) url.searchParams.set(key, value);
  return url.href;
}

/** A full sign-in: the token and profile answers given; returns the page address afterwards. */
async function signIn(grant = spotifyGrant(), profile = spotifyProfile(), body?: Record<string, unknown>): Promise<string | null> {
  fake.add(tokenRoute(grant, 1));
  fake.add(profileRoute(profile, 1));
  const url = await start(body);
  return finishSignIn(t.ctx, callback(url.searchParams.get('state')!));
}

const oauthResult = (href: string | null): string | null => new URL(href!).searchParams.get('oauth');
const listAccounts = async (): Promise<Account[]> => (await t.json<Account[]>('GET', '/api/accounts')).body;

describe('spotify accounts: the app registration', () => {
  it('shows this site as the redirect URI to register', async () => {
    await setup([], { client: false });
    const res = await t.json<OAuthClientInfo>('GET', '/api/oauth-clients/spotify');
    expect(res).toEqual({ status: 200, body: { clientId: null, hasSecret: false, redirectUri: APP_URL } });
  });

  it('takes a Spotify client ID and no secret', async () => {
    await setup([], { client: false });
    const wrong = await t.json<ErrorBody>('PUT', '/api/oauth-clients/spotify', { clientId: '0f0e0d0c-0b0a-4908-8706-050403020100' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.details?.[0]?.path).toBe('clientId');
    const secret = await t.json<ErrorBody>('PUT', '/api/oauth-clients/spotify', { clientId: SPOTIFY_CLIENT_ID, clientSecret: 'nope' });
    expect(secret.status).toBe(422);
    expect(secret.body.error.details?.[0]?.path).toBe('clientSecret');
    expect((await t.json<OAuthClientInfo>('PUT', '/api/oauth-clients/spotify', { clientId: SPOTIFY_CLIENT_ID })).body.clientId).toBe(SPOTIFY_CLIENT_ID);
    expect((await t.json<OAuthClientInfo>('GET', '/api/oauth-clients/microsoft')).body.clientId).toBeNull();
  });

  it('reads a stored registration from before Spotify signed in from the browser', async () => {
    await setup([], { client: false });
    t.ctx.state.set(SLICE.oauthClients, { microsoft: { clientId: 'kept', updatedAt: 1 } });
    await t.ctx.state.commit(SLICE.oauthClients);
    expect(getOAuthClients(t.ctx).microsoft?.clientId).toBe('kept');
    expect((await t.json<OAuthClientInfo>('PUT', '/api/oauth-clients/spotify', { clientId: SPOTIFY_CLIENT_ID })).status).toBe(200);
    expect(getOAuthClients(t.ctx).microsoft?.clientId).toBe('kept');
  });

  it('still answers "not here" for Google', async () => {
    await setup();
    const res = await t.json<ErrorBody>('GET', '/api/oauth-clients/google');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'not_configured', message: 'Google accounts are not available in the browser-only build.' });
  });
});

describe('spotify accounts: starting a sign-in', () => {
  it('asks for the two playback scopes, with PKCE and this site as the redirect URI', async () => {
    await setup();
    const url = await start();
    expect(`${url.origin}${url.pathname}`).toBe(SPOTIFY_AUTHORIZE_ENDPOINT);
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({ client_id: SPOTIFY_CLIENT_ID, response_type: 'code', redirect_uri: APP_URL, scope: SPOTIFY_SCOPES.join(' '), code_challenge_method: 'S256' });
    expect(params.prompt).toBeUndefined();
    const [pending] = getOAuthStates(t.ctx);
    expect(pending).toMatchObject({ provider: 'spotify', state: params.state, accountId: null, returnTo: '#/settings/accounts', silent: false, capabilities: ['music'] });
    expect(params.code_challenge).toBe(await pkceChallenge(pending!.codeVerifier));
  });

  it('needs the app registration first', async () => {
    await setup([], { client: false });
    const res = await t.json<ErrorBody>('POST', '/api/oauth/spotify/start', {});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'not_configured', message: 'Set up the Spotify OAuth client first' });
  });

  it('refuses a service Spotify does not offer, and an account that is not Spotify’s', async () => {
    await setup();
    expect((await t.json('POST', '/api/oauth/spotify/start', { capabilities: ['calendar'] })).status).toBe(422);
    expect((await t.json('POST', '/api/oauth/spotify/start', { accountId: '00000000-0000-4000-8000-0000000000ff' })).status).toBe(404);
  });
});

describe('spotify accounts: finishing a sign-in', () => {
  it('connects: the code goes to Spotify with the verifier, and the identity comes from GET /me', async () => {
    await setup();
    const after = await signIn();
    expect(new URL(after!).hash).toBe('#/settings/accounts');
    expect(oauthResult(after)).toBe('connected');

    const form = formOf(fake.calls[0]!);
    expect(form).toMatchObject({ client_id: SPOTIFY_CLIENT_ID, grant_type: 'authorization_code', code: 'auth-code', redirect_uri: APP_URL });
    expect(form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.client_secret).toBeUndefined();
    expect(form.scope).toBeUndefined();
    expect(fake.calls[1]!.headers.get('authorization')).toBe('Bearer AT1');
    expect(fake.calls[1]!.init.credentials).toBe('omit');

    const [account] = await listAccounts();
    expect(account).toMatchObject({ kind: 'spotify', label: 'Harbor Listener', email: null, capabilities: ['music'], enabledCapabilities: ['music'], status: 'ok', statusMessage: null });
    const [row] = getAccounts(t.ctx);
    expect(row).toMatchObject({ externalId: SPOTIFY_SUBJECT, grantedScopes: [...SPOTIFY_SCOPES].sort(), requestedScopes: [...SPOTIFY_SCOPES].sort() });
    expect(getAccountTokens(t.ctx)[row!.id]).toMatchObject({ refreshToken: 'RT1', accessToken: 'AT1', sessionExpiresAt: T0 + SPOTIFY_SESSION_MS, silentAttemptAt: null });
  });

  it('labels an account without a display name, and falls back on `id` without an account_id', async () => {
    await setup();
    await signIn(spotifyGrant(), spotifyProfile({ account_id: null, display_name: '  ' }));
    expect(getAccounts(t.ctx)[0]).toMatchObject({ label: 'Spotify account', externalId: 'harbor-listener' });
  });

  it('says so when the Spotify app does not let this account in (403 from GET /me)', async () => {
    await setup();
    expect(oauthResult(await signIn(spotifyGrant(), { status: 403, text: 'User not registered in the Developer Dashboard' }))).toBe('not_allowed');
    expect(getAccounts(t.ctx)).toEqual([]);
    expect(getAccountTokens(t.ctx)).toEqual({});
    const fields = getClientEvents().map((entry) => entry.event.fields);
    expect(fields).toContainEqual(expect.objectContaining({ provider: 'spotify', host: 'api.spotify.com', status: 403, code: 'not_allowed' }));
  });

  it('reports an unreadable profile as an error, and keeps nothing', async () => {
    await setup();
    expect(oauthResult(await signIn(spotifyGrant(), { status: 200, text: 'not json' }))).toBe('error');
    expect(getAccounts(t.ctx)).toEqual([]);
  });

  it('treats a grant without both scopes as refused: reading without controlling is not a player', async () => {
    await setup();
    expect(oauthResult(await signIn(spotifyGrant({ scope: 'user-read-playback-state' })))).toBe('denied');
    expect(getAccounts(t.ctx)).toEqual([]);
  });

  it('needs the scopes and a refresh token in the answer', async () => {
    await setup();
    expect(oauthResult(await signIn(spotifyGrant({ scope: undefined })))).toBe('error');
    expect(oauthResult(await signIn(spotifyGrant({ refresh_token: undefined })))).toBe('error');
    expect(getAccounts(t.ctx)).toEqual([]);
  });

  it('reports a refused code and a declined sign-in, and never reflects Spotify’s text', async () => {
    await setup();
    fake.add(tokenRoute(tokenError('invalid_grant'), 1));
    const url = await start();
    const after = await finishSignIn(t.ctx, callback(url.searchParams.get('state')!));
    expect(oauthResult(after)).toBe('error');
    expect(after).not.toContain('script');

    const declined = await start();
    expect(oauthResult(await finishSignIn(t.ctx, callback(declined.searchParams.get('state')!, { error: 'access_denied' })))).toBe('denied');
    const events = getClientEvents().map((entry) => entry.event);
    expect(events.map((event) => event.fields)).toContainEqual(expect.objectContaining({ provider: 'spotify', host: 'accounts.spotify.com', code: 'access_denied' }));
    expect(JSON.stringify(events)).not.toContain('auth-code');
  });

  it('uses a state once', async () => {
    await setup();
    fake.add(tokenRoute(spotifyGrant(), 1));
    fake.add(profileRoute(spotifyProfile(), 1));
    const url = await start();
    const href = callback(url.searchParams.get('state')!);
    expect(oauthResult(await finishSignIn(t.ctx, href))).toBe('connected');
    expect(oauthResult(await finishSignIn(t.ctx, href))).toBe('expired');
  });

  it('a reconnect keeps the account, its name and the user’s choice, with the new tokens', async () => {
    await setup();
    await signIn();
    const [row] = getAccounts(t.ctx);
    await t.json('PATCH', `/api/accounts/${row!.id}`, { label: 'Kitchen', enabledCapabilities: [] });
    t.tick(1000);
    const after = await signIn(spotifyGrant({ access_token: 'AT2', refresh_token: 'RT2' }), spotifyProfile(), { accountId: row!.id });
    expect(oauthResult(after)).toBe('reconnected');
    expect(getAccounts(t.ctx)).toHaveLength(1);
    expect(getAccounts(t.ctx)[0]).toMatchObject({ id: row!.id, label: 'Kitchen', enabledCapabilities: [] });
    expect(getAccountTokens(t.ctx)[row!.id]).toMatchObject({ refreshToken: 'RT2', accessToken: 'AT2', sessionExpiresAt: T0 + 1000 + SPOTIFY_SESSION_MS });
  });

  it('a reconnect as someone else adds that account and says so', async () => {
    await setup();
    await signIn();
    const [row] = getAccounts(t.ctx);
    const after = await signIn(spotifyGrant(), spotifyProfile({ account_id: 'acct-someone-else', display_name: 'Someone Else' }), { accountId: row!.id });
    expect(oauthResult(after)).toBe('different_account');
    expect(getAccounts(t.ctx).map((a) => a.label)).toEqual(['Harbor Listener', 'Someone Else']);
  });
});

describe('spotify accounts: tokens', () => {
  async function connected(): Promise<string> {
    await setup();
    await signIn();
    return getAccounts(t.ctx)[0]!.id;
  }

  it('keeps using a fresh token', async () => {
    const id = await connected();
    const before = fake.calls.length;
    expect(await getAccessToken(t.ctx, id)).toBe('AT1');
    expect(fake.calls).toHaveLength(before);
  });

  it('refreshes with no scope, and stores a rotated refresh token', async () => {
    const id = await connected();
    t.tick(60 * 60 * 1000);
    fake.add(tokenRoute(spotifyGrant({ access_token: 'AT2', refresh_token: 'RT2' }), 1));
    expect(await getAccessToken(t.ctx, id)).toBe('AT2');
    const form = formOf(fake.calls.at(-1)!);
    expect(form).toEqual({ client_id: SPOTIFY_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'RT1' });
    expect(getAccountTokens(t.ctx)[id]).toMatchObject({ refreshToken: 'RT2', accessToken: 'AT2', sessionExpiresAt: T0 + SPOTIFY_SESSION_MS });
  });

  it('keeps the refresh token when Spotify does not send a new one', async () => {
    const id = await connected();
    t.tick(60 * 60 * 1000);
    fake.add(tokenRoute(spotifyGrant({ access_token: 'AT2', refresh_token: undefined }), 1));
    expect(await getAccessToken(t.ctx, id)).toBe('AT2');
    expect(getAccountTokens(t.ctx)[id]?.refreshToken).toBe('RT1');
  });

  it('a dead refresh token needs a reconnect, in Spotify’s words and not Microsoft’s 24 hours', async () => {
    const id = await connected();
    t.tick(SPOTIFY_SESSION_MS + 1000);
    fake.add(tokenRoute(tokenError('invalid_grant'), 1));
    await expect(getAccessToken(t.ctx, id)).rejects.toMatchObject({ code: 'reauth_required', message: MESSAGES.grantExpired, accountId: id });
    expect(getAccounts(t.ctx)[0]).toMatchObject({ status: 'reauth', statusMessage: MESSAGES.grantExpired });
    expect((await listAccounts())[0]).toMatchObject({ status: 'reauth' });
  });

  it('names Spotify when the refresh fails for another reason', async () => {
    const id = await connected();
    t.tick(60 * 60 * 1000);
    fake.add(tokenRoute({ status: 503, text: 'busy' }, 1));
    await expect(getAccessToken(t.ctx, id)).rejects.toMatchObject({ code: 'provider_error', message: 'Spotify could not refresh access right now' });
  });

  it('never tries an automatic sign-in, which Spotify does not have', async () => {
    const id = await connected();
    t.tick(SPOTIFY_SESSION_MS + 1000);
    fake.add(tokenRoute(tokenError('invalid_grant'), 1));
    await expect(getAccessToken(t.ctx, id)).rejects.toMatchObject({ code: 'reauth_required' });
    t.ctx.state.set(SLICE.oauthClients, { microsoft: { clientId: '0f0e0d0c-0b0a-4908-8706-050403020100', updatedAt: 1 }, spotify: { clientId: SPOTIFY_CLIENT_ID, updatedAt: 1 } });
    expect(await planAutomaticSignIn(t.ctx, `${APP_URL}#/`)).toBeNull();
  });

  it('the connection test refreshes, and answers for music', async () => {
    const id = await connected();
    fake.add(tokenRoute(spotifyGrant({ access_token: 'AT2' }), 1));
    const res = await t.json('POST', `/api/accounts/${id}/test`);
    expect(res).toEqual({ status: 200, body: { results: { music: { ok: true } } } });
  });

  it('removing the account forgets its tokens', async () => {
    const id = await connected();
    expect((await t.call('DELETE', `/api/accounts/${id}`)).status).toBe(204);
    expect(getAccounts(t.ctx)).toEqual([]);
    expect(getAccountTokens(t.ctx)).toEqual({});
  });
});
