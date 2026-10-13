import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Account, AccountDraft } from '@portly/shared';
import { HttpError } from '../../lib/errors.ts';
import type { FakeAccountService } from '../../testing/fake-accounts.ts';
import { createTestContext, type TestContext } from '../../testing/test-context.ts';
import { FakeImapServer, listEntry, message } from './__fixtures__/fake-imap.ts';
import { imapFlowOptions } from './providers/imap-client.ts';
import { decodeImapId, encodeImapId } from './providers/imap-id.ts';
import {
  ImapOpError,
  REAUTH_MESSAGE,
  connectPhase,
  createImapProbe,
  createImapProvider,
  foldersKey,
  imapHealthHints,
  mapImapError,
  moveStrategy,
  resolveFolders,
  UNREAD_SCAN_WINDOW,
  type ImapClientLike,
} from './providers/imap.ts';
import { ImapWorkerError } from './providers/imap-runner.ts';
import type { MailProvider } from './providers/types.ts';

const YAHOO_CONFIG = {
  username: 'me@yahoo.com',
  imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls', webmailUrl: 'https://mail.yahoo.com/' },
};
const IMAP_CONFIG = { username: 'me', imap: { host: 'mail.example.net', port: 143, security: 'starttls', webmailUrl: null } };

let ctx: TestContext;
let accounts: FakeAccountService;
let server: FakeImapServer;
let provider: MailProvider;
const signal = () => new AbortController().signal;
const yahoo = () => accounts.get('y1') as Account;

beforeEach(() => {
  ctx = createTestContext({
    accounts: [
      { id: 'y1', kind: 'yahoo', email: 'me@yahoo.com', capabilities: ['calendar', 'mail'], password: 'app-password', config: YAHOO_CONFIG },
      { id: 'i1', kind: 'imap', capabilities: ['mail'], password: 'app-password', config: IMAP_CONFIG },
    ],
  });
  accounts = ctx.accounts as FakeAccountService;
  server = new FakeImapServer({
    mailboxes: [{ path: 'INBOX', uidValidity: 1700000000n, messages: [1, 2, 3, 5, 8, 9].map((uid) => message(uid, { seen: uid % 3 === 0 })) }],
  });
  provider = createImapProvider({ accounts, memo: ctx.memo, log: ctx.log, connect: server.factory() });
});
afterEach(() => ctx.close());

const loginError = (props: Record<string, unknown>): Error & Record<string, unknown> => Object.assign(new Error('LOGIN failed'), props);
const idFor = (uid: number, uidValidity: bigint | number = 1700000000n, mailbox = 'INBOX') => encodeImapId({ mailbox, uidValidity, uid });

describe('IMAP message ids (§4.10)', () => {
  it('round-trips base64url(mailbox\\nuidValidity\\nuid), including non-ASCII mailbox names', () => {
    const id = encodeImapId({ mailbox: 'INBOX/Café', uidValidity: 4294967295n, uid: 42 });
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(id, 'base64url').toString('utf8')).toBe('INBOX/Café\n4294967295\n42');
    expect(decodeImapId(id)).toEqual({ mailbox: 'INBOX/Café', uidValidity: '4294967295', uid: 42 });
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'abc+/='],
    ['two parts', Buffer.from('INBOX\n5').toString('base64url')],
    ['four parts', Buffer.from('INBOX\n5\n6\n7').toString('base64url')],
    ['uid 0', Buffer.from('INBOX\n5\n0').toString('base64url')],
    ['uid overflow', Buffer.from('INBOX\n5\n4294967296').toString('base64url')],
    ['leading zeros', Buffer.from('INBOX\n05\n6').toString('base64url')],
    ['negative', Buffer.from('INBOX\n5\n-6').toString('base64url')],
    ['empty mailbox', Buffer.from('\n5\n6').toString('base64url')],
    ['control chars', Buffer.from('IN\u0000BOX\n5\n6').toString('base64url')],
    ['non-canonical', `${Buffer.from('INBOX\n5\n6').toString('base64url')}A`],
    ['not a string', 42],
  ])('rejects %s', (_label, id) => {
    expect(decodeImapId(id)).toBeNull();
  });
});

