import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderUnauthorizedError } from '../../lib/errors.ts';
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_TOKEN_ENDPOINT,
  MICROSOFT_CLIENT_ID,
  MICROSOFT_SCOPES,
  MICROSOFT_TOKEN_ENDPOINT,
  configureClients,
  createAccountsHarness,
  deferred,
  formOf,
  formsSentTo,
  route,
  seedAccount,
  storedRefreshToken,
  tokenError,
  tokenOk,
  type AccountsHarness,
} from './__fixtures__/oauth.ts';
import { REFRESH_MARGIN_MS } from './service.ts';
import { accountSecretId } from './store.ts';

const MINUTE = 60 * 1000;

let h: AccountsHarness;

beforeEach(() => {
  h = createAccountsHarness();
  configureClients(h);
});
afterEach(async () => {
  await h.core.settle();
  h.ctx.close();
});

function statusOf(id: string): { status: string; message: string | null } {
  const account = h.service.get(id);
  return { status: account?.status ?? 'missing', message: account?.statusMessage ?? null };
}

describe('AccountService: listing and config', () => {
  beforeEach(() => {
    seedAccount(h, { id: 'g1', kind: 'google', capabilities: ['calendar', 'mail'], refreshToken: 'rt-g1' });
    h.ctx.db.run(`UPDATE accounts SET enabled_capabilities = '["calendar"]', color = '#AABBCC' WHERE id = 'g1'`);
    seedAccount(h, {
      id: 'y1',
      kind: 'yahoo',
      capabilities: ['mail'],
      config: { username: 'me@yahoo.com', imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls' } },
      password: 'app-pw',
    });
  });

  it('lists accounts in sort order, filtered by kind and by *enabled* capability', () => {
    expect(h.service.list().map((a) => a.id)).toEqual(['g1', 'y1']);
    expect(h.service.list({ kind: 'yahoo' }).map((a) => a.id)).toEqual(['y1']);
    expect(h.service.list({ capability: 'mail' }).map((a) => a.id)).toEqual(['y1']);
    expect(h.service.list({ capability: 'calendar' }).map((a) => a.id)).toEqual(['g1']);
    const g1 = h.service.get('g1');
    expect(g1).toMatchObject({ kind: 'google', capabilities: ['calendar', 'mail'], enabledCapabilities: ['calendar'], color: '#aabbcc', status: 'ok' });
    expect(g1?.createdAt).toBe(new Date(h.clock.now).toISOString());
    expect(h.service.get('nope')).toBeNull();
  });

  it('returns the validated per-kind config, 404 for unknown ids and 500 for corrupt configs', () => {
    expect(h.service.getConfig<'yahoo'>('y1')).toMatchObject({ username: 'me@yahoo.com', imap: { host: 'imap.mail.yahoo.com', webmailUrl: null } });
    expect(() => h.service.getConfig('nope')).toThrow(expect.objectContaining({ status: 404 }));
    h.ctx.db.run(`UPDATE accounts SET config = '{"imap":{}}' WHERE id = 'y1'`);
    expect(() => h.service.getConfig('y1')).toThrow(expect.objectContaining({ status: 500, code: 'internal' }));
  });

  it('reports every account as reauth while the vault is locked (without changing the stored status)', () => {
    h.ctx.vault.setState('locked');
    expect(h.service.list().map((a) => a.status)).toEqual(['reauth', 'reauth']);
    h.ctx.vault.setState('ready');
    expect(h.service.list().map((a) => a.status)).toEqual(['ok', 'ok']);
  });
});

describe('AccountService.getAccessToken', () => {
  beforeEach(() => {
    seedAccount(h, { id: 'g1', kind: 'google', refreshToken: 'rt-g1' });
    seedAccount(h, { id: 'm1', kind: 'microsoft', refreshToken: 'rt-m1' });
  });

  it('refreshes with the client secret, caches in memory and refreshes again 5 min before expiry', async () => {
    let n = 0;
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, () => tokenOk({ access_token: `at-${++n}`, expires_in: 3600 })));

    expect(await h.service.getAccessToken('g1')).toBe('at-1');
    expect(formsSentTo(h.fake, GOOGLE_TOKEN_ENDPOINT)).toEqual([
      { client_id: GOOGLE_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'rt-g1', client_secret: GOOGLE_CLIENT_SECRET },
    ]);
    h.clock.advance(60 * MINUTE - REFRESH_MARGIN_MS - 1);
    expect(await h.service.getAccessToken('g1')).toBe('at-1');
    h.clock.advance(1);
    expect(await h.service.getAccessToken('g1')).toBe('at-2');
    expect(h.fake.calls).toHaveLength(2);
    // Access tokens are never persisted.
    expect(JSON.stringify(h.ctx.db.all('SELECT * FROM accounts'))).not.toContain('at-');
    expect(h.ctx.vault.get(accountSecretId('g1'))).toBe(JSON.stringify({ refreshToken: 'rt-g1' }));
  });

  it('is single-flight per account: concurrent callers share one refresh request', async () => {
    const gate = deferred<void>();
    h.fake.add(
      route(GOOGLE_TOKEN_ENDPOINT, async () => {
        await gate.promise;
        return tokenOk({ access_token: 'at-shared' });
      }),
    );
    const pending = Array.from({ length: 5 }, () => h.service.getAccessToken('g1'));
    await new Promise((r) => setTimeout(r, 10));
    gate.resolve();
    expect(await Promise.all(pending)).toEqual(Array(5).fill('at-shared'));
    expect(h.fake.calls).toHaveLength(1);
  });

  it('Microsoft: public client (no secret, scopes repeated) and rotated refresh tokens persisted before resolving', async () => {
    let n = 0;
    h.fake.add(route(MICROSOFT_TOKEN_ENDPOINT, () => tokenOk({ access_token: `mat-${++n}`, refresh_token: `rt-m1-v${n + 1}`, expires_in: 3600 })));

    const token = await h.service.getAccessToken('m1');
    expect(token).toBe('mat-1');
    expect(storedRefreshToken(h, 'm1')).toBe('rt-m1-v2');
    const [first] = formsSentTo(h.fake, MICROSOFT_TOKEN_ENDPOINT);
    expect(first).toEqual({ client_id: MICROSOFT_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'rt-m1', scope: MICROSOFT_SCOPES.join(' ') });
    expect(first).not.toHaveProperty('client_secret');

    h.clock.advance(60 * MINUTE);
    expect(await h.service.getAccessToken('m1')).toBe('mat-2');
    expect(formsSentTo(h.fake, MICROSOFT_TOKEN_ENDPOINT)[1]?.refresh_token).toBe('rt-m1-v2');
    expect(storedRefreshToken(h, 'm1')).toBe('rt-m1-v3');
  });

  it('Microsoft: a refresh asks only for the scopes of the services the account was granted', async () => {
    seedAccount(h, { id: 'm2', kind: 'microsoft', capabilities: ['calendar'], refreshToken: 'rt-m2' });
    h.fake.add(route(MICROSOFT_TOKEN_ENDPOINT, () => tokenOk({ access_token: 'mat', expires_in: 3600 })));
    expect(await h.service.getAccessToken('m2')).toBe('mat');
    expect(formsSentTo(h.fake, MICROSOFT_TOKEN_ENDPOINT)[0]?.scope).toBe('openid profile email offline_access User.Read Calendars.ReadWrite');
  });

  it('invalid_grant with the stored refresh token → reauth (no further refresh attempts)', async () => {
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, tokenError('invalid_grant')));
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ status: 409, code: 'reauth_required', accountId: 'g1' });
    expect(statusOf('g1').status).toBe('reauth');
    expect(statusOf('g1').message).not.toContain('script');
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ code: 'reauth_required' });
    expect(h.fake.calls).toHaveLength(1);
  });

  it('invalid_grant for a refresh token replaced meanwhile (reconnect) → no reauth; retries with the new grant', async () => {
    h.fake.add(
      route(
        GOOGLE_TOKEN_ENDPOINT,
        () => {
          // The user reconnected while this refresh was in flight.
          h.ctx.vault.put(accountSecretId('g1'), JSON.stringify({ refreshToken: 'rt-g1-new' }));
          return tokenError('invalid_grant');
        },
        { times: 1 },
      ),
      route(GOOGLE_TOKEN_ENDPOINT, (req) => (formOf(req).refresh_token === 'rt-g1-new' ? tokenOk({ access_token: 'at-new' }) : tokenError('invalid_grant'))),
    );
    expect(await h.service.getAccessToken('g1')).toBe('at-new');
    expect(statusOf('g1').status).toBe('ok');
    expect(formsSentTo(h.fake, GOOGLE_TOKEN_ENDPOINT).map((f) => f.refresh_token)).toEqual(['rt-g1', 'rt-g1-new']);
  });

  it('never overwrites a refresh token stored by a reconnect with a rotation of the old grant', async () => {
    h.fake.add(
      route(MICROSOFT_TOKEN_ENDPOINT, () => {
        h.ctx.vault.put(accountSecretId('m1'), JSON.stringify({ refreshToken: 'rt-from-reconnect' }));
        return tokenOk({ access_token: 'mat-old-grant', refresh_token: 'rt-rotated-old' });
      }),
    );
    expect(await h.service.getAccessToken('m1')).toBe('mat-old-grant');
    expect(storedRefreshToken(h, 'm1')).toBe('rt-from-reconnect');
  });

  it('never resurrects the secret of an account deleted during a refresh', async () => {
    h.fake.add(
      route(MICROSOFT_TOKEN_ENDPOINT, () => {
        h.ctx.db.run(`DELETE FROM accounts WHERE id = 'm1'`);
        h.ctx.vault.delete(accountSecretId('m1'));
        return tokenOk({ access_token: 'mat', refresh_token: 'rt-rotated' });
      }),
    );
    await expect(h.service.getAccessToken('m1')).rejects.toMatchObject({ status: 404 });
    expect(h.ctx.vault.has(accountSecretId('m1'))).toBe(false);
  });

  it('network failures and 5xx set status=error (never reauth); a later success clears it', async () => {
    h.fake.add(
      route(
        GOOGLE_TOKEN_ENDPOINT,
        () => {
          throw new Error('ECONNRESET');
        },
        { times: 1 },
      ),
      route(GOOGLE_TOKEN_ENDPOINT, { status: 503, text: 'Service Unavailable' }, { times: 1 }),
      route(GOOGLE_TOKEN_ENDPOINT, tokenOk({ access_token: 'at-ok' })),
    );
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ status: 502, code: 'provider_error', accountId: 'g1' });
    expect(statusOf('g1')).toEqual({ status: 'error', message: 'Could not reach Google to refresh access' });
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ status: 502, code: 'provider_error' });
    expect(statusOf('g1')).toEqual({ status: 'error', message: 'Google could not refresh access right now' });
    expect(await h.service.getAccessToken('g1')).toBe('at-ok');
    expect(statusOf('g1')).toEqual({ status: 'ok', message: null });
  });

  it('a transport failure never downgrades a reauth status', async () => {
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, { status: 500, text: 'oops' }));
    h.service.setStatus('g1', 'reauth', 'Reconnect');
    await expect(h.core.refreshNow('g1')).rejects.toMatchObject({ code: 'provider_error' });
    expect(statusOf('g1').status).toBe('reauth');
  });

  it('maps rejected clients to status=error and 429 to rate_limited', async () => {
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, tokenError('invalid_client', 401), { times: 1 }), route(GOOGLE_TOKEN_ENDPOINT, { status: 429, json: {} }));
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ status: 502, code: 'provider_error' });
    expect(statusOf('g1')).toEqual({ status: 'error', message: 'Google rejected the OAuth client; check its settings and reconnect' });
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ status: 429, code: 'rate_limited', accountId: 'g1' });
  });

  it('refuses app-password accounts, unknown ids, a locked vault, missing credentials and missing clients', async () => {
    seedAccount(h, { id: 'y1', kind: 'yahoo', password: 'pw' });
    await expect(h.service.getAccessToken('y1')).rejects.toMatchObject({ status: 400 });
    await expect(h.service.getAccessToken('nope')).rejects.toMatchObject({ status: 404 });

    h.ctx.vault.setState('locked');
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ status: 409, code: 'reauth_required', accountId: 'g1' });
    h.ctx.vault.setState('ready');

    h.ctx.vault.delete(accountSecretId('g1'));
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ code: 'reauth_required' });
    expect(statusOf('g1').status).toBe('reauth');

    h.ctx.db.run(`DELETE FROM oauth_clients WHERE provider = 'microsoft'`);
    await expect(h.service.getAccessToken('m1')).rejects.toMatchObject({ status: 409, code: 'not_configured', accountId: 'm1' });
    expect(h.fake.calls).toHaveLength(0);
  });

  it('drops a cached token once its credentials are gone (e.g. vault reset)', async () => {
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, tokenOk({ access_token: 'at-1' })));
    expect(await h.service.getAccessToken('g1')).toBe('at-1');
    await h.ctx.vault.reset();
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ code: 'reauth_required' });
  });
});

