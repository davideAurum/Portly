/**
 * `accounts` rows ↔ API shape (§5, §7a) and the queries shared by the service and the routes.
 * JSON columns (`capabilities`, `enabled_capabilities`, `granted_scopes`, `config`) are validated
 * on read; invalid stored values degrade to empty lists instead of failing a request.
 *
 * {@link applyAccountStatus} is the only writer of `status`/`status_message` (§17): it
 * logs every change and records the account's health subject `account:<id>`.
 */
import {
  ACCOUNT_KINDS,
  CAPABILITIES,
  REASON_TOKEN,
  normalizeHexColor,
  type Account,
  type AccountKind,
  type AccountStatus,
  type Capability,
  type VaultState,
} from '@portly/shared';
import { z } from 'zod';
import { msToIso } from '../../db/helpers.ts';
import type { Db } from '../../db/open.ts';
import { HttpError } from '../../lib/errors.ts';
import type { DetailValue, HealthRecorder, HealthSubject, Outcome } from '../../lib/health.ts';
import type { Logger } from '../../lib/logger.ts';

export interface AccountRow {
  id: string;
  kind: AccountKind;
  label: string;
  email: string | null;
  external_id: string | null;
  config: string;
  capabilities: string;
  enabled_capabilities: string;
  granted_scopes: string | null;
  color: string | null;
  sort: number;
  status: AccountStatus;
  status_message: string | null;
  created_at: number | null;
  updated_at: number | null;
}

const COLUMNS =
  'id, kind, label, email, external_id, config, capabilities, enabled_capabilities, granted_scopes, color, sort, status, status_message, created_at, updated_at';

/** Kinds authenticated with OAuth (refresh token in the vault). */
export const OAUTH_KINDS = ['google', 'microsoft'] as const satisfies readonly AccountKind[];
/** Kinds authenticated with an app password (password in the vault). */
export const APP_PASSWORD_KINDS = ['yahoo', 'caldav', 'imap'] as const satisfies readonly AccountKind[];
export type AppPasswordKind = (typeof APP_PASSWORD_KINDS)[number];

export function isOAuthKind(kind: AccountKind): kind is (typeof OAUTH_KINDS)[number] {
  return (OAUTH_KINDS as readonly string[]).includes(kind);
}

export function isAppPasswordKind(kind: AccountKind): kind is AppPasswordKind {
  return (APP_PASSWORD_KINDS as readonly string[]).includes(kind);
}

export const VAULT_LOCKED_MESSAGE = 'The credential vault is locked; reset credentials in Settings';

/** Vault secret id holding an account's credentials (`{refreshToken}` or `{password}`, §4.6). */
export function accountSecretId(accountId: string): string {
  return `account:${accountId}`;
}

const RefreshSecretSchema = z.object({ refreshToken: z.string().min(1) });
const PasswordSecretSchema = z.object({ password: z.string().min(1) });

function parseSecret<S extends z.ZodType>(schema: S, raw: string | null): z.output<S> | null {
  if (raw === null) return null;
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Refresh token from an OAuth account secret (`{refreshToken}`), or null. */
export function parseRefreshTokenSecret(raw: string | null): string | null {
  return parseSecret(RefreshSecretSchema, raw)?.refreshToken ?? null;
}

/** Password from an app-password account secret (`{password}`), or null. */
export function parsePasswordSecret(raw: string | null): string | null {
  return parseSecret(PasswordSecretSchema, raw)?.password ?? null;
}

export function refreshTokenSecret(refreshToken: string): string {
  return JSON.stringify({ refreshToken });
}

export function passwordSecret(password: string): string {
  return JSON.stringify({ password });
}

export function accountNotFound(): HttpError {
  return new HttpError(404, 'not_found', 'Account not found');
}

// ---------------------------------------------------------------------------
// Capability lists
// ---------------------------------------------------------------------------

/** Deduplicated capabilities in canonical order (`CAPABILITIES`). Unknown values are dropped. */
export function orderCapabilities(values: Iterable<unknown>): Capability[] {
  const set = new Set<unknown>(values);
  return CAPABILITIES.filter((c) => set.has(c));
}

/** Parses a JSON capability list column; invalid JSON or entries are ignored. */
export function parseCapabilities(text: unknown): Capability[] {
  if (typeof text !== 'string') return [];
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? orderCapabilities(data) : [];
  } catch {
    return [];
  }
}

