/**
 * Account operations behind the `/api/accounts` routes: app-password create/re-add, PATCH,
 * DELETE (with best-effort token revocation) and connection tests. Statuses are written through
 * `applyAccountStatus` after each operation's transaction (logged, recorded on `account:<id>`);
 * a deleted account's health subjects are forgotten.
 */
import {
  normalizeHexColor,
  type Account,
  type AccountCreateResult,
  type AccountDraft,
  type AccountTestResult,
  type AccountUpdate,
  type Capability,
  type ProbeResult,
  type ValidationIssue,
} from '@homebase/shared';
import type { SqlValue } from '../../db/open.ts';
import { HttpError } from '../../lib/errors.ts';
import type { DetailValue } from '../../lib/health.ts';
import { newId } from '../../lib/ids.ts';
import { withLogContext } from '../../lib/log-context.ts';
import { errorFields } from '../../lib/logger.ts';
import { VaultLockedError } from '../../security/vault.ts';
import { draftOf, type PreparedAccount } from './app-password.ts';
import { providerSpec } from './oauth/providers.ts';
import { NOT_VERIFIED, capabilityLabel, probeIssues, runProbes, type ProbeDiagnosis, type ProbeRun } from './probes.ts';
import { MAX_STATUS_MESSAGE, type AccountsCore } from './service.ts';
import {
  accountNotFound,
  accountSecretId,
  applyAccountStatus,
  findAccountByExternalId,
  getAccountRow,
  insertAccountRow,
  isOAuthKind,
  mergeEnabledCapabilities,
  orderCapabilities,
  parseCapabilities,
  parsePasswordSecret,
  parseRefreshTokenSecret,
  passwordSecret,
  serializeCapabilities,
  toAccount,
} from './store.ts';

const REVOKE_TIMEOUT_MS = 5_000;
/** Vault ids of ICS feed URLs (`ics:<calendarId>`, §4.6). */
const ICS_SECRET_PREFIX = 'ics:';

function mustGetAccount(core: AccountsCore, id: string): Account {
  const account = core.service.get(id);
  if (!account) throw accountNotFound();
  return account;
}

// ---------------------------------------------------------------------------
// Create (or re-add) app-password accounts
// ---------------------------------------------------------------------------

export interface SaveResult {
  created: boolean;
  body: AccountCreateResult;
}

/**
 * Runs the kind's probes, then creates the account — or, when the same login already exists
 * (`(kind, external_id)`), replaces its settings and password and clears its status.
 * Capabilities = passing probes + capabilities without a registered probe ("not verified");
 * none → 422 with one issue per failed capability.
 */