describe('IMAP listing', () => {
  it('STATUS INBOX (UNSEEN), EXAMINE INBOX, fetches the newest N by sequence, then logs out', async () => {
    const listing = await provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() });
    expect(server.log).toEqual([
      'CONNECT',
      'LIST',
      'STATUS INBOX (UNSEEN)',
      'EXAMINE INBOX',
      'FETCH 2:6 (UID FLAGS ENVELOPE INTERNALDATE)',
      'RELEASE INBOX',
      'LOGOUT',
    ]);
    expect(server.connections[0]).toMatchObject({ host: 'imap.mail.yahoo.com', port: 993, security: 'tls', username: 'me@yahoo.com' });
    expect(listing.unread).toBe(4);
    expect(listing.canArchive).toBe(true);
    expect(listing.messages.map((m) => decodeImapId(m.id)?.uid)).toEqual([9, 8, 5, 3, 2]);
    expect(listing.messages[0]).toEqual({
      id: idFor(9),
      accountId: 'y1',
      from: { name: 'Sender 9', address: 'sender9@example.com' },
      subject: 'Message 9',
      snippet: null,
      date: '2026-09-01T08:09:00.000Z',
      unread: false,
      webUrl: null,
    });
    expect(listing.messages.find((m) => decodeImapId(m.id)?.uid === 8)?.unread).toBe(true);
  });

  it('unreadOnly: UID SEARCH <recent seq> UNSEEN, then UID FETCH of the highest N UIDs', async () => {
    const listing = await provider.list(yahoo(), { maxMessages: 2, unreadOnly: true, signal: signal() });
    expect(server.log).toContain('UID SEARCH 1:6 UNSEEN');
    expect(server.log).toContain('UID FETCH 8,5 (UID FLAGS ENVELOPE INTERNALDATE)');
    expect(listing.messages.map((m) => decodeImapId(m.id)?.uid)).toEqual([8, 5]);
    expect(listing.messages.every((m) => m.unread)).toBe(true);
  });

  it('unreadOnly searches only the newest UNREAD_SCAN_WINDOW messages, so the SEARCH line stays small', async () => {
    server.inbox().messages = Array.from({ length: UNREAD_SCAN_WINDOW + 500 }, (_, i) => message(i + 1, { seen: i % 2 === 0 }));
    const listing = await provider.list(yahoo(), { maxMessages: 3, unreadOnly: true, signal: signal() });
    expect(server.log).toContain(`UID SEARCH 501:${UNREAD_SCAN_WINDOW + 500} UNSEEN`);
    expect(listing.messages.map((m) => decodeImapId(m.id)?.uid)).toEqual([1500, 1498, 1496]);
    // The count still comes from STATUS (the whole mailbox).
    expect(listing.unread).toBe(750);
  });

  it('an empty inbox fetches nothing', async () => {
    server.inbox().messages = [];
    const listing = await provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() });
    expect(listing).toMatchObject({ unread: 0, messages: [] });
    expect(server.log.some((c) => c.includes('FETCH'))).toBe(false);
  });

  it('caches the mailbox list per account in the memo', async () => {
    await provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() });
    await provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() });
    expect(server.log.filter((c) => c === 'LIST')).toHaveLength(1);
    expect(ctx.memo.get(foldersKey('y1'))).toEqual({ trash: 'Trash', archive: 'Archive' });
  });

  it('canArchive is false without an Archive folder or without MOVE/UIDPLUS', async () => {
    server.list = [listEntry('INBOX'), listEntry('Trash', { flags: ['\\Trash'] })];
    expect((await provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() })).canArchive).toBe(false);

    ctx.memo.delPrefix('mail:');
    server.list = [listEntry('INBOX'), listEntry('Archive', { flags: ['\\Archive'] })];
    server.capabilities = new Set(['IMAP4rev1']);
    expect((await provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() })).canArchive).toBe(false);
  });

  it('a rejected login marks the account for reauth and is not retried until fixed', async () => {
    server.password = 'changed';
    await expect(provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() })).rejects.toMatchObject({
      status: 409,
      code: 'reauth_required',
      accountId: 'y1',
    });
    expect(accounts.statusChanges).toContainEqual({
      id: 'y1',
      status: 'reauth',
      message: 'The mail server rejected the password',
      meta: { reason: 'imap_password_rejected', source: 'mail' },
    });
    expect(server.log).toEqual(['CONNECT', 'CLOSE']);

    server.clearLog();
    // Parked: a fixed text that blames no one (CalDAV or a vault reset may have parked it too).
    await expect(provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() })).rejects.toMatchObject({
      code: 'reauth_required',
      message: REAUTH_MESSAGE,
    });
    expect(server.log).toEqual([]);
  });

  it('a parked account never echoes its status message', async () => {
    accounts.setStatus('y1', 'reauth', 'CalDAV server said: Invalid credentials for me@yahoo.com');
    const failure = provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() });
    await expect(failure).rejects.toMatchObject({ code: 'reauth_required', accountId: 'y1', message: REAUTH_MESSAGE });
    expect(server.connections).toHaveLength(0);
  });

  it.each<[Record<string, unknown>, string, string]>([
    [{ code: 'ENOTFOUND' }, 'provider_error', 'could not be found'],
    [{ code: 'ECONNREFUSED' }, 'provider_error', 'Could not connect'],
    [{ tlsFailed: true, code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }, 'provider_error', 'TLS'],
    [{ code: 'CONNECT_TIMEOUT' }, 'upstream_timeout', 'did not respond'],
    [{ code: 'ETHROTTLE' }, 'rate_limited', 'rate limiting'],
  ])('maps connection error %j to %s', async (props, code, text) => {
    server.connectError = Object.assign(new Error('boom: server said something'), props);
    const failure = provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() });
    await expect(failure).rejects.toMatchObject({ code, accountId: 'y1', message: expect.stringContaining(text) });
    await expect(failure).rejects.not.toMatchObject({ message: expect.stringContaining('server said') });
    expect(server.clients[0]?.closed).toBe(true);
  });

  it.each<[string, string, string]>([
    ['UNAVAILABLE', 'provider_error', 'temporarily unavailable'],
    ['LIMIT', 'rate_limited', 'too many connections'],
    ['INUSE', 'rate_limited', 'too many connections'],
    ['SERVERBUG', 'provider_error', 'temporarily unavailable'],
  ])('a transient LOGIN refusal [%s] is %s, not a wrong password (no reauth lock-out)', async (responseCode, code, text) => {
    server.connectError = loginError({ authenticationFailed: true, serverResponseCode: responseCode });
    await expect(provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() })).rejects.toMatchObject({
      code,
      accountId: 'y1',
      message: expect.stringContaining(text),
    });
    expect(accounts.statusChanges.filter((c) => c.status === 'reauth')).toEqual([]);
    // The next refresh tries again (the account is not parked in reauth).
    server.connectError = null;
    await expect(provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() })).resolves.toMatchObject({ unread: 4 });
  });

  it('LOGIN refusals with AUTHENTICATIONFAILED (or no response code) still mean a wrong password', async () => {
    server.connectError = loginError({ authenticationFailed: true, serverResponseCode: 'AUTHENTICATIONFAILED' });
    await expect(provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() })).rejects.toMatchObject({ code: 'reauth_required' });
    const other = accounts.get('i1') as Account;
    server.connectError = loginError({ authenticationFailed: true });
    await expect(provider.list(other, { maxMessages: 5, unreadOnly: false, signal: signal() })).rejects.toMatchObject({ code: 'reauth_required' });
  });

  it('canTrash is false without a Trash folder or without MOVE/UIDPLUS (the UI hides the action, §4.10)', async () => {
    expect(await provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() })).toMatchObject({ canTrash: true, canArchive: true });

    ctx.memo.delPrefix('mail:');
    server.list = [listEntry('INBOX'), listEntry('Archive', { flags: ['\\Archive'] })];
    expect(await provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() })).toMatchObject({ canTrash: false, canArchive: true });

    ctx.memo.delPrefix('mail:');
    server.list = [listEntry('INBOX'), listEntry('Trash', { flags: ['\\Trash'] })];
    server.capabilities = new Set(['IMAP4rev1']);
    expect(await provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() })).toMatchObject({ canTrash: false, canArchive: false });
  });

  it('aborting (per-account timeout) closes the connection and reports upstream_timeout', async () => {
    server.hang = true;
    const controller = new AbortController();
    const pending = provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'upstream_timeout' });
    expect(server.clients[0]?.closed).toBe(true);
  });
});

