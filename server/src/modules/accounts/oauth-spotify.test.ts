import type { OAuthClientInfo, OAuthStartResponse } from '@portly/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testRequest } from '../../testing/test-request.ts';
import { createAccountsHarness, formsSentTo, route, seedAccount, storedRefreshToken, tokenError, tokenOk, type AccountsHarness } from './__fixtures__/oauth.ts';
import { SPOTIFY_PROFILE_ENDPOINT, SPOTIFY_SCOPE_MODIFY_PLAYBACK, SPOTIFY_SCOPE_READ_PLAYBACK, SPOTIFY_TOKEN_ENDPOINT, spotify } from './oauth/spotify.ts';

const CLIENT_ID = '0123456789abcdef0123456789abcdef';
const REDIRECT = 'http://127.0.0.1:5757/api/oauth/spotify/callback';
const BOTH_SCOPES = `${SPOTIFY_SCOPE_READ_PLAYBACK} ${SPOTIFY_SCOPE_MODIFY_PLAYBACK}`;
const PROFILE = { id: 'old-style-id', account_id: 'stable-account-id', display_name: 'Sam Example' };

let h: AccountsHarness;

beforeEach(() => {
  h = createAccountsHarness();
});
afterEach(async () => {
  await h.core.settle();
  h.ctx.close();
});

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

function configure(): void {
  h.ctx.db.run('INSERT INTO oauth_clients (provider, client_id, has_secret, updated_at) VALUES (?, ?, 0, ?)', ['spotify', CLIENT_ID, 1]);
}

async function start(body: Record<string, unknown> = {}): Promise<URL> {
  const res = await testRequest(h.app, 'POST', '/api/oauth/spotify/start', { body });
  expect(res.status).toBe(200);
  return new URL((await json<OAuthStartResponse>(res)).authorizeUrl);
}

/** Spotify redirecting the browser back, to the loopback IP it was given. */
function callback(query: string): Promise<Response> {
  return testRequest(h.app, 'GET', `/api/oauth/spotify/callback?${query}`, {
    headers: { 'X-Portly': null, 'Sec-Fetch-Site': 'cross-site', Host: '127.0.0.1:5757' },
  });
}

function tokenRoute(fields: Record<string, unknown> = {}): void {
  h.fake.add(route(SPOTIFY_TOKEN_ENDPOINT, () => tokenOk({ access_token: 's-at', refresh_token: 's-rt', scope: BOTH_SCOPES, ...fields })));
}

function profileRoute(respond: Parameters<typeof route>[1] = { json: PROFILE }): void {
  h.fake.add(route(SPOTIFY_PROFILE_ENDPOINT, respond, { method: 'GET' }));
}

async function signIn(body: Record<string, unknown> = {}): Promise<string> {
  const state = (await start(body)).searchParams.get('state');
  const res = await callback(`code=the-code&state=${state}`);
  expect(res.status).toBe(302);
  return res.headers.get('location') ?? '';
}

describe('Spotify: OAuth client', () => {
  it('reports the redirect URI to register: the loopback IP, because Spotify refuses localhost', async () => {
    expect(await json<OAuthClientInfo>(await testRequest(h.app, 'GET', '/api/oauth-clients/spotify'))).toEqual({ clientId: null, hasSecret: false, redirectUri: REDIRECT });
  });

  it('takes a client id with no secret, and says what a wrong one should look like', async () => {
    const bad = await testRequest(h.app, 'PUT', '/api/oauth-clients/spotify', { body: { clientId: 'not-a-spotify-id' } });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(await bad.json())).toContain('32 letters and digits');
    const secret = await testRequest(h.app, 'PUT', '/api/oauth-clients/spotify', { body: { clientId: CLIENT_ID, clientSecret: 'nope' } });
    expect(secret.status).toBe(422);
    const ok = await testRequest(h.app, 'PUT', '/api/oauth-clients/spotify', { body: { clientId: CLIENT_ID } });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ clientId: CLIENT_ID, hasSecret: false, redirectUri: REDIRECT });
  });
});

