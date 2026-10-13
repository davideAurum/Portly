/**
 * Outlook.com mail via Microsoft Graph (§8 Microsoft): `/me/mailFolders/inbox` → `unreadItemCount`;
 * `/me/mailFolders/inbox/messages?$top=N&$orderby=receivedDateTime desc&$select=…`; `PATCH isRead`;
 * `POST /me/messages/{id}/move {destinationId: 'archive'|'deleteditems'}`. Every request carries
 * `Prefer: IdType="ImmutableId"` so ids survive moves (§4.10); `bodyPreview` is already plain text.
 * Outbound purposes: `graph.mail.folder`, `graph.mail.list`, `graph.mail.update`, `graph.mail.move`.
 */
import { z } from 'zod';
import type { Account, MailMessage } from '@portly/shared';
import { HttpError } from '../../../lib/errors.ts';
import { cleanPreview, cleanSubject, mailAddress, toIsoDate } from '../text.ts';
import { allowlistedWebUrl } from '../weburl.ts';
import { restCall, type RestDeps } from './http.ts';
import type { MailAction, MailProvider } from './types.ts';

export const GRAPH_API = 'https://graph.microsoft.com/v1.0';
export const GRAPH_PREFER = 'IdType="ImmutableId"';
const NAME = 'Outlook.com';

/** Graph ids are URL-safe base64-like strings. */
export const GRAPH_ID = /^[A-Za-z0-9_=+/-]{1,512}$/;

const FolderSchema = z.looseObject({ unreadItemCount: z.number().int().nonnegative().optional() });

const RecipientSchema = z.looseObject({
  emailAddress: z.looseObject({ name: z.string().nullish(), address: z.string().nullish() }).nullish(),
});

const MessageSchema = z.looseObject({
  id: z.string().regex(GRAPH_ID),
  subject: z.string().nullish(),
  from: RecipientSchema.nullish(),
  receivedDateTime: z.string().nullish(),
  isRead: z.boolean().nullish(),
  bodyPreview: z.string().nullish(),
  webLink: z.string().nullish(),
});

const ListSchema = z.looseObject({ value: z.array(z.unknown()).optional() });

/** Maps a Graph `message` resource; null when it is not a usable message. */
export function mapGraphMessage(raw: unknown, account: Pick<Account, 'id'>, now: () => number = Date.now): MailMessage | null {
  const parsed = MessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  return {
    id: m.id,
    accountId: account.id,
    from: mailAddress(m.from?.emailAddress?.name, m.from?.emailAddress?.address),
    subject: cleanSubject(m.subject),
    snippet: cleanPreview(m.bodyPreview),
    date: toIsoDate(m.receivedDateTime) ?? new Date(now()).toISOString(),
    unread: m.isRead === false,
    webUrl: allowlistedWebUrl(m.webLink),
  };
}

/** OData query string: `$` keys kept literal, values percent-encoded (spaces as %20, not '+'). */
function odataQuery(params: readonly (readonly [string, string])[]): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}

export function graphListUrl(maxMessages: number, unreadOnly: boolean): string {
  const params: [string, string][] = [
    ['$top', String(maxMessages)],
    ['$orderby', 'receivedDateTime desc'],
    ['$select', 'id,subject,from,receivedDateTime,isRead,bodyPreview,webLink'],
  ];
  // Graph requires $orderby properties to appear first in $filter ("InefficientFilter" otherwise).
  if (unreadOnly) params.push(['$filter', 'receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false']);
  return `${GRAPH_API}/me/mailFolders/inbox/messages?${odataQuery(params)}`;
}

export function createGraphProvider(deps: RestDeps & { now?: () => number }): MailProvider {
  const now = deps.now ?? Date.now;
  const headers = { Prefer: GRAPH_PREFER };

  return {
    async list(account, { maxMessages, unreadOnly, signal, onStage }) {
      const get = (url: string, purpose: string) => restCall(deps, NAME, account.id, url, { kind: 'list', purpose, signal, onStage, headers });
      const [folderData, listData] = await Promise.all([
        get(`${GRAPH_API}/me/mailFolders/inbox?$select=unreadItemCount`, 'graph.mail.folder'),
        get(graphListUrl(maxMessages, unreadOnly), 'graph.mail.list'),
      ]);
      const messages = (ListSchema.safeParse(listData).data?.value ?? [])
        .map((raw) => mapGraphMessage(raw, account, now))
        .filter((m): m is MailMessage => m !== null)
        .slice(0, maxMessages);
      const counted = FolderSchema.safeParse(folderData).data?.unreadItemCount;
      return { unread: counted ?? messages.filter((m) => m.unread).length, messages, canArchive: true };
    },

    async act(account, messageId, action: MailAction, signal, onStage) {
      if (!GRAPH_ID.test(messageId)) throw new HttpError(404, 'not_found', { message: 'Unknown message', accountId: account.id });
      const url = `${GRAPH_API}/me/messages/${encodeURIComponent(messageId)}`;
      const call = (target: string, method: 'PATCH' | 'POST', body: unknown) =>
        restCall(deps, NAME, account.id, target, {
          method,
          body,
          kind: 'action',
          purpose: method === 'PATCH' ? 'graph.mail.update' : 'graph.mail.move',
          signal,
          onStage,
          headers,
        });
      switch (action.type) {
        case 'read':
          await call(url, 'PATCH', { isRead: action.read });
          return;
        case 'archive':
          await call(`${url}/move`, 'POST', { destinationId: 'archive' });
          return;
        case 'trash':
          await call(`${url}/move`, 'POST', { destinationId: 'deleteditems' });
          return;
      }
    },
  };
}
