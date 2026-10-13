/**
 * Diagnostics of the accounts module (§17): status changes through applyAccountStatus (one
 * log line per change, every outcome on `account:<id>`), token refresh outcomes and their log
 * context, refusals warned once (never hiding a reauth), the second-401 warning, connection-test
 * verdicts from the probes' real errors, purposes and log context of outbound calls, forgetting a
 * deleted account's subjects — and no secret or provider text in any of it.
 */
import type { AccountCreateResult, AccountTestResult, OAuthStartResponse } from '@portly/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError, ProviderUnauthorizedError } from '../../lib/errors.ts';
import { getLogContext, withLogContext } from '../../lib/log-context.ts';
import { createTestLogger, type LogRecordOut } from '../../lib/logger.ts';
import type { SafeFetchOptions } from '../../security/safe-fetch.ts';
import { testRequest } from '../../testing/test-request.ts';
import { DavHttpError } from '../calendar/providers/caldav.ts';
import {
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  T0,
  configureClients,
  createAccountsHarness,
  googleIdToken,
  route,
  seedAccount,
  tokenError,
  tokenOk,
  type AccountsHarness,
} from './__fixtures__/oauth.ts';
import { MESSAGES } from './service.ts';
import { accountSecretId, applyAccountStatus } from './store.ts';

let h: AccountsHarness;
let log: ReturnType<typeof createTestLogger>;
/** Outbound calls with their purpose and the account of the log context they were made in. */
const fetches: { url: string; purpose: string | undefined; accountId: string | undefined }[] = [];

beforeEach(() => {
  fetches.length = 0;
  log = createTestLogger();
  h = createAccountsHarness({
    log,
    onFetch: (url, options: SafeFetchOptions) => fetches.push({ url, purpose: options.purpose, accountId: getLogContext()?.accountId }),
  });
  configureClients(h);
});
afterEach(async () => {
  await h.core.settle();
  h.ctx.close();
});

const lines = (msg: string): LogRecordOut[] => log.lines().filter((l) => l.msg === msg);
const health = (id: string) => h.ctx.health.get(`account:${id}`);
const storedStatus = (id: string) => h.ctx.db.get<{ status: string; status_message: string | null }>('SELECT status, status_message FROM accounts WHERE id = ?', [id]);