describe('Spotify: sign-in', () => {
  beforeEach(configure);

  it('asks for the two playback scopes only, with PKCE', async () => {
    const url = await start();
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.spotify.com/authorize');
    const params = url.searchParams;
    expect(params.get('client_id')).toBe(CLIENT_ID);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('redirect_uri')).toBe(REDIRECT);
    expect(params.get('scope')).toBe(BOTH_SCOPES);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('state')).toBeTruthy();
    expect(params.has('client_secret')).toBe(false);
  });

  it('refuses services Spotify does not offer', async () => {
    const res = await testRequest(h.app, 'POST', '/api/oauth/spotify/start', { body: { capabilities: ['mail'] } });
    expect(res.status).toBe(422);
  });

  it('connects: identity from GET /me, the refresh token in the vault, music switched on', async () => {
    tokenRoute();
    profileRoute();
    expect(await signIn()).toBe('http://localhost:5757/?oauth=connected#/settings/accounts');

    const [form] = formsSentTo(h.fake, SPOTIFY_TOKEN_ENDPOINT);
    expect(form).toMatchObject({ client_id: CLIENT_ID, grant_type: 'authorization_code', code: 'the-code', redirect_uri: REDIRECT });
    expect(form?.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(form).not.toHaveProperty('client_secret');
    expect(form).not.toHaveProperty('scope');

    const me = h.fake.calls.find((c) => c.url === SPOTIFY_PROFILE_ENDPOINT);
    expect(me?.headers.get('authorization')).toBe('Bearer s-at');

    const [account] = h.service.list();
    expect(account).toMatchObject({ kind: 'spotify', label: 'Sam Example', email: null, capabilities: ['music'], enabledCapabilities: ['music'], status: 'ok' });
    expect(storedRefreshToken(h, account!.id)).toBe('s-rt');
    expect(h.ctx.db.get<{ external_id: string }>('SELECT external_id FROM accounts')?.external_id).toBe('stable-account-id');
    expect(JSON.stringify(h.ctx.db.all('SELECT * FROM accounts'))).not.toContain('s-rt');
    // The access token from the exchange is used straight away: no refresh needed.
    expect(await h.service.getAccessToken(account!.id)).toBe('s-at');
    expect(formsSentTo(h.fake, SPOTIFY_TOKEN_ENDPOINT)).toHaveLength(1);
  });

  it('uses `id` when there is no `account_id`, and a default name when there is no display name', async () => {
    tokenRoute();
    profileRoute({ json: { id: 'plain-id', display_name: null } });
    await signIn();
    expect(h.service.list()[0]).toMatchObject({ label: 'Spotify account' });
    expect(h.ctx.db.get<{ external_id: string }>('SELECT external_id FROM accounts')?.external_id).toBe('plain-id');
  });

  it('a 403 from GET /me is told apart: the developer app refuses this account', async () => {
    tokenRoute();
    profileRoute({ status: 403, text: 'User not registered in the Developer Dashboard' });
    expect(await signIn()).toBe('http://localhost:5757/?oauth=not_allowed#/settings/accounts');
    expect(h.service.list()).toEqual([]);
    expect(h.ctx.vault.has('account:anything')).toBe(false);
  });

  it.each([
    ['a server error', { status: 500, text: 'oops' }],
    ['an unreadable answer', { status: 200, text: '<html>' }],
    ['an answer without an id', { status: 200, json: { display_name: 'No Id' } }],
  ])('%s from GET /me stores nothing', async (_name, respond) => {
    tokenRoute();
    profileRoute(respond);
    expect(await signIn()).toContain('?oauth=error');
    expect(h.service.list()).toEqual([]);
  });

  it('a grant without both scopes is denied: reading without controlling is no player', async () => {
    tokenRoute({ scope: SPOTIFY_SCOPE_READ_PLAYBACK });
    profileRoute();
    expect(await signIn()).toContain('?oauth=denied');
    expect(h.service.list()).toEqual([]);
  });

  it('reconnecting the same account keeps it; another account is added as new', async () => {
    let who: Record<string, unknown> = PROFILE;
    let refreshToken = 's-rt';
    h.fake.add(route(SPOTIFY_TOKEN_ENDPOINT, () => tokenOk({ access_token: 's-at', refresh_token: refreshToken, scope: BOTH_SCOPES })));
    profileRoute(() => ({ json: who }));
    await signIn();
    const [first] = h.service.list();
    expect(await signIn({ accountId: first!.id })).toContain('?oauth=reconnected');
    expect(h.service.list()).toHaveLength(1);

    who = { id: 'someone-else', display_name: 'Robin' };
    refreshToken = 's-rt-2';
    expect(await signIn({ accountId: first!.id })).toContain('?oauth=different_account');
    expect(h.service.list().map((a) => a.label).sort()).toEqual(['Robin', 'Sam Example']);
    expect(storedRefreshToken(h, first!.id)).toBe('s-rt');
  });
});