describe('special-use resolution (§4.10)', () => {
  it('prefers RFC 6154 \\Trash / \\Archive attributes', () => {
    expect(
      resolveFolders([
        listEntry('INBOX'),
        listEntry('Trash'),
        listEntry('[Gmail]/Bin', { flags: ['\\Trash'] }),
        listEntry('[Gmail]/All Mail', { flags: ['\\All'] }),
        listEntry('Old', { flags: ['\\Archive'] }),
        listEntry('Archive'),
      ]),
    ).toEqual({ trash: '[Gmail]/Bin', archive: 'Old' });
  });

  it('falls back to the exact names Trash, Deleted Items, Deleted Messages, Bin / Archive', () => {
    expect(resolveFolders([listEntry('INBOX'), listEntry('Deleted Items'), listEntry('Archive')])).toEqual({ trash: 'Deleted Items', archive: 'Archive' });
    expect(resolveFolders([listEntry('INBOX'), listEntry('Deleted Messages')])).toEqual({ trash: 'Deleted Messages', archive: null });
    expect(resolveFolders([listEntry('INBOX'), listEntry('Bin')]).trash).toBe('Bin');
    // Namespace-prefixed servers (INBOX.Trash).
    expect(resolveFolders([listEntry('INBOX'), listEntry('INBOX.Trash'), listEntry('INBOX.Archive')])).toEqual({
      trash: 'INBOX.Trash',
      archive: 'INBOX.Archive',
    });
  });

  it('ignores \\Noselect / \\NonExistent entries, nested look-alikes and imapflow name guesses', () => {
    expect(
      resolveFolders([
        listEntry('INBOX'),
        listEntry('Trash', { flags: ['\\Noselect'] }),
        listEntry('Projects/Trash'),
        listEntry('Papierkorb', { specialUse: '\\Trash', specialUseSource: 'name' }),
        listEntry('Archives'),
        listEntry('trash'),
      ]),
    ).toEqual({ trash: null, archive: null });
    expect(resolveFolders([listEntry('Gone', { flags: ['\\Trash', '\\NonExistent'] }), listEntry('Bin')]).trash).toBe('Bin');
  });

  it('MOVE when advertised, COPY + UID EXPUNGE only with UIDPLUS, otherwise nothing', () => {
    expect(moveStrategy(new Map([['MOVE', true]]))).toBe('move');
    expect(moveStrategy(new Map([['UIDPLUS', true]]))).toBe('copy-expunge');
    expect(moveStrategy(new Map([['IMAP4rev1', true]]))).toBeNull();
  });

  it('IMAP4rev2 folds MOVE/UIDPLUS in exactly when imapflow treats rev2 as active', () => {
    // rev2-only server, or rev2 ENABLEd by imapflow: MOVE is base protocol (imapflow sends UID MOVE).
    expect(moveStrategy(new Map([['IMAP4rev2', true]]))).toBe('move');
    expect(moveStrategy(new Map([['IMAP4rev1', true], ['IMAP4rev2', true]]), new Set(['IMAP4REV2']))).toBe('move');
    // Advertised but not enabled: stay on the rev1 rules.
    expect(moveStrategy(new Map([['IMAP4rev1', true], ['IMAP4rev2', true]]))).toBeNull();
  });
});

