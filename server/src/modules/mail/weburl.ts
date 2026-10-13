/**
 * Webmail links (§4.4): every `webUrl`/`webmailUrl` handed to the client is a SafeHttpUrl whose
 * host is allowlisted — `mail.google.com`, `outlook.live.com`, `mail.yahoo.com` (https only) — or
 * that stays on the origin of the IMAP account's configured `webmailUrl`. Anything else is null
 * and the UI renders no link.
 */
import { WEBMAIL_HOSTS, YAHOO_PRESET, toSafeHttpUrl, type Account, type AccountConfigByKind } from '@portly/shared';

const FIXED_HOSTS: ReadonlySet<string> = new Set(WEBMAIL_HOSTS);

/**
 * `value` when it is a SafeHttpUrl on an allowlisted webmail host (or on `configuredOrigin`),
 * otherwise null.
 */
export function allowlistedWebUrl(value: unknown, configuredWebmailUrl: string | null = null): string | null {
  const safe = toSafeHttpUrl(value);
  if (safe === null) return null;
  const url = new URL(safe);
  if (url.protocol === 'https:' && url.port === '' && FIXED_HOSTS.has(url.hostname.toLowerCase())) return url.href;
  const configured = toSafeHttpUrl(configuredWebmailUrl);
  if (configured !== null && new URL(configured).origin === url.origin) return url.href;
  return null;
}

/** Gmail message link: `https://mail.google.com/mail/u/?authuser=<email>#inbox/<threadId>` (§8). */
export function gmailMessageUrl(email: string | null, threadId: unknown): string | null {
  if (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) return null;
  const base = email ? `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}` : 'https://mail.google.com/mail/u/0/';
  return allowlistedWebUrl(`${base}#inbox/${threadId}`);
}

/** The account's webmail inbox. */
export function webmailUrlFor(account: Pick<Account, 'kind' | 'email'>, config: unknown): string | null {
  switch (account.kind) {
    case 'google':
      return allowlistedWebUrl(
        account.email ? `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account.email)}` : 'https://mail.google.com/mail/',
      );
    case 'microsoft':
      return allowlistedWebUrl('https://outlook.live.com/mail/');
    case 'yahoo': {
      const imap = (config as AccountConfigByKind['yahoo'] | undefined)?.imap;
      return allowlistedWebUrl(imap?.webmailUrl ?? YAHOO_PRESET.webmailUrl);
    }
    case 'imap': {
      const configured = (config as AccountConfigByKind['imap'] | undefined)?.imap?.webmailUrl ?? null;
      return allowlistedWebUrl(configured, configured);
    }
    case 'caldav':
      return null;
  }
}
