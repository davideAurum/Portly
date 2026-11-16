/**
 * Mail contracts (§7a mail.ts, §4.10, §7 Mail routes). Mail content is never persisted server-side.
 */
import { z } from 'zod';
import type { ItemError } from './errors.ts';

export const MAIL_TEXT_LIMITS = {
  subject: 500,
  snippet: 500,
} as const;

export const MIN_MAIL_MESSAGES = 5;
export const MAX_MAIL_MESSAGES = 20;

/** The folders the widget can list, per account (each provider maps them to its own folder/label). */
export const MAIL_FOLDERS = ['inbox', 'sent', 'drafts', 'spam', 'trash'] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];
export const MailFolderSchema = z.enum(MAIL_FOLDERS);

export interface MailAddress {
  name: string;
  address: string;
}

export interface MailMessage {
  /** Opaque id; for IMAP base64url(`${mailbox}\n${uidValidity}\n${uid}`). */
  id: string;
  accountId: string;
  from: MailAddress;
  subject: string;
  /** Plain text (decoded server-side), or null when the provider has none (IMAP). */
  snippet: string | null;
  /** ISO date-time. */
  date: string;
  unread: boolean;
  /** The folder it was listed from; absent means the inbox (older answers). */
  folder?: MailFolder;
  /** Host-allowlisted webmail link, or null. */
  webUrl: string | null;
}

/** `GET /api/mail/summary` item (one per mail-enabled account). */
export interface MailAccountSummary {
  accountId: string;
  label: string;
  email: string | null;
  color: string | null;
  /** Unread messages in the inbox (0 when the inbox was not requested). */
  unread: number;
  messages: MailMessage[];
  webmailUrl: string | null;
  canArchive: boolean;
  /** False when the account has no resolvable trash target (§4.10); the UI hides the action. */
  canTrash?: boolean;
  /** Per-account failure; other accounts still return data (HTTP 200). */
  error?: ItemError;
}

/** `POST /api/mail/:accountId/messages/:id/read {read}` */
export const MailReadSchema = z
  .object({
    read: z.boolean(),
  })
  .strict();
export type MailRead = z.output<typeof MailReadSchema>;