describe('AccountService.withToken', () => {
  beforeEach(() => {
    seedAccount(h, { id: 'g1', kind: 'google', refreshToken: 'rt-g1' });
    let n = 0;
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, () => tokenOk({ access_token: `at-${++n}` })));
  });

  it('on a provider 401 forces one refresh and retries once', async () => {
    await h.service.getAccessToken('g1'); // at-1 cached
    const seen: string[] = [];
    const result = await h.service.withToken('g1', async (token) => {
      seen.push(token);
      if (token === 'at-1') throw new ProviderUnauthorizedError('401');
      return 'data';
    });
    expect(result).toBe('data');
    expect(seen).toEqual(['at-1', 'at-2']);
    expect(h.fake.calls).toHaveLength(2);
    expect(statusOf('g1').status).toBe('ok');
  });

  it('a second 401 with a fresh token → reauth', async () => {
    await expect(
      h.service.withToken('g1', async () => {
        throw new ProviderUnauthorizedError('401');
      }),
    ).rejects.toMatchObject({ status: 409, code: 'reauth_required', accountId: 'g1' });
    expect(statusOf('g1').status).toBe('reauth');
    expect(h.fake.calls).toHaveLength(2);
  });

  it('concurrent 401s share a single forced refresh', async () => {
    await h.service.getAccessToken('g1');
    const call = () =>
      h.service.withToken('g1', async (token) => {
        await new Promise((r) => setTimeout(r, 1));
        if (token === 'at-1') throw new ProviderUnauthorizedError('401');
        return token;
      });
    expect(await Promise.all([call(), call(), call()])).toEqual(['at-2', 'at-2', 'at-2']);
    expect(h.fake.calls).toHaveLength(2);
  });

  it('passes other errors through without refreshing', async () => {
    await expect(
      h.service.withToken('g1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(h.fake.calls).toHaveLength(1);
  });
});

