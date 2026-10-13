import type { Account, AccountCreateResult, AccountDraft, AccountTestResult, ValidationIssue } from '@homebase/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../lib/errors.ts';
import { testRequest } from '../../testing/test-request.ts';
import {
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  MICROSOFT_TOKEN_ENDPOINT,
  configureClients,
  createAccountsHarness,
  deferred,
  formOf,
  route,
  seedAccount,
  tokenError,
  tokenOk,
  type AccountsHarness,
} from './__fixtures__/oauth.ts';
import type { LookupFn } from './net.ts';
import { accountSecretId } from './store.ts';

let h: AccountsHarness;
const lookups: string[] = [];
const fakeLookup: LookupFn = async (hostname) => {
  lookups.push(hostname);
  if (hostname === 'nas.lan') return [{ address: '192.168.1.20', family: 4 }];
  if (hostname === 'mixed.example') return [{ address: '10.0.0.5', family: 4 }, { address: '93.184.216.34', family: 4 }];
  return [{ address: '93.184.216.34', family: 4 }];
};

beforeEach(() => {
  lookups.length = 0;
  h = createAccountsHarness({ lookup: fakeLookup });
});
afterEach(async () => {
  await h.core.settle();
  h.ctx.close();
});

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const post = (path: string, body: unknown) => testRequest(h.app, 'POST', path, { body });

const YAHOO = { email: 'me@yahoo.com', appPassword: 'abcd efgh ijkl mnop' };

describe('GET/PATCH /api/accounts', () => {
  beforeEach(() => {
    seedAccount(h, { id: 'g1', kind: 'google', refreshToken: 'rt', capabilities: ['calendar', 'mail'], label: 'Gmail' });
    seedAccount(h, { id: 'i1', kind: 'imap', capabilities: ['mail'], password: 'pw', label: 'Fastmail' });
  });

  it('lists accounts without any secret', async () => {
    const res = await testRequest(h.app, 'GET', '/api/accounts');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toMatch(/"rt"|"pw"|refreshToken|password/);
    expect((JSON.parse(text) as Account[]).map((a) => a.label)).toEqual(['Gmail', 'Fastmail']);
  });

  it('updates label, normalized color, sort and enabled capabilities; emits updated', async () => {
    const events: string[] = [];
    h.service.onChange((e) => events.push(`${e.type}:${e.accountId}`));
    const res = await testRequest(h.app, 'PATCH', '/api/accounts/g1', {
      body: { label: '  Personal  ', color: '#AABBCC', sort: 5, enabledCapabilities: ['mail', 'mail'] },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ id: 'g1', label: 'Personal', color: '#aabbcc', sort: 5, enabledCapabilities: ['mail'] });
    expect(h.service.list().map((a) => a.id)).toEqual(['i1', 'g1']);
    expect(events).toEqual(['updated:g1']);

    const cleared = await json<Account>(await testRequest(h.app, 'PATCH', '/api/accounts/g1', { body: { color: null } }));
    expect(cleared.color).toBeNull();
  });

  it('cosmetic edits (label, color, sort, unchanged capabilities) do not announce a change (no provider resync)', async () => {
    const events: string[] = [];
    h.service.onChange((e) => events.push(`${e.type}:${e.accountId}`));
    for (const body of [{ color: '#112233' }, { label: 'Renamed' }, { sort: 3 }, { enabledCapabilities: ['mail', 'calendar'] }]) {
      expect((await testRequest(h.app, 'PATCH', '/api/accounts/g1', { body })).status, JSON.stringify(body)).toBe(200);
    }
    expect(h.service.get('g1')).toMatchObject({ label: 'Renamed', color: '#112233', sort: 3 });
    expect(events).toEqual([]);
    await testRequest(h.app, 'PATCH', '/api/accounts/g1', { body: { enabledCapabilities: ['calendar'] } });
    expect(events).toEqual(['updated:g1']);
  });

  it('rejects capabilities the account does not have, bad colors, unknown fields and unknown ids', async () => {
    const res = await testRequest(h.app, 'PATCH', '/api/accounts/i1', { body: { enabledCapabilities: ['calendar'] } });
    expect(res.status).toBe(422);
    expect((await json<{ error: { details: ValidationIssue[] } }>(res)).error.details[0]?.path).toBe('enabledCapabilities');
    for (const body of [{ color: 'red' }, { color: '#abc' }, { status: 'ok' }, { label: '' }]) {
      expect((await testRequest(h.app, 'PATCH', '/api/accounts/i1', { body })).status, JSON.stringify(body)).toBe(422);
    }
    expect((await testRequest(h.app, 'PATCH', '/api/accounts/nope', { body: { label: 'x' } })).status).toBe(404);
    expect(h.service.get('i1')).toMatchObject({ label: 'Fastmail', enabledCapabilities: ['mail'] });
  });
});

