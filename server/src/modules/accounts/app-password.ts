/**
 * App-password accounts (§7, §8): Yahoo preset, generic CalDAV and generic IMAP. Validated
 * payloads become a {@link PreparedAccount}: the draft handed to capability probes plus the
 * identity used for upserts. `external_id` makes re-adding the same login update the existing
 * account (new password / settings, status reset) instead of duplicating it.
 */
import {
  ACCOUNT_CONFIG_SCHEMAS,
  YAHOO_PRESET,
  type AccountDraft,
  type CaldavAccountCreate,
  type ImapAccountCreate,
  type ValidationIssue,
  type YahooAccountCreate,
} from '@portly/shared';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.ts';
import { hostIsPrivate, type LookupFn } from './net.ts';
import type { AppPasswordKind } from './store.ts';

export interface PreparedAccount {
  kind: AppPasswordKind;
  label: string;
  email: string | null;
  externalId: string;
  config: Record<string, unknown>;
  password: string;
  /** Keep the stored label when the account already exists (Yahoo labels default to the email). */
  keepLabelOnUpdate: boolean;
}

export function draftOf(prepared: PreparedAccount): AccountDraft {
  return {
    kind: prepared.kind,
    label: prepared.label,
    email: prepared.email,
    config: prepared.config,
    secret: { password: prepared.password },
  };
}

function invalid(path: string, message: string): HttpError {
  const issues: ValidationIssue[] = [{ path, message, code: 'custom' }];
  return new HttpError(422, 'validation_failed', message, issues);
}

const EmailShape = z.email();

function emailOrNull(value: string): string | null {
  return EmailShape.safeParse(value).success ? value : null;
}

/** Sanity check: what we store must read back with the kind's schema. */
function checkedConfig(kind: AppPasswordKind, config: Record<string, unknown>): Record<string, unknown> {
  if (!ACCOUNT_CONFIG_SCHEMAS[kind].safeParse(config).success) throw invalid('', 'Invalid account settings');
  return config;
}

export function prepareYahoo(input: YahooAccountCreate): PreparedAccount {
  const email = input.email.trim();
  const caldavOrigin = new URL(YAHOO_PRESET.caldavServerUrl).origin;
  return {
    kind: 'yahoo',
    label: email,
    email,
    externalId: email.toLowerCase(),
    config: checkedConfig('yahoo', {
      username: email,
      caldav: { serverUrl: YAHOO_PRESET.caldavServerUrl, credentialOrigins: [caldavOrigin], insecureLan: false },
      imap: {
        host: YAHOO_PRESET.imapHost,
        port: YAHOO_PRESET.imapPort,
        security: YAHOO_PRESET.imapSecurity,
        webmailUrl: YAHOO_PRESET.webmailUrl,
      },
    }),
    password: input.appPassword,
    keepLabelOnUpdate: true,
  };
}

/**
 * Generic CalDAV: https required; `http` only with `insecureLan` and a host that is (or resolves
 * only to) a private address. TLS verification is never optional (§8).
 */
export async function prepareCaldav(input: CaldavAccountCreate, lookup?: LookupFn): Promise<PreparedAccount> {
  const url = new URL(input.serverUrl);
  url.hash = '';
  if (url.protocol === 'http:') {
    if (!input.insecureLan) {
      throw invalid('serverUrl', 'Use an https:// server URL (plain http is only allowed for servers on your local network)');
    }
    if (!(await hostIsPrivate(url.hostname, lookup))) {
      throw invalid('serverUrl', 'Plain http is only allowed for servers with a private (local network) address');
    }
  }
  const username = input.username;
  return {
    kind: 'caldav',
    label: input.label,
    email: emailOrNull(username),
    externalId: `${url.origin}|${username}`,
    config: checkedConfig('caldav', {
      username,
      caldav: { serverUrl: url.href, credentialOrigins: [url.origin], insecureLan: url.protocol === 'http:' },
    }),
    password: input.password,
    keepLabelOnUpdate: false,
  };
}

/** Generic IMAP: implicit TLS or STARTTLS only (never plaintext); schema-validated host/port. */
export function prepareImap(input: ImapAccountCreate): PreparedAccount {
  const host = input.host.toLowerCase().replace(/\.$/, '');
  const username = input.username;
  return {
    kind: 'imap',
    label: input.label,
    email: emailOrNull(username),
    externalId: `${host}:${input.port}|${username}`,
    config: checkedConfig('imap', {
      username,
      imap: {
        host,
        port: input.port,
        security: input.security,
        webmailUrl: input.webmailUrl === undefined ? null : new URL(input.webmailUrl).href,
      },
    }),
    password: input.password,
    keepLabelOnUpdate: false,
  };
}