export function serializeCapabilities(values: Iterable<Capability>): string {
  return JSON.stringify(orderCapabilities(values));
}

/**
 * Enabled capabilities after the supported set changed from `previous` to `next`: keep what the
 * user had enabled (if still supported) and switch newly supported capabilities on.
 */
export function mergeEnabledCapabilities(
  previousCapabilities: readonly Capability[],
  previousEnabled: readonly Capability[],
  next: readonly Capability[],
): Capability[] {
  return orderCapabilities(next.filter((c) => previousEnabled.includes(c) || !previousCapabilities.includes(c)));
}

// ---------------------------------------------------------------------------
// Row → API
// ---------------------------------------------------------------------------

const EPOCH_ISO = new Date(0).toISOString();

/**
 * API shape of a row. While the vault is locked every account reports `reauth` (§4.6) — an
 * overlay only; the stored status is untouched.
 */
export function toAccount(row: AccountRow, vaultState: VaultState): Account {
  const capabilities = parseCapabilities(row.capabilities);
  const enabledCapabilities = parseCapabilities(row.enabled_capabilities).filter((c) => capabilities.includes(c));
  const locked = vaultState === 'locked';
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    email: row.email,
    color: normalizeHexColor(row.color),
    capabilities,
    enabledCapabilities,
    status: locked ? 'reauth' : row.status,
    statusMessage: locked ? VAULT_LOCKED_MESSAGE : row.status_message,
    sort: row.sort,
    createdAt: msToIso(row.created_at) ?? EPOCH_ISO,
    updatedAt: msToIso(row.updated_at) ?? msToIso(row.created_at) ?? EPOCH_ISO,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getAccountRow(db: Db, id: string): AccountRow | undefined {
  return db.get<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`, [id]);
}

export function listAccountRows(db: Db, kind?: AccountKind): AccountRow[] {
  if (kind !== undefined) {
    if (!(ACCOUNT_KINDS as readonly string[]).includes(kind)) return [];
    return db.all<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE kind = ? ORDER BY sort, created_at, id`, [kind]);
  }
  return db.all<AccountRow>(`SELECT ${COLUMNS} FROM accounts ORDER BY sort, created_at, id`);
}