describe('IMAP actions (§4.10)', () => {
  it('read/unread: SELECT, UIDVALIDITY check, UID SEARCH, UID STORE ±FLAGS (\\Seen)', async () => {
    await provider.act(yahoo(), idFor(8), { type: 'read', read: true }, signal());
    expect(server.log).toEqual(['CONNECT', 'SELECT INBOX', 'UID SEARCH UID 8', 'UID STORE 8 +FLAGS (\\Seen)', 'RELEASE INBOX', 'LOGOUT']);
    expect(server.inbox().messages.find((m) => m.uid === 8)?.flags.has('\\Seen')).toBe(true);

    server.clearLog();
    await provider.act(yahoo(), idFor(8), { type: 'read', read: false }, signal());
    expect(server.log).toContain('UID STORE 8 -FLAGS (\\Seen)');
    expect(server.inbox().messages.find((m) => m.uid === 8)?.flags.has('\\Seen')).toBe(false);
  });

  it('UIDVALIDITY mismatch → 409 conflict (stale_message) and nothing is changed', async () => {
    const err = await provider.act(yahoo(), idFor(8, 1600000000n), { type: 'trash' }, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 409, code: 'conflict', details: { reason: 'stale_message' }, accountId: 'y1' });
    expect(server.log.some((c) => /STORE|MOVE|COPY|EXPUNGE/.test(c))).toBe(false);
    expect(server.inbox().messages).toHaveLength(6);
  });

  it('trash with MOVE: UID MOVE to the \\Trash mailbox', async () => {
    await provider.act(yahoo(), idFor(5), { type: 'trash' }, signal());
    expect(server.log).toEqual(['CONNECT', 'LIST', 'SELECT INBOX', 'UID SEARCH UID 5', 'UID MOVE 5 Trash', 'RELEASE INBOX', 'LOGOUT']);
    expect(server.inbox().messages.map((m) => m.uid)).not.toContain(5);
    expect(server.mailboxes.get('Trash')?.messages).toHaveLength(1);
  });

  it('archive without MOVE but with UIDPLUS: UID COPY, then STORE \\Deleted + UID EXPUNGE of that UID only', async () => {
    server.capabilities = new Set(['IMAP4rev1', 'UIDPLUS']);
    server.inbox().messages.find((m) => m.uid === 1)?.flags.add('\\Deleted'); // someone else's pending delete
    await provider.act(yahoo(), idFor(5), { type: 'archive' }, signal());
    const actionLog = server.log.slice(server.log.indexOf('UID SEARCH UID 5') + 1, server.log.indexOf('RELEASE INBOX'));
    expect(actionLog).toEqual(['UID COPY 5 Archive', 'UID STORE 5 +FLAGS (\\Deleted)', 'UID EXPUNGE 5']);
    expect(server.log).not.toContain('EXPUNGE');
    expect(server.inbox().messages.map((m) => m.uid)).toEqual([1, 2, 3, 8, 9]);
    expect(server.mailboxes.get('Archive')?.messages).toHaveLength(1);
  });

  it('a failed COPY never flags \\Deleted or expunges', async () => {
    server.capabilities = new Set(['IMAP4rev1', 'UIDPLUS']);
    server.failCopy = true;
    await expect(provider.act(yahoo(), idFor(5), { type: 'trash' }, signal())).rejects.toMatchObject({ code: 'provider_error' });
    expect(server.log).toContain('UID COPY 5 Trash');
    expect(server.log.some((c) => c.includes('\\Deleted') || c.includes('EXPUNGE'))).toBe(false);
    expect(server.inbox().messages).toHaveLength(6);
  });

  it('refuses (422) without MOVE and UIDPLUS — no COPY, STORE or EXPUNGE is attempted', async () => {
    server.capabilities = new Set(['IMAP4rev1']);
    await expect(provider.act(yahoo(), idFor(5), { type: 'trash' }, signal())).rejects.toMatchObject({ status: 422, code: 'validation_failed' });
    expect(server.log.some((c) => /COPY|MOVE|STORE|EXPUNGE|SELECT/.test(c))).toBe(false);
  });

  it('unresolvable target → 422 (archive without an Archive folder)', async () => {
    server.list = [listEntry('INBOX'), listEntry('Trash', { flags: ['\\Trash'] })];
    await expect(provider.act(yahoo(), idFor(5), { type: 'archive' }, signal())).rejects.toMatchObject({
      status: 422,
      message: 'This mailbox has no Archive folder',
    });
  });

  it('a message that no longer exists → 404 without touching anything', async () => {
    await expect(provider.act(yahoo(), idFor(77), { type: 'read', read: true }, signal())).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(server.log.some((c) => c.includes('STORE'))).toBe(false);
  });

  it('malformed ids never open a connection', async () => {
    await expect(provider.act(yahoo(), 'not-an-id', { type: 'trash' }, signal())).rejects.toMatchObject({ status: 404 });
    expect(server.connections).toHaveLength(0);
  });

  it('uses only UID commands for actions', async () => {
    await provider.act(yahoo(), idFor(9), { type: 'read', read: true }, signal());
    await provider.act(yahoo(), idFor(9), { type: 'trash' }, signal());
    const mutating = server.log.filter((c) => /STORE|MOVE|COPY|EXPUNGE|SEARCH|FETCH/.test(c));
    expect(mutating.length).toBeGreaterThan(0);
    expect(mutating.every((c) => c.startsWith('UID '))).toBe(true);
  });
});

