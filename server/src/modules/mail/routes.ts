/**
 * HTTP routes of the mail module (§7 Mail). All are non-exempt JSON routes (§4.2), declared
 * `paired()` (the paired Pages site may use them too).
 *
 * - `GET /api/mail/summary?maxMessages=5..20&unreadOnly=true|false&accountIds=a,b`
 *   → `MailAccountSummary[]` (200 with per-account `error`s; 409 `not_configured` when no account
 *   has mail enabled). `accountIds` is optional and only narrows the result. Each item carries
 *   `canTrash` (false when the account has no resolvable trash target, §4.10).
 * - `POST /api/mail/:accountId/messages/:id/read {read}` · `…/archive` · `…/trash` → 204.
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { EntityId, MAX_MAIL_MESSAGES, MIN_MAIL_MESSAGES, MailReadSchema } from '@portly/shared';
import type { AppEnv } from '../../context.ts';
import { HttpError } from '../../lib/errors.ts';
import { paired } from '../../lib/routes.ts';
import { parseBody, parseQuery } from '../../lib/validate.ts';
import type { MailAction } from './providers/types.ts';
import { DEFAULT_MAX_MESSAGES, type MailService } from './service.ts';

const BooleanParam = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

export const SummaryQuerySchema = z.object({
  maxMessages: z.coerce.number().int().min(MIN_MAIL_MESSAGES).max(MAX_MAIL_MESSAGES).default(DEFAULT_MAX_MESSAGES),
  unreadOnly: BooleanParam,
  accountIds: z
    .string()
    .max(20_000)
    .optional()
    .transform((v) =>
      v === undefined
        ? undefined
        : v
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
    )
    .pipe(z.array(EntityId).max(50).optional()),
});

function params(c: Context<AppEnv>): { accountId: string; messageId: string } {
  const accountId = EntityId.safeParse(c.req.param('accountId'));
  const messageId = EntityId.safeParse(c.req.param('id'));
  if (!accountId.success || !messageId.success) throw new HttpError(404, 'not_found', 'Message not found');
  return { accountId: accountId.data, messageId: messageId.data };
}

export function registerMailRoutes(app: Hono<AppEnv>, service: MailService): void {
  app.get('/api/mail/summary', paired(), async (c) => {
    const query = parseQuery(c, SummaryQuerySchema);
    return c.json(await service.summary(query));
  });

  const act = async (c: Context<AppEnv>, action: MailAction): Promise<Response> => {
    const { accountId, messageId } = params(c);
    await service.act(accountId, messageId, action);
    return c.body(null, 204);
  };

  app.post('/api/mail/:accountId/messages/:id/read', paired(), async (c) => {
    const { read } = await parseBody(c, MailReadSchema);
    return act(c, { type: 'read', read });
  });
  app.post('/api/mail/:accountId/messages/:id/archive', paired(), (c) => act(c, { type: 'archive' }));
  app.post('/api/mail/:accountId/messages/:id/trash', paired(), (c) => act(c, { type: 'trash' }));
}
