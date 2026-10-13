/**
 * Microsoft sign-in client of the static backend: the authorization URL, PKCE, token-endpoint
 * classification and id_token rules (ports of the server's microsoft.ts, token-endpoint.ts and
 * id-token.ts tests, with the browser scopes and the single-page-app session length).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MICROSOFT_CONSUMER_TENANT_ID } from '@homebase/shared';
import { createFakeFetch, failingFetch } from './__fixtures__/fakeFetch.ts';
import { MICROSOFT_CLIENT_ID, SUBJECT, microsoftIdToken, tokenError, tokenOk } from './__fixtures__/microsoft.ts';
import {
  MICROSOFT_AUTHORIZE_ENDPOINT,
  MICROSOFT_TOKEN_ENDPOINT,
  authorizeUrl,
  capabilitiesOf,
  decodeJwtClaims,
  grantedScopes,
  microsoftIdentity,
  pkceChallenge,
  requestToken,
} from './microsoftAuth.ts';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authorization URL', () => {
  it('asks the consumers authority for a code with PKCE and the calendar scopes only', () => {
    const url = new URL(
      authorizeUrl({ clientId: MICROSOFT_CLIENT_ID, redirectUri: 'https://user.github.io/', state: 'S', codeChallenge: 'C' }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(MICROSOFT_AUTHORIZE_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: MICROSOFT_CLIENT_ID,
      response_type: 'code',
      redirect_uri: 'https://user.github.io/',
      response_mode: 'query',
      scope: 'openid profile email offline_access User.Read Calendars.ReadWrite',
      state: 'S',
      code_challenge: 'C',
      code_challenge_method: 'S256',
    });
  });

  it('adds prompt=none and the account as login_hint for the automatic sign-in', () => {
    const url = new URL(
      authorizeUrl({ clientId: MICROSOFT_CLIENT_ID, redirectUri: 'https://user.github.io/', state: 'S', codeChallenge: 'C', silent: true, loginHint: 'bob@outlook.com' }),
    );
    expect(url.searchParams.get('prompt')).toBe('none');
    expect(url.searchParams.get('login_hint')).toBe('bob@outlook.com');
  });

  it('computes the S256 challenge of RFC 7636 appendix B', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('token endpoint', () => {
  it('posts a form and maps a usable answer, including the refresh-token lifetime when given', async () => {
    const fake = createFakeFetch([
      { match: MICROSOFT_TOKEN_ENDPOINT, respond: tokenOk({ access_token: 'AT', refresh_token: 'RT', refresh_token_expires_in: 86399, scope: 'Calendars.ReadWrite', id_token: 'x.y.z' }) },
    ]);
    vi.stubGlobal('fetch', fake.fetch);
    const result = await requestToken({ grant_type: 'refresh_token', refresh_token: 'old' });
    expect(result).toEqual({
      ok: true,
      tokens: { accessToken: 'AT', expiresInSec: 3599, refreshToken: 'RT', refreshExpiresInSec: 86399, scope: 'Calendars.ReadWrite', idToken: 'x.y.z' },
    });
    expect(fake.calls[0]!.method).toBe('POST');
    expect(fake.calls[0]!.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(fake.calls[0]!.body).toBe('grant_type=refresh_token&refresh_token=old');
  });

  it.each([
    [tokenError('invalid_grant'), 'invalid_grant'],
    [tokenError('interaction_required'), 'invalid_grant'],
    [tokenError('invalid_client', 401), 'client_rejected'],
    [tokenError('invalid_request'), 'rejected'],
    [tokenError('temporarily_unavailable', 429), 'rate_limited'],
    [{ status: 503, text: 'down' }, 'server_error'],
    [{ status: 200, json: { token_type: 'mac', access_token: 'x' } }, 'bad_response'],
    [{ status: 200, text: 'not json' }, 'bad_response'],
  ] as const)('classifies %j as %s', async (respond, failure) => {
    vi.stubGlobal('fetch', createFakeFetch([{ match: MICROSOFT_TOKEN_ENDPOINT, respond }]).fetch);
    const result = await requestToken({ grant_type: 'refresh_token', refresh_token: 'old' });
    expect(result).toMatchObject({ ok: false, failure });
    // Provider text never travels further than this function.
    expect(JSON.stringify(result)).not.toContain('script');
  });

  it('reports a blocked or failed request (CORS, offline) as unreachable', async () => {
    vi.stubGlobal('fetch', failingFetch);
    expect(await requestToken({})).toEqual({ ok: false, failure: 'unreachable', status: null });
  });
});

describe('id_token', () => {
  it('decodes the payload of a compact JWT and rejects anything else', () => {
    expect(decodeJwtClaims(microsoftIdToken(NOW))).toMatchObject({ oid: SUBJECT, tid: MICROSOFT_CONSUMER_TENANT_ID });
    for (const bad of [null, '', 'a.b', 'a.b.c.d', '!!.e30.x', `x.${'a'.repeat(20_000)}.y`, 'eyJ9.bm90IGpzb24.x']) expect(decodeJwtClaims(bad)).toBeNull();
  });

  it('accepts personal accounts of this client only', () => {
    const ok = microsoftIdentity(decodeJwtClaims(microsoftIdToken(NOW))!, MICROSOFT_CLIENT_ID, NOW);
    expect(ok).toEqual({ ok: true, identity: { subject: SUBJECT, email: 'bob@outlook.com' } });
    const withEmail = microsoftIdentity(decodeJwtClaims(microsoftIdToken(NOW, { email: 'b@live.com' }))!, MICROSOFT_CLIENT_ID, NOW);
    expect(withEmail).toMatchObject({ identity: { email: 'b@live.com' } });
    const cases: [string, Record<string, unknown>][] = [
      ['tenant', { tid: '72f988bf-86f1-41af-91ab-2d7cd011db47' }],
      ['issuer', { iss: 'https://evil.example' }],
      ['audience', { aud: 'someone-else' }],
      ['expired', { exp: Math.floor(NOW / 1000) - 3600 }],
      ['subject', { oid: undefined }],
    ];
    for (const [reason, overrides] of cases) {
      expect(microsoftIdentity(decodeJwtClaims(microsoftIdToken(NOW, overrides))!, MICROSOFT_CLIENT_ID, NOW), reason).toEqual({ ok: false, reason });
    }
  });
});

describe('scopes', () => {
  it('normalizes granted scopes and unlocks the calendar only', () => {
    expect(grantedScopes('https://graph.microsoft.com/Calendars.ReadWrite openid User.Read')).toEqual(['calendars.readwrite', 'openid', 'user.read']);
    expect(grantedScopes(undefined)).toContain('calendars.readwrite');
    expect(capabilitiesOf(['calendars.readwrite', 'mail.readwrite'])).toEqual(['calendar']);
    expect(capabilitiesOf(['openid', 'user.read'])).toEqual([]);
  });
});