describe('AccountService: secrets, status, probes and events', () => {
  it('returns app passwords; refuses OAuth kinds; missing secret → reauth; locked vault → reauth_required', async () => {
    seedAccount(h, { id: 'y1', kind: 'yahoo', password: 'app-pw' });
    seedAccount(h, { id: 'g1', kind: 'google', refreshToken: 'rt' });
    seedAccount(h, { id: 'i1', kind: 'imap' });
    expect(await h.service.getSecret('y1')).toEqual({ password: 'app-pw' });
    await expect(h.service.getSecret('g1')).rejects.toMatchObject({ status: 400 });
    await expect(h.service.getSecret('nope')).rejects.toMatchObject({ status: 404 });
    await expect(h.service.getSecret('i1')).rejects.toMatchObject({ code: 'reauth_required', accountId: 'i1' });
    expect(statusOf('i1').status).toBe('reauth');
    h.ctx.vault.setState('locked');
    await expect(h.service.getSecret('y1')).rejects.toMatchObject({ code: 'reauth_required', accountId: 'y1' });
  });

  it('setStatus persists status + bounded message, ignores unknown ids and rejects invalid statuses', () => {
    seedAccount(h, { id: 'y1', kind: 'yahoo', password: 'pw' });
    h.service.setStatus('y1', 'error', 'IMAP timeout');
    expect(statusOf('y1')).toEqual({ status: 'error', message: 'IMAP timeout' });
    h.service.setStatus('y1', 'ok');
    expect(statusOf('y1')).toEqual({ status: 'ok', message: null });
    h.service.setStatus('y1', 'error', 'x'.repeat(2000));
    expect(statusOf('y1').message).toHaveLength(500);
    expect(() => h.service.setStatus('nope', 'ok')).not.toThrow();
    expect(() => h.service.setStatus('y1', 'broken' as never)).toThrow(TypeError);
  });

  it('validates probe registrations', () => {
    expect(() => h.service.registerProbe('calendar', ['caldav', 'yahoo'], async () => ({}))).not.toThrow();
    expect(() => h.service.registerProbe('weather' as never, ['caldav'], async () => ({}))).toThrow(TypeError);
    expect(() => h.service.registerProbe('mail', ['proton' as never], async () => ({}))).toThrow(TypeError);
  });

  it('isolates failing change listeners', () => {
    const seen: string[] = [];
    h.service.onChange(() => {
      throw new Error('listener bug');
    });
    h.service.onChange(async () => {
      throw new Error('async listener bug');
    });
    h.service.onChange((e) => seen.push(`${e.type}:${e.accountId}`));
    h.core.emit({ type: 'updated', accountId: 'a1' });
    expect(seen).toEqual(['updated:a1']);
  });
});