describe('DELETE /api/accounts/:id', () => {
  beforeEach(() => {
    configureClients(h);
    seedAccount(h, { id: 'g1', kind: 'google', refreshToken: 'google-rt' });
    h.ctx.db.run(`INSERT INTO calendars (id, account_id, source, remote_id, name) VALUES ('c1', 'g1', 'google', 'primary', 'Main')`);
    h.ctx.db.run(
      `INSERT INTO events (id, calendar_id, remote_id, title, start, "end", all_day, updated_at)
       VALUES ('c1:e1', 'c1', 'e1', 'Standup', '2026-09-25T09:00:00Z', '2026-09-25T09:15:00Z', 0, 1)`,
    );
    h.ctx.db.run(`INSERT INTO calendars (id, account_id, source, remote_id, name) VALUES ('ics1', NULL, 'ics', 'feed', 'Holidays')`);
  });

  it('deletes the account, its secret and cascaded calendars/events in one go; revokes the Google token', async () => {
    h.fake.add(route(GOOGLE_TOKEN_ENDPOINT, tokenOk({ access_token: 'at' })), route(GOOGLE_REVOKE_ENDPOINT, { status: 200, json: {} }));
    await h.service.getAccessToken('g1');
    const events: string[] = [];
    h.service.onChange((e) => events.push(`${e.type}:${e.accountId}`));

    const res = await testRequest(h.app, 'DELETE', '/api/accounts/g1');
    expect(res.status).toBe(204);
    await h.core.settle();

    expect(h.service.get('g1')).toBeNull();
    expect(h.ctx.vault.has(accountSecretId('g1'))).toBe(false);
    expect(h.ctx.db.all('SELECT id FROM calendars')).toEqual([{ id: 'ics1' }]);
    expect(h.ctx.db.all('SELECT id FROM events')).toEqual([]);
    expect(events).toEqual(['deleted:g1']);
    const revoke = h.fake.calls.filter((c) => c.url === GOOGLE_REVOKE_ENDPOINT);
    expect(revoke.map(formOf)).toEqual([{ token: 'google-rt' }]);
    await expect(h.service.getAccessToken('g1')).rejects.toMatchObject({ status: 404 });
  });

  it('revocation is best-effort: failures never undo or fail the deletion', async () => {
    h.fake.add(
      route(GOOGLE_REVOKE_ENDPOINT, () => {
        throw new Error('offline');
      }),
    );
    expect((await testRequest(h.app, 'DELETE', '/api/accounts/g1')).status).toBe(204);
    await h.core.settle();
    expect(h.service.get('g1')).toBeNull();
  });

  it('does not call a revocation endpoint for Microsoft; 404 for unknown ids', async () => {
    seedAccount(h, { id: 'm1', kind: 'microsoft', refreshToken: 'ms-rt' });
    expect((await testRequest(h.app, 'DELETE', '/api/accounts/m1')).status).toBe(204);
    await h.core.settle();
    expect(h.fake.calls).toHaveLength(0);
    expect((await testRequest(h.app, 'DELETE', '/api/accounts/m1')).status).toBe(404);
  });

  it('removes orphaned ICS secrets of the account calendars, whatever the calendar id scheme', async () => {
    // Calendar ids are the calendar module's business and need not be valid vault secret ids.
    h.ctx.db.run(
      `INSERT INTO calendars (id, account_id, source, remote_id, name) VALUES ('g1:en.usa#holiday@group.v.calendar.google.com', 'g1', 'google', 'h', 'Holidays')`,
    );
    h.ctx.db.run(`INSERT INTO calendars (id, account_id, source, remote_id, name) VALUES ('c2', 'g1', 'google', 'c2', 'Other')`);
    h.ctx.vault.put('ics:c2', 'https://example.com/orphan.ics');
    h.ctx.vault.put('ics:ics1', 'https://example.com/holidays.ics');
    h.fake.add(route(GOOGLE_REVOKE_ENDPOINT, { status: 200, json: {} }));

    expect((await testRequest(h.app, 'DELETE', '/api/accounts/g1')).status).toBe(204);
    await h.core.settle();
    expect(h.ctx.db.all('SELECT id FROM calendars')).toEqual([{ id: 'ics1' }]);
    expect(h.ctx.vault.list('ics:')).toEqual(['ics:ics1']);
  });

  it('still deletes while the vault is locked (no revocation possible)', async () => {
    h.ctx.vault.setState('locked');
    expect((await testRequest(h.app, 'DELETE', '/api/accounts/g1')).status).toBe(204);
    await h.core.settle();
    expect(h.fake.calls).toHaveLength(0);
    expect(h.ctx.vault.has(accountSecretId('g1'))).toBe(false);
  });
});

