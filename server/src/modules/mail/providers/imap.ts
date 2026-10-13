/**
 * IMAP mail (§8 Yahoo / Generic IMAP, §4.10). One short-lived connection per request:
 * connect → work → logout, every step bounded by 15 s timeouts (see imap-client.ts). The session
 * itself (imap-session.ts) runs in a worker thread (imap-runner.ts), so a hostile server's
 * responses are never parsed on the main thread; this module maps its results and errors.
 *
 * Listing: `STATUS INBOX (UNSEEN)` for the count, then INBOX is opened read-only (EXAMINE) and the
 * newest N messages are fetched with ENVELOPE + FLAGS + INTERNALDATE (no bodies, so no snippets).
 * "Newest" is by UID: without `unreadOnly` the last N sequence numbers are fetched (sequence order
 * is UID order), with `unreadOnly` the N highest UIDs of `UID SEARCH <last 1000 seq> UNSEEN` are
 * fetched by UID (the search is bounded so its one-line response stays small).
 *
 * Actions (§4.10): the id encodes mailbox + UIDVALIDITY + UID. Every action SELECTs the mailbox,
 * compares UIDVALIDITY (mismatch → 409 `conflict`/`stale_message`) and uses UID commands only.
 * - read/unread: `UID STORE ±FLAGS (\Seen)`.
 * - trash/archive: the target is the RFC 6154 special-use mailbox (`\Trash` / `\Archive`), falling
 *   back to exact names (Trash, Deleted Items, Deleted Messages, Bin / Archive); unresolvable → 422.
 *   With MOVE: `UID MOVE`. Without MOVE but with UIDPLUS: `UID COPY`, and only after a successful
 *   copy `UID STORE +FLAGS (\Deleted)` + `UID EXPUNGE`. Without either: refused (422). Plain
 *   EXPUNGE is never issued (imapflow's own MOVE fallback is deliberately not used: it expunges
 *   without checking the copy or UIDPLUS).
 *
 * The mailbox list (special-use targets) is cached per account in the in-memory memo.
 *
 * Diagnostics (§17): the session reports its phase (`connect` … `logout`) to the caller's
 * stage reporter; mapped errors keep the session's error as `cause` (codes only — the worker never
 * sends server text), which {@link imapHealthHints} turns into health codes (`tls`, `reset`,
 * `parse_error`, `worker_failed`) and detail. A rejected password parks the account in `reauth`
 * with `{reason: 'imap_password_rejected', source: 'mail'}`.
 */
import {
  ACCOUNT_CONFIG_SCHEMAS,
  YAHOO_PRESET,
  type Account,
  type AccountDraft,
  type MailMessage,
} from '@homebase/shared';
import type { AccountProbe, AccountService } from '../../../context.ts';
import type { MemoryCache } from '../../../lib/cache.ts';
import { HttpError } from '../../../lib/errors.ts';
import type { DetailValue, Outcome } from '../../../lib/health.ts';
import type { Logger } from '../../../lib/logger.ts';
import { cleanSubject, mailAddress, toIsoDate } from '../text.ts';
import { decodeImapId, encodeImapId } from './imap-id.ts';
import { ImapWorkerError, inProcessImapRunner, runImapJobInWorker, type ImapSessionRunner } from './imap-runner.ts';
import {
  ImapAuthError,
  ImapOpError,
  imapErrorFields,
  type ImapClientFactory,
  type ImapConnectionParams,
  type ImapFetched,
  type ImapFolders,
  type ImapJob,
  type ImapJobOutput,
  type ImapPhase,
} from './imap-session.ts';
import type { MailAction, MailProvider, StageReporter } from './types.ts';

// The session layer (worker-safe) lives in imap-session.ts; re-exported for existing importers.
export {
  ARCHIVE_FALLBACK_NAMES,
  IMAP_FETCH_QUERY,
  IMAP_PHASES,
  ImapAuthError,
  ImapOpError,
  TRASH_FALLBACK_NAMES,
  UNREAD_SCAN_WINDOW,
  connectPhase,
  moveStrategy,
  resolveFolders,
} from './imap-session.ts';
export type {
  ImapAddress,
  ImapClientFactory,
  ImapClientLike,
  ImapConnectionParams,
  ImapFetchQuery,
  ImapFetched,
  ImapFolders,
  ImapListEntry,
  ImapMailboxInfo,
  ImapPhase,
  MoveStrategy,
} from './imap-session.ts';

export const FOLDERS_TTL_MS = 10 * 60 * 1000;

