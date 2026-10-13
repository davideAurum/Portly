/**
 * Gmail (§8 Google): `users.labels.get(INBOX)` → `messagesUnread`; `messages.list(labelIds=INBOX,
 * maxResults=N)` + `messages.get(format=metadata, metadataHeaders=[From,Subject,Date])` with at
 * most 5 requests in flight. Actions use `messages.modify` (UNREAD / INBOX labels) and
 * `messages.trash` only — never `delete`/`batchDelete` (§4.10). Outbound purposes: `gmail.labels`,
 * `gmail.list`, `gmail.get`, `gmail.modify`, `gmail.trash`.
 */
import { z } from 'zod';
import type { Account, MailMessage } from '@portly/shared';
import { HttpError } from '../../../lib/errors.ts';
import { cleanSubject, decodeSnippet, parseFromHeader, toIsoDate } from '../text.ts';
import { gmailMessageUrl } from '../weburl.ts';
import { mapLimit, restCall, type RestDeps } from './http.ts';
import type { MailAction, MailProvider } from './types.ts';

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_GET_CONCURRENCY = 5;
const NAME = 'Gmail';

/** Gmail message/thread ids are short hex strings; anything else never reaches a URL. */
export const GMAIL_ID = /^[A-Za-z0-9_-]{1,256}$/;

const LabelSchema = z.looseObject({ messagesUnread: z.number().int().nonnegative().optional() });

const ListSchema = z.looseObject({
  messages: z.array(z.looseObject({ id: z.string(), threadId: z.string().optional() })).optional(),
});

const HeaderSchema = z.looseObject({ name: z.string(), value: z.string() });
const MessageSchema = z.looseObject({
  id: z.string().regex(GMAIL_ID),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: z.looseObject({ headers: z.array(HeaderSchema).optional() }).optional(),
});

function header(headers: readonly { name: string; value: string }[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** Maps a `messages.get(format=metadata)` resource; null when it is not a usable message. */
export function mapGmailMessage(raw: unknown, account: Pick<Account, 'id' | 'email'>, now: () => number = Date.now): MailMessage | null {
  const parsed = MessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  const headers = m.payload?.headers ?? [];
  const labels = m.labelIds ?? [];
  return {
    id: m.id,
    accountId: account.id,
    from: parseFromHeader(header(headers, 'From')),
    subject: cleanSubject(header(headers, 'Subject')),
    snippet: decodeSnippet(m.snippet),
    date: toIsoDate(m.internalDate, header(headers, 'Date')) ?? new Date(now()).toISOString(),
    unread: labels.includes('UNREAD'),
    webUrl: gmailMessageUrl(account.email, m.threadId),
  };
}

export function gmailListUrl(maxMessages: number, unreadOnly: boolean): string {
  const params = new URLSearchParams({ labelIds: 'INBOX', maxResults: String(maxMessages) });
  if (unreadOnly) params.append('labelIds', 'UNREAD');
  return `${GMAIL_API}/messages?${params}`;
}

export function gmailGetUrl(id: string): string {
  const params = new URLSearchParams({ format: 'metadata' });
  for (const h of ['From', 'Subject', 'Date']) params.append('metadataHeaders', h);
  return `${GMAIL_API}/messages/${encodeURIComponent(id)}?${params}`;
}

export function createGmailProvider(deps: RestDeps & { now?: () => number }): MailProvider {
  const now = deps.now ?? Date.now;

  return {
    async list(account, { maxMessages, unreadOnly, signal, onStage }) {
      const get = (url: string, purpose: string) => restCall(deps, NAME, account.id, url, { kind: 'list', purpose, signal, onStage });
      const [labelData, listData] = await Promise.all([
        get(`${GMAIL_API}/labels/INBOX`, 'gmail.labels'),
        get(gmailListUrl(maxMessages, unreadOnly), 'gmail.list'),
      ]);

      const refs = (ListSchema.safeParse(listData).data?.messages ?? [])
        .map((r) => r.id)
        .filter((id) => GMAIL_ID.test(id))
        .slice(0, maxMessages);

      const resources = await mapLimit(refs, GMAIL_GET_CONCURRENCY, async (id) => {
        try {
          return await restCall(deps, NAME, account.id, gmailGetUrl(id), { kind: 'action', purpose: 'gmail.get', signal, onStage });
        } catch (err) {
          // Deleted between list and get: skip it.
          if (err instanceof HttpError && err.code === 'not_found') return null;
          throw err;
        }
      });
      const messages = resources
        .map((r) => (r === null ? null : mapGmailMessage(r, account, now)))
        .filter((m): m is MailMessage => m !== null);

      const counted = LabelSchema.safeParse(labelData).data?.messagesUnread;
      return {
        unread: counted ?? messages.filter((m) => m.unread).length,
        messages,
        canArchive: true,
      };
    },

    async act(account, messageId, action: MailAction, signal, onStage) {
      if (!GMAIL_ID.test(messageId)) throw new HttpError(404, 'not_found', { message: 'Unknown message', accountId: account.id });
      const base = `${GMAIL_API}/messages/${encodeURIComponent(messageId)}`;
      const call = (op: 'modify' | 'trash', body?: unknown) =>
        restCall(deps, NAME, account.id, `${base}/${op}`, {
          method: 'POST',
          kind: 'action',
          purpose: `gmail.${op}`,
          signal,
          onStage,
          ...(body === undefined ? {} : { body }),
        });
      switch (action.type) {
        case 'read':
          await call('modify', action.read ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] });
          return;
        case 'archive':
          await call('modify', { removeLabelIds: ['INBOX'] });
          return;
        case 'trash':
          await call('trash');
          return;
      }
    },
  };
}
