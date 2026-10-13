import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailAccountSummary } from '@homebase/shared';
import { createApp } from '../../app.ts';
import { HttpError } from '../../lib/errors.ts';
import type { LogRecordOut } from '../../lib/logger.ts';
import type { FakeAccountSeed, FakeAccountService } from '../../testing/fake-accounts.ts';
import type { FakeFetchRoute } from '../../testing/fake-fetch.ts';
import { createTestContext, type TestContext } from '../../testing/test-context.ts';
import { testRequest, type TestRequestOptions } from '../../testing/test-request.ts';
import { FakeImapServer, message } from './__fixtures__/fake-imap.ts';
import { GMAIL_INBOX_LABEL, GMAIL_LIST, GMAIL_MESSAGES, GRAPH_ID_1, GRAPH_INBOX, GRAPH_MESSAGES } from './__fixtures__/providers.ts';
import { createMailModule, prefixes } from './index.ts';
import { GMAIL_API } from './providers/gmail.ts';
import { GRAPH_API } from './providers/graph.ts';
import { encodeImapId } from './providers/imap-id.ts';
import type { MailProvider } from './providers/types.ts';
import type { MailServiceOptions } from './service.ts';

const GMAIL: FakeAccountSeed = { id: 'g1', kind: 'google', label: 'Gmail', email: 'me@gmail.com', color: '#ea4335', capabilities: ['calendar', 'mail'], token: 'tok-g' };
const OUTLOOK: FakeAccountSeed = { id: 'm1', kind: 'microsoft', label: 'Outlook', email: 'me@outlook.com', capabilities: ['mail'], token: 'tok-m' };
const YAHOO: FakeAccountSeed = {
  id: 'y1',
  kind: 'yahoo',
  label: 'Yahoo',
  email: 'me@yahoo.com',
  capabilities: ['calendar', 'mail'],
  password: 'app-password',
  config: { username: 'me@yahoo.com', imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls', webmailUrl: 'https://mail.yahoo.com/' } },
};

const GMAIL_ROUTES: FakeFetchRoute[] = [
  { match: `${GMAIL_API}/labels/INBOX`, respond: { json: GMAIL_INBOX_LABEL } },
  { match: `${GMAIL_API}/messages?`, respond: { json: GMAIL_LIST } },
  {
    match: /\/gmail\/v1\/users\/me\/messages\/[0-9a-f]+\?format=metadata/,
    respond: (req) => ({ json: GMAIL_MESSAGES[/messages\/([0-9a-f]+)\?/.exec(req.url)?.[1] ?? ''] }),
  },
  { match: /\/gmail\/v1\/users\/me\/messages\/[0-9a-f]+\/(modify|trash)$/, method: 'POST', respond: { json: {} } },
];
const GRAPH_ROUTES: FakeFetchRoute[] = [
  { match: `${GRAPH_API}/me/mailFolders/inbox?`, respond: { json: GRAPH_INBOX } },
  { match: `${GRAPH_API}/me/mailFolders/inbox/messages?`, respond: { json: GRAPH_MESSAGES } },
  { match: `${GRAPH_API}/me/messages/`, respond: { json: {} } },
];

interface Testbed {
  ctx: TestContext;
  accounts: FakeAccountService;
  imap: FakeImapServer;
  req(method: string, path: string, options?: TestRequestOptions): Promise<Response>;
  summary(query?: string): Promise<{ status: number; body: MailAccountSummary[] & { error?: { code: string } } }>;
  calls(fragment: string): number;
}

let t: Testbed;
afterEach(() => {
  vi.useRealTimers();
  t?.ctx.close();
});

function testbed(seeds: FakeAccountSeed[], opts: { routes?: FakeFetchRoute[] } & MailServiceOptions = {}): Testbed {
  const { routes = [...GMAIL_ROUTES, ...GRAPH_ROUTES], ...serviceOptions } = opts;
  const ctx = createTestContext({ accounts: seeds, fetchRoutes: routes });
  const imap = new FakeImapServer({
    mailboxes: [{ path: 'INBOX', uidValidity: 42n, messages: [message(1), message(2, { seen: true }), message(3)] }],
  });
  const register = createMailModule({ imapConnect: imap.factory(), ...serviceOptions });
  const { app } = createApp(ctx, { modules: [{ name: 'mail', prefixes, register }], webDist: null });
  const req = (method: string, path: string, options?: TestRequestOptions) => testRequest(app, method, path, options);
  return {
    ctx,
    accounts: ctx.accounts as FakeAccountService,
    imap,
    req,
    async summary(query = '') {
      const res = await req('GET', `/api/mail/summary${query}`);
      return { status: res.status, body: (await res.json()) as MailAccountSummary[] & { error?: { code: string } } };
    },
    calls: (fragment) => (ctx.fakeFetch?.calls ?? []).filter((c) => c.url.includes(fragment)).length,
  };
}

const post = (path: string, body?: unknown) => t.req('POST', path, body === undefined ? {} : { body });

describe('GET /api/mail/summary', () => {
  it('409 not_configured when no account has mail enabled', async () => {
    t = testbed([{ ...GMAIL, enabledCapabilities: ['calendar'] }, { id: 'c1', kind: 'caldav', capabilities: ['calendar'] }]);
    const res = await t.summary();
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('not_configured');
  });

  it('aggregates accounts in order with a per-account error for the failing one (HTTP 200)', async () => {
    t = testbed([GMAIL, { ...OUTLOOK, token: undefined }, YAHOO]);
    const res = await t.summary('?maxMessages=5');
    expect(res.status).toBe(200);
    expect(res.body.map((s) => s.accountId)).toEqual(['g1', 'm1', 'y1']);

    const [gmail, outlook, yahoo] = res.body as [MailAccountSummary, MailAccountSummary, MailAccountSummary];
    expect(gmail).toMatchObject({
      label: 'Gmail',
      email: 'me@gmail.com',
      color: '#ea4335',
      unread: 7,
      canArchive: true,
      canTrash: true,
      webmailUrl: 'https://mail.google.com/mail/u/?authuser=me%40gmail.com',
    });
    expect(gmail.error).toBeUndefined();
    // Sorted newest first.
    expect(gmail.messages.map((m) => m.date)).toEqual([...gmail.messages.map((m) => m.date)].sort().reverse());

    expect(outlook).toMatchObject({
      unread: 0,
      messages: [],
      canArchive: false,
      canTrash: false,
      webmailUrl: 'https://outlook.live.com/mail/',
      error: { code: 'reauth_required', accountId: 'm1' },
    });

    expect(yahoo).toMatchObject({ unread: 2, canArchive: true, canTrash: true, webmailUrl: 'https://mail.yahoo.com/' });
    expect(yahoo.messages.map((m) => m.subject)).toEqual(['Message 3', 'Message 2', 'Message 1']);
  });

  it('a hanging account times out on its own while the others return', async () => {
    const hanging: MailProvider = {
      list: (_account, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      act: async () => {},
    };
    t = testbed([GMAIL, OUTLOOK], { providers: { microsoft: hanging }, accountTimeoutMs: 30 });
    const res = await t.summary();
    expect(res.status).toBe(200);
    expect(res.body[0]?.error).toBeUndefined();
    expect(res.body[1]?.error).toMatchObject({ code: 'upstream_timeout', accountId: 'm1' });
  });

  it('unexpected provider exceptions become a generic provider_error item', async () => {
    const broken: MailProvider = {
      list: async () => {
        throw new TypeError('secret internal detail');
      },
      act: async () => {},
    };
    t = testbed([OUTLOOK], { providers: { microsoft: broken } });
    const res = await t.summary();
    expect(res.body[0]?.error).toEqual({ code: 'provider_error', message: 'Mail could not be loaded', accountId: 'm1' });
  });

  it('validates the query (maxMessages 5–20, unreadOnly boolean) and narrows by accountIds', async () => {
    t = testbed([GMAIL, OUTLOOK]);
    for (const q of ['?maxMessages=4', '?maxMessages=21', '?maxMessages=abc', '?unreadOnly=yes']) {
      expect((await t.req('GET', `/api/mail/summary${q}`)).status, q).toBe(422);
    }
    const only = await t.summary('?accountIds=m1');
    expect(only.body.map((s) => s.accountId)).toEqual(['m1']);
    expect(t.calls('gmail.googleapis.com')).toBe(0);
    expect((await t.summary('?accountIds=nope')).body).toEqual([]);

    await t.summary('?unreadOnly=true&accountIds=g1');
    const list = t.ctx.fakeFetch?.calls.find((c) => c.url.includes('labelIds=UNREAD'));
    expect(list?.url).toContain('maxResults=10');
  });

  it('memoizes each account for 60 s in memory only (never the SQLite cache)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    t = testbed([GMAIL]);
    await t.summary();
    await t.summary();
    expect(t.calls('/labels/INBOX')).toBe(1);
    await t.summary('?maxMessages=5');
    expect(t.calls('/labels/INBOX')).toBe(2);

    vi.setSystemTime(Date.now() + 61_000);
    await t.summary();
    expect(t.calls('/labels/INBOX')).toBe(3);
    expect(t.ctx.db.all('SELECT key FROM cache')).toEqual([]);
  });

  it('is gated like every /api route', async () => {
    t = testbed([GMAIL]);
    expect((await t.req('GET', '/api/mail/summary', { headers: { 'X-Homebase': null } })).status).toBe(403);
  });
});

describe('mail actions', () => {
  const gmailId = '1925c0ffee000001';

  it('rejects ids the server has not listed for that account (allowlist) without calling the provider', async () => {
    t = testbed([GMAIL, OUTLOOK]);
    const res = await post(`/api/mail/g1/messages/${gmailId}/read`, { read: true });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found', details: { reason: 'not_listed' } } });
    expect(t.calls('/modify')).toBe(0);

    // Listed for another account only → still rejected.
    await t.summary('?accountIds=m1');
    expect((await post(`/api/mail/g1/messages/${encodeURIComponent(GRAPH_ID_1)}/trash`)).status).toBe(404);
    expect((await post(`/api/mail/m1/messages/${gmailId}/trash`)).status).toBe(404);
    expect(t.calls('/move')).toBe(0);
  });

  it('acts on listed ids, invalidates the account cache, and allows undo of read/unread', async () => {
    t = testbed([GMAIL]);
    await t.summary();
    expect(t.calls('/labels/INBOX')).toBe(1);

    expect((await post(`/api/mail/g1/messages/${gmailId}/read`, { read: true })).status).toBe(204);
    expect((await post(`/api/mail/g1/messages/${gmailId}/read`, { read: false })).status).toBe(204);
    expect(t.calls(`/messages/${gmailId}/modify`)).toBe(2);

    await t.summary();
    expect(t.calls('/labels/INBOX')).toBe(2);
  });

  it('trash/archive remove the id from the allowlist', async () => {
    t = testbed([GMAIL, OUTLOOK]);
    await t.summary();
    expect((await post(`/api/mail/g1/messages/${gmailId}/trash`)).status).toBe(204);
    expect((await post(`/api/mail/g1/messages/${gmailId}/read`, { read: true })).status).toBe(404);

    const graphPath = `/api/mail/m1/messages/${encodeURIComponent(GRAPH_ID_1)}`;
    expect((await post(`${graphPath}/archive`)).status).toBe(204);
    const move = t.ctx.fakeFetch?.calls.find((c) => c.url.endsWith('/move'));
    expect(move?.headers.get('prefer')).toBe('IdType="ImmutableId"');
    expect((await post(`${graphPath}/trash`)).status).toBe(404);
  });

  it('IMAP UIDVALIDITY change → 409 stale_message through the route, and the cache is dropped', async () => {
    t = testbed([YAHOO]);
    const first = await t.summary();
    const id = first.body[0]?.messages[0]?.id as string;
    t.imap.inbox().uidValidity = 43n;
    const res = await post(`/api/mail/y1/messages/${id}/read`, { read: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'stale_message' }, accountId: 'y1' } });

    const fresh = await t.summary();
    expect(fresh.body[0]?.messages[0]?.id).toBe(encodeImapId({ mailbox: 'INBOX', uidValidity: 43n, uid: 3 }));
  });

  it('IMAP trash through the route uses UID MOVE', async () => {
    t = testbed([YAHOO]);
    const id = (await t.summary()).body[0]?.messages[0]?.id as string;
    expect((await post(`/api/mail/y1/messages/${id}/trash`)).status).toBe(204);
    expect(t.imap.log).toContain('UID MOVE 3 Trash');
  });

  it('validates bodies and unknown / non-mail accounts', async () => {
    t = testbed([GMAIL, { ...OUTLOOK, enabledCapabilities: [] }]);
    await t.summary();
    expect((await post(`/api/mail/g1/messages/${gmailId}/read`, { read: 'yes' })).status).toBe(422);
    expect((await post(`/api/mail/g1/messages/${gmailId}/read`, { read: true, extra: 1 })).status).toBe(422);
    expect((await post(`/api/mail/zzz/messages/${gmailId}/trash`)).status).toBe(404);
    expect((await post(`/api/mail/m1/messages/${encodeURIComponent(GRAPH_ID_1)}/trash`)).status).toBe(404);
  });

  it('reauth during an action surfaces 409 reauth_required with the account id', async () => {
    t = testbed([GMAIL], { routes: [...GMAIL_ROUTES.slice(0, 3), { match: '/modify', respond: { status: 401, json: {} } }] });
    await t.summary();
    const res = await post(`/api/mail/g1/messages/${gmailId}/archive`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'reauth_required', accountId: 'g1' } });
  });

  it('a listing that was in flight during an action never serves pre-action data afterwards', async () => {
    // Controllable provider: `hold` parks list() after it has read the (pre-action) mailbox.
    let inbox = ['a', 'b'];
    let hold = false;
    const parked: (() => void)[] = [];
    let listCalls = 0;
    const controlled: MailProvider = {
      list: async (account) => {
        listCalls++;
        const snapshot = inbox.map((id, i) => ({
          id,
          accountId: account.id,
          from: { name: 'S', address: 's@example.com' },
          subject: id,
          snippet: null,
          date: new Date(Date.UTC(2026, 8, 1, 8, i)).toISOString(),
          unread: true,
          webUrl: null,
        }));
        if (hold) await new Promise<void>((resolve) => parked.push(resolve));
        return { unread: snapshot.length, messages: snapshot, canArchive: true };
      },
      act: async (_account, id) => {
        inbox = inbox.filter((x) => x !== id);
      },
    };
    t = testbed([OUTLOOK], { providers: { microsoft: controlled } });
    expect((await t.summary()).body[0]?.messages.map((m) => m.id).sort()).toEqual(['a', 'b']);
    t.ctx.memo.delPrefix('mail:list:'); // the 60 s list expired

    hold = true;
    const inFlight = t.summary(); // e.g. a window-focus refetch that started before the click
    await vi.waitFor(() => expect(parked).toHaveLength(1));
    hold = false;

    expect((await post('/api/mail/m1/messages/a/trash')).status).toBe(204);
    // The post-action refetch must not join the stale in-flight listing…
    const after = t.summary();
    parked.shift()?.();
    await inFlight;
    expect((await after).body[0]?.messages.map((m) => m.id)).toEqual(['b']);
    // …and the stale result must not have been cached either.
    expect((await t.summary()).body[0]?.messages.map((m) => m.id)).toEqual(['b']);
    expect(listCalls).toBe(3);
  });

  it('deleting an account clears its lists and allowlist', async () => {
    t = testbed([GMAIL]);
    await t.summary();
    t.accounts.emit({ type: 'deleted', accountId: 'g1' });
    expect(t.ctx.memo.get('mail:allow:g1:')).toBeUndefined();
    expect((await post(`/api/mail/g1/messages/${gmailId}/trash`)).status).toBe(404);
  });
});