describe('applyAccountStatus', () => {
  beforeEach(() => seedAccount(h, { id: 'y1', kind: 'yahoo', password: 'pw' }));

  it('writes and logs a change once, and records every outcome on account:<id>', () => {
    const change = applyAccountStatus(h.core, 'y1', 'reauth', 'The CalDAV server rejected the password', {
      reason: 'caldav_password_rejected',
      source: 'calendar',
    });
    expect(change).toEqual({ accountId: 'y1', kind: 'yahoo', from: 'ok', to: 'reauth', changed: true });
    expect(storedStatus('y1')).toEqual({ status: 'reauth', status_message: 'The CalDAV server rejected the password' });
    const [line] = lines('account status changed');
    expect(line).toMatchObject({
      level: 'info',
      fields: { accountId: 'y1', kind: 'yahoo', from: 'ok', to: 'reauth', reason: 'caldav_password_rejected', source: 'calendar' },
    });
    // The message stays in the account row and the health entry, never in the line.
    expect(JSON.stringify(line)).not.toContain('rejected the password');
    expect(health('y1')).toMatchObject({
      area: 'accounts',
      accountId: 'y1',
      status: 'failing',
      lastCode: 'caldav_password_rejected',
      lastMessage: 'The CalDAV server rejected the password',
      consecutiveFailures: 1,
      detail: { source: 'calendar' },
      expectEveryMs: null,
    });
    expect(lines('accounts failing')).toHaveLength(1);

    // Same status again: no write, no line, but another failure of the subject.
    expect(applyAccountStatus(h.core, 'y1', 'reauth', 'The CalDAV server rejected the password', { reason: 'caldav_password_rejected' })?.changed).toBe(false);
    expect(lines('account status changed')).toHaveLength(1);
    expect(health('y1')?.consecutiveFailures).toBe(2);

    applyAccountStatus(h.core, 'y1', 'ok', null, { reason: 'connection_test', source: 'accounts' });
    expect(lines('account status changed')[1]?.fields).toMatchObject({ from: 'reauth', to: 'ok', reason: 'connection_test', source: 'accounts' });
    expect(health('y1')).toMatchObject({ status: 'ok', detail: { reason: 'connection_test', source: 'accounts' } });
    expect(lines('accounts recovered')).toHaveLength(1);
  });

  it('ignores unknown ids, never lets an error hide a reauth, and drops reasons that are not machine tokens', () => {
    expect(applyAccountStatus(h.core, 'nope', 'error', 'x', { reason: 'http_5xx' })).toBeNull();
    expect(health('nope')).toBeNull();

    applyAccountStatus(h.core, 'y1', 'reauth', 'Reconnect');
    expect(health('y1')).toMatchObject({ status: 'failing', lastCode: 'reauth_required' });
    const kept = applyAccountStatus(h.core, 'y1', 'error', 'Could not reach Yahoo', { reason: 'refresh_unreachable', keepReauth: true });
    expect(kept).toMatchObject({ from: 'reauth', to: 'reauth', changed: false });
    expect(storedStatus('y1')?.status).toBe('reauth');
    expect(health('y1')).toMatchObject({ lastCode: 'reauth_required', consecutiveFailures: 1 });

    applyAccountStatus(h.core, 'y1', 'error', 'Broken', { reason: 'not a token!', source: 'Some Module' });
    expect(lines('account status changed').at(-1)?.fields).toMatchObject({ from: 'reauth', to: 'error', reason: null, source: null });
    expect(health('y1')).toMatchObject({ status: 'failing', lastCode: null, lastMessage: 'Broken' });
  });

  it('setStatus honours the caller meta (reason and deciding module)', () => {
    h.service.setStatus('y1', 'error', 'Calendar list failed: timeout', { reason: 'calendar_list_failed', source: 'calendar' });
    expect(lines('account status changed')[0]?.fields).toMatchObject({ to: 'error', reason: 'calendar_list_failed', source: 'calendar' });
    expect(health('y1')).toMatchObject({ lastCode: 'calendar_list_failed', detail: { source: 'calendar' } });
    h.service.setStatus('y1', 'ok', undefined, { source: 'calendar' });
    expect(health('y1')?.status).toBe('ok');
  });
});