export function findAccountByExternalId(db: Db, kind: AccountKind, externalId: string): AccountRow | undefined {
  return db.get<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE kind = ? AND external_id = ?`, [kind, externalId]);
}

/** Sort value that places a new account last. */
export function nextAccountSort(db: Db): number {
  const row = db.get<{ next: number | null }>('SELECT MAX(sort) + 1 AS next FROM accounts');
  return typeof row?.next === 'number' ? row.next : 0;
}

export interface NewAccountRow {
  id: string;
  kind: AccountKind;
  label: string;
  email: string | null;
  externalId: string;
  config: Record<string, unknown>;
  capabilities: readonly Capability[];
  grantedScopes: readonly string[] | null;
  statusMessage: string | null;
  now: number;
}

/** Inserts a new account (enabled capabilities = capabilities, status ok, placed last). */
export function insertAccountRow(db: Db, row: NewAccountRow): void {
  const capabilities = serializeCapabilities(row.capabilities);
  db.run(
    `INSERT INTO accounts (id, kind, label, email, external_id, config, capabilities, enabled_capabilities,
       granted_scopes, color, sort, status, status_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'ok', ?, ?, ?)`,
    [
      row.id,
      row.kind,
      row.label,
      row.email,
      row.externalId,
      JSON.stringify(row.config),
      capabilities,
      capabilities,
      row.grantedScopes === null ? null : JSON.stringify(row.grantedScopes),
      nextAccountSort(db),
      row.statusMessage,
      row.now,
      row.now,
    ],
  );
}

// ---------------------------------------------------------------------------
// Status (and the account's health subject)
// ---------------------------------------------------------------------------

/** Health key of an account (every kind): status, credentials and token refresh (§17). */
export function accountHealthKey(accountId: string): string {
  return `account:${accountId}`;
}

export function accountHealthSubject(accountId: string): HealthSubject {
  // On-demand subject (refreshes and status changes happen when used): never stale.
  return { key: accountHealthKey(accountId), area: 'accounts', accountId, expectEveryMs: null };
}

/** What {@link applyAccountStatus} works with (the module's internals satisfy it). */
export interface AccountStatusDeps {
  db: Db;
  log: Logger;
  /** Undefined in tests that do not track health. */
  health: HealthRecorder | undefined;
  now(): number;
}

export interface AccountStatusMeta {
  /**
   * Machine reason, logged and used as the health code of a failure: `invalid_grant`,
   * `interaction_required`, `consent_required`, `caldav_password_rejected`, `imap_password_rejected`,
   * `no_credentials`, `vault_locked`, `credentials_reset`, `client_rejected`, `refresh_unreachable`,
   * `calendar_list_failed` …; for `ok`, what cleared it (`token_refreshed`, `reconnected` …).
   */
  reason?: string | null;
  /** The module that decided it (`accounts`, `calendar`, `mail`, `core`). */
  source?: string | null;
  /** Upstream HTTP status behind a failure (health). */
  httpStatus?: number | null;
  /** Extra health detail: machine tokens, hostnames, numbers (the tracker drops anything else). */
  detail?: Record<string, DetailValue>;
  /** Duration of the check that produced this status (health). */
  ms?: number;
  /**
   * Level of the health tracker's first-failure line (default warn); `info` when the caller writes
   * its own warning for the same event (one warn per event).
   */
  severity?: 'info' | 'warn' | 'error';
  /**
   * An account that needs reauth keeps it (an error must never hide a reauth): nothing is written
   * or recorded.
   */
  keepReauth?: boolean;
}

export interface AccountStatusChange {
  accountId: string;
  kind: AccountKind;
  from: AccountStatus;
  to: AccountStatus;
  /** The row was written (status or message differed). */
  changed: boolean;
}

const SOURCE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function token(value: string | null | undefined, re: RegExp): string | null {
  return typeof value === 'string' && re.test(value) ? value : null;
}

/**
 * The one writer of an account's status (§17). Sets status/message when they differ from the stored
 * values and, on a change, logs `info 'account status changed' {accountId, kind, from, to, reason,
 * source}` (never the message: the health entry keeps it, scrubbed). Every call is also an outcome
 * of `account:<id>`: `ok` → ok, `reauth`/`error` → failing with `code = reason` (a reauth without
 * one: `reauth_required`) and the status message as its Portly-authored message.
 *
 * Unknown ids (e.g. deleted meanwhile) are ignored: null, nothing logged or recorded, so a late
 * failure never recreates a forgotten subject. Call it after the caller's own transaction, so the
 * line and the health record describe what was committed.
 */
export function applyAccountStatus(
  deps: AccountStatusDeps,
  id: string,
  status: AccountStatus,
  message: string | null,
  meta: AccountStatusMeta = {},
): AccountStatusChange | null {
  const { db, log, health } = deps;
  const row = db.get<{ kind: AccountKind; status: AccountStatus; status_message: string | null }>(
    'SELECT kind, status, status_message FROM accounts WHERE id = ?',
    [id],
  );
  if (!row) return null;
  if (meta.keepReauth && row.status === 'reauth' && status !== 'reauth') {
    return { accountId: id, kind: row.kind, from: row.status, to: row.status, changed: false };
  }

  const reason = token(meta.reason, REASON_TOKEN);
  const source = token(meta.source, SOURCE_RE);
  let changed = false;
  if (row.status !== status || row.status_message !== message) {
    changed =
      db.run('UPDATE accounts SET status = ?, status_message = ?, updated_at = ? WHERE id = ?', [status, message, deps.now(), id]).changes > 0;
  }
  if (changed) {
    log.info('account status changed', { accountId: id, kind: row.kind, from: row.status, to: status, reason, source });
  }

  if (health) {
    const detail: Record<string, DetailValue> = { ...meta.detail };
    let outcome: Outcome;
    if (status === 'ok') {
      outcome = { ok: true };
      // What last confirmed the account (`token_refreshed`, `reconnected` …).
      if (reason !== null) detail.reason = reason;
    } else {
      outcome = { ok: false, code: reason ?? (status === 'reauth' ? 'reauth_required' : undefined), message: message ?? undefined };
      if (typeof meta.httpStatus === 'number') outcome.status = meta.httpStatus;
      if (meta.severity !== undefined) outcome.severity = meta.severity;
    }
    if (meta.ms !== undefined) outcome.ms = meta.ms;
    if (source !== null) detail.source = source;
    if (Object.keys(detail).length > 0) outcome.detail = detail;
    health.record(accountHealthSubject(id), outcome);
  }
  return { accountId: id, kind: row.kind, from: row.status, to: status, changed };
}
