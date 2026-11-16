/**
 * Pure view logic of the mail widget: grouping (merged by date / by account), unread totals,
 * sender labels and the link a row opens (message link, else the account's webmail inbox).
 */
import { MAIL_FOLDERS, type MailAccountSummary, type MailAddress, type MailFolder, type MailMessage } from '@portly/shared';
import { safeHref } from '../../lib/openUrl.ts';

export interface MailRow {
  message: MailMessage;
  summary: MailAccountSummary;
}

export interface MailGroup {
  summary: MailAccountSummary;
  rows: MailRow[];
}

function time(message: MailMessage): number {
  const ms = Date.parse(message.date);
  return Number.isNaN(ms) ? 0 : ms;
}

export const FOLDER_LABELS: Readonly<Record<MailFolder, string>> = Object.freeze({
  inbox: 'Inbox',
  sent: 'Sent',
  drafts: 'Drafts',
  spam: 'Spam',
  trash: 'Trash',
});

/** `folders` with `folder` switched on or off, in the fixed folder order; the last folder cannot be switched off. */
export function toggleFolder(folders: readonly MailFolder[], folder: MailFolder, on: boolean): MailFolder[] {
  const next = new Set(folders);
  if (on) next.add(folder);
  else if (next.size > 1) next.delete(folder);
  return MAIL_FOLDERS.filter((f) => next.has(f));
}

/** The folder a message came from (older answers carry none: the inbox). */
export function folderOf(message: MailMessage): MailFolder {
  return message.folder ?? 'inbox';
}

/** The accounts not switched off in the sidebar (server order kept). */
export function visibleSummaries(summaries: readonly MailAccountSummary[], hiddenIds: readonly string[]): MailAccountSummary[] {
  if (hiddenIds.length === 0) return [...summaries];
  const hidden = new Set(hiddenIds);
  return summaries.filter((s) => !hidden.has(s.accountId));
}

/** `hiddenIds` with `accountId` switched on or off; ids of accounts no longer listed are dropped. */
export function toggleHidden(hiddenIds: readonly string[], accountId: string, visible: boolean, knownIds: readonly string[]): string[] {
  const known = new Set(knownIds);
  const next = new Set(hiddenIds.filter((id) => known.has(id)));
  if (visible) next.delete(accountId);
  else next.add(accountId);
  return [...next];
}

/** Unread messages across the accounts that loaded. */
export function totalUnread(summaries: readonly MailAccountSummary[]): number {
  return summaries.reduce((sum, s) => sum + (s.error ? 0 : Math.max(0, s.unread)), 0);
}

/** Every account's messages merged newest first, at most `limit` rows. */
export function mergedRows(summaries: readonly MailAccountSummary[], limit: number): MailRow[] {
  return summaries
    .flatMap((summary) => summary.messages.map((message) => ({ message, summary })))
    .sort((a, b) => time(b.message) - time(a.message) || a.message.id.localeCompare(b.message.id))
    .slice(0, Math.max(0, limit));
}

/** One group per account (server order), each newest first, at most `limit` rows. */
export function accountGroups(summaries: readonly MailAccountSummary[], limit: number): MailGroup[] {
  return summaries.map((summary) => ({
    summary,
    rows: [...summary.messages]
      .sort((a, b) => time(b) - time(a))
      .slice(0, Math.max(0, limit))
      .map((message) => ({ message, summary })),
  }));
}

export function failedAccounts(summaries: readonly MailAccountSummary[]): MailAccountSummary[] {
  return summaries.filter((s) => s.error !== undefined);
}

export function senderLabel(from: MailAddress): string {
  return from.name.trim() || from.address.trim() || 'Unknown sender';
}

/** The safe URL a row opens: the message itself, else the account's webmail inbox. */
export function rowHref(row: MailRow): string | undefined {
  return safeHref(row.message.webUrl, { allowAppRoutes: false }) ?? safeHref(row.summary.webmailUrl, { allowAppRoutes: false });
}
