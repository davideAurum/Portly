/**
 * Pure view logic of the mail widget: grouping (merged by date / by account), unread totals,
 * sender labels and the link a row opens (message link, else the account's webmail inbox).
 */
import type { MailAccountSummary, MailAddress, MailMessage } from '@portly/shared';
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