describe('IMAP probe and connection options', () => {
  const draft = (password: string, kind: 'yahoo' | 'imap' = 'yahoo'): AccountDraft => ({
    kind,
    label: 'x',
    email: null,
    config: kind === 'yahoo' ? YAHOO_CONFIG : IMAP_CONFIG,
    secret: { password },
  });

  it('logs in and checks STATUS INBOX with the draft credentials', async () => {
    const probe = createImapProbe({ connect: server.factory(), log: ctx.log });
    await expect(probe(draft('app-password'))).resolves.toEqual({});
    expect(server.log).toEqual(['CONNECT', 'STATUS INBOX (UNSEEN)', 'LOGOUT']);
    await expect(probe(draft('app-password', 'imap'))).resolves.toEqual({});
    expect(server.connections[1]).toMatchObject({ host: 'mail.example.net', port: 143, security: 'starttls', username: 'me' });
  });

  it('a transient LOGIN refusal is reported as a server problem, not as wrong credentials', async () => {
    server.connectError = loginError({ authenticationFailed: true, serverResponseCode: 'UNAVAILABLE' });
    const probe = createImapProbe({ connect: server.factory(), log: ctx.log });
    await expect(probe(draft('app-password'))).rejects.toMatchObject({ code: 'provider_error', message: expect.stringContaining('temporarily unavailable') });
  });

  it('reports rejected credentials as a validation failure (no account exists yet)', async () => {
    const probe = createImapProbe({ connect: server.factory(), log: ctx.log });
    await expect(probe(draft('wrong'))).rejects.toMatchObject({ status: 422, code: 'validation_failed' });
    await expect(probe({ ...draft('x'), config: { username: 'me' }, kind: 'imap' })).rejects.toMatchObject({ status: 422 });
  });

  it('imapflow options: TLS or mandatory STARTTLS, verified certificates, TLS ≥ 1.2, logger off, 15 s timeouts', () => {
    const tls = imapFlowOptions({ host: 'imap.mail.yahoo.com', port: 993, security: 'tls', username: 'u', password: 'p' });
    expect(tls).toMatchObject({
      secure: true,
      logger: false,
      disableAutoIdle: true,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 15_000,
    });
    expect(tls.doSTARTTLS).toBeUndefined();
    const starttls = imapFlowOptions({ host: 'mail.example.net', port: 143, security: 'starttls', username: 'u', password: 'p' });
    expect(starttls).toMatchObject({ secure: false, doSTARTTLS: true, tls: { rejectUnauthorized: true } });
  });

  it('bounds lines, literals and whole responses tightly (no bodies are ever fetched)', () => {
    const options = imapFlowOptions({ host: 'imap.mail.yahoo.com', port: 993, security: 'tls', username: 'u', password: 'p' });
    expect(options.maxLineLength).toBeLessThanOrEqual(64 * 1024);
    expect(options.maxLiteralSize).toBeLessThanOrEqual(64 * 1024);
    expect(options.maxResponseSize).toBeLessThanOrEqual(256 * 1024);
    // imapflow wants headroom: a response must be able to hold a maximal literal plus its line.
    expect(options.maxResponseSize).toBeGreaterThan((options.maxLiteralSize ?? 0) + (options.maxLineLength ?? 0));
  });
});

