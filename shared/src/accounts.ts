/**
 * Accounts & OAuth contracts (§7a accounts.ts, §4.7, §7 Accounts routes, §8 provider notes).
 * Secrets never appear here: APIs only ever expose `{configured: true}` / host-only displays.
 */
import { z } from 'zod';
import { EntityId, HexColor, SafeHttpUrl } from './core.ts';
import type { ErrorCode } from './errors.ts';

export const ACCOUNT_KINDS = ['google', 'microsoft', 'yahoo', 'caldav', 'imap'] as const;
export const AccountKindSchema = z.enum(ACCOUNT_KINDS);
export type AccountKind = z.output<typeof AccountKindSchema>;

export const CAPABILITIES = ['calendar', 'mail'] as const;
export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.output<typeof CapabilitySchema>;

export const ACCOUNT_STATUSES = ['ok', 'error', 'reauth'] as const;
export const AccountStatusSchema = z.enum(ACCOUNT_STATUSES);
export type AccountStatus = z.output<typeof AccountStatusSchema>;

export const OAUTH_PROVIDERS = ['google', 'microsoft'] as const;
export const OAuthProviderSchema = z.enum(OAUTH_PROVIDERS);
export type OAuthProvider = z.output<typeof OAuthProviderSchema>;

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return typeof value === 'string' && (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The services (capabilities) a sign-in can ask for, per provider, on the Portly server. Each one
 * maps to its own OAuth scopes (the provider specs on the server); a sign-in asks only for the
 * scopes of the services picked. The browser-only build offers fewer (Microsoft: calendar only).
 */
export const OAUTH_PROVIDER_CAPABILITIES: Readonly<Record<OAuthProvider, readonly Capability[]>> = Object.freeze({
  google: ['calendar', 'mail'],
  microsoft: ['calendar', 'mail'],
});

/** Outcome reported to the SPA as `/?oauth=<result>#<returnTo>`. */
export const OAUTH_RESULTS = ['connected', 'reconnected', 'different_account', 'denied', 'expired', 'error'] as const;
export const OAuthResultSchema = z.enum(OAUTH_RESULTS);
export type OAuthResult = z.output<typeof OAuthResultSchema>;

export const OAUTH_RETURN_TO_REGEX = /^#\/[a-z0-9/_-]*$/;
export const DEFAULT_OAUTH_RETURN_TO = '#/settings/accounts';

/** Microsoft consumer (personal account) tenant id — id_token `tid` must equal this. */
export const MICROSOFT_CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

/** Webmail hosts allowed for `MailMessage.webUrl` (plus an IMAP account's configured `webmailUrl`). */
export const WEBMAIL_HOSTS = ['mail.google.com', 'outlook.live.com', 'mail.yahoo.com'] as const;

export const YAHOO_PRESET = Object.freeze({
  caldavServerUrl: 'https://caldav.calendar.yahoo.com',
  imapHost: 'imap.mail.yahoo.com',
  imapPort: 993,
  imapSecurity: 'tls',
  webmailUrl: 'https://mail.yahoo.com/',
} as const);

// ---------------------------------------------------------------------------
// Account (API shape)
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  kind: AccountKind;
  label: string;
  email: string | null;
  color: string | null;
  /** Capabilities the account supports (probe results / granted scopes). */
  capabilities: Capability[];
  /** Capabilities the user has switched on (subset of `capabilities`). */
  enabledCapabilities: Capability[];
  status: AccountStatus;
  statusMessage: string | null;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Per-kind config (stored in `accounts.config`, validated on read; never contains secrets)
// ---------------------------------------------------------------------------

export const IMAP_SECURITY = ['tls', 'starttls'] as const;
export const ImapSecuritySchema = z.enum(IMAP_SECURITY);
export type ImapSecurity = z.output<typeof ImapSecuritySchema>;

/** Hostname (DNS name or IP literal; no scheme, port or path). */
export const HostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?)$/, {
    message: 'Must be a host name',
  });

export const PortSchema = z.number().int().min(1).max(65535);

/** CalDAV connection details (Yahoo preset or generic). Probes may add discovered fields. */
export const CaldavConnectionSchema = z.looseObject({
  serverUrl: SafeHttpUrl,
  /** Origins credentials may be sent to (entered origin + same-site `.well-known` redirects). */
  credentialOrigins: z.array(z.string()).max(10),
  /** http allowed only for private-address hosts when the user ticked it. */
  insecureLan: z.boolean().default(false),
  principalUrl: SafeHttpUrl.optional(),
  calendarHomeUrl: SafeHttpUrl.optional(),
});
export type CaldavConnection = z.output<typeof CaldavConnectionSchema>;

/** IMAP connection details (Yahoo preset or generic). */
export const ImapConnectionSchema = z.looseObject({
  host: HostnameSchema,
  port: PortSchema,
  security: ImapSecuritySchema,
  webmailUrl: SafeHttpUrl.nullable().default(null),
});
export type ImapConnection = z.output<typeof ImapConnectionSchema>;