describe('module registration', () => {
  it('registers the IMAP mail probe for yahoo and imap accounts', () => {
    t = testbed([]);
    expect(t.accounts.probes).toEqual([{ capability: 'mail', kinds: ['yahoo', 'imap'], probe: expect.any(Function) }]);
  });
});

describe('diagnostics: health mail:<accountId>, log context, action lines', () => {
  const lines = (msg: string): LogRecordOut[] => t.ctx.logs.query({ limit: 5000 }).records.filter((r) => r.msg === msg);
  const gmailFailing = (respond: FakeFetchRoute['respond']): FakeFetchRoute[] => [{ match: GMAIL_API, respond }];

  it('records every fresh listing as mail:<accountId> {stage, count} — memo hits record nothing', async () => {
    t = testbed([GMAIL, YAHOO]);
    const record = vi.spyOn(t.ctx.health, 'record');
    await t.summary('?maxMessages=5');
    expect(t.ctx.health.get('mail:g1')).toMatchObject({
      area: 'mail',
      accountId: 'g1',
      status: 'ok',
      detail: { stage: 'done', count: 3 },
      expectEveryMs: null,
    });
    expect(t.ctx.health.get('mail:y1')).toMatchObject({ status: 'ok', detail: { stage: 'done', count: 3 } });
    expect(record).toHaveBeenCalledTimes(2);

    await t.summary('?maxMessages=5');
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('Gmail API disabled → api_disabled with the provider status, reasons and the stage of the failing request', async () => {
    t = testbed([GMAIL], {
      routes: [
        {
          match: `${GMAIL_API}/labels/INBOX`,
          respond: {
            status: 403,
            json: { error: { code: 403, message: 'Gmail API has not been used in project 123', errors: [{ reason: 'accessNotConfigured' }] } },
          },
        },
        ...GMAIL_ROUTES.slice(1),
      ],
    });
    const res = await t.summary();
    expect(res.body[0]?.error).toMatchObject({ code: 'provider_error', message: expect.stringContaining('not enabled') });
    const entry = t.ctx.health.get('mail:g1');
    expect(entry).toMatchObject({ status: 'failing', lastCode: 'api_disabled', lastStatus: 403, lastMessage: expect.stringContaining('not enabled') });
    // `gmail.list` ran alongside and reported its stage after `gmail.labels` did; the failing request owns it.
    expect(entry?.detail).toMatchObject({ stage: 'labels', providerReason: 'accessNotConfigured', upstreamStatus: 403 });
    const [failing] = lines('mail failing');
    expect(failing).toMatchObject({ level: 'warn', area: 'mail', fields: { key: 'mail:g1', accountId: 'g1', code: 'api_disabled' } });
    expect(JSON.stringify(t.ctx.logs.query({ limit: 5000 }).records)).not.toContain('project 123');
  });

  it('a request failing while a parallel one still runs names its own stage, not the last one reported', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    t = testbed([OUTLOOK], {
      routes: [
        { match: `${GRAPH_API}/me/mailFolders/inbox?`, respond: { status: 404, json: { error: { code: 'ErrorItemNotFound' } } } },
        {
          match: `${GRAPH_API}/me/mailFolders/inbox/messages?`,
          respond: () =>
            new Promise((resolve) => {
              gate.release = () => resolve({ json: GRAPH_MESSAGES });
            }),
        },
      ],
    });
    const res = await t.summary();
    gate.release?.();
    expect(res.body[0]?.error).toMatchObject({ code: 'provider_error', accountId: 'm1' });
    expect(t.ctx.health.get('mail:m1')).toMatchObject({ lastCode: 'not_found', lastStatus: 404, detail: { stage: 'folder' } });
    expect(lines('mail listing failed')[0]).toMatchObject({ level: 'debug', fields: { kind: 'microsoft', stage: 'folder', upstreamStatus: 404 } });
  });

  it('a rate limit carries Retry-After into nextAttemptAt', async () => {
    t = testbed([GMAIL], { routes: gmailFailing({ status: 429, json: { error: { code: 429 } }, headers: { 'retry-after': '90' } }) });
    const before = Date.now();
    await t.summary();
    const entry = t.ctx.health.get('mail:g1');
    expect(entry).toMatchObject({ lastCode: 'rate_limited', lastStatus: 429 });
    expect(entry?.nextAttemptAt).toBeGreaterThanOrEqual(before + 89_000);
  });

  it.each<[string, FakeFetchRoute['respond'], string]>([
    [
      'network',
      () => {
        throw new TypeError('fetch failed');
      },
      'network',
    ],
    ['redirect', { status: 302, headers: { location: 'https://elsewhere.example/' } }, 'redirect'],
    ['unreadable 2xx', { status: 200, text: '<html>captive portal</html>' }, 'parse_error'],
  ])('a REST %s failure is classified by its SafeFetchError, under the mail message', async (_label, respond, code) => {
    t = testbed([OUTLOOK], { routes: [{ match: GRAPH_API, respond }] });
    const res = await t.summary();
    expect(res.body[0]?.error?.message).toMatch(/Outlook\.com/);
    expect(t.ctx.health.get('mail:m1')).toMatchObject({
      lastCode: code,
      lastMessage: res.body[0]?.error?.message,
      detail: { host: 'graph.microsoft.com' },
    });
  });

  it.each<[string, (t: Testbed) => void]>([
    ['needs reconnecting', (tb) => tb.accounts.add({ ...OUTLOOK, token: undefined })],
    [
      'has no configured OAuth client (recorded on the account by the accounts module)',
      (tb) => {
        vi.spyOn(tb.accounts, 'getAccessToken').mockRejectedValue(
          new HttpError(409, 'not_configured', { message: 'The Microsoft OAuth client is not configured', accountId: 'm1' }),
        );
      },
    ],
  ])('an account that %s → account_unavailable caused by account:<id> (info, not warn)', async (_label, arrange) => {
    t = testbed([OUTLOOK]);
    arrange(t);
    await t.summary();
    expect(t.ctx.health.get('mail:m1')).toMatchObject({ status: 'failing', lastCode: 'account_unavailable', causeKey: 'account:m1', detail: { stage: 'token' } });
    expect(lines('mail failing')[0]).toMatchObject({ level: 'info', fields: { causeKey: 'account:m1' } });
  });

  it('IMAP settings missing → the mailbox’s own not_configured (warn, no cause: the account’s subject does not record it)', async () => {
    t = testbed([{ id: 'i1', kind: 'imap', label: 'IMAP', email: 'me@example.com', capabilities: ['mail'], password: 'pw', config: {} }]);
    const res = await t.summary();
    expect(res.body[0]?.error).toMatchObject({ code: 'not_configured', accountId: 'i1' });
    expect(t.ctx.health.get('mail:i1')).toMatchObject({ status: 'failing', lastCode: 'not_configured', causeKey: null, lastMessage: 'This account has no IMAP settings' });
    expect(lines('mail failing')[0]).toMatchObject({ level: 'warn', fields: { key: 'mail:i1', code: 'not_configured' } });
  });

  it('IMAP: a rejected password parks the account (imap_password_rejected) and the mailbox depends on it', async () => {
    t = testbed([YAHOO]);
    t.imap.password = 'changed';
    const res = await t.summary();
    expect(res.body[0]?.error).toMatchObject({ code: 'reauth_required', accountId: 'y1' });
    expect(t.accounts.statusChanges).toContainEqual({
      id: 'y1',
      status: 'reauth',
      message: 'The mail server rejected the password',
      meta: { reason: 'imap_password_rejected', source: 'mail' },
    });
    expect(t.ctx.health.get('mail:y1')).toMatchObject({ lastCode: 'account_unavailable', causeKey: 'account:y1', detail: { stage: 'login' } });
  });

  it.each<[string, Record<string, unknown>, string, Record<string, unknown>]>([
    ['refused', { code: 'ECONNREFUSED' }, 'refused', { stage: 'connect', causeCode: 'ECONNREFUSED' }],
    ['not found', { code: 'ENOTFOUND' }, 'dns', { stage: 'connect' }],
    ['TLS', { tlsFailed: true, code: 'ERR_SSL_WRONG_VERSION_NUMBER' }, 'tls', { stage: 'connect', tlsFailed: true }],
    ['closed', { code: 'EConnectionClosed' }, 'reset', { stage: 'connect' }],
    ['too many connections', { authenticationFailed: true, serverResponseCode: 'INUSE' }, 'rate_limited', { stage: 'login', serverResponseCode: 'INUSE' }],
    ['greeting timeout', { code: 'GREETING_TIMEOUT' }, 'timeout', { stage: 'greeting' }],
  ])('IMAP %s → health %s with the session codes as detail (never server text)', async (_label, fields, code, detail) => {
    t = testbed([YAHOO]);
    t.imap.connectError = Object.assign(new Error('server said: me@yahoo.com is not welcome'), fields);
    await t.summary();
    const entry = t.ctx.health.get('mail:y1');
    expect(entry).toMatchObject({ status: 'failing', lastCode: code, detail });
    expect(JSON.stringify([entry, t.ctx.logs.query({ limit: 5000 }).records])).not.toContain('not welcome');
  });

  it('a timeout freezes and reports the stage it hit; later reports cannot move it', async () => {
    const hanging: MailProvider = {
      list: (_account, { signal, onStage }) =>
        new Promise((_, reject) => {
          onStage?.('token');
          onStage?.('get');
          signal.addEventListener('abort', () => {
            onStage?.('list');
            reject(new Error('aborted'));
          });
        }),
      act: async () => {},
    };
    t = testbed([OUTLOOK], { providers: { microsoft: hanging }, accountTimeoutMs: 30 });
    const res = await t.summary();
    expect(res.body[0]?.error).toMatchObject({ code: 'upstream_timeout' });
    expect(t.ctx.health.get('mail:m1')).toMatchObject({ lastCode: 'timeout', lastStatus: null, detail: { stage: 'get' } });
    expect(lines('mail timed out')[0]).toMatchObject({ level: 'debug', fields: { op: 'list', stage: 'get', accountId: 'm1' } });
  });

  it('unexpected exceptions: health internal with the error name only; the stack goes to a debug line', async () => {
    const broken: MailProvider = {
      list: async () => {
        throw new TypeError('secret internal detail');
      },
      act: async () => {},
    };
    t = testbed([OUTLOOK], { providers: { microsoft: broken } });
    await t.summary();
    expect(t.ctx.health.get('mail:m1')).toMatchObject({ lastCode: 'internal', lastMessage: 'TypeError' });
    const [debug] = lines('mail listing failed');
    expect(debug).toMatchObject({ level: 'debug', fields: { errName: 'TypeError', kind: 'microsoft', stage: 'start' } });
    expect(typeof debug?.fields.stack).toBe('string');
    expect(t.ctx.logs.query({ level: 'warn', limit: 5000 }).records.filter((r) => r.msg === 'mail listing failed')).toEqual([]);
  });

  it('runs each account in withLogContext({area: mail, accountId}): outbound lines carry the account', async () => {
    t = testbed([GMAIL, OUTLOOK]);
    await t.summary();
    const outbound = t.ctx.logs.query({ limit: 5000 }).records.filter((r) => r.msg === 'outbound');
    expect(outbound.length).toBeGreaterThan(0);
    for (const line of outbound) {
      expect(line.tags).toContain('mail');
      expect(line.fields.accountId).toBe(line.fields.host === 'gmail.googleapis.com' ? 'g1' : 'm1');
    }
  });

  it('mail actions log info {op, accountId, ms}; failures warn with the stage', async () => {
    const gmailId = '1925c0ffee000001';
    t = testbed([GMAIL], { routes: [...GMAIL_ROUTES.slice(0, 3), { match: '/modify', respond: { status: 503, text: 'Backend Error' } }] });
    await t.summary();
    expect((await post(`/api/mail/g1/messages/${gmailId}/read`, { read: false })).status).toBe(502);
    expect(lines('mail action')).toEqual([]);
    const [failed] = lines('mail action failed');
    expect(failed).toMatchObject({
      level: 'warn',
      area: 'mail',
      fields: { op: 'unread', accountId: 'g1', kind: 'google', stage: 'modify', errCode: 'provider_error', upstreamStatus: 503 },
    });
    expect(typeof failed?.fields.ms).toBe('number');

    t.ctx.close();
    t = testbed([GMAIL]);
    await t.summary();
    expect((await post(`/api/mail/g1/messages/${gmailId}/archive`)).status).toBe(204);
    const [done] = lines('mail action');
    expect(done).toMatchObject({ level: 'info', area: 'mail', fields: { op: 'archive', accountId: 'g1', kind: 'google' } });
    expect(typeof done?.fields.ms).toBe('number');
  });

  it('never logs mail content, addresses or tokens', async () => {
    t = testbed([GMAIL, OUTLOOK, YAHOO]);
    const first = await t.summary();
    const imapId = first.body[2]?.messages[0]?.id as string;
    await post(`/api/mail/y1/messages/${imapId}/trash`);
    await post(`/api/mail/g1/messages/1925c0ffee000001/read`, { read: true });
    const text = JSON.stringify([t.ctx.logs.query({ limit: 5000 }).records, t.ctx.health.list()]);
    for (const content of ['Agenda for Monday', 'Dinner on Friday', 'Message 3', 'jane@example.com', 'alex@outlook.com', 'sender3@example.com']) {
      expect(text).not.toContain(content);
    }
    for (const secret of ['me@gmail.com', 'me@outlook.com', 'me@yahoo.com', 'tok-g', 'tok-m', 'app-password', 'authuser']) {
      expect(text).not.toContain(secret);
    }
  });

  it('forgets mail:<id> when the account is deleted or its mail switched off; a late listing does not bring it back', async () => {
    t = testbed([GMAIL, OUTLOOK]);
    await t.summary();
    expect(t.ctx.health.get('mail:g1')).not.toBeNull();
    expect(t.ctx.health.get('mail:m1')).not.toBeNull();

    // Mail switched off.
    t.accounts.add({ ...OUTLOOK, enabledCapabilities: [] });
    t.accounts.emit({ type: 'updated', accountId: 'm1' });
    expect(t.ctx.health.get('mail:m1')).toBeNull();

    // Account deleted (the fake accounts service does not forget the account's subjects itself).
    t.accounts.remove('g1');
    t.accounts.emit({ type: 'deleted', accountId: 'g1' });
    expect(t.ctx.health.get('mail:g1')).toBeNull();

    // A listing still in flight when the account goes.
    const gate: { release: (() => void) | null } = { release: null };
    const parked: MailProvider = {
      list: async () => {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        return { unread: 0, messages: [], canArchive: true };
      },
      act: async () => {},
    };
    t.ctx.close();
    t = testbed([GMAIL], { providers: { google: parked } });
    const pending = t.summary();
    await vi.waitFor(() => expect(gate.release).not.toBeNull());
    t.accounts.remove('g1');
    t.accounts.emit({ type: 'deleted', accountId: 'g1' });
    gate.release?.();
    await pending;
    expect(t.ctx.health.get('mail:g1')).toBeNull();
  });
});
