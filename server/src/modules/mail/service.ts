/**
 * Mail service (§7 Mail, §9, §4.10): aggregates every account with the `mail` capability enabled,
 * in parallel, each under its own timeout and with its own error (HTTP 200 overall); lists are
 * memoized in memory for 60 s per account (mail is never persisted, §5); actions are accepted only
 * for message ids the server listed for that account (in-memory allowlist) and invalidate the
 * account's cached lists.
 *
 * Diagnostics (ARCHITECTURE §17): each account's work runs in `withLogContext({area: 'mail',
 * accountId})`. Every fresh listing (not a memo hit) is recorded as health `mail:<accountId>`
 * (on demand: never stale) with detail `{stage, count}` — the health tracker logs the failure,
 * recovery and reminder lines; this module logs debug detail only, plus `info 'mail action'
 * {op, accountId, ms}` / `warn 'mail action failed'`. Providers report the stage they reach
 * (`token`, `list`, `get`, IMAP `login`, `fetch` …); a timeout freezes and reports it, and a
 * failed REST request names its own ({@link failedStage}: its siblings run in parallel). Failures
 * go through `outcomeFromError`: a transport failure by its SafeFetchError (dns, refused, tls …),
 * an IMAP failure refined by {@link imapHealthHints}, and an account that cannot be used (reconnect
 * needed, Google/Microsoft OAuth client not configured) as `account_unavailable` caused by
 * `account:<id>`; missing IMAP settings are the mailbox's own `not_configured`. The subject is
 * forgotten when the account is deleted or its mail is switched off. Never logged: subjects,
 * senders, bodies, addresses, URLs.
 */
import {
  MAX_MAIL_MESSAGES,
  MIN_MAIL_MESSAGES,
  type Account,
  type AccountKind,
  type ItemError,
  type MailAccountSummary,
  type MailMessage,
} from '@homebase/shared';
import type { AppContext } from '../../context.ts';
import { HttpError } from '../../lib/errors.ts';
import { outcomeFromError, type HealthSubject, type Outcome } from '../../lib/health.ts';
import { withLogContext } from '../../lib/log-context.ts';
import { errorFields, type Logger } from '../../lib/logger.ts';
import { SafeFetchError } from '../../security/safe-fetch.ts';
import { createGmailProvider } from './providers/gmail.ts';
import { createGraphProvider } from './providers/graph.ts';
import { failedStage } from './providers/http.ts';
import { createImapProvider, foldersKey, imapHealthHints, type ImapClientFactory } from './providers/imap.ts';
import type { MailAction, MailProvider, ProviderListing, StageReporter } from './providers/types.ts';
import { webmailUrlFor } from './weburl.ts';

export const LIST_TTL_MS = 60_000;
export const ALLOWLIST_TTL_MS = 30 * 60_000;
export const ALLOWLIST_MAX = 1000;
export const ACCOUNT_TIMEOUT_MS = 20_000;
export const ACTION_TIMEOUT_MS = 25_000;
export const DEFAULT_MAX_MESSAGES = 10;

export type MailServiceContext = Pick<AppContext, 'accounts' | 'memo' | 'log' | 'fetch' | 'health'>;

export interface MailServiceOptions {
  /** Provider overrides by account kind (tests). */
  providers?: Partial<Record<AccountKind, MailProvider>>;
  /**
   * Same-thread IMAP client factory (tests pass a fake). Without it every IMAP session runs in
   * its own worker thread (providers/imap-runner.ts).
   */
  imapConnect?: ImapClientFactory;
  now?: () => number;
  accountTimeoutMs?: number;
  actionTimeoutMs?: number;
}

export interface SummaryQuery {
  maxMessages: number;
  unreadOnly: boolean;
  /** Only these accounts (the widget's selection); all mail accounts when omitted. */
  accountIds?: readonly string[] | undefined;
}

export interface MailService {
  /** One `MailAccountSummary` per mail account; `canTrash` is always set (§4.10). */
  summary(query: SummaryQuery): Promise<MailAccountSummary[]>;
  act(accountId: string, messageId: string, action: MailAction): Promise<void>;
  /** Drops the cached lists of an account (and, with `all`, its allowlist and folder cache). */
  invalidate(accountId: string, opts?: { all?: boolean }): void;
}

export function listKeyPrefix(accountId: string): string {
  return `mail:list:${accountId}:`;
}

/**
 * Memo key of one listing. `generation` is bumped whenever the account's lists are invalidated,
 * so a listing that was already in flight (and read the mailbox before an action) can neither be
 * joined by a later request nor be served after it lands — it is stored under a dead key.
 */