describe('token refresh', () => {
  beforeEach(() => seedAccount(h, { id: 'g1', kind: 'google', refreshToken: 'rt-g1' }));

  it('records a success and runs in the account context, whoever asked first', async () => {
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, tokenOk({ access_token: 'at-1' })));
    await withLogContext({ rid: 'abcdefghij', area: 'calendar', job: 'calendar:sync' }, () => h.service.getAccessToken('g1'));
    const [refreshed] = lines('access token refreshed');
    expect(refreshed).toMatchObject({ level: 'debug', rid: 'abcdefghij', area: 'accounts', fields: { accountId: 'g1', job: 'calendar:sync' } });
    expect(health('g1')).toMatchObject({ status: 'ok', detail: { reason: 'token_refreshed', source: 'accounts' } });
    // Already ok: no status change line.
    expect(lines('account status changed')).toEqual([]);
    expect(fetches).toEqual([{ url: GOOGLE_TOKEN_ENDPOINT, purpose: 'oauth.refresh', accountId: 'g1' }]);
  });

  it.each([
    ['invalid_grant', 'invalid_grant'],
    ['consent_required', 'consent_required'],
    ['interaction_required', 'interaction_required'],
    ['login_required', 'interaction_required'],
  ])('a dead grant (%s) → reauth with reason %s', async (error, reason) => {
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, tokenError(error)));
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ code: 'reauth_required' });
    expect(storedStatus('g1')).toEqual({ status: 'reauth', status_message: MESSAGES.grantExpired });
    expect(lines('account status changed')[0]?.fields).toMatchObject({ accountId: 'g1', kind: 'google', from: 'ok', to: 'reauth', reason, source: 'accounts' });
    expect(health('g1')).toMatchObject({
      status: 'failing',
      lastCode: reason,
      lastStatus: 400,
      detail: { provider: 'google', failure: 'invalid_grant', oauthError: error, source: 'accounts' },
    });
    // The token endpoint's own line is debug detail, in the account's context.
    const [refused] = lines('oauth token request refused');
    expect(refused).toMatchObject({ level: 'debug', fields: { accountId: 'g1', error, status: 400 } });
  });

  it('maps the other refusals and transport failures to reasons; a success recovers', async () => {
    h.fake.add(
      route(GOOGLE_TOKEN_ENDPOINT, tokenError('invalid_client', 401), { times: 1 }),
      route(GOOGLE_TOKEN_ENDPOINT, { status: 403, json: { error: 'access_denied' } }, { times: 1 }),
      route(GOOGLE_TOKEN_ENDPOINT, { status: 503, text: 'down' }, { times: 1 }),
      route(GOOGLE_TOKEN_ENDPOINT, { status: 200, text: 'not json' }, { times: 1 }),
      route(
        GOOGLE_TOKEN_ENDPOINT,
        () => {
          throw new Error('ECONNRESET');
        },
        { times: 1 },
      ),
      route(GOOGLE_TOKEN_ENDPOINT, tokenOk({ access_token: 'at-ok' })),
    );
    const codes: (string | null | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      await expect(h.core.refreshNow('g1')).rejects.toBeInstanceOf(HttpError);
      codes.push(health('g1')?.lastCode);
    }
    expect(codes).toEqual(['client_rejected', 'http_4xx', 'http_5xx', 'parse_error', 'refresh_unreachable']);
    expect(health('g1')).toMatchObject({
      status: 'failing',
      consecutiveFailures: 5,
      lastStatus: null,
      lastMessage: 'Could not reach Google to refresh access',
      detail: { failure: 'unreachable', errReason: 'network', host: 'oauth2.googleapis.com' },
    });
    expect(storedStatus('g1')?.status).toBe('error');

    expect(await h.service.getAccessToken('g1')).toBe('at-ok');
    expect(health('g1')?.status).toBe('ok');
    expect(lines('accounts recovered')[0]?.fields).toMatchObject({ key: 'account:g1', failures: 5 });
    expect(lines('account status changed').at(-1)?.fields).toMatchObject({ from: 'error', to: 'ok', reason: 'token_refreshed' });
  });

  it('a transport failure keeps its cause on the thrown error', async () => {
    h.fake.add(
      route(GOOGLE_TOKEN_ENDPOINT, () => {
        throw new Error('ECONNRESET');
      }),
    );
    const err: unknown = await h.service.getAccessToken('g1').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'provider_error', accountId: 'g1' });
    expect((err as Error).cause).toMatchObject({ name: 'SafeFetchError', reason: 'network' });
  });

  it('a 429 leaves the status alone and records rate_limited with its Retry-After', async () => {
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, { status: 429, json: { error: 'rate_limit_exceeded' }, headers: { 'Retry-After': '120' } }));
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
    expect(storedStatus('g1')?.status).toBe('ok');
    expect(lines('account status changed')).toEqual([]);
    expect(health('g1')).toMatchObject({ status: 'failing', lastCode: 'rate_limited', lastStatus: 429, nextAttemptAt: T0 + 120_000 });
  });

  it('missing credentials → reauth no_credentials (OAuth refresh token and app password)', async () => {
    h.ctx.vault.delete(accountSecretId('g1'));
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ code: 'reauth_required' });
    expect(health('g1')).toMatchObject({ lastCode: 'no_credentials', lastMessage: MESSAGES.noCredentials });

    seedAccount(h, { id: 'i1', kind: 'imap' });
    await expect(h.service.getSecret('i1')).rejects.toMatchObject({ code: 'reauth_required' });
    expect(lines('account status changed').map((l) => l.fields.reason)).toEqual(['no_credentials', 'no_credentials']);
  });
});

