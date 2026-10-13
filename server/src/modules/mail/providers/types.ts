/**
 * Provider interface of the mail module: one implementation per API (Gmail, Microsoft Graph,
 * IMAP). Providers map provider data to the shared `MailMessage` shape (plain text, capped,
 * allowlisted links) and throw `HttpError`s with §7a codes; the service adds caching, the id
 * allowlist, per-account timeouts, error aggregation and health (§17: `mail:<accountId>`).
 */
import type { Account, MailMessage } from '@homebase/shared';

/**
 * Reports the step a provider call has reached, so a failure or a timeout names it in logs and
 * health (`detail.stage`): REST `token`, `labels`, `folder`, `list`, `get`, `modify`, `trash`,
 * `update`, `move`; IMAP the session phase (`connect`, `greeting`, `starttls`, `login`, `list`,
 * `status`, `examine`, `select`, `search`, `fetch`, `store`, `move`, `copy`, `expunge`, `logout`).
 * Machine words only — never content.
 */
export type StageReporter = (stage: string) => void;

export interface ListOptions {
  /** 5–20. */
  maxMessages: number;
  unreadOnly: boolean;
  /** Aborted when the per-account timeout expires (providers stop work and close connections). */
  signal: AbortSignal;
  /** See {@link StageReporter}. */
  onStage?: StageReporter;
}

export interface ProviderListing {
  /** Unread messages in the inbox (provider count, not just the listed ones). */
  unread: number;
  /** Newest first. */
  messages: MailMessage[];
  /** Whether archive is available for this account right now. */
  canArchive: boolean;
  /** Whether trash is available (IMAP: a Trash folder and MOVE/UIDPLUS); default true. */
  canTrash?: boolean;
}

export type MailAction = { type: 'read'; read: boolean } | { type: 'archive' } | { type: 'trash' };

export interface MailProvider {
  list(account: Account, options: ListOptions): Promise<ProviderListing>;
  /** Performs `action` on a message id this server listed for `account` (checked by the caller). */
  act(account: Account, messageId: string, action: MailAction, signal: AbortSignal, onStage?: StageReporter): Promise<void>;
}