export function listKey(accountId: string, generation: number, maxMessages: number, unreadOnly: boolean): string {
  return `${listKeyPrefix(accountId)}${generation}:${maxMessages}:${unreadOnly ? 'unread' : 'all'}`;
}

export function allowKey(accountId: string): string {
  return `mail:allow:${accountId}:`;
}

/** Health key of an account's mailbox (§17). */
export function mailHealthKey(accountId: string): string {
  return `mail:${accountId}`;
}

type Allowlist = ReadonlyMap<string, number>;

function hasMail(account: Account): boolean {
  return account.capabilities.includes('mail') && account.enabledCapabilities.includes('mail');
}

function byDateDesc(a: MailMessage, b: MailMessage): number {
  return Date.parse(b.date) - Date.parse(a.date);
}

export function clampMaxMessages(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_MESSAGES;
  return Math.min(MAX_MAIL_MESSAGES, Math.max(MIN_MAIL_MESSAGES, Math.trunc(value)));
}

/** The step a listing or an action has reached; frozen once it ends or times out (later reports are ignored). */
export interface StageTracker {
  readonly stage: string;
  readonly report: StageReporter;
  freeze(): void;
}

export function createStageTracker(initial = 'start'): StageTracker {
  let stage = initial;
  let frozen = false;
  return {
    get stage() {
      return stage;
    },
    report: (next) => {
      if (!frozen) stage = next;
    },
    freeze: () => {
      frozen = true;
    },
  };
}

interface TimeoutOptions {
  ms: number;
  accountId: string;
  /** Who did not answer ("Gmail", "Yahoo Mail" …), for the 504 message. */
  what: string;
  /** `list`, or the action's op. */
  op: string;
  tracker: StageTracker;
  log: Logger;
}

/**
 * Runs `fn` with an AbortSignal that fires (and a 504 `upstream_timeout`) after `ms`. When it
 * fires, the stage reached is frozen and reported (`debug 'mail timed out' {op, stage, ms}`), so the
 * health outcome or the action line names it; the work aborted afterwards cannot move it.
 */
async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, opts: TimeoutOptions): Promise<T> {
  const { ms, accountId, what, op, tracker, log } = opts;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      tracker.freeze();
      log.debug('mail timed out', { op, stage: tracker.stage, ms });
      // Settle the race first, then abort (abort listeners reject the provider's own promise).
      reject(new HttpError(504, 'upstream_timeout', { message: `${what} did not respond in time`, accountId }));
      controller.abort();
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    tracker.freeze();
  }
}

const PROVIDER_NAMES: Readonly<Record<AccountKind, string>> = Object.freeze({
  google: 'Gmail',
  microsoft: 'Outlook.com',
  yahoo: 'Yahoo Mail',
  imap: 'The mail server',
  caldav: 'The server',
});

/** `read` / `unread` / `archive` / `trash` (the log's `op`). */
function actionOp(action: MailAction): string {
  return action.type === 'read' ? (action.read ? 'read' : 'unread') : action.type;
}

/**
 * The account cannot be used, and its own subject (`account:<id>`) says why: it must be
 * reconnected (any kind), or it is a Google/Microsoft account whose OAuth client is not configured
 * (the accounts module records that refusal on the account). Its mailbox waits for it. Missing
 * IMAP settings are the mailbox's own `not_configured` failure.
 */
function isAccountUnusable(err: unknown, kind: AccountKind): boolean {
  if (!(err instanceof HttpError)) return false;
  return err.code === 'reauth_required' || (err.code === 'not_configured' && (kind === 'google' || kind === 'microsoft'));
}

/**
 * Health outcome of a failed fresh listing (§17): `account_unavailable` caused by
 * `account:<id>` (severity info; the account's own subject says why) when the account cannot be
 * used; else `outcomeFromError` — of the SafeFetchError behind a REST transport failure (dns,
 * refused, tls, too_large, parse_error …) under the mail message, or of the error itself, with
 * IMAP codes and flags from {@link imapHealthHints}. Detail always carries the stage reached.
 */
