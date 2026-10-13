import { describe, expect, it } from 'vitest';
import { MAIL_TEXT_LIMITS } from '@homebase/shared';
import { capText, cleanSubject, decodeSnippet, parseFromHeader, toIsoDate } from './text.ts';
import { allowlistedWebUrl, gmailMessageUrl, webmailUrlFor } from './weburl.ts';

describe('snippet decoding (§4.4)', () => {
  it('decodes HTML entities with entities.decodeHTML and keeps markup as plain text', () => {
    expect(decodeSnippet('Here&#39;s A &amp; B &lt;b&gt;bold&lt;/b&gt; &quot;q&quot; caf&eacute; &#x1F600;')).toBe(
      'Here\'s A & B <b>bold</b> "q" café 😀',
    );
  });

  it('never interprets HTML: tags stay literal text, nothing is stripped or executed', () => {
    expect(decodeSnippet('<script>alert(1)</script><img src=x onerror=alert(1)>')).toBe('<script>alert(1)</script><img src=x onerror=alert(1)>');
  });

  it('removes invisible padding, bidi overrides and control characters; collapses whitespace', () => {
    expect(decodeSnippet('Sale\u200c\u034f\u00ad \u202egnp.exe\u202c\u0007 &nbsp;&nbsp; now\r\n\tok')).toBe('Sale gnp.exe now ok');
  });

  it('returns null for empty or non-string input', () => {
    expect(decodeSnippet('')).toBeNull();
    expect(decodeSnippet('   &nbsp; \u200b')).toBeNull();
    expect(decodeSnippet(undefined)).toBeNull();
    expect(decodeSnippet(42)).toBeNull();
  });

  it('caps snippets and subjects at 500 code points without splitting surrogate pairs', () => {
    const long = '😀'.repeat(600);
    const snippet = decodeSnippet(long) as string;
    expect(Array.from(snippet)).toHaveLength(MAIL_TEXT_LIMITS.snippet);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(Array.from(cleanSubject('x'.repeat(2000)))).toHaveLength(MAIL_TEXT_LIMITS.subject);
    expect(capText('short', 10)).toBe('short');
  });

  it('decodes entities before capping so an entity is never cut', () => {
    const text = decodeSnippet(`${'a'.repeat(498)}&amp;&amp;&amp;`) as string;
    expect(text).not.toContain('&amp');
  });
});

describe('From header parsing', () => {
  it.each([
    ['"Doe, Jane" <jane@example.com>', { name: 'Doe, Jane', address: 'jane@example.com' }],
    ['Jane Doe <jane@example.com>', { name: 'Jane Doe', address: 'jane@example.com' }],
    ['<jane@example.com>', { name: '', address: 'jane@example.com' }],
    ['jane@example.com', { name: '', address: 'jane@example.com' }],
    ['jane@example.com (Jane Doe)', { name: 'Jane Doe', address: 'jane@example.com' }],
    ['Undisclosed', { name: 'Undisclosed', address: '' }],
  ])('%s', (header, expected) => {
    expect(parseFromHeader(header)).toEqual(expected);
  });

  it('strips bidi controls from display names', () => {
    expect(parseFromHeader('PayPal\u202e Support <x@evil.example>').name).toBe('PayPal Support');
  });

  it('never takes an address from inside a quoted display name (sender spoofing)', () => {
    // The real sender is the angle-addr outside the quotes; a look-alike inside the display name
    // must stay display text and must never become the shown/hover address.
    expect(parseFromHeader('"PayPal <service@paypal.com>" <attacker@evil.example>')).toEqual({
      name: 'PayPal <service@paypal.com>',
      address: 'attacker@evil.example',
    });
    expect(parseFromHeader('"Jane \\"JD\\" Doe" <jd@example.com>')).toEqual({ name: 'Jane "JD" Doe', address: 'jd@example.com' });
    expect(parseFromHeader('"support@bank.example" <attacker@evil.example>').address).toBe('attacker@evil.example');
    // A bare address inside quotes is display text only.
    expect(parseFromHeader('"billing@bank.example"')).toEqual({ name: 'billing@bank.example', address: '' });
  });
});

