import { describe, expect, it } from 'vitest';
import type { MailAccountSummary, MailMessage } from '@portly/shared';
import { applyMailAction, mailSummaryKey, mailSummaryPath } from '../../api/mail.ts';
import { accountGroups, failedAccounts, folderOf, mergedRows, rowHref, senderLabel, toggleFolder, toggleHidden, totalUnread, visibleSummaries } from './view.ts';

function msg(id: string, accountId: string, date: string, extra: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    accountId,
    from: { name: `From ${id}`, address: `${id}@example.com` },
    subject: `Subject ${id}`,
    snippet: null,
    date,
    unread: false,
    webUrl: null,
    ...extra,
  };
}

function summary(accountId: string, messages: MailMessage[], extra: Partial<MailAccountSummary> = {}): MailAccountSummary {
  return {
    accountId,
    label: accountId.toUpperCase(),
    email: `${accountId}@example.com`,
    color: null,
    unread: messages.filter((m) => m.unread).length,
    messages,
    webmailUrl: null,
    canArchive: true,
    ...extra,
  };
}

const A = summary('a', [msg('a1', 'a', '2026-09-24T10:00:00Z', { unread: true }), msg('a2', 'a', '2026-09-20T10:00:00Z')]);
const B = summary('b', [msg('b1', 'b', '2026-09-25T08:00:00Z'), msg('b2', 'b', '2026-09-22T10:00:00Z', { unread: true })], { unread: 12 });
const C = summary('c', [], { error: { code: 'reauth_required', message: 'Reconnect', accountId: 'c' }, unread: 0 });

describe('mail view grouping', () => {
  it('merged: every account newest first, capped at the limit', () => {
    expect(mergedRows([A, B, C], 10).map((r) => r.message.id)).toEqual(['b1', 'a1', 'b2', 'a2']);
    expect(mergedRows([A, B, C], 3).map((r) => r.message.id)).toEqual(['b1', 'a1', 'b2']);
    expect(mergedRows([A, B], 10)[0]?.summary.accountId).toBe('b');
  });

  it('byAccount: one group per account in server order, each capped', () => {
    const groups = accountGroups([B, A, C], 1);
    expect(groups.map((g) => [g.summary.accountId, g.rows.map((r) => r.message.id)])).toEqual([
      ['b', ['b1']],
      ['a', ['a1']],
      ['c', []],
    ]);
  });

  it('totals the provider unread counts of accounts that loaded', () => {
    expect(totalUnread([A, B, C])).toBe(13);
    expect(failedAccounts([A, B, C]).map((s) => s.accountId)).toEqual(['c']);
  });

  it('labels senders by name, else address, else a placeholder', () => {
    expect(senderLabel({ name: 'Jane', address: 'j@x.com' })).toBe('Jane');
    expect(senderLabel({ name: ' ', address: 'j@x.com' })).toBe('j@x.com');
    expect(senderLabel({ name: '', address: '' })).toBe('Unknown sender');
  });

  it('rows open the message link, else the webmail inbox, never unsafe URLs', () => {
    const webmail = summary('w', [], { webmailUrl: 'https://mail.yahoo.com/' });
    expect(rowHref({ summary: webmail, message: msg('x', 'w', '2026-09-24T10:00:00Z', { webUrl: 'https://mail.google.com/mail/u/0/#inbox/x' }) })).toBe(
      'https://mail.google.com/mail/u/0/#inbox/x',
    );
    expect(rowHref({ summary: webmail, message: msg('x', 'w', '2026-09-24T10:00:00Z') })).toBe('https://mail.yahoo.com/');
    expect(rowHref({ summary: webmail, message: msg('x', 'w', '2026-09-24T10:00:00Z', { webUrl: 'javascript:alert(1)' }) })).toBe('https://mail.yahoo.com/');
    expect(rowHref({ summary: { ...webmail, webmailUrl: '#/settings/accounts' }, message: msg('x', 'w', '2026-09-24T10:00:00Z') })).toBeUndefined();
  });
});