describe('refusals (OAuth client not configured, vault locked)', () => {
  beforeEach(() => seedAccount(h, { id: 'g1', kind: 'google', refreshToken: 'rt-g1' }));

  it('warn once per account and reason, are recorded without a status change, and warn again after a recovery', async () => {
    const googleClient = h.ctx.db.get<Record<string, string | number>>(`SELECT * FROM oauth_clients WHERE provider = 'google'`);
    h.ctx.db.run(`DELETE FROM oauth_clients WHERE provider = 'google'`);
    for (let i = 0; i < 3; i++) await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ code: 'not_configured' });
    const warned = lines('account cannot refresh access: its OAuth client is not configured');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ level: 'warn', fields: { accountId: 'g1', kind: 'google', reason: 'not_configured' } });
    expect(storedStatus('g1')?.status).toBe('ok');
    expect(health('g1')).toMatchObject({ status: 'failing', lastCode: 'not_configured', consecutiveFailures: 3 });
    // The warning is the line: the health transition is info.
    expect(lines('accounts failing')[0]?.level).toBe('info');
    expect(h.fake.calls).toHaveLength(0);

    h.ctx.db.run('INSERT INTO oauth_clients (provider, client_id, has_secret, updated_at) VALUES (:provider, :client_id, :has_secret, :updated_at)', googleClient);
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, tokenOk({ access_token: 'at-1' })));
    expect(await h.service.getAccessToken('g1')).toBe('at-1');
    expect(health('g1')?.status).toBe('ok');
    h.ctx.db.run(`DELETE FROM oauth_clients WHERE provider = 'google'`);
    await expect(h.core.refreshNow('g1')).rejects.toMatchObject({ code: 'not_configured' });
    expect(lines('account cannot refresh access: its OAuth client is not configured')).toHaveLength(2);
  });

  it('a locked vault is warned once per account and recorded as vault_locked', async () => {
    seedAccount(h, { id: 'm1', kind: 'microsoft', refreshToken: 'rt-m1' });
    h.ctx.vault.setState('locked');
    for (const id of ['g1', 'g1', 'm1']) await expect(h.service.getAccessToken(id)).rejects.toMatchObject({ code: 'reauth_required' });
    expect(lines('account cannot refresh access: the credential vault is locked').map((l) => l.fields.accountId)).toEqual(['g1', 'm1']);
    expect(health('g1')).toMatchObject({ lastCode: 'vault_locked', consecutiveFailures: 2 });
    expect(storedStatus('g1')?.status).toBe('ok');
  });

  it('never replace the reason of an account that needs reauth (nor does a 429 of its connection test)', async () => {
    h.service.setStatus('g1', 'reauth', MESSAGES.grantExpired, { reason: 'invalid_grant', source: 'accounts' });
    const before = health('g1');
    expect(before).toMatchObject({ status: 'failing', lastCode: 'invalid_grant', consecutiveFailures: 1 });

    // A locked vault (e.g. the transient DPAPI lock at start-up): still warned, not recorded.
    h.ctx.vault.setState('locked');
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ code: 'reauth_required' });
    expect(lines('account cannot refresh access: the credential vault is locked')).toHaveLength(1);
    h.ctx.vault.setState('ready');
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ code: 'reauth_required' });
    expect(health('g1')).toEqual(before);

    // A connection test refreshes despite the reauth: rate limited, then the client is gone.
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, { status: 429, json: { error: 'rate_limit_exceeded' } }, { times: 1 }));
    await expect(h.core.refreshNow('g1')).rejects.toMatchObject({ code: 'rate_limited' });
    h.ctx.db.run(`DELETE FROM oauth_clients WHERE provider = 'google'`);
    await expect(h.core.refreshNow('g1')).rejects.toMatchObject({ code: 'not_configured' });
    expect(health('g1')).toEqual(before);
    expect(storedStatus('g1')?.status).toBe('reauth');
  });
});