/** Message of an account parked in `reauth` (whatever parked it: IMAP, CalDAV, a vault reset …). */
export const REAUTH_MESSAGE = "This account's password needs to be updated in Settings";

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export function mapImapMessage(
  fetched: ImapFetched,
  account: Pick<Account, 'id'>,
  mailbox: { path: string; uidValidity: bigint | string },
  now: () => number = Date.now,
): MailMessage | null {
  if (!Number.isInteger(fetched.uid) || fetched.uid <= 0) return null;
  const envelope = fetched.envelope ?? {};
  const from = envelope.from?.[0] ?? envelope.sender?.[0];
  return {
    id: encodeImapId({ mailbox: mailbox.path, uidValidity: mailbox.uidValidity, uid: fetched.uid }),
    accountId: account.id,
    from: mailAddress(from?.name, from?.address),
    subject: cleanSubject(envelope.subject),
    snippet: null,
    date: toIsoDate(fetched.internalDate, envelope.date) ?? new Date(now()).toISOString(),
    unread: !(fetched.flags?.has('\\Seen') ?? false),
    webUrl: null,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const TIMEOUT_CODES = new Set(['ETIMEOUT', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'LockTimeout']);
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'NoConnection', 'EConnectionClosed']);

interface ImapErrorLike {
  code?: unknown;
  authenticationFailed?: unknown;
  serverResponseCode?: unknown;
  tlsFailed?: unknown;
}

/**
 * RFC 5530 response codes on a refused LOGIN that do not mean "wrong password": the server is
 * temporarily unable, or the user has too many connections. These must not park the account in
 * `reauth` (which stops all retries until the user re-enters the password).
 */
const LOGIN_BUSY_CODES = new Set(['LIMIT', 'INUSE']);
const LOGIN_UNAVAILABLE_CODES = new Set(['UNAVAILABLE', 'SERVERBUG']);

/**
 * Maps anything a session throws to an HttpError (no server text is reflected). The session's
 * error is kept as `cause` (logs show its name and code; health refines the code, see
 * {@link imapHealthHints}).
 */