export async function saveAppPasswordAccount(core: AccountsCore, prepared: PreparedAccount): Promise<SaveResult> {
  const { db, vault, log } = core;
  if (vault.state !== 'ready') throw new VaultLockedError();

  const run = await runProbes(core.probes, draftOf(prepared), { log });
  const capabilities = orderCapabilities([...run.passed, ...run.unprobed]);
  if (capabilities.length === 0) {
    throw new HttpError(422, 'validation_failed', 'Could not connect with these settings', probeIssues(run.results));
  }
  const statusMessage = run.unprobed.length > 0 ? NOT_VERIFIED : null;
  const secret = passwordSecret(prepared.password);

  const saved = db.tx(() => {
    const now = core.now();
    const existing = findAccountByExternalId(db, prepared.kind, prepared.externalId);
    if (existing) {
      const enabled = mergeEnabledCapabilities(
        parseCapabilities(existing.capabilities),
        parseCapabilities(existing.enabled_capabilities),
        capabilities,
      );
      // The status is reset below, after the transaction (applyAccountStatus).
      db.run(
        `UPDATE accounts SET label = ?, email = ?, config = ?, capabilities = ?, enabled_capabilities = ?, updated_at = ?
         WHERE id = ?`,
        [
          prepared.keepLabelOnUpdate ? existing.label : prepared.label,
          prepared.email,
          JSON.stringify(run.config),
          serializeCapabilities(capabilities),
          serializeCapabilities(enabled),
          now,
          existing.id,
        ],
      );
      vault.put(accountSecretId(existing.id), secret);
      return { id: existing.id, created: false };
    }
    const id = newId();
    insertAccountRow(db, {
      id,
      kind: prepared.kind,
      label: prepared.label,
      email: prepared.email,
      externalId: prepared.externalId,
      config: run.config,
      capabilities,
      grantedScopes: null,
      statusMessage,
      now,
    });
    vault.put(accountSecretId(id), secret);
    return { id, created: true };
  });

  // The probes just passed: ok (a new row already is; a re-added one is reset), and recorded as such.
  applyAccountStatus(core, saved.id, 'ok', statusMessage, { reason: saved.created ? 'connected' : 'reconnected', source: 'accounts' });
  log.info('account saved', { accountId: saved.id, kind: prepared.kind, created: saved.created, capabilities });
  core.emit({ type: saved.created ? 'created' : 'updated', accountId: saved.id });
  return { created: saved.created, body: { account: mustGetAccount(core, saved.id), probes: run.results } };
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

/**
 * Applies `{label?, color?, enabledCapabilities?, sort?}` through a static field → column map.
 * Only a change of the enabled capabilities is announced (`updated`): label, color and sort are
 * read live by calendar and mail, and a resync of every calendar per color pick would be waste.
 */
export function updateAccount(core: AccountsCore, id: string, patch: AccountUpdate): Account {
  const { db } = core;
  const capabilitiesChanged = db.tx(() => {
    const row = getAccountRow(db, id);
    if (!row) throw accountNotFound();
    const sets: string[] = [];
    const params: SqlValue[] = [];
    let capabilities = false;

    if (patch.label !== undefined) {
      sets.push('label = ?');
      params.push(patch.label);
    }
    if (patch.color !== undefined) {
      sets.push('color = ?');
      params.push(patch.color === null ? null : normalizeHexColor(patch.color));
    }
    if (patch.enabledCapabilities !== undefined) {
      const supported = parseCapabilities(row.capabilities);
      const unsupported = patch.enabledCapabilities.filter((c) => !supported.includes(c));
      if (unsupported.length > 0) {
        const issues: ValidationIssue[] = unsupported.map((c) => ({
          path: 'enabledCapabilities',
          message: `${capabilityLabel(c)} is not available for this account`,
          code: 'custom',
        }));
        throw new HttpError(422, 'validation_failed', 'Capabilities not available for this account', issues);
      }
      sets.push('enabled_capabilities = ?');
      params.push(serializeCapabilities(patch.enabledCapabilities));
      capabilities = serializeCapabilities(patch.enabledCapabilities) !== serializeCapabilities(parseCapabilities(row.enabled_capabilities));
    }
    if (patch.sort !== undefined) {
      sets.push('sort = ?');
      params.push(patch.sort);
    }
    if (sets.length === 0) return false;
    sets.push('updated_at = ?');
    params.push(core.now());
    db.run(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    return capabilities;
  });
  if (capabilitiesChanged) core.emit({ type: 'updated', accountId: id });
  return mustGetAccount(core, id);
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

/**
 * Deletes the account, its secret and (FK cascade) its calendars and events in one transaction,
 * forgets its health subjects (`account:`, `mail:`, `calendar-list:` and every subject recorded
 * with its id), then revokes the provider token best-effort in the background (Google).
 */
export function deleteAccount(core: AccountsCore, id: string): void {
  const { db, vault, log } = core;
  const row = getAccountRow(db, id);
  if (!row) throw accountNotFound();

  let revoke: { endpoint: string; token: string } | null = null;
  if (isOAuthKind(row.kind) && vault.state === 'ready') {
    const endpoint = providerSpec(row.kind).revokeEndpoint;
    try {
      const token = endpoint === null ? null : parseRefreshTokenSecret(vault.get(accountSecretId(id)));
      if (endpoint !== null && token !== null) revoke = { endpoint, token };
    } catch (err) {
      log.warn('could not read the token to revoke', { accountId: id, ...errorFields(err) });
    }
  }

  db.tx(() => {
    const calendarIds = new Set(db.all<{ id: string }>('SELECT id FROM calendars WHERE account_id = ?', [id]).map((c) => c.id));
    db.run('DELETE FROM accounts WHERE id = ?', [id]);
    vault.delete(accountSecretId(id));
    // Defensive: no account calendar should own an ICS secret, but never leave one orphaned. Only
    // ids the vault actually holds are touched: calendar ids are the calendar module's business
    // and need not be valid secret ids (vault.delete would throw on those).
    for (const secretId of vault.list(ICS_SECRET_PREFIX)) {
      if (calendarIds.has(secretId.slice(ICS_SECRET_PREFIX.length))) vault.delete(secretId);
    }
  });
  core.forgetAccount(id);
  log.info('account deleted', { accountId: id, kind: row.kind });
  core.emit({ type: 'deleted', accountId: id });

  if (revoke !== null) {
    const { endpoint, token } = revoke;
    // track() attaches its handlers here too: a failed revocation's line names the account.
    withLogContext({ area: 'accounts', accountId: id }, () => core.track(revokeToken(core, endpoint, token), 'oauth-revoke'));
  }
}

async function revokeToken(core: AccountsCore, endpoint: string, token: string): Promise<void> {
  const res = await core.fetch(endpoint, {
    method: 'POST',
    policy: 'provider',
    purpose: 'oauth.revoke',
    as: 'text',
    maxBytes: 64 * 1024,
    timeoutMs: REVOKE_TIMEOUT_MS,
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
  if (res.status >= 200 && res.status < 300) core.log.info('oauth token revoked', { host: new URL(endpoint).host });
  else core.log.warn('oauth token revocation refused', { host: new URL(endpoint).host, status: res.status });
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

function failureOf(err: unknown): ProbeResult {
  if (err instanceof HttpError) return { ok: false, code: err.code, message: err.message };
  return { ok: false, code: 'internal', message: 'The connection test failed' };
}

/** Status reason of a probe whose server refused the app password, per capability. */
const PASSWORD_REJECTED: Readonly<Record<Capability, string>> = Object.freeze({
  calendar: 'caldav_password_rejected',
  mail: 'imap_password_rejected',
});

/** Probe diagnoses that mean the server refused the credentials (a CalDAV 401 is `auth_failed`). */
const REJECTED_CODES: ReadonlySet<string> = new Set(['auth_failed', 'reauth_required', ...Object.values(PASSWORD_REJECTED)]);

/** Status reason of a failed probe, from its diagnosis (the original error, not the API code). */
function probeFailureReason(capability: Capability, diagnosis: ProbeDiagnosis | undefined): { reason: string; rejected: boolean } {
  const code = diagnosis?.code ?? 'internal';
  return REJECTED_CODES.has(code) ? { reason: PASSWORD_REJECTED[capability], rejected: true } : { reason: code, rejected: false };
}

interface TestVerdict {
  status: 'ok' | 'error' | 'reauth';
  message: string | null;
  /** Status reason: what failed (the health code), or `connection_test` when everything passed. */
  reason: string;
  /** Upstream HTTP status behind that failure. */
  httpStatus: number | null;
  /** Reason of each failed capability (health detail). */
  detail: Record<string, DetailValue>;
}

/**
 * Status after a connection test. Only the account's own capabilities count: a probe failing for
 * a capability the account never had (e.g. Yahoo CalDAV on a mail-only account) is reported in
 * the results but does not flag an otherwise working account. A refused password means reauth
 * (`caldav_password_rejected` / `imap_password_rejected`, as the sync paths set it); any other
 * failure is an error with the first failing capability's health code.
 */
function statusAfterTest(run: ProbeRun, capabilities: readonly Capability[]): TestVerdict {
  const failures = orderCapabilities(capabilities).flatMap((c) => {
    const result = run.results[c];
    if (!result || result.ok) return [];
    const diagnosis = run.diagnoses[c];
    return [{ capability: c, message: result.message, httpStatus: diagnosis?.status ?? null, ...probeFailureReason(c, diagnosis) }];
  });
  const [first] = failures;
  if (first === undefined) {
    const unverified = run.unprobed.some((c) => capabilities.includes(c));
    return { status: 'ok', message: unverified ? NOT_VERIFIED : null, reason: 'connection_test', httpStatus: null, detail: {} };
  }
  const message = failures
    .map(({ capability, message: text }) => `${capabilityLabel(capability)}: ${text}`)
    .join(' · ')
    .slice(0, MAX_STATUS_MESSAGE);
  const detail: Record<string, DetailValue> = {};
  for (const { capability, reason } of failures) detail[capability] = reason;
  const rejected = failures.find((f) => f.rejected);
  const cause = rejected ?? first;
  return { status: rejected ? 'reauth' : 'error', message, reason: cause.reason, httpStatus: cause.httpStatus, detail };
}

/** Stored config (validated) and password of an app-password account, as probes see them. */
function testedCredentials(core: AccountsCore, id: string): { config: string; password: string | null } {
  return {
    config: JSON.stringify(core.service.getConfig(id)),
    password: parsePasswordSecret(core.vault.get(accountSecretId(id))),
  };
}

/**
 * `POST /api/accounts/:id/test`. OAuth kinds: a forced token refresh (reported for each
 * capability). App-password kinds: re-runs the probes; newly passing capabilities are added (a
 * failing probe never removes a capability) and the status reflects the results. When the
 * account's settings or password changed while the probes ran (e.g. it was re-added), the stale
 * results are reported but not stored. Runs in the account's log context.
 */
export function testAccount(core: AccountsCore, id: string): Promise<AccountTestResult> {
  return withLogContext({ area: 'accounts', accountId: id, op: 'test' }, () => runAccountTest(core, id));
}

async function runAccountTest(core: AccountsCore, id: string): Promise<AccountTestResult> {
  const { db, log } = core;
  const row = getAccountRow(db, id);
  if (!row) throw accountNotFound();
  const account = toAccount(row, core.vault.state);

  if (isOAuthKind(row.kind)) {
    let result: ProbeResult;
    try {
      await core.refreshNow(id);
      result = { ok: true };
    } catch (err) {
      result = failureOf(err);
    }
    const results: AccountTestResult['results'] = {};
    for (const capability of account.capabilities) results[capability] = result;
    return { results };
  }

  const { password } = await core.service.getSecret(id);
  const draft: AccountDraft = {
    kind: row.kind,
    label: row.label,
    email: row.email,
    config: core.service.getConfig(id) as Record<string, unknown>,
    secret: { password },
  };
  const testedConfig = JSON.stringify(draft.config);
  const startedAt = Date.now();
  const run = await runProbes(core.probes, draft, { log });
  const ms = Date.now() - startedAt;

  type TestOutcome = { kind: 'gone' | 'stale' } | { kind: 'kept' | 'settings'; verdict: TestVerdict };
  const outcome = db.tx((): TestOutcome => {
    const current = getAccountRow(db, id);
    if (!current) return { kind: 'gone' };
    const latest = testedCredentials(core, id);
    if (latest.config !== testedConfig || latest.password !== password) return { kind: 'stale' };

    const previous = parseCapabilities(current.capabilities);
    const capabilities = orderCapabilities([...previous, ...run.passed]);
    const enabled = serializeCapabilities(mergeEnabledCapabilities(previous, parseCapabilities(current.enabled_capabilities), capabilities));
    const verdict = statusAfterTest(run, capabilities);
    const config = JSON.stringify(run.config);
    const settingsChanged = config !== testedConfig || capabilities.length !== previous.length;
    if (settingsChanged || enabled !== current.enabled_capabilities) {
      // The status is written below, after the transaction (applyAccountStatus).
      db.run(
        `UPDATE accounts SET config = ?, capabilities = ?, enabled_capabilities = ?, updated_at = ?
         WHERE id = ?`,
        [config, serializeCapabilities(capabilities), enabled, core.now(), id],
      );
    }
    return { kind: settingsChanged ? 'settings' : 'kept', verdict };
  });
  if (outcome.kind === 'kept' || outcome.kind === 'settings') {
    const { status, message, reason, httpStatus, detail } = outcome.verdict;
    applyAccountStatus(core, id, status, message, { reason, source: 'accounts', httpStatus, detail, ms });
  }
  if (outcome.kind === 'stale') log.info('account changed during its connection test; results not stored', { accountId: id, kind: row.kind });
  else log.info('account tested', { accountId: id, kind: row.kind, passed: run.passed, failed: run.failed, ms });
  if (outcome.kind === 'settings') core.emit({ type: 'updated', accountId: id });
  return { results: run.results };
}