describe('withToken', () => {
  beforeEach(() => {
    seedAccount(h, { id: 'g1', kind: 'google', refreshToken: 'rt-g1' });
    let n = 0;
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, () => tokenOk({ access_token: `at-${++n}` })));
  });

  it('a second 401 after the forced refresh warns with the caller purpose and records token_rejected', async () => {
    await expect(
      withLogContext({ area: 'calendar', op: 'sync' }, () =>
        h.service.withToken('g1', async () => {
          throw new ProviderUnauthorizedError('Google rejected the access token');
        }),
      ),
    ).rejects.toMatchObject({ code: 'reauth_required' });
    expect(lines('provider rejected the access token; refreshing')[0]?.fields).toMatchObject({ accountId: 'g1', purpose: 'calendar.sync' });
    const [warned] = lines('provider rejected a freshly refreshed token');
    expect(warned).toMatchObject({ level: 'warn', fields: { accountId: 'g1', purpose: 'calendar.sync' } });
    expect(lines('account status changed')[0]?.fields).toMatchObject({ to: 'reauth', reason: 'token_rejected', source: 'accounts' });
    expect(health('g1')).toMatchObject({ status: 'failing', lastCode: 'token_rejected', lastMessage: MESSAGES.tokenRejected });
    // One warning for the event: the health transition is info.
    expect(lines('accounts failing')[0]?.level).toBe('info');
    expect(log.lines().filter((l) => l.level === 'warn')).toEqual([warned]);
  });
});