function failureOutcome(err: unknown, account: Account, stage: string, ms: number): Outcome {
  if (isAccountUnusable(err, account.kind)) {
    return outcomeFromError(err, { code: 'account_unavailable', causeKey: `account:${account.id}`, severity: 'info', ms, detail: { stage } });
  }
  if (err instanceof HttpError && err.cause instanceof SafeFetchError) {
    return outcomeFromError(err.cause, { message: err.message, ms, detail: { stage } });
  }
  if (account.kind === 'yahoo' || account.kind === 'imap') {
    const hints = imapHealthHints(err);
    return outcomeFromError(err, { ...hints, ms, detail: { ...hints.detail, stage } });
  }
  return outcomeFromError(err, { ms, detail: { stage } });
}

export function createMailService(ctx: MailServiceContext, options: MailServiceOptions = {}): MailService {
  const { accounts, memo, log, health } = ctx;
  const now = options.now ?? Date.now;
  const accountTimeoutMs = options.accountTimeoutMs ?? ACCOUNT_TIMEOUT_MS;
  const actionTimeoutMs = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;

  const rest = { fetch: ctx.fetch, accounts, now };
  const imap = createImapProvider({ accounts, memo, log, connect: options.imapConnect, now });
  const providers: Partial<Record<AccountKind, MailProvider>> = {
    google: createGmailProvider(rest),
    microsoft: createGraphProvider(rest),
    yahoo: imap,
    imap,
    ...options.providers,
  };

  // --- id allowlist (§4.10) -------------------------------------------------

  const allowlist = (accountId: string): Allowlist => memo.get<Allowlist>(allowKey(accountId)) ?? new Map<string, number>();

  const remember = (accountId: string, ids: readonly string[]): void => {
    const t = now();
    const next = new Map<string, number>();
    for (const [id, expiresAt] of allowlist(accountId)) if (expiresAt > t) next.set(id, expiresAt);
    for (const id of ids) {
      next.delete(id);
      next.set(id, t + ALLOWLIST_TTL_MS);
    }
    for (const id of next.keys()) {
      if (next.size <= ALLOWLIST_MAX) break;
      next.delete(id);
    }
    memo.set(allowKey(accountId), next, ALLOWLIST_TTL_MS);
  };

  const isListed = (accountId: string, id: string): boolean => (allowlist(accountId).get(id) ?? 0) > now();

  const forget = (accountId: string, id: string): void => {
    const current = allowlist(accountId);
    if (!current.has(id)) return;
    const next = new Map(current);
    next.delete(id);
    memo.set(allowKey(accountId), next, ALLOWLIST_TTL_MS);
  };

  // --- list cache generations ------------------------------------------------

  const generations = new Map<string, number>();
  const generation = (accountId: string): number => generations.get(accountId) ?? 0;

  const invalidate = (accountId: string, opts: { all?: boolean } = {}): void => {
    generations.set(accountId, generation(accountId) + 1);
    memo.delPrefix(listKeyPrefix(accountId));
    if (opts.all) {
      memo.delPrefix(allowKey(accountId));
      memo.delPrefix(foldersKey(accountId));
    }
  };

  // Account removed or its settings changed: cached lists (and, on delete, everything) go; so does
  // the mailbox's health once the account or its mail is gone.
  accounts.onChange((event) => {
    invalidate(event.accountId, { all: event.type === 'deleted' });
    if (event.type === 'updated') memo.delPrefix(foldersKey(event.accountId));
    if (event.type === 'deleted') health.forget(mailHealthKey(event.accountId));
    if (event.type === 'updated') {
      const account = accounts.get(event.accountId);
      if (account !== null && !hasMail(account)) health.forget(mailHealthKey(event.accountId));
    }
  });

  // --- health ---------------------------------------------------------------

  const subjectOf = (account: Account): HealthSubject => ({ key: mailHealthKey(account.id), area: 'mail', accountId: account.id });

  /** Records one fresh listing, unless the account (or its mail) went away while it ran. Never throws. */
  const recordListing = (account: Account, outcome: Outcome): void => {
    let current: Account | null;
    try {
      current = accounts.get(account.id);
    } catch {
      return;
    }
    if (current === null || !hasMail(current)) return;
    health.record(subjectOf(account), outcome);
  };

  /** Lists `account` from its provider (a memo miss) and records the outcome as `mail:<accountId>`. */
  const freshListing = async (account: Account, provider: MailProvider, query: SummaryQuery): Promise<ProviderListing> => {
    const tracker = createStageTracker();
    const started = now();
    try {
      const fresh = await withTimeout(
        (signal) => provider.list(account, { maxMessages: query.maxMessages, unreadOnly: query.unreadOnly, signal, onStage: tracker.report }),
        { ms: accountTimeoutMs, accountId: account.id, what: PROVIDER_NAMES[account.kind], op: 'list', tracker, log },
      );
      const listing = { ...fresh, messages: [...fresh.messages].sort(byDateDesc).slice(0, query.maxMessages) };
      recordListing(account, { ok: true, ms: now() - started, detail: { stage: 'done', count: listing.messages.length } });
      return listing;
    } catch (err) {
      const ms = now() - started;
      const unexpected = !(err instanceof HttpError);
      const stage = failedStage(err) ?? tracker.stage;
      log.debug('mail listing failed', { ...errorFields(err, { stack: unexpected }), kind: account.kind, stage, ms });
      recordListing(account, failureOutcome(err, account, stage, ms));
      throw err;
    }
  };

  // --- summary ----------------------------------------------------------------

  // Failures were recorded and debug-logged by freshListing (unexpected ones with their stack).
  const itemError = (err: unknown, account: Account): ItemError => {
    if (err instanceof HttpError) {
      const error: ItemError = { code: err.code, message: err.message, accountId: account.id };
      if (err.details !== undefined) error.details = err.details;
      return error;
    }
    return { code: 'provider_error', message: 'Mail could not be loaded', accountId: account.id };
  };

  const summarize = async (account: Account, provider: MailProvider, query: SummaryQuery): Promise<MailAccountSummary> => {
    let webmailUrl: string | null = null;
    try {
      webmailUrl = webmailUrlFor(account, accounts.getConfig(account.id));
    } catch {
      webmailUrl = null;
    }
    const base = { accountId: account.id, label: account.label, email: account.email, color: account.color, webmailUrl };
    try {
      // The memo's single-flight body runs in the first caller's context; the key is per account,
      // so that context already names this account.
      const listing = await memo.getOrSet<ProviderListing>(
        listKey(account.id, generation(account.id), query.maxMessages, query.unreadOnly),
        LIST_TTL_MS,
        () => freshListing(account, provider, query),
      );
      remember(
        account.id,
        listing.messages.map((m) => m.id),
      );
      return {
        ...base,
        unread: listing.unread,
        messages: listing.messages,
        canArchive: listing.canArchive,
        canTrash: listing.canTrash ?? true,
      };
    } catch (err) {
      return { ...base, unread: 0, messages: [], canArchive: false, canTrash: false, error: itemError(err, account) };
    }
  };

  return {
    async summary(query) {
      const maxMessages = clampMaxMessages(query.maxMessages);
      const mailAccounts = accounts.list({ capability: 'mail' }).filter((a) => hasMail(a) && providers[a.kind] !== undefined);
      if (mailAccounts.length === 0) {
        throw new HttpError(409, 'not_configured', 'No mail accounts are connected yet');
      }
      const wanted = query.accountIds === undefined ? null : new Set(query.accountIds);
      const selected = wanted === null ? mailAccounts : mailAccounts.filter((a) => wanted.has(a.id));
      return Promise.all(
        selected.map((account) =>
          withLogContext({ area: 'mail', accountId: account.id }, () =>
            summarize(account, providers[account.kind] as MailProvider, { ...query, maxMessages }),
          ),
        ),
      );
    },

    async act(accountId, messageId, action) {
      const account = accounts.get(accountId);
      const provider = account ? providers[account.kind] : undefined;
      if (!account || !provider || !hasMail(account)) throw new HttpError(404, 'not_found', 'Mail account not found');
      if (!isListed(accountId, messageId)) {
        throw new HttpError(404, 'not_found', {
          message: 'This message is not in the current list; refresh and try again',
          details: { reason: 'not_listed' },
          accountId,
        });
      }
      const op = actionOp(action);
      await withLogContext({ area: 'mail', accountId }, async () => {
        const tracker = createStageTracker();
        const started = now();
        try {
          await withTimeout((signal) => provider.act(account, messageId, action, signal, tracker.report), {
            ms: actionTimeoutMs,
            accountId,
            what: PROVIDER_NAMES[account.kind],
            op,
            tracker,
            log,
          });
          if (action.type !== 'read') forget(accountId, messageId);
          log.info('mail action', { op, accountId, kind: account.kind, ms: now() - started });
        } catch (err) {
          log.warn('mail action failed', {
            ...errorFields(err, { stack: !(err instanceof HttpError) }),
            op,
            accountId,
            kind: account.kind,
            stage: failedStage(err) ?? tracker.stage,
            ms: now() - started,
          });
          throw err;
        } finally {
          // Whatever happened (even a partial failure), the next list must come from the provider.
          invalidate(accountId);
        }
      });
    },

    invalidate,
  };
}
