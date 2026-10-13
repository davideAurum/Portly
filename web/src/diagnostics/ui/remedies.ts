/**
 * What to do about a failing subject (Settings → Diagnostics, Connections & sync; ARCHITECTURE §17):
 * every `HEALTH_CODES` value has a one-line remedy (a few read differently for an account's
 * subjects) and a section of `docs/setup/troubleshooting.md`, whose anchor is the code itself
 * (`#rate_limited`). The page shows the anchor as text: the docs are not served. Codes a newer
 * server adds, and provider reason tokens recorded as codes, have no remedy (the code alone is
 * shown).
 */
import { HEALTH_CODES, type HealthCode } from '@homebase/shared';

export interface HealthRemedy {
  code: HealthCode;
  /** One sentence: what it means and what to do. */
  remedy: string;
  /** `troubleshooting.md#<code>` (W3 writes one section per code under this anchor). */
  anchor: string;
}

export const TROUBLESHOOTING_DOC = 'docs/setup/troubleshooting.md';

/** One line per code: plain words, the step that fixes it, where in Homebase to take it. */
export const HEALTH_REMEDIES: Readonly<Record<HealthCode, string>> = Object.freeze({
  rate_limited: 'The provider is limiting requests. Homebase waits and tries again by itself; nothing to do unless it lasts for hours.',
  account_unavailable: 'It depends on an account that needs attention: fix that account first.',
  reauth_required: 'Homebase lost access to the account. Sign in again in Settings → Accounts (Reconnect).',
  api_disabled: "The provider's API is turned off for your app registration. Turn it on in the provider's developer console.",
  insufficient_scope: 'Homebase is missing a permission. Reconnect the account and allow everything it asks for.',
  denied: 'The provider refused access. Check the account and its permissions, then reconnect it.',
  not_found: 'The provider no longer has it (deleted, moved or renamed). Remove it from Homebase or add it again.',
  timeout: "The server took too long to answer. Usually temporary; check this PC's internet connection if it keeps happening.",
  dns: "The server's name could not be found. Check the address, and this PC's internet connection and DNS.",
  refused: 'The server refused the connection. Check the address and port, and that the service is running.',
  reset: 'The connection was dropped. Usually temporary; a VPN, proxy or firewall can cause it.',
  tls: "The secure connection failed (a certificate problem). Check the address and this PC's date and time; a proxy that inspects HTTPS can cause it.",
  blocked: 'Homebase does not connect to private or reserved addresses (also when a redirect leads there). Use a public address.',
  not_lan: 'This account may only use servers on your local network. Check the server address.',
  network: "A network error. Check this PC's internet connection.",
  redirect: "The server redirected too often, or where Homebase doesn't follow (an API that shouldn't redirect). Check the address in a browser.",
  bad_url: "Homebase doesn't fetch this address: only http(s), with a host name and no user name or password in it. Check the address.",
  http_4xx: "The server rejected the request. Check the address and the account's settings.",
  http_5xx: "The provider's server had a problem. Usually temporary: Homebase tries again.",
  parse_error: 'The answer could not be read. Check that the address points to the right kind of data.',
  not_a_feed: "The address is not an RSS or Atom feed. Use the feed's own address (often linked as RSS on the site).",
  too_large: 'The answer was larger than Homebase accepts. Use a smaller feed or calendar.',
  token_rejected: 'Todoist rejected the API token. Paste a new token in Settings → Todoist.',
  storage_limit: 'This calendar was not updated: Homebase already stores as many events as it keeps. Remove a very large calendar to make room.',
  truncated: 'Homebase stored only part of this calendar to stay within its limits (long repeating series, malformed events). Nothing is lost at the provider.',
  vault_locked: "Saved credentials can't be unlocked. Reset them in Settings → Accounts, then reconnect your accounts.",
  not_configured: 'Not set up yet. Finish the setup in Settings.',
  auth_failed: 'Sign-in failed. Check the user name and (app) password, then reconnect the account.',
  invalid_grant: "The sign-in expired or was revoked at the provider. Reconnect the account in Settings → Accounts.",
  interaction_required: 'The provider wants you to sign in again. Reconnect the account in Settings → Accounts.',
  consent_required: 'The provider needs your consent again. Reconnect the account and accept the permissions.',
  caldav_password_rejected: 'The CalDAV server rejected the password. Enter a new (app) password and reconnect the account.',
  imap_password_rejected: 'The mail server rejected the password. Enter a new (app) password and reconnect the account.',
  credentials_reset: 'Saved credentials were reset. Reconnect the account in Settings → Accounts.',
  client_rejected: "The provider rejected Homebase's app registration (client ID or secret). Check it in Settings → Accounts.",
  refresh_unreachable: "The provider's sign-in server could not be reached to renew access. Usually temporary; check the internet connection.",
  calendar_list_failed: "The account's calendar list could not be read. Check the account's status, then run the sync again.",
  no_credentials: 'No saved credentials for this account. Reconnect it in Settings → Accounts.',
  worker_failed: 'A background worker inside Homebase failed. Check the server log; restart Homebase if it keeps happening.',
  internal: 'An unexpected error inside Homebase. Check the server log for details.',
});

/**
 * Codes an account's subjects (`account:`, `calendar-list:`, `calendar:`, `mail:`) record with
 * another meaning than {@link HEALTH_REMEDIES} gives: `token_rejected` there is a provider refusing
 * an access token Homebase had just renewed, not Todoist's API token.
 */
const ACCOUNT_REMEDIES: Readonly<Partial<Record<HealthCode, string>>> = Object.freeze({
  token_rejected: "The provider refused Homebase's access even after renewing it. Reconnect the account in Settings → Accounts.",
});

const ACCOUNT_SUBJECT = /^(?:account|calendar-list|calendar|mail):/;

const CODES: ReadonlySet<string> = new Set(HEALTH_CODES);

export function isHealthCode(code: unknown): code is HealthCode {
  return typeof code === 'string' && CODES.has(code);
}

/**
 * The remedy for a health code of the subject `key` (its text may depend on the subject), or null
 * for a code this version does not know (or none).
 */
export function remedyFor(code: string | null | undefined, key: string | null = null): HealthRemedy | null {
  if (!isHealthCode(code)) return null;
  const remedy = (key !== null && ACCOUNT_SUBJECT.test(key) ? ACCOUNT_REMEDIES[code] : undefined) ?? HEALTH_REMEDIES[code];
  return { code, remedy, anchor: `troubleshooting.md#${code}` };
}