describe('dates', () => {
  it('accepts epoch ms strings, ISO and RFC 2822 text; ignores garbage', () => {
    expect(toIsoDate('1790234100000')).toBe('2026-09-24T07:15:00.000Z');
    expect(toIsoDate('2026-09-24T18:02:11Z')).toBe('2026-09-24T18:02:11.000Z');
    expect(toIsoDate('Thu, 24 Sep 2026 09:15:00 +0200')).toBe('2026-09-24T07:15:00.000Z');
    expect(toIsoDate('nonsense', 0, '1790234100000')).toBe('2026-09-24T07:15:00.000Z');
    expect(toIsoDate(undefined, null)).toBeNull();
  });
});

describe('webUrl allowlist (§4.4)', () => {
  it('accepts https links on mail.google.com, outlook.live.com and mail.yahoo.com', () => {
    expect(allowlistedWebUrl('https://mail.google.com/mail/u/?authuser=a%40b.c#inbox/abc')).toBe(
      'https://mail.google.com/mail/u/?authuser=a%40b.c#inbox/abc',
    );
    expect(allowlistedWebUrl('https://outlook.live.com/owa/?ItemID=x&exvsurl=1')).toBe('https://outlook.live.com/owa/?ItemID=x&exvsurl=1');
    expect(allowlistedWebUrl('https://mail.yahoo.com/')).toBe('https://mail.yahoo.com/');
  });

  it.each([
    'https://evil.example/owa',
    'https://mail.google.com.evil.example/',
    'https://evil.example/?next=https://mail.google.com',
    'http://mail.google.com/mail/',
    'https://mail.google.com:8443/mail/',
    'https://user:pw@mail.google.com/',
    'javascript:alert(1)//mail.google.com',
    'data:text/html,<b>mail.google.com</b>',
    'https://mail.google.com/\u0000',
    `https://mail.google.com/${'a'.repeat(2100)}`,
    '',
    null,
  ])('rejects %s', (value) => {
    expect(allowlistedWebUrl(value)).toBeNull();
  });

  it("allows the IMAP account's configured webmail origin only", () => {
    const configured = 'https://webmail.example.net/roundcube/';
    expect(allowlistedWebUrl('https://webmail.example.net/roundcube/?_mbox=INBOX', configured)).toBe(
      'https://webmail.example.net/roundcube/?_mbox=INBOX',
    );
    expect(allowlistedWebUrl('https://other.example.net/', configured)).toBeNull();
    expect(allowlistedWebUrl('http://webmail.example.net/roundcube/', configured)).toBeNull();
  });

  it('builds Gmail thread links (§8) and refuses odd thread ids', () => {
    expect(gmailMessageUrl('me@gmail.com', '1925bead00000009')).toBe('https://mail.google.com/mail/u/?authuser=me%40gmail.com#inbox/1925bead00000009');
    expect(gmailMessageUrl(null, 'abc')).toBe('https://mail.google.com/mail/u/0/#inbox/abc');
    expect(gmailMessageUrl('me@gmail.com', '../../evil')).toBeNull();
    expect(gmailMessageUrl('me@gmail.com', undefined)).toBeNull();
  });

  it('derives the webmail inbox per account kind', () => {
    expect(webmailUrlFor({ kind: 'google', email: 'me@gmail.com' }, {})).toBe('https://mail.google.com/mail/u/?authuser=me%40gmail.com');
    expect(webmailUrlFor({ kind: 'microsoft', email: null }, {})).toBe('https://outlook.live.com/mail/');
    expect(webmailUrlFor({ kind: 'yahoo', email: 'me@yahoo.com' }, { username: 'me@yahoo.com' })).toBe('https://mail.yahoo.com/');
    expect(
      webmailUrlFor({ kind: 'imap', email: null }, { imap: { host: 'imap.example.net', port: 993, security: 'tls', webmailUrl: 'https://webmail.example.net/' } }),
    ).toBe('https://webmail.example.net/');
    expect(webmailUrlFor({ kind: 'imap', email: null }, { imap: { host: 'imap.example.net', port: 993, security: 'tls', webmailUrl: null } })).toBeNull();
    expect(webmailUrlFor({ kind: 'imap', email: null }, { imap: { webmailUrl: 'javascript:alert(1)' } })).toBeNull();
  });
});
