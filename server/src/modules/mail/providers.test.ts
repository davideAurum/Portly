import { afterEach, describe, expect, it } from 'vitest';
import type { Account } from '@portly/shared';
import type { HttpError } from '../../lib/errors.ts';
import { outcomeFromError } from '../../lib/health.ts';
import { ProviderHttpError } from '../../lib/provider-errors.ts';
import { SafeFetchError, type SafeFetch } from '../../security/safe-fetch.ts';
import { createTestContext, type TestContext } from '../../testing/test-context.ts';
import type { FakeAccountService } from '../../testing/fake-accounts.ts';
import type { FakeFetchRoute } from '../../testing/fake-fetch.ts';
import {
  GMAIL_INBOX_LABEL,
  GMAIL_LIST,
  GMAIL_MESSAGES,
  GRAPH_ID_1,
  GRAPH_ID_2,
  GRAPH_INBOX,
  GRAPH_MESSAGES,
} from './__fixtures__/providers.ts';
import { GMAIL_API, createGmailProvider, gmailGetUrl, mapGmailMessage } from './providers/gmail.ts';
import { GRAPH_API, createGraphProvider, graphListUrl, mapGraphMessage } from './providers/graph.ts';

let ctx: TestContext;
afterEach(() => ctx?.close());

const signal = () => new AbortController().signal;

function setup(routes: FakeFetchRoute[]): { ctx: TestContext; accounts: FakeAccountService; google: Account; microsoft: Account } {
  ctx = createTestContext({
    fetchRoutes: routes,
    accounts: [
      { id: 'g1', kind: 'google', email: 'me@gmail.com', label: 'Gmail', capabilities: ['mail'], token: 'tok-g', refreshedTokens: ['tok-g2'] },
      { id: 'm1', kind: 'microsoft', email: 'me@outlook.com', label: 'Outlook', capabilities: ['mail'], token: 'tok-m' },
    ],
  });
  const accounts = ctx.accounts as FakeAccountService;
  return { ctx, accounts, google: accounts.get('g1') as Account, microsoft: accounts.get('m1') as Account };
}

function gmailRoutes(overrides: FakeFetchRoute[] = []): FakeFetchRoute[] {
  return [
    ...overrides,
    { match: `${GMAIL_API}/labels/INBOX`, respond: { json: GMAIL_INBOX_LABEL } },
    { match: `${GMAIL_API}/messages?`, respond: { json: GMAIL_LIST } },
    {
      match: /\/gmail\/v1\/users\/me\/messages\/([0-9a-f]+)\?format=metadata/,
      respond: (req) => {
        const id = /messages\/([0-9a-f]+)\?/.exec(req.url)?.[1] ?? '';
        return GMAIL_MESSAGES[id] ? { json: GMAIL_MESSAGES[id] } : { status: 404, json: { error: { code: 404, message: 'Not Found' } } };
      },
    },
  ];
}

describe('Gmail mapper (fixtures)', () => {
  const account = { id: 'g1', email: 'me@gmail.com' };

  it('maps metadata resources to plain-text MailMessages', () => {
    expect(mapGmailMessage(GMAIL_MESSAGES['1925c0ffee000001'], account)).toEqual({
      id: '1925c0ffee000001',
      accountId: 'g1',
      from: { name: 'Doe, Jane', address: 'jane@example.com' },
      subject: 'Agenda for Monday',
      snippet: 'Hi Dana, here\'s the agenda for Monday & the notes <b>attached</b> "v2"',
      date: '2026-09-24T07:15:00.000Z',
      unread: true,
      webUrl: 'https://mail.google.com/mail/u/?authuser=me%40gmail.com#inbox/1925c0ffee000001',
    });
  });

  it('handles lower-case headers, bare addresses, hostile text and read messages', () => {
    const m = mapGmailMessage(GMAIL_MESSAGES['1925c0ffee000002'], account);
    expect(m).toMatchObject({
      from: { name: '', address: 'deals@shop.example' },
      subject: 'Invoice gnp.exe for you',
      snippet: 'Big sale <script>alert(1)</script> ends soon',
      unread: false,
      webUrl: 'https://mail.google.com/mail/u/?authuser=me%40gmail.com#inbox/1925bead00000009',
    });
  });

  it('empty snippet → null; missing subject → empty string; invalid resources → null', () => {
    expect(mapGmailMessage(GMAIL_MESSAGES['1925c0ffee000003'], account)).toMatchObject({ snippet: null, subject: '', unread: true });
    expect(mapGmailMessage({ id: '../etc' }, account)).toBeNull();
    expect(mapGmailMessage(null, account)).toBeNull();
  });
});