export const GoogleAccountConfigSchema = z.looseObject({});
export const MicrosoftAccountConfigSchema = z.looseObject({});
export const YahooAccountConfigSchema = z.looseObject({
  username: z.string().min(1).max(320),
  caldav: CaldavConnectionSchema.optional(),
  imap: ImapConnectionSchema.optional(),
});
export const CaldavAccountConfigSchema = z.looseObject({
  username: z.string().min(1).max(320),
  caldav: CaldavConnectionSchema,
});
export const ImapAccountConfigSchema = z.looseObject({
  username: z.string().min(1).max(320),
  imap: ImapConnectionSchema,
});

export type GoogleAccountConfig = z.output<typeof GoogleAccountConfigSchema>;
export type MicrosoftAccountConfig = z.output<typeof MicrosoftAccountConfigSchema>;
export type YahooAccountConfig = z.output<typeof YahooAccountConfigSchema>;
export type CaldavAccountConfig = z.output<typeof CaldavAccountConfigSchema>;
export type ImapAccountConfig = z.output<typeof ImapAccountConfigSchema>;

export interface AccountConfigByKind {
  google: GoogleAccountConfig;
  microsoft: MicrosoftAccountConfig;
  yahoo: YahooAccountConfig;
  caldav: CaldavAccountConfig;
  imap: ImapAccountConfig;
}

export const ACCOUNT_CONFIG_SCHEMAS = {
  google: GoogleAccountConfigSchema,
  microsoft: MicrosoftAccountConfigSchema,
  yahoo: YahooAccountConfigSchema,
  caldav: CaldavAccountConfigSchema,
  imap: ImapAccountConfigSchema,
} as const satisfies Record<AccountKind, z.ZodType>;

/**
 * Candidate account handed to capability probes before it is saved (server-side only).
 * `secret.password` is the app password / CalDAV / IMAP password.
 */
export interface AccountDraft {
  kind: AccountKind;
  label: string;
  email: string | null;
  config: Record<string, unknown>;
  secret: { password: string };
}

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

const AccountLabel = z.string().trim().min(1).max(100);
const Username = z.string().trim().min(1).max(320);
const Password = z.string().min(1).max(1024);

/** `PATCH /api/accounts/:id {label?, color?, enabledCapabilities?, sort?}` */
export const AccountUpdateSchema = z
  .object({
    label: AccountLabel.optional(),
    color: HexColor.nullable().optional(),
    enabledCapabilities: z.array(CapabilitySchema).max(CAPABILITIES.length).optional(),
    sort: z.number().int().optional(),
  })
  .strict();
export type AccountUpdate = z.output<typeof AccountUpdateSchema>;

/** `POST /api/accounts/yahoo {email, appPassword}` */
export const YahooAccountCreateSchema = z
  .object({
    email: z.email().max(320),
    appPassword: Password,
  })
  .strict();
export type YahooAccountCreate = z.output<typeof YahooAccountCreateSchema>;

/** `POST /api/accounts/caldav {label, serverUrl, username, password, insecureLan?}` */
export const CaldavAccountCreateSchema = z
  .object({
    label: AccountLabel,
    serverUrl: SafeHttpUrl,
    username: Username,
    password: Password,
    insecureLan: z.boolean().default(false),
  })
  .strict();
export type CaldavAccountCreate = z.output<typeof CaldavAccountCreateSchema>;

/** `POST /api/accounts/imap {label, host, port, security, username, password, webmailUrl?}` */
export const ImapAccountCreateSchema = z
  .object({
    label: AccountLabel,
    host: HostnameSchema,
    port: PortSchema,
    security: ImapSecuritySchema,
    username: Username,
    password: Password,
    webmailUrl: SafeHttpUrl.optional(),
  })
  .strict();
export type ImapAccountCreate = z.output<typeof ImapAccountCreateSchema>;

/** Result of one capability probe (account creation / `POST /api/accounts/:id/test`). */
export type ProbeResult = { ok: true } | { ok: false; code: ErrorCode; message: string };

/** Response of the create endpoints: the account plus per-capability probe results. */
export interface AccountCreateResult {
  account: Account;
  probes: Partial<Record<Capability, ProbeResult>>;
}

/** `POST /api/accounts/:id/test` response. */
export interface AccountTestResult {
  results: Partial<Record<Capability, ProbeResult>>;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/**
 * `POST /api/oauth/:provider/start {accountId?, returnTo?, capabilities?}`. `capabilities` are the
 * services to ask for: a new connection asks for only these (absent: every service the provider
 * offers); a reconnect asks for the account's granted services plus these (incremental consent).
 */
export const OAuthStartSchema = z
  .object({
    accountId: EntityId.optional(),
    returnTo: z.string().max(200).regex(OAUTH_RETURN_TO_REGEX).optional(),
    capabilities: z.array(CapabilitySchema).min(1).max(CAPABILITIES.length).optional(),
  })
  .strict();
export type OAuthStart = z.output<typeof OAuthStartSchema>;

export interface OAuthStartResponse {
  authorizeUrl: string;
}

/** `GET /api/oauth-clients/:provider` — `redirectUri` is the exact value to register. */
export interface OAuthClientInfo {
  clientId: string | null;
  hasSecret: boolean;
  redirectUri: string;
}

/** `PUT /api/oauth-clients/:provider {clientId, clientSecret?}` */
export const OAuthClientUpdateSchema = z
  .object({
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().trim().min(1).max(1024).optional(),
  })
  .strict();
export type OAuthClientUpdate = z.output<typeof OAuthClientUpdateSchema>;
