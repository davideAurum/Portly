/**
 * Mail module (§7 Mail, §4.10, §8, §9): unread counts and recent inbox messages for Gmail (API),
 * Outlook.com (Graph) and IMAP (Yahoo preset + generic), with read/unread, archive and trash.
 * Mail content is never persisted — only kept in the in-memory memo (60 s lists, id allowlist).
 * Registers the IMAP capability probe for `yahoo`/`imap` accounts (§6). Logs as `{module: 'mail'}`;
 * health subject `mail:<accountId>` (service.ts).
 */
import type { Hono } from 'hono';
import type { AppContext, AppEnv, RegisterModule } from '../../context.ts';
import { createImapProbe } from './providers/imap.ts';
import { registerMailRoutes } from './routes.ts';
import { createMailService, type MailServiceOptions } from './service.ts';

export const prefixes = ['/api/mail'] as const;

/** A `register` with injectable providers / IMAP client (tests). */
export function createMailModule(options: MailServiceOptions = {}): RegisterModule {
  return (app: Hono<AppEnv>, ctx: AppContext): void => {
    const log = ctx.log.child({ module: 'mail' });
    const service = createMailService({ accounts: ctx.accounts, memo: ctx.memo, log, fetch: ctx.fetch, health: ctx.health }, options);
    registerMailRoutes(app, service);
    ctx.accounts.registerProbe('mail', ['yahoo', 'imap'], createImapProbe({ connect: options.imapConnect, log }));
  };
}

export const register: RegisterModule = createMailModule();