describe('Gmail provider', () => {
  it('lists INBOX with the unread label count, metadata headers and ≤ 5 concurrent gets', async () => {
    let inflight = 0;
    let peak = 0;
    const many = { messages: Array.from({ length: 12 }, (_, i) => ({ id: `a${i.toString(16).padStart(3, '0')}`, threadId: 't' })) };
    const { ctx: c, google } = setup([
      { match: `${GMAIL_API}/labels/INBOX`, respond: { json: GMAIL_INBOX_LABEL } },
      { match: `${GMAIL_API}/messages?`, respond: { json: many } },
      {
        match: /messages\/a[0-9a-f]{3}\?/,
        respond: async (req) => {
          inflight++;
          peak = Math.max(peak, inflight);
          await new Promise((r) => setTimeout(r, 5));
          inflight--;
          const id = /messages\/(a[0-9a-f]{3})/.exec(req.url)?.[1];
          return { json: { ...(GMAIL_MESSAGES['1925c0ffee000001'] as object), id } };
        },
      },
    ]);
    const provider = createGmailProvider({ fetch: c.fetch, accounts: c.accounts });
    const listing = await provider.list(google, { maxMessages: 12, unreadOnly: false, signal: signal() });
    expect(listing.messages).toHaveLength(12);
    expect(listing.unread).toBe(7);
    expect(listing.canArchive).toBe(true);
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);

    const calls = c.fakeFetch?.calls ?? [];
    const list = calls.find((r) => r.url.startsWith(`${GMAIL_API}/messages?`));
    expect(list?.url).toBe(`${GMAIL_API}/messages?labelIds=INBOX&maxResults=12`);
    const get = calls.find((r) => r.url.includes('/messages/a000'));
    expect(get?.url).toBe(gmailGetUrl('a000'));
    expect(get?.url).toContain('format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date');
    expect(get?.headers.get('authorization')).toBe('Bearer tok-g');
  });

  it('unreadOnly adds the UNREAD label; messages deleted between list and get are skipped', async () => {
    const { ctx: c, google } = setup(
      gmailRoutes([{ match: `${GMAIL_API}/messages?labelIds=INBOX&maxResults=5&labelIds=UNREAD`, respond: { json: { messages: [{ id: '1925c0ffee000001' }, { id: 'deadbeef' }] } } }]),
    );
    const provider = createGmailProvider({ fetch: c.fetch, accounts: c.accounts });
    const listing = await provider.list(google, { maxMessages: 5, unreadOnly: true, signal: signal() });
    expect(listing.messages.map((m) => m.id)).toEqual(['1925c0ffee000001']);
  });

  it('retries once with a refreshed token on 401 (withToken)', async () => {
    const { ctx: c, google, accounts } = setup([
      { match: `${GMAIL_API}/labels/INBOX`, times: 1, respond: { status: 401, json: { error: { code: 401 } } } },
      ...gmailRoutes(),
    ]);
    const provider = createGmailProvider({ fetch: c.fetch, accounts: c.accounts });
    const listing = await provider.list(google, { maxMessages: 5, unreadOnly: false, signal: signal() });
    expect(listing.messages).toHaveLength(3);
    expect(accounts.refreshes.get('g1')).toBe(1);
    expect(c.fakeFetch?.calls.filter((r) => r.headers.get('authorization') === 'Bearer tok-g2').length).toBeGreaterThan(0);
  });

  it.each([
    [{ status: 429, json: { error: { code: 429 } } }, 'rate_limited', 429],
    [{ status: 403, json: { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } } }, 'rate_limited', 429],
    [{ status: 403, json: { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } } }, 'provider_error', 502],
    [{ status: 503, text: 'Backend Error' }, 'provider_error', 502],
    [{ status: 504, text: 'Gateway Timeout' }, 'upstream_timeout', 504],
  ])('maps provider failure %j to %s', async (respond, code, status) => {
    const { ctx: c, google } = setup([{ match: GMAIL_API, respond }]);
    const provider = createGmailProvider({ fetch: c.fetch, accounts: c.accounts });
    const failure = provider.list(google, { maxMessages: 5, unreadOnly: false, signal: signal() });
    await expect(failure).rejects.toMatchObject({ code, status, accountId: 'g1' });
    // Provider text is never reflected.
    await expect(failure).rejects.not.toMatchObject({ message: expect.stringContaining('Backend Error') });
  });

  it.each([
    [{ errors: [{ reason: 'accessNotConfigured' }], details: [{ reason: 'SERVICE_DISABLED' }] }, 'not enabled in your Google Cloud project'],
    [{ details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] }, 'access was not granted'],
    [{ errors: [{ reason: 'insufficientPermissions' }] }, 'access was not granted'],
    [{ errors: [{ reason: 'forbidden' }] }, 'refused access to this mailbox'],
  ])('explains a 403 with Google reasons %j', async (error, text) => {
    const { ctx: c, google } = setup([{ match: GMAIL_API, respond: { status: 403, json: { error: { code: 403, message: 'Gmail API has not been used', ...error } } } }]);
    const provider = createGmailProvider({ fetch: c.fetch, accounts: c.accounts });
    const failure = provider.list(google, { maxMessages: 5, unreadOnly: false, signal: signal() });
    await expect(failure).rejects.toMatchObject({ code: 'provider_error', status: 502, message: expect.stringContaining(text) });
    await expect(failure).rejects.not.toMatchObject({ message: expect.stringContaining('has not been used') });
  });

  it('actions use messages.modify (UNREAD / INBOX) and messages.trash only — never delete', async () => {
    const { ctx: c, google } = setup([
      { match: /\/messages\/1925c0ffee000001\/(modify|trash)$/, method: 'POST', respond: { json: { id: '1925c0ffee000001' } } },
    ]);
    const provider = createGmailProvider({ fetch: c.fetch, accounts: c.accounts });
    await provider.act(google, '1925c0ffee000001', { type: 'read', read: true }, signal());
    await provider.act(google, '1925c0ffee000001', { type: 'read', read: false }, signal());
    await provider.act(google, '1925c0ffee000001', { type: 'archive' }, signal());
    await provider.act(google, '1925c0ffee000001', { type: 'trash' }, signal());
    const calls = (c.fakeFetch?.calls ?? []).map((r) => `${r.method} ${r.url.replace(GMAIL_API, '')} ${r.body ?? ''}`);
    expect(calls).toEqual([
      'POST /messages/1925c0ffee000001/modify {"removeLabelIds":["UNREAD"]}',
      'POST /messages/1925c0ffee000001/modify {"addLabelIds":["UNREAD"]}',
      'POST /messages/1925c0ffee000001/modify {"removeLabelIds":["INBOX"]}',
      'POST /messages/1925c0ffee000001/trash ',
    ]);
    expect((c.fakeFetch?.calls ?? []).every((r) => r.method !== 'DELETE' && !r.url.includes('batchDelete'))).toBe(true);
  });

  it('refuses malformed ids before any request and maps a 404 action to not_found', async () => {
    const { ctx: c, google } = setup([{ match: '/messages/abc/modify', respond: { status: 404, json: {} } }]);
    const provider = createGmailProvider({ fetch: c.fetch, accounts: c.accounts });
    await expect(provider.act(google, '../../x', { type: 'trash' }, signal())).rejects.toMatchObject({ code: 'not_found' });
    expect(c.fakeFetch?.calls).toHaveLength(0);
    await expect(provider.act(google, 'abc', { type: 'archive' }, signal())).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('Graph mapper (fixtures)', () => {
  it('maps messages; bodyPreview is plain text; non-allowlisted webLinks become null', () => {
    const [first, second] = GRAPH_MESSAGES.value.map((raw) => mapGraphMessage(raw, { id: 'm1' }));
    expect(first).toEqual({
      id: GRAPH_ID_1,
      accountId: 'm1',
      from: { name: 'Alex Kim', address: 'alex@outlook.com' },
      subject: 'Dinner on Friday?',
      snippet: 'Are you free on Friday evening? We could try the new place &amp; then a walk.',
      date: '2026-09-24T18:02:11.000Z',
      unread: true,
      webUrl: 'https://outlook.live.com/owa/?ItemID=AAkALgAAAAAAHYQDEapmEc2byACqAC%2FEWg0A&exvsurl=1&viewmodel=ReadMessageItem',
    });
    expect(second).toMatchObject({ id: GRAPH_ID_2, subject: '', snippet: null, unread: false, webUrl: null });
    expect(mapGraphMessage({ id: 'bad id with spaces' }, { id: 'm1' })).toBeNull();
  });
});

describe('Graph provider', () => {
  const graphRoutes = (): FakeFetchRoute[] => [
    { match: `${GRAPH_API}/me/mailFolders/inbox?$select=unreadItemCount`, respond: { json: GRAPH_INBOX } },
    { match: `${GRAPH_API}/me/mailFolders/inbox/messages?`, respond: { json: GRAPH_MESSAGES } },
  ];

  it('lists the inbox with $top/$orderby/$select and Prefer: IdType="ImmutableId"', async () => {
    const { ctx: c, microsoft } = setup(graphRoutes());
    const provider = createGraphProvider({ fetch: c.fetch, accounts: c.accounts });
    const listing = await provider.list(microsoft, { maxMessages: 10, unreadOnly: false, signal: signal() });
    expect(listing).toMatchObject({ unread: 3, canArchive: true });
    expect(listing.messages.map((m) => m.id)).toEqual([GRAPH_ID_1, GRAPH_ID_2]);
    const calls = c.fakeFetch?.calls ?? [];
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers.get('prefer')).toBe('IdType="ImmutableId"');
      expect(call.headers.get('authorization')).toBe('Bearer tok-m');
    }
    const list = calls.find((r) => r.url.includes('/messages?'));
    expect(list?.url).toBe(
      `${GRAPH_API}/me/mailFolders/inbox/messages?$top=10&$orderby=receivedDateTime%20desc&$select=id%2Csubject%2Cfrom%2CreceivedDateTime%2CisRead%2CbodyPreview%2CwebLink`,
    );
  });

  it('unreadOnly filters with the $orderby property first (Graph InefficientFilter rule)', () => {
    const url = decodeURIComponent(graphListUrl(5, true));
    expect(url).toContain('$filter=receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false');
    expect(url).toContain('$top=5');
  });

  it('PATCHes isRead and moves to archive / deleteditems with the ImmutableId header', async () => {
    const { ctx: c, microsoft } = setup([
      { match: `${GRAPH_API}/me/messages/`, respond: (req) => ({ status: req.method === 'PATCH' ? 200 : 201, json: { id: GRAPH_ID_1 } }) },
    ]);
    const provider = createGraphProvider({ fetch: c.fetch, accounts: c.accounts });
    await provider.act(microsoft, GRAPH_ID_1, { type: 'read', read: true }, signal());
    await provider.act(microsoft, GRAPH_ID_1, { type: 'archive' }, signal());
    await provider.act(microsoft, GRAPH_ID_1, { type: 'trash' }, signal());
    const calls = (c.fakeFetch?.calls ?? []).map((r) => `${r.method} ${r.url.replace(GRAPH_API, '')} ${r.body}`);
    expect(calls).toEqual([
      `PATCH /me/messages/${GRAPH_ID_1} {"isRead":true}`,
      `POST /me/messages/${GRAPH_ID_1}/move {"destinationId":"archive"}`,
      `POST /me/messages/${GRAPH_ID_1}/move {"destinationId":"deleteditems"}`,
    ]);
    expect((c.fakeFetch?.calls ?? []).every((r) => r.headers.get('prefer') === 'IdType="ImmutableId"')).toBe(true);
  });

  it('a second 401 after the forced refresh surfaces reauth_required with the account id', async () => {
    const { ctx: c, microsoft, accounts } = setup([{ match: GRAPH_API, respond: { status: 401, json: {} } }]);
    const provider = createGraphProvider({ fetch: c.fetch, accounts: c.accounts });
    await expect(provider.list(microsoft, { maxMessages: 5, unreadOnly: false, signal: signal() })).rejects.toMatchObject({
      code: 'reauth_required',
      accountId: 'm1',
    });
    expect(accounts.statusChanges).toContainEqual({ id: 'm1', status: 'reauth' });
  });
});