describe('POST /api/accounts/yahoo|caldav|imap', () => {
  it('without registered probes: saves every capability of the kind as "not verified" (Yahoo preset config)', async () => {
    const res = await post('/api/accounts/yahoo', YAHOO);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(YAHOO.appPassword);
    const body = JSON.parse(text) as AccountCreateResult;
    expect(body.probes).toEqual({});
    expect(body.account).toMatchObject({
      kind: 'yahoo',
      label: 'me@yahoo.com',
      email: 'me@yahoo.com',
      capabilities: ['calendar', 'mail'],
      enabledCapabilities: ['calendar', 'mail'],
      status: 'ok',
      statusMessage: 'not verified',
    });
    expect(h.service.getConfig<'yahoo'>(body.account.id)).toEqual({
      username: 'me@yahoo.com',
      caldav: { serverUrl: 'https://caldav.calendar.yahoo.com', credentialOrigins: ['https://caldav.calendar.yahoo.com'], insecureLan: false },
      imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls', webmailUrl: 'https://mail.yahoo.com/' },
    });
    expect(await h.service.getSecret(body.account.id)).toEqual({ password: YAHOO.appPassword });
  });

  it('runs the registered probes: CalDAV failure still allows a mail-only Yahoo account', async () => {
    const drafts: AccountDraft[] = [];
    h.service.registerProbe('calendar', ['yahoo', 'caldav'], async (draft) => {
      drafts.push(draft);
      throw new HttpError(409, 'reauth_required', 'CalDAV rejected the app password');
    });
    h.service.registerProbe('mail', ['yahoo', 'imap'], async (draft) => {
      drafts.push(draft);
      return { configPatch: { imap: { capabilitiesSeen: ['MOVE'] } } };
    });
    const res = await post('/api/accounts/yahoo', YAHOO);
    expect(res.status).toBe(201);
    const body = await json<AccountCreateResult>(res);
    expect(body.probes).toEqual({
      calendar: { ok: false, code: 'reauth_required', message: 'CalDAV rejected the app password' },
      mail: { ok: true },
    });
    expect(body.account).toMatchObject({ capabilities: ['mail'], enabledCapabilities: ['mail'], status: 'ok', statusMessage: null });
    expect(drafts.map((d) => d.secret.password)).toEqual([YAHOO.appPassword, YAHOO.appPassword]);
    expect(drafts[0]).toMatchObject({ kind: 'yahoo', email: 'me@yahoo.com' });
    // The passing probe's config patch is merged one level deep.
    expect(h.service.getConfig<'yahoo'>(body.account.id).imap).toMatchObject({ host: 'imap.mail.yahoo.com', capabilitiesSeen: ['MOVE'] });
  });

  it('422 with one issue per capability when every probe fails; nothing is stored', async () => {
    h.service.registerProbe('calendar', ['yahoo'], async () => {
      throw new HttpError(504, 'upstream_timeout', 'CalDAV server timed out');
    });
    h.service.registerProbe('mail', ['yahoo'], async () => {
      throw new Error('AUTHENTICATIONFAILED raw server text');
    });
    const res = await post('/api/accounts/yahoo', YAHOO);
    expect(res.status).toBe(422);
    const body = await json<{ error: { code: string; details: ValidationIssue[] } }>(res);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details).toEqual([
      { path: 'calendar', code: 'upstream_timeout', message: 'CalDAV server timed out' },
      { path: 'mail', code: 'provider_error', message: 'Mail connection test failed' },
    ]);
    expect(h.service.list()).toEqual([]);
    expect(h.ctx.vault.list('account:')).toEqual([]);
  });

  it('a probe returning an invalid config patch counts as failed', async () => {
    h.service.registerProbe('mail', ['imap'], async () => ({ configPatch: { imap: { port: 'not-a-port' } } }));
    const res = await post('/api/accounts/imap', { label: 'Mail', host: 'imap.example.com', port: 993, security: 'tls', username: 'u', password: 'p' });
    expect(res.status).toBe(422);
  });

  it('re-adding the same login updates the existing account (new password, status reset, label kept)', async () => {
    const first = await json<AccountCreateResult>(await post('/api/accounts/yahoo', YAHOO));
    await testRequest(h.app, 'PATCH', `/api/accounts/${first.account.id}`, { body: { label: 'Yahoo!' } });
    h.service.setStatus(first.account.id, 'reauth', 'Wrong password');
    const res = await post('/api/accounts/yahoo', { email: 'ME@yahoo.com', appPassword: 'new-password' });
    expect(res.status).toBe(200);
    const body = await json<AccountCreateResult>(res);
    expect(body.account.id).toBe(first.account.id);
    expect(body.account).toMatchObject({ label: 'Yahoo!', status: 'ok' });
    expect(await h.service.getSecret(first.account.id)).toEqual({ password: 'new-password' });
    expect(h.service.list()).toHaveLength(1);
  });

  it('CalDAV: https required; http only with insecureLan for private hosts', async () => {
    const base = { label: 'NAS', username: 'me', password: 'pw' };
    const cases: [Record<string, unknown>, number][] = [
      [{ serverUrl: 'http://93.184.216.34/dav/', insecureLan: true }, 422],
      [{ serverUrl: 'http://192.168.1.20:5232/', insecureLan: false }, 422],
      [{ serverUrl: 'http://public.example/dav/', insecureLan: true }, 422],
      [{ serverUrl: 'http://mixed.example/dav/', insecureLan: true }, 422],
      [{ serverUrl: 'ftp://192.168.1.20/' }, 422],
      [{ serverUrl: 'https://user:pw@dav.example.com/' }, 422],
    ];
    for (const [extra, status] of cases) {
      expect((await post('/api/accounts/caldav', { ...base, ...extra })).status, JSON.stringify(extra)).toBe(status);
    }
    expect(h.service.list()).toEqual([]);

    const lan = await json<AccountCreateResult>(await post('/api/accounts/caldav', { ...base, serverUrl: 'http://nas.lan:5232/dav/#x', insecureLan: true }));
    expect(h.service.getConfig<'caldav'>(lan.account.id).caldav).toEqual({
      serverUrl: 'http://nas.lan:5232/dav/',
      credentialOrigins: ['http://nas.lan:5232'],
      insecureLan: true,
    });
    const literal = await post('/api/accounts/caldav', { ...base, username: 'other', serverUrl: 'http://[fd00::20]:5232/', insecureLan: true });
    expect(literal.status).toBe(201);
    const https = await json<AccountCreateResult>(
      await post('/api/accounts/caldav', { label: 'Fastmail', username: 'me@fastmail.com', password: 'pw', serverUrl: 'https://caldav.fastmail.com/dav/', insecureLan: true }),
    );
    expect(https.account).toMatchObject({ kind: 'caldav', label: 'Fastmail', email: 'me@fastmail.com', capabilities: ['calendar'] });
    expect(h.service.getConfig<'caldav'>(https.account.id).caldav.insecureLan).toBe(false);
    expect(lookups).toEqual(['public.example', 'mixed.example', 'nas.lan']);
  });

  it('IMAP: tls/starttls only; host normalized; webmailUrl stored', async () => {
    const base = { label: 'Work mail', host: 'IMAP.Example.com.', port: 143, username: 'me@example.com', password: 'pw' };
    expect((await post('/api/accounts/imap', { ...base, security: 'none' })).status).toBe(422);
    expect((await post('/api/accounts/imap', { ...base, security: 'tls', webmailUrl: 'javascript:alert(1)' })).status).toBe(422);
    const res = await post('/api/accounts/imap', { ...base, security: 'starttls', webmailUrl: 'https://mail.example.com' });
    expect(res.status).toBe(201);
    const body = await json<AccountCreateResult>(res);
    expect(body.account).toMatchObject({ kind: 'imap', capabilities: ['mail'], email: 'me@example.com' });
    expect(h.service.getConfig<'imap'>(body.account.id)).toEqual({
      username: 'me@example.com',
      imap: { host: 'imap.example.com', port: 143, security: 'starttls', webmailUrl: 'https://mail.example.com/' },
    });
  });

  it('refuses to create accounts while the vault is locked', async () => {
    h.ctx.vault.setState('locked');
    const res = await post('/api/accounts/yahoo', YAHOO);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: { code: 'reauth_required' } });
  });
});