describe('optimistic mail actions (applyMailAction)', () => {
  it('read/unread flips the message and adjusts the account count once', () => {
    const read = applyMailAction([A, B], { accountId: 'a', messageId: 'a1', action: 'read' });
    expect(read[0]?.messages[0]?.unread).toBe(false);
    expect(read[0]?.unread).toBe(0);
    expect(read[1]).toBe(B);
    // Already read: unchanged.
    expect(applyMailAction(read, { accountId: 'a', messageId: 'a1', action: 'read' })[0]).toBe(read[0]);
    const unread = applyMailAction(read, { accountId: 'a', messageId: 'a2', action: 'unread' });
    expect(unread[0]?.unread).toBe(1);
  });

  it('archive/trash remove the message and decrement unread when it was unread', () => {
    const trashed = applyMailAction([A, B], { accountId: 'b', messageId: 'b2', action: 'trash' });
    expect(trashed[1]?.messages.map((m) => m.id)).toEqual(['b1']);
    expect(trashed[1]?.unread).toBe(11);
    const archived = applyMailAction([A, B], { accountId: 'b', messageId: 'b1', action: 'archive' });
    expect(archived[1]?.unread).toBe(12);
  });

  it('ignores unknown accounts/messages', () => {
    const list = [A, B];
    expect(applyMailAction(list, { accountId: 'zzz', messageId: 'a1', action: 'trash' })).toEqual(list);
    expect(applyMailAction(list, { accountId: 'a', messageId: 'b1', action: 'trash' })[0]).toBe(A);
  });

  it('builds stable query keys and request paths', () => {
    expect(mailSummaryKey({ maxMessages: 10, unreadOnly: false, accountIds: ['b', 'a'] })).toEqual([
      'mail',
      'summary',
      { maxMessages: 10, unreadOnly: false, accountIds: 'a,b' },
    ]);
    expect(mailSummaryPath({ maxMessages: 7, unreadOnly: true, accountIds: 'all' })).toBe('/api/mail/summary?maxMessages=7&unreadOnly=true');
    expect(mailSummaryPath({ maxMessages: 7, unreadOnly: false, accountIds: ['x', 'y'] })).toBe(
      '/api/mail/summary?maxMessages=7&unreadOnly=false&accountIds=x%2Cy',
    );
  });
});

describe('sidebar visibility', () => {
  const a = summary('a', []);
  const b = summary('b', []);

  it('visibleSummaries drops hidden accounts and keeps order', () => {
    expect(visibleSummaries([a, b], []).map((s) => s.accountId)).toEqual(['a', 'b']);
    expect(visibleSummaries([a, b], ['a']).map((s) => s.accountId)).toEqual(['b']);
  });

  it('toggleHidden adds/removes an id and forgets accounts that are gone', () => {
    expect(toggleHidden([], 'a', false, ['a', 'b'])).toEqual(['a']);
    expect(toggleHidden(['a'], 'a', true, ['a', 'b'])).toEqual([]);
    expect(toggleHidden(['gone', 'a'], 'b', false, ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('folders', () => {
  it('toggleFolder adds in the fixed order and never switches off the last folder', () => {
    expect(toggleFolder(['inbox'], 'trash', true)).toEqual(['inbox', 'trash']);
    expect(toggleFolder(['trash'], 'sent', true)).toEqual(['sent', 'trash']);
    expect(toggleFolder(['inbox', 'sent'], 'inbox', false)).toEqual(['sent']);
    expect(toggleFolder(['sent'], 'sent', false)).toEqual(['sent']);
  });

  it('folderOf defaults to the inbox', () => {
    expect(folderOf(msg('x', 'a', '2026-09-24T10:00:00Z'))).toBe('inbox');
    expect(folderOf(msg('x', 'a', '2026-09-24T10:00:00Z', { folder: 'spam' }))).toBe('spam');
  });

  it('puts the folders in the request path and key only when they are not just the inbox', () => {
    const base = { maxMessages: 10, unreadOnly: false, accountIds: 'all' } as const;
    expect(mailSummaryPath({ ...base, folders: ['inbox'] })).toBe('/api/mail/summary?maxMessages=10&unreadOnly=false');
    expect(mailSummaryPath({ ...base, folders: ['trash', 'inbox', 'sent'] })).toBe(
      '/api/mail/summary?maxMessages=10&unreadOnly=false&folders=inbox%2Csent%2Ctrash',
    );
    expect(mailSummaryKey({ ...base, folders: ['inbox'] })).toEqual(mailSummaryKey(base));
    expect(mailSummaryKey({ ...base, folders: ['sent'] })).toEqual(['mail', 'summary', { maxMessages: 10, unreadOnly: false, accountIds: 'all', folders: 'sent' }]);
  });

  it('actions on other folders leave the inbox unread count alone', () => {
    const sent = summary('s', [msg('s1', 's', '2026-09-24T10:00:00Z', { unread: true, folder: 'sent' })], { unread: 4 });
    expect(applyMailAction([sent], { accountId: 's', messageId: 's1', action: 'read' })[0]?.unread).toBe(4);
    expect(applyMailAction([sent], { accountId: 's', messageId: 's1', action: 'trash' })[0]?.unread).toBe(4);
  });
});