describe('diagnostics: purposes, stages and provider errors', () => {
  /** ctx.fetch wrapped to record each call's outbound purpose. */
  function recording(c: TestContext): { fetch: SafeFetch; purposes: (string | undefined)[] } {
    const purposes: (string | undefined)[] = [];
    const fetch: SafeFetch = (url, options) => {
      purposes.push(options.purpose);
      return c.fetch(url, options);
    };
    return { fetch, purposes };
  }

  it('every Gmail request carries a gmail.* purpose; stages go token → labels/list → get', async () => {
    const { ctx: c, google } = setup([
      ...gmailRoutes(),
      { match: /\/messages\/1925c0ffee000001\/(modify|trash)$/, method: 'POST', respond: { json: {} } },
    ]);
    const { fetch, purposes } = recording(c);
    const provider = createGmailProvider({ fetch, accounts: c.accounts });
    const seen: string[] = [];
    await provider.list(google, { maxMessages: 5, unreadOnly: false, signal: signal(), onStage: (s) => seen.push(s) });
    expect(purposes.slice(0, 2).sort()).toEqual(['gmail.labels', 'gmail.list']);
    expect(purposes.slice(2)).toEqual(['gmail.get', 'gmail.get', 'gmail.get']);
    expect(seen.slice(0, 2)).toEqual(['token', 'token']);
    expect(new Set(seen)).toEqual(new Set(['token', 'labels', 'list', 'get']));
    expect(seen.at(-1)).toBe('get');

    purposes.length = 0;
    const acted: string[] = [];
    await provider.act(google, '1925c0ffee000001', { type: 'read', read: true }, signal(), (s) => acted.push(s));
    await provider.act(google, '1925c0ffee000001', { type: 'trash' }, signal());
    expect(purposes).toEqual(['gmail.modify', 'gmail.trash']);
    expect(acted).toEqual(['token', 'modify']);
  });

  it('every Graph request carries a graph.mail.* purpose', async () => {
    const { ctx: c, microsoft } = setup([
      { match: `${GRAPH_API}/me/mailFolders/inbox?$select=unreadItemCount`, respond: { json: GRAPH_INBOX } },
      { match: `${GRAPH_API}/me/mailFolders/inbox/messages?`, respond: { json: GRAPH_MESSAGES } },
      { match: `${GRAPH_API}/me/messages/`, respond: { json: {} } },
    ]);
    const { fetch, purposes } = recording(c);
    const provider = createGraphProvider({ fetch, accounts: c.accounts });
    await provider.list(microsoft, { maxMessages: 5, unreadOnly: false, signal: signal() });
    expect([...purposes].sort()).toEqual(['graph.mail.folder', 'graph.mail.list']);
    purposes.length = 0;
    await provider.act(microsoft, GRAPH_ID_1, { type: 'read', read: false }, signal());
    await provider.act(microsoft, GRAPH_ID_1, { type: 'archive' }, signal());
    await provider.act(microsoft, GRAPH_ID_1, { type: 'trash' }, signal());
    expect(purposes).toEqual(['graph.mail.update', 'graph.mail.move', 'graph.mail.move']);
  });

  it.each<[string, number, unknown, Record<string, string>, Record<string, unknown>, Record<string, unknown>]>([
    [
      'API disabled',
      403,
      { error: { code: 403, status: 'PERMISSION_DENIED', errors: [{ reason: 'accessNotConfigured' }], details: [{ reason: 'SERVICE_DISABLED' }] } },
      {},
      { status: 502, code: 'provider_error', denial: 'api_disabled', providerReason: 'PERMISSION_DENIED accessNotConfigured SERVICE_DISABLED' },
      { code: 'api_disabled', status: 403 },
    ],
    [
      'scope not granted',
      403,
      { error: { code: 403, details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } },
      {},
      { status: 502, code: 'provider_error', denial: 'insufficient_scope' },
      { code: 'insufficient_scope', status: 403 },
    ],
    [
      'other 403',
      403,
      { error: { code: 403, errors: [{ reason: 'forbidden' }] } },
      {},
      { status: 502, code: 'provider_error', denial: 'denied' },
      { code: 'denied', status: 403 },
    ],
    [
      '429 with Retry-After',
      429,
      { error: { code: 429 } },
      { 'retry-after': '120' },
      { status: 429, code: 'rate_limited', retryAfterSeconds: 120, denial: null },
      { code: 'rate_limited', status: 429 },
    ],
    [
      'rate-limit 403',
      403,
      { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } },
      {},
      { status: 429, code: 'rate_limited', providerReason: 'userRateLimitExceeded' },
      { code: 'rate_limited', status: 403 },
    ],
    ['503', 503, null, {}, { status: 502, code: 'provider_error', httpStatus: 503 }, { code: 'http_5xx', status: 503 }],
    ['400', 400, null, {}, { status: 502, code: 'provider_error' }, { code: 'http_4xx', status: 400 }],
    ['404 on a list', 404, null, {}, { status: 502, code: 'provider_error' }, { code: 'not_found', status: 404 }],
    ['504', 504, null, {}, { status: 504, code: 'upstream_timeout' }, { code: 'timeout', status: 504 }],
  ])('%s → ProviderHttpError with the provider facts, and its health code', async (_label, status, json, headers, error, outcome) => {
    const { ctx: c, google } = setup([{ match: GMAIL_API, respond: json === null ? { status, text: 'oops', headers } : { status, json, headers } }]);
    const provider = createGmailProvider({ fetch: c.fetch, accounts: c.accounts });
    const err = await provider.list(google, { maxMessages: 5, unreadOnly: false, signal: signal() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err).toMatchObject({ accountId: 'g1', httpStatus: status, ...error });
    expect(outcomeFromError(err)).toMatchObject({ ok: false, ...outcome });
  });

  it('a Retry-After becomes the health nextAttemptAt; the client body never carries provider facts', async () => {
    const { ctx: c, google } = setup([
      { match: GMAIL_API, respond: { status: 429, json: { error: { code: 429, message: 'Quota exceeded for project 1234' } }, headers: { 'retry-after': '60' } } },
    ]);
    const provider = createGmailProvider({ fetch: c.fetch, accounts: c.accounts });
    const err = (await provider.list(google, { maxMessages: 5, unreadOnly: false, signal: signal() }).catch((e: unknown) => e)) as ProviderHttpError;
    const before = Date.now();
    const outcome = outcomeFromError(err);
    expect(outcome.nextAttemptAt).toBeGreaterThanOrEqual(before + 59_000);
    expect(outcome.detail).toMatchObject({ retryAfterSeconds: 60, upstreamStatus: 429 });
    expect(JSON.stringify(err.toBody())).not.toMatch(/Quota|1234|retry/i);
  });

  it('a transport failure keeps the SafeFetchError as the cause (the client sees the provider name only)', async () => {
    const { ctx: c, google } = setup([
      { match: `${GMAIL_API}/labels/INBOX`, respond: { status: 302, headers: { location: 'https://elsewhere.example/' } } },
      { match: `${GMAIL_API}/messages?`, respond: { json: GMAIL_LIST } },
    ]);
    const provider = createGmailProvider({ fetch: c.fetch, accounts: c.accounts });
    const redirected = (await provider.list(google, { maxMessages: 5, unreadOnly: false, signal: signal() }).catch((e: unknown) => e)) as HttpError;
    expect(redirected).toMatchObject({ code: 'provider_error', message: 'Could not reach Gmail', accountId: 'g1' });
    expect(redirected.cause).toBeInstanceOf(SafeFetchError);
    expect(redirected.cause).toMatchObject({ reason: 'redirect', host: 'gmail.googleapis.com' });
    expect(redirected.toBody()).toEqual({ error: { code: 'provider_error', message: 'Could not reach Gmail', accountId: 'g1' } });
  });

  it('an unreadable 2xx body carries an invalid_json SafeFetchError (health parse_error)', async () => {
    const { ctx: c, microsoft } = setup([{ match: GRAPH_API, respond: { status: 200, text: '<html>captive portal</html>' } }]);
    const graph = createGraphProvider({ fetch: c.fetch, accounts: c.accounts });
    const unreadable = (await graph.list(microsoft, { maxMessages: 5, unreadOnly: false, signal: signal() }).catch((e: unknown) => e)) as Error;
    expect(unreadable).toMatchObject({ code: 'provider_error', message: 'Outlook.com returned an unreadable response', accountId: 'm1' });
    expect(unreadable.cause).toBeInstanceOf(SafeFetchError);
    expect(unreadable.cause).toMatchObject({ reason: 'invalid_json', host: 'graph.microsoft.com' });
    expect(outcomeFromError(unreadable.cause)).toMatchObject({ code: 'parse_error' });
  });
});