describe('Spotify: refresh', () => {
  beforeEach(() => {
    configure();
    seedAccount(h, { id: 's1', kind: 'spotify', capabilities: ['music'], refreshToken: 'old-rt' });
  });

  it('sends the client id and no secret, and keeps the refresh token when Spotify returns none', async () => {
    h.fake.add(route(SPOTIFY_TOKEN_ENDPOINT, () => tokenOk({ access_token: 'fresh-at' })));
    expect(await h.service.getAccessToken('s1')).toBe('fresh-at');
    const [form] = formsSentTo(h.fake, SPOTIFY_TOKEN_ENDPOINT);
    expect(form).toEqual({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'old-rt' });
    expect(storedRefreshToken(h, 's1')).toBe('old-rt');
  });

  it('stores a new refresh token when Spotify returns one', async () => {
    h.fake.add(route(SPOTIFY_TOKEN_ENDPOINT, () => tokenOk({ access_token: 'fresh-at', refresh_token: 'new-rt' })));
    await h.service.getAccessToken('s1');
    expect(storedRefreshToken(h, 's1')).toBe('new-rt');
  });

  it('a dead grant (the six months are up) asks to reconnect', async () => {
    h.fake.add(route(SPOTIFY_TOKEN_ENDPOINT, () => tokenError('invalid_grant')));
    await expect(h.service.getAccessToken('s1')).rejects.toMatchObject({ code: 'reauth_required', accountId: 's1' });
    expect(h.service.get('s1')?.status).toBe('reauth');
  });

  it('removing the account forgets its tokens; Spotify has nothing to revoke', async () => {
    expect((await testRequest(h.app, 'DELETE', '/api/accounts/s1')).status).toBe(204);
    await h.core.settle();
    expect(h.service.get('s1')).toBeNull();
    expect(h.ctx.vault.has('account:s1')).toBe(false);
    expect(h.fake.calls).toEqual([]);
  });
});

describe('Spotify: spec', () => {
  it('has no id_token rule of its own', () => {
    expect(spotify.identity({}, CLIENT_ID, 0)).toEqual({ ok: false, reason: 'no_id_token' });
  });

  it('checks client ids', () => {
    expect(spotify.isValidClientId(CLIENT_ID)).toBe(true);
    expect(spotify.isValidClientId(CLIENT_ID.toUpperCase())).toBe(true);
    expect(spotify.isValidClientId('short')).toBe(false);
    expect(spotify.isValidClientId(`${CLIENT_ID}0`)).toBe(false);
  });

  it('reads granted scopes, and null without any', () => {
    expect(spotify.grantedScopes(` ${BOTH_SCOPES}  ${SPOTIFY_SCOPE_READ_PLAYBACK} `, [])).toEqual([SPOTIFY_SCOPE_MODIFY_PLAYBACK, SPOTIFY_SCOPE_READ_PLAYBACK]);
    expect(spotify.grantedScopes(undefined, [])).toBeNull();
    expect(spotify.capabilities([SPOTIFY_SCOPE_READ_PLAYBACK, SPOTIFY_SCOPE_MODIFY_PLAYBACK])).toEqual(['music']);
    expect(spotify.capabilities([SPOTIFY_SCOPE_MODIFY_PLAYBACK])).toEqual([]);
  });
});