describe('connect, save, test and delete', () => {
  async function connectGoogle(body: Record<string, unknown> = {}): Promise<string | null> {
    const started = await testRequest(h.app, 'POST', '/api/oauth/google/start', { body });
    const state = new URL(((await started.json()) as OAuthStartResponse).authorizeUrl).searchParams.get('state') ?? '';
    const res = await testRequest(h.app, 'GET', `/api/oauth/google/callback?code=c1&state=${state}`, {
      headers: { 'X-Portly': null, 'Sec-Fetch-Site': 'cross-site' },
    });
    return res.headers.get('location');
  }

  it('OAuth: a new account is recorded ok; a reconnect resets reauth through applyAccountStatus', async () => {
    h.fake.add(
      route(GOOGLE_TOKEN_ENDPOINT, () =>
        tokenOk({ access_token: 'g-at', refresh_token: 'g-rt', scope: GOOGLE_SCOPES.join(' '), id_token: googleIdToken(h.clock.now) }),
      ),
    );
    expect(await connectGoogle()).toContain('oauth=connected');
    const id = h.service.list()[0]?.id ?? '';
    expect(health(id)).toMatchObject({ status: 'ok', detail: { reason: 'connected' } });
    expect(lines('account status changed')).toEqual([]);
    // A new account has no id before its code exchange.
    expect(fetches).toEqual([{ url: GOOGLE_TOKEN_ENDPOINT, purpose: 'oauth.token', accountId: undefined }]);

    h.service.setStatus(id, 'reauth', 'Reconnect', { reason: 'invalid_grant', source: 'accounts' });
    expect(await connectGoogle({ accountId: id })).toContain('oauth=reconnected');
    expect(lines('account status changed').at(-1)?.fields).toMatchObject({ accountId: id, from: 'reauth', to: 'ok', reason: 'reconnected', source: 'accounts' });
    expect(h.service.get(id)).toMatchObject({ status: 'ok', statusMessage: null });
    expect(health(id)?.status).toBe('ok');
    // The reconnect's code exchange ran in the account's context.
    expect(fetches[1]).toEqual({ url: GOOGLE_TOKEN_ENDPOINT, purpose: 'oauth.token', accountId: id });
  });

  it('app-password: save and re-add are recorded ok; a rejected password sets the CalDAV/IMAP reason', async () => {
    const created = (await (await testRequest(h.app, 'POST', '/api/accounts/yahoo', { body: { email: 'me@yahoo.com', appPassword: 'pw-1' } })).json()) as AccountCreateResult;
    const id = created.account.id;
    expect(health(id)).toMatchObject({ status: 'ok', detail: { reason: 'connected' } });

    // What the real probes throw: CalDAV discovery's 401 (an HttpError `forbidden` keeping the
    // upstream 401), and the IMAP probe's 422 naming its health code in `details.reason`.
    let rejected: 'calendar' | 'mail' | 'none' = 'calendar';
    h.service.registerProbe('calendar', ['yahoo'], async () => {
      if (rejected === 'calendar') throw new DavHttpError(401, 'The server rejected the username or password');
      return {};
    });
    h.service.registerProbe('mail', ['yahoo'], async () => {
      if (rejected === 'mail') {
        throw new HttpError(422, 'validation_failed', {
          message: 'The mail server rejected the username or password',
          details: { reason: 'imap_password_rejected' },
        });
      }
      return {};
    });
    const tested = await testRequest(h.app, 'POST', `/api/accounts/${id}/test`, { body: {} });
    // The API keeps the probe's own code; the status and health say what it means.
    expect(((await tested.json()) as AccountTestResult).results.calendar).toMatchObject({ ok: false, code: 'forbidden' });
    expect(storedStatus(id)).toEqual({ status: 'reauth', status_message: 'Calendar: The server rejected the username or password' });
    expect(health(id)).toMatchObject({
      status: 'failing',
      lastCode: 'caldav_password_rejected',
      lastStatus: 401,
      detail: { calendar: 'caldav_password_rejected', source: 'accounts' },
    });
    expect(lines('account status changed').at(-1)?.fields).toMatchObject({ accountId: id, to: 'reauth', reason: 'caldav_password_rejected' });
    // The probe failure is debug detail with error fields only; the test ran in the account's context.
    expect(lines('account probe failed')[0]).toMatchObject({
      level: 'debug',
      fields: { capability: 'calendar', kind: 'yahoo', errName: 'DavHttpError', upstreamStatus: 401, accountId: id, op: 'test' },
    });

    rejected = 'mail';
    await testRequest(h.app, 'POST', `/api/accounts/${id}/test`, { body: {} });
    expect(storedStatus(id)?.status).toBe('reauth');
    expect(health(id)).toMatchObject({ lastCode: 'imap_password_rejected', lastStatus: null, detail: { mail: 'imap_password_rejected' } });

    rejected = 'none';
    const readded = await testRequest(h.app, 'POST', '/api/accounts/yahoo', { body: { email: 'me@yahoo.com', appPassword: 'pw-2' } });
    expect(readded.status).toBe(200);
    expect(lines('account status changed').at(-1)?.fields).toMatchObject({ accountId: id, from: 'reauth', to: 'ok', reason: 'reconnected' });
    expect(health(id)?.status).toBe('ok');

    // Any other failure is an error with its health code (here: the mail server refused the connection).
    h.service.registerProbe('mail', ['yahoo'], async () => {
      throw new HttpError(502, 'provider_error', {
        message: 'Could not reach the mail server',
        cause: Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }),
      });
    });
    await testRequest(h.app, 'POST', `/api/accounts/${id}/test`, { body: {} });
    expect(storedStatus(id)?.status).toBe('error');
    expect(health(id)).toMatchObject({ status: 'failing', lastCode: 'refused', detail: { mail: 'refused' } });
  });

  it('a connection test that times out sets status error with reason timeout', async () => {
    seedAccount(h, { id: 'c1', kind: 'caldav', capabilities: ['calendar'], password: 'pw', config: { username: 'me', caldav: { serverUrl: 'https://dav.example.com/', credentialOrigins: ['https://dav.example.com'], insecureLan: false } } });
    h.service.registerProbe('calendar', ['caldav'], async () => {
      throw new HttpError(504, 'upstream_timeout', 'The CalDAV server did not respond');
    });
    await testRequest(h.app, 'POST', '/api/accounts/c1/test', { body: {} });
    expect(storedStatus('c1')).toEqual({ status: 'error', status_message: 'Calendar: The CalDAV server did not respond' });
    expect(health('c1')).toMatchObject({ lastCode: 'timeout', detail: { calendar: 'timeout' } });
  });

  it('deleting an account forgets its health subjects; the revocation names its purpose', async () => {
    seedAccount(h, { id: 'g1', kind: 'google', refreshToken: 'google-rt' });
    h.fake.add(route(GOOGLE_REVOKE_ENDPOINT, { status: 200, json: {} }));
    h.service.setStatus('g1', 'error', 'Calendar list failed', { reason: 'calendar_list_failed', source: 'calendar' });
    h.ctx.health.record({ key: 'mail:g1', area: 'mail', accountId: 'g1' }, { ok: true });
    h.ctx.health.record({ key: 'calendar:cal-1', area: 'calendar', accountId: 'g1' }, { ok: true });
    expect(health('g1')).not.toBeNull();

    expect((await testRequest(h.app, 'DELETE', '/api/accounts/g1')).status).toBe(204);
    await h.core.settle();
    expect(health('g1')).toBeNull();
    expect(h.ctx.health.get('mail:g1')).toBeNull();
    expect(h.ctx.health.get('calendar:cal-1')).toBeNull();
    expect(fetches).toEqual([{ url: GOOGLE_REVOKE_ENDPOINT, purpose: 'oauth.revoke', accountId: 'g1' }]);
    expect(lines('oauth token revoked')[0]?.fields).toMatchObject({ accountId: 'g1', host: 'oauth2.googleapis.com' });
    // A late outcome of the deleted account never recreates its subject.
    h.service.setStatus('g1', 'reauth', 'Reconnect');
    expect(health('g1')).toBeNull();
  });

  it('a revocation that fails is logged with the deleted account', async () => {
    seedAccount(h, { id: 'g1', kind: 'google', refreshToken: 'google-rt' });
    h.fake.add(
      route(GOOGLE_REVOKE_ENDPOINT, () => {
        throw new Error('ECONNRESET');
      }),
    );
    expect((await testRequest(h.app, 'DELETE', '/api/accounts/g1')).status).toBe(204);
    await h.core.settle();
    const [failed] = lines('background task failed');
    expect(failed).toMatchObject({ level: 'warn', fields: { task: 'oauth-revoke', accountId: 'g1', errName: 'SafeFetchError' } });
    expect(JSON.stringify(failed)).not.toContain('google-rt');
  });
});

describe('privacy', () => {
  it('no token, code, client secret or provider text reaches the log or the health tracker', async () => {
    seedAccount(h, { id: 'g1', kind: 'google', refreshToken: 'rt-secret-g1' });
    h.fake.add(
      route(GOOGLE_TOKEN_ENDPOINT, tokenOk({ access_token: 'at-secret-1', refresh_token: 'rt-secret-rotated' }), { times: 1 }),
      route(GOOGLE_TOKEN_ENDPOINT, tokenError('invalid_grant')),
    );
    await h.service.getAccessToken('g1');
    await h.core.refreshNow('g1').catch(() => {});
    h.ctx.health.flush();
    const text = JSON.stringify([log.lines(), h.ctx.health.list(), h.ctx.health.history('account:g1')]);
    for (const secret of ['rt-secret-g1', 'at-secret-1', 'rt-secret-rotated', GOOGLE_CLIENT_SECRET, '<script>', 'from provider']) {
      expect(text).not.toContain(secret);
    }
    expect(health('g1')?.lastCode).toBe('invalid_grant');
  });
});