export function mapImapError(err: unknown, host: string, accountId: string | undefined, aborted: boolean): Error {
  if (err instanceof HttpError || err instanceof ImapAuthError) return err;
  const cause = err ?? undefined;
  if (err instanceof ImapOpError) {
    return new HttpError(err.status, err.code, {
      message: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
      ...(accountId === undefined ? {} : { accountId }),
      cause,
    });
  }
  const e = (err ?? {}) as ImapErrorLike;
  const code = typeof e.code === 'string' ? e.code : '';
  const withAccount = (status: number, errCode: 'provider_error' | 'upstream_timeout' | 'rate_limited', message: string) =>
    new HttpError(status, errCode, accountId === undefined ? { message, cause } : { message, accountId, cause });

  if (err instanceof ImapWorkerError && !aborted) {
    // Homebase's own failure (worker could not run or crashed), not the mail server's.
    return withAccount(502, 'provider_error', `The mail session with ${host} stopped unexpectedly; try again`);
  }

  if (e.authenticationFailed === true) {
    const responseCode = typeof e.serverResponseCode === 'string' ? e.serverResponseCode.toUpperCase() : '';
    if (LOGIN_BUSY_CODES.has(responseCode)) {
      return withAccount(429, 'rate_limited', `The mail server ${host} refused the login: too many connections; try again shortly`);
    }
    if (LOGIN_UNAVAILABLE_CODES.has(responseCode)) {
      return withAccount(502, 'provider_error', `The mail server ${host} is temporarily unavailable; try again later`);
    }
    return new ImapAuthError('The mail server rejected the username or password');
  }
  if (aborted || TIMEOUT_CODES.has(code)) return withAccount(504, 'upstream_timeout', `The mail server ${host} did not respond in time`);
  if (code === 'ETHROTTLE') return withAccount(429, 'rate_limited', `The mail server ${host} is rate limiting requests; try again shortly`);
  if (e.tlsFailed === true || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL/i.test(code)) {
    return withAccount(502, 'provider_error', `A secure connection to ${host} could not be established (TLS/certificate problem)`);
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return withAccount(502, 'provider_error', `The mail server ${host} could not be found`);
  if (UNREACHABLE_CODES.has(code)) return withAccount(502, 'provider_error', `Could not connect to the mail server ${host}`);
  return withAccount(502, 'provider_error', `The mail server ${host} returned an error`);
}

const TLS_CODE = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL|STARTTLS/i;
/** imapflow codes for a connection the server (or the path) closed. */
const CLOSED_CODES = new Set(['NoConnection', 'EConnectionClosed', 'ClosedAfterConnectTLS', 'ClosedAfterConnectText']);
/** imapflow codes for a response it could not understand. */
const PROTOCOL_CODES = new Set(['InvalidResponse', 'UnexpectedTag', 'ResponseProcessingFailed']);

/**
 * Health hints of a mapped IMAP failure (§17): detail from the session's error codes
 * (`serverResponseCode`, `tlsFailed`, `authenticationFailed`, the worker failure `reason`), and a
 * sharper `code` than `outcomeFromError` can tell from a generic 502 `provider_error`: `tls`,
 * `reset` (connection closed), `parse_error` (unreadable response), `worker_failed`. Timeouts,
 * rate limits and DNS/refused/unreachable (from the cause's code) are left to `outcomeFromError`.
 */
export function imapHealthHints(err: unknown): Pick<Outcome, 'code' | 'detail'> {
  const cause = err instanceof Error ? err.cause : undefined;
  const generic = err instanceof HttpError && err.code === 'provider_error';
  if (cause instanceof ImapWorkerError) {
    return generic ? { code: 'worker_failed', detail: { worker: cause.reason } } : { detail: { worker: cause.reason } };
  }
  const fields = imapErrorFields(cause);
  const detail: Record<string, DetailValue> = {};
  if (fields.serverResponseCode !== undefined) detail.serverResponseCode = fields.serverResponseCode;
  if (fields.tlsFailed === true) detail.tlsFailed = true;
  if (fields.authenticationFailed === true) detail.authenticationFailed = true;
  const code = fields.code ?? '';
  let health: string | undefined;
  if (generic) {
    if (fields.tlsFailed === true || TLS_CODE.test(code)) health = 'tls';
    else if (CLOSED_CODES.has(code)) health = 'reset';
    else if (PROTOCOL_CODES.has(code)) health = 'parse_error';
  }
  return health === undefined ? { detail } : { code: health, detail };
}

/** Log fields of a session error: `{errCode, serverResponseCode, authenticationFailed, tlsFailed}` (codes and flags only). */
function imapLogFields(err: unknown): Record<string, string | boolean> {
  const { code, ...rest } = imapErrorFields(err);
  return code === undefined ? { ...rest } : { errCode: code, ...rest };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Runs `job` on one short-lived connection through `run` (a worker in production, see
 * imap-runner.ts) and maps any failure to an HttpError / ImapAuthError. Phases go to `onStage`;
 * connection-level errors and the failure itself are debug-logged with the phase and the
 * session's codes and flags only (host, port and security are configuration, never server text).
 */
export async function withImapSession(
  run: ImapSessionRunner,
  params: ImapConnectionParams,
  opts: { signal: AbortSignal; accountId?: string; log: Logger; onStage?: StageReporter | undefined },
  job: ImapJob,
): Promise<ImapJobOutput> {
  if (opts.signal.aborted) throw mapImapError(null, params.host, opts.accountId, true);
  const server = { host: params.host, port: params.port, security: params.security };
  let phase: ImapPhase | null = null;
  try {
    return await run(params, job, {
      signal: opts.signal,
      log: opts.log,
      onPhase: (next) => {
        phase = next;
        opts.onStage?.(next);
      },
      onConnectionError: (err) => opts.log.debug('imap connection error', { ...server, phase, ...imapLogFields(err) }),
    });
  } catch (err) {
    const mapped = mapImapError(err, params.host, opts.accountId, opts.signal.aborted);
    opts.log.debug('imap session failed', {
      ...server,
      op: job.op,
      phase,
      aborted: opts.signal.aborted,
      errName: err instanceof Error ? err.name : typeof err,
      ...imapLogFields(err),
      mappedTo: mapped instanceof HttpError ? mapped.code : mapped.name,
    });
    throw mapped;
  }
}

/** Connection settings of a stored yahoo/imap account config (or a draft's config). */
export function imapSettingsOf(kind: Account['kind'], config: unknown): Omit<ImapConnectionParams, 'password'> | null {
  if (kind === 'yahoo') {
    const parsed = ACCOUNT_CONFIG_SCHEMAS.yahoo.safeParse(config);
    if (!parsed.success) return null;
    const imap = parsed.data.imap ?? { host: YAHOO_PRESET.imapHost, port: YAHOO_PRESET.imapPort, security: YAHOO_PRESET.imapSecurity };
    return { host: imap.host, port: imap.port, security: imap.security, username: parsed.data.username };
  }
  if (kind === 'imap') {
    const parsed = ACCOUNT_CONFIG_SCHEMAS.imap.safeParse(config);
    if (!parsed.success) return null;
    const { imap } = parsed.data;
    return { host: imap.host, port: imap.port, security: imap.security, username: parsed.data.username };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ImapDeps {
  accounts: AccountService;
  memo: MemoryCache;
  log: Logger;
  /** Same-thread client factory (tests pass the fake server); ignored when `run` is given. */
  connect?: ImapClientFactory | undefined;
  /** Session runner; default: one worker per session (imap-runner.ts). */
  run?: ImapSessionRunner | undefined;
  now?: () => number;
}

function runnerOf(deps: Pick<ImapDeps, 'connect' | 'run'>): ImapSessionRunner {
  if (deps.run) return deps.run;
  return deps.connect ? inProcessImapRunner(deps.connect) : runImapJobInWorker;
}

export function foldersKey(accountId: string): string {
  return `mail:imap-folders:${accountId}:`;
}

export function createImapProvider(deps: ImapDeps): MailProvider {
  const { accounts, memo, log } = deps;
  const now = deps.now ?? Date.now;
  const run = runnerOf(deps);

  const connectionFor = async (account: Account): Promise<ImapConnectionParams> => {
    // A rejected password is not retried until the user fixes it (repeated failed logins can lock
    // the mailbox at the provider); re-adding or testing the account resets the status. The text is
    // fixed and names no cause: the account may be parked by CalDAV, a vault reset or a missing
    // password too (its own status message says which, and is not echoed here).
    if (account.status === 'reauth') {
      throw new HttpError(409, 'reauth_required', { message: REAUTH_MESSAGE, accountId: account.id });
    }
    const settings = imapSettingsOf(account.kind, accounts.getConfig(account.id));
    if (!settings) throw new HttpError(409, 'not_configured', { message: 'This account has no IMAP settings', accountId: account.id });
    const { password } = await accounts.getSecret(account.id);
    return { ...settings, password };
  };

  const session = async (account: Account, signal: AbortSignal, job: ImapJob, onStage?: StageReporter): Promise<ImapJobOutput> => {
    const params = await connectionFor(account);
    try {
      return await withImapSession(run, params, { signal, accountId: account.id, log, onStage }, job);
    } catch (err) {
      if (err instanceof ImapAuthError) {
        accounts.setStatus(account.id, 'reauth', 'The mail server rejected the password', { reason: 'imap_password_rejected', source: 'mail' });
        throw new HttpError(409, 'reauth_required', {
          message: 'The mail server rejected the password; update it in Settings',
          accountId: account.id,
          cause: err,
        });
      }
      throw err;
    }
  };

  const cachedFolders = (account: Account): ImapFolders | null => memo.get<ImapFolders>(foldersKey(account.id)) ?? null;
  const rememberFolders = (account: Account, cached: ImapFolders | null, resolved: ImapFolders | null): void => {
    if (cached === null && resolved !== null) memo.set(foldersKey(account.id), resolved, FOLDERS_TTL_MS);
  };
  const unexpected = (account: Account): HttpError =>
    new HttpError(502, 'provider_error', { message: 'The mail server returned an error', accountId: account.id });

  return {
    async list(account, { maxMessages, unreadOnly, signal, onStage }) {
      const folders = cachedFolders(account);
      const output = await session(account, signal, { op: 'list', maxMessages, unreadOnly, folders }, onStage);
      if (output.op !== 'list') throw unexpected(account);
      rememberFolders(account, folders, output.folders);
      const { mailbox } = output;
      const messages = output.fetched
        .filter((f: ImapFetched) => !(unreadOnly && f.flags?.has('\\Seen')))
        .sort((a, b) => b.uid - a.uid)
        .slice(0, maxMessages)
        .map((f) => mapImapMessage(f, account, { path: mailbox.path, uidValidity: mailbox.uidValidity }, now))
        .filter((m): m is MailMessage => m !== null);
      return {
        unread: output.unseen ?? messages.filter((m) => m.unread).length,
        messages,
        canArchive: output.folders.archive !== null && output.movable,
        canTrash: output.folders.trash !== null && output.movable,
      };
    },

    async act(account, messageId, action: MailAction, signal, onStage) {
      const ref = decodeImapId(messageId);
      if (!ref) throw new HttpError(404, 'not_found', { message: 'Unknown message', accountId: account.id });
      const folders = action.type === 'read' ? null : cachedFolders(account);
      const output = await session(account, signal, { op: 'act', ref, action, folders }, onStage);
      if (output.op !== 'act') throw unexpected(account);
      rememberFolders(account, folders, output.folders);
    },
  };
}

// ---------------------------------------------------------------------------
// Account probe (§6): yahoo/imap accounts get the mail capability when login + STATUS INBOX work.
// ---------------------------------------------------------------------------

export const PROBE_TIMEOUT_MS = 25_000;

export function createImapProbe(deps: Pick<ImapDeps, 'connect' | 'run' | 'log'>): AccountProbe {
  const run = runnerOf(deps);
  return async (draft: AccountDraft) => {
    const settings = imapSettingsOf(draft.kind, draft.config);
    if (!settings) throw new HttpError(422, 'validation_failed', 'The IMAP settings are incomplete');
    const params: ImapConnectionParams = { ...settings, password: draft.secret.password };
    try {
      await withImapSession(run, params, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), log: deps.log }, { op: 'probe' });
    } catch (err) {
      if (err instanceof ImapAuthError) {
        throw new HttpError(422, 'validation_failed', 'The mail server rejected the username or password');
      }
      throw err;
    }
    return {};
  };
}