describe('diagnostics: phases, causes and health hints', () => {
  const stages = () => {
    const seen: string[] = [];
    return { seen, onStage: (stage: string) => seen.push(stage) };
  };
  const records = (msg: string) => ctx.logs.query({ limit: 5000 }).records.filter((r) => r.msg === msg);
  const sessionError = (message: string, props: Record<string, unknown>): Error & Record<string, unknown> => Object.assign(new Error(message), props);

  it('reports each session phase of a listing (LIST only while folders are not cached)', async () => {
    const first = stages();
    await provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal(), onStage: first.onStage });
    expect(first.seen).toEqual(['connect', 'list', 'status', 'examine', 'fetch', 'logout']);

    const unread = stages();
    await provider.list(yahoo(), { maxMessages: 2, unreadOnly: true, signal: signal(), onStage: unread.onStage });
    expect(unread.seen).toEqual(['connect', 'status', 'examine', 'search', 'fetch', 'logout']);
  });

  it('reports the phases of actions (store, move, copy + expunge)', async () => {
    const read = stages();
    await provider.act(yahoo(), idFor(8), { type: 'read', read: true }, signal(), read.onStage);
    expect(read.seen).toEqual(['connect', 'select', 'search', 'store', 'logout']);

    const trash = stages();
    await provider.act(yahoo(), idFor(5), { type: 'trash' }, signal(), trash.onStage);
    expect(trash.seen).toEqual(['connect', 'list', 'select', 'search', 'move', 'logout']);

    server.capabilities = new Set(['IMAP4rev1', 'UIDPLUS']);
    const archive = stages();
    await provider.act(yahoo(), idFor(9), { type: 'archive' }, signal(), archive.onStage);
    expect(archive.seen).toEqual(['connect', 'select', 'search', 'copy', 'expunge', 'logout']);
  });

  it('a refused login is reported at the login phase; a connect failure at connect', async () => {
    server.password = 'changed';
    const login = stages();
    await expect(provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal(), onStage: login.onStage })).rejects.toMatchObject({
      code: 'reauth_required',
    });
    expect(login.seen).toEqual(['connect', 'login']);

    server.connectError = sessionError('connect ECONNREFUSED', { code: 'ECONNREFUSED' });
    const refused = stages();
    const other = accounts.get('i1') as Account;
    await expect(provider.list(other, { maxMessages: 5, unreadOnly: false, signal: signal(), onStage: refused.onStage })).rejects.toMatchObject({
      code: 'provider_error',
    });
    expect(refused.seen).toEqual(['connect']);
  });

  it('connectPhase reads how far connect() got from the error and the client state', () => {
    type State = Partial<Pick<ImapClientLike, 'tls' | 'greeting' | 'secureConnection' | 'authenticated'>>;
    const client = (state: State) => state as ImapClientLike;
    // Not connected yet / TLS handshake.
    expect(connectPhase(client({}), 'tls')).toBe('connect');
    // Connected, waiting for the greeting.
    expect(connectPhase(client({ tls: false }), 'starttls')).toBe('greeting');
    // Greeted on cleartext: STARTTLS (CAPABILITY, STARTTLS) pending.
    expect(connectPhase(client({ tls: false, greeting: '', secureConnection: false }), 'starttls')).toBe('starttls');
    // Upgraded, or implicit TLS: logging in.
    expect(connectPhase(client({ tls: {}, greeting: 'Hi', secureConnection: true }), 'starttls')).toBe('login');
    expect(connectPhase(client({ tls: {}, greeting: 'Hi', secureConnection: true }), 'tls')).toBe('login');
    // The error names the step when it can.
    expect(connectPhase(client({}), 'tls', { code: 'GREETING_TIMEOUT' })).toBe('greeting');
    expect(connectPhase(client({ tls: false, greeting: '' }), 'starttls', { code: 'UPGRADE_TIMEOUT' })).toBe('starttls');
    expect(connectPhase(client({ tls: false, greeting: '' }), 'starttls', { code: 'STARTTLS_INJECTION' })).toBe('starttls');
    expect(connectPhase(client({ tls: {} }), 'tls', { code: 'CONNECT_TIMEOUT' })).toBe('connect');
    expect(connectPhase(client({}), 'tls', { authenticationFailed: true })).toBe('login');
  });

  it('mapImapError keeps the session error as the cause, never its text', () => {
    const raw = Object.assign(new Error('* BYE server said: me@yahoo.com is over quota'), { code: 'ECONNRESET' });
    const mapped = mapImapError(raw, 'imap.example.net', 'y1', false);
    expect(mapped).toBeInstanceOf(HttpError);
    expect(mapped).toMatchObject({ code: 'provider_error', accountId: 'y1', message: 'Could not connect to the mail server imap.example.net' });
    expect(mapped.cause).toBe(raw);
    expect((mapped as HttpError).toBody()).toEqual({
      error: { code: 'provider_error', message: 'Could not connect to the mail server imap.example.net', accountId: 'y1' },
    });

    const op = new ImapOpError(409, 'conflict', 'The mailbox changed', { reason: 'stale_message' });
    expect(mapImapError(op, 'h', 'y1', false).cause).toBe(op);
    // A worker failure is Portly's, not the server's.
    const worker = mapImapError(new ImapWorkerError('error', 'The IMAP worker failed'), 'imap.example.net', 'y1', false);
    expect(worker).toMatchObject({ code: 'provider_error', message: expect.stringContaining('stopped unexpectedly') });
    expect(worker.message).not.toContain('returned an error');
    // …unless the caller had already given up.
    expect(mapImapError(new ImapWorkerError('exit', 'x'), 'h', 'y1', true)).toMatchObject({ code: 'upstream_timeout' });
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['TLS (flag only)', { tlsFailed: true, code: 'STARTTLS_INJECTION' }, { code: 'tls', detail: { tlsFailed: true } }],
    ['TLS (certificate code)', { code: 'CERT_HAS_EXPIRED' }, { code: 'tls', detail: {} }],
    ['closed connection', { code: 'NoConnection' }, { code: 'reset', detail: {} }],
    ['closed after connect', { code: 'ClosedAfterConnectText' }, { code: 'reset', detail: {} }],
    ['unreadable response', { code: 'InvalidResponse' }, { code: 'parse_error', detail: {} }],
    ['refused (left to the cause code)', { code: 'ECONNREFUSED' }, { detail: {} }],
    [
      'server temporarily unavailable',
      { authenticationFailed: true, serverResponseCode: 'UNAVAILABLE' },
      { detail: { authenticationFailed: true, serverResponseCode: 'UNAVAILABLE' } },
    ],
    [
      'too many connections (rate_limited stays)',
      { authenticationFailed: true, serverResponseCode: 'LIMIT' },
      { detail: { authenticationFailed: true, serverResponseCode: 'LIMIT' } },
    ],
    ['timeout stays a timeout', { code: 'GREETING_TIMEOUT' }, { detail: {} }],
  ])('imapHealthHints: %s', (_label, fields, expected) => {
    const mapped = mapImapError(Object.assign(new Error('server text'), fields), 'imap.example.net', 'y1', false);
    expect(imapHealthHints(mapped)).toEqual(expected);
  });

  it('imapHealthHints: worker failures, and nothing for errors without an IMAP cause', () => {
    const worker = mapImapError(new ImapWorkerError('exit', 'The IMAP worker stopped unexpectedly'), 'h', 'y1', false);
    expect(imapHealthHints(worker)).toEqual({ code: 'worker_failed', detail: { worker: 'exit' } });
    expect(imapHealthHints(new HttpError(409, 'reauth_required', 'x'))).toEqual({ detail: {} });
    expect(imapHealthHints(new TypeError('boom'))).toEqual({ detail: {} });
    // Codes that are not machine tokens (a server-chosen response code, say) are dropped.
    const busy = mapImapError(Object.assign(new Error('x'), { authenticationFailed: true, serverResponseCode: 'LIMIT', code: 'a b c' }), 'h', 'y1', false);
    expect(imapHealthHints(busy)).toEqual({ detail: { authenticationFailed: true, serverResponseCode: 'LIMIT' } });
    const odd = mapImapError(Object.assign(new Error('x'), { tlsFailed: true, serverResponseCode: 'see me@x.com now' }), 'h', 'y1', false);
    expect(imapHealthHints(odd)).toEqual({ code: 'tls', detail: { tlsFailed: true } });
  });

  it('session failures are debug-logged with the phase and codes only (no server text)', async () => {
    server.connectError = sessionError('boom: server said me@yahoo.com is locked', { code: 'ECONNREFUSED', responseText: 'locked' });
    await expect(provider.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() })).rejects.toMatchObject({ code: 'provider_error' });
    const [line] = records('imap session failed');
    expect(line?.level).toBe('debug');
    expect(line?.fields).toMatchObject({
      host: 'imap.mail.yahoo.com',
      port: 993,
      security: 'tls',
      op: 'list',
      phase: 'connect',
      errCode: 'ECONNREFUSED',
      mappedTo: 'provider_error',
      aborted: false,
    });
    const text = JSON.stringify(ctx.logs.query({ limit: 5000 }).records);
    expect(text).not.toContain('server said');
    expect(text).not.toContain('locked');
    expect(text).not.toContain('me@yahoo.com');
    expect(text).not.toContain('app-password');
  });

  it('connection-level errors are debug-logged with codes and flags only', async () => {
    const connect = server.factory();
    const noisy = createImapProvider({
      accounts,
      memo: ctx.memo,
      log: ctx.log,
      connect: (params) => {
        const client = connect(params) as ImapClientLike & { errorListeners: ((err: Error) => void)[] };
        queueMicrotask(() => {
          for (const listener of client.errorListeners) {
            listener(Object.assign(new Error('Socket closed by me@yahoo.com'), { code: 'ECONNRESET', tlsFailed: true }));
          }
        });
        return client;
      },
    });
    await noisy.list(yahoo(), { maxMessages: 5, unreadOnly: false, signal: signal() });
    const [line] = records('imap connection error');
    expect(line?.fields).toMatchObject({ host: 'imap.mail.yahoo.com', errCode: 'ECONNRESET', tlsFailed: true });
    expect(JSON.stringify(line)).not.toContain('me@yahoo.com');
  });
});