describe('POST /api/accounts/:id/test', () => {
  it('app-password: re-runs probes, adds newly passing capabilities, never removes one, updates status', async () => {
    const created = await json<AccountCreateResult>(await post('/api/accounts/yahoo', YAHOO));
    const id = created.account.id;
    let calendarOk = false;
    h.service.registerProbe('calendar', ['yahoo'], async () => {
      if (!calendarOk) throw new HttpError(409, 'reauth_required', 'Password rejected');
      return { configPatch: { caldav: { principalUrl: 'https://caldav.calendar.yahoo.com/principals/me/' } } };
    });
    h.service.registerProbe('mail', ['yahoo'], async () => ({}));

    const failed = await json<AccountTestResult>(await post(`/api/accounts/${id}/test`, {}));
    expect(failed.results).toEqual({ calendar: { ok: false, code: 'reauth_required', message: 'Password rejected' }, mail: { ok: true } });
    expect(h.service.get(id)).toMatchObject({ capabilities: ['calendar', 'mail'], status: 'reauth', statusMessage: 'Calendar: Password rejected' });

    calendarOk = true;
    const events: string[] = [];
    h.service.onChange((e) => events.push(e.type));
    const passed = await json<AccountTestResult>(await post(`/api/accounts/${id}/test`, {}));
    expect(passed.results).toEqual({ calendar: { ok: true }, mail: { ok: true } });
    expect(h.service.get(id)).toMatchObject({ status: 'ok', statusMessage: null });
    expect(h.service.getConfig<'yahoo'>(id).caldav?.principalUrl).toBe('https://caldav.calendar.yahoo.com/principals/me/');
    expect(events).toEqual(['updated']);
  });

  it('app-password: a newly passing probe adds the capability', async () => {
    h.service.registerProbe('calendar', ['yahoo'], async () => {
      throw new HttpError(502, 'provider_error', 'CalDAV unavailable');
    });
    h.service.registerProbe('mail', ['yahoo'], async () => ({}));
    const created = await json<AccountCreateResult>(await post('/api/accounts/yahoo', YAHOO));
    expect(created.account.capabilities).toEqual(['mail']);
    h.service.registerProbe('calendar', ['yahoo'], async () => ({}));
    await post(`/api/accounts/${created.account.id}/test`, {});
    expect(h.service.get(created.account.id)).toMatchObject({ capabilities: ['calendar', 'mail'], enabledCapabilities: ['calendar', 'mail'] });
  });

  it('app-password: a failing probe for a capability the account never had does not flag the account', async () => {
    h.service.registerProbe('calendar', ['yahoo'], async () => {
      throw new HttpError(502, 'provider_error', 'CalDAV unavailable');
    });
    h.service.registerProbe('mail', ['yahoo'], async () => ({}));
    const created = await json<AccountCreateResult>(await post('/api/accounts/yahoo', YAHOO));
    const id = created.account.id;
    expect(created.account).toMatchObject({ capabilities: ['mail'], status: 'ok', statusMessage: null });
    const before = h.service.get(id)?.updatedAt;
    const events: string[] = [];
    h.service.onChange((e) => events.push(e.type));

    const tested = await json<AccountTestResult>(await post(`/api/accounts/${id}/test`, {}));
    // The results still report the calendar failure; the account's own capability works.
    expect(tested.results).toEqual({ calendar: { ok: false, code: 'provider_error', message: 'CalDAV unavailable' }, mail: { ok: true } });
    expect(h.service.get(id)).toMatchObject({ capabilities: ['mail'], status: 'ok', statusMessage: null, updatedAt: before });
    expect(events).toEqual([]);
  });

  it('app-password: results of a test that raced a re-add never overwrite the newer settings', async () => {
    const created = await json<AccountCreateResult>(await post('/api/accounts/yahoo', YAHOO));
    const id = created.account.id;
    const release = deferred<void>();
    let started!: () => void;
    const probing = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.service.registerProbe('mail', ['yahoo'], async (draft) => {
      if (draft.secret.password === YAHOO.appPassword) {
        started();
        await release.promise;
        throw new HttpError(409, 'reauth_required', 'Password rejected');
      }
      return {};
    });
    h.service.registerProbe('calendar', ['yahoo'], async () => ({}));

    const test = post(`/api/accounts/${id}/test`, {});
    await probing;
    // Meanwhile the user re-adds the account with a new app password (both probes pass).
    const readded = await post('/api/accounts/yahoo', { email: YAHOO.email, appPassword: 'new-password' });
    expect(readded.status).toBe(200);
    release.resolve();
    expect((await json<AccountTestResult>(await test)).results.mail).toMatchObject({ ok: false });

    expect(h.service.get(id)).toMatchObject({ status: 'ok', statusMessage: null });
    expect(await h.service.getSecret(id)).toEqual({ password: 'new-password' });
  });

  it('OAuth: forces a token refresh and reports it per capability', async () => {
    configureClients(h);
    seedAccount(h, { id: 'm1', kind: 'microsoft', refreshToken: 'rt', capabilities: ['calendar', 'mail'] });
    h.fake.add(route(MICROSOFT_TOKEN_ENDPOINT, tokenOk({ access_token: 'a1' }), { times: 1 }), route(MICROSOFT_TOKEN_ENDPOINT, tokenError('invalid_grant')));
    expect(await json(await post('/api/accounts/m1/test', {}))).toEqual({ results: { calendar: { ok: true }, mail: { ok: true } } });
    const failed = await json<AccountTestResult>(await post('/api/accounts/m1/test', {}));
    expect(failed.results.calendar).toMatchObject({ ok: false, code: 'reauth_required' });
    expect(h.service.get('m1')?.status).toBe('reauth');
    expect(h.fake.calls).toHaveLength(2);
    expect((await post('/api/accounts/nope/test', {})).status).toBe(404);
  });
});
