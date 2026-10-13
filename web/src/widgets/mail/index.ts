import { lazy } from 'react';
import { Mail } from 'lucide-react';
import { z } from 'zod';
import { MAX_MAIL_MESSAGES, MIN_MAIL_MESSAGES } from '@portly/shared';
import { lazyWithPreload } from '../lazyWidget.ts';
import type { WidgetDefinition } from '../types.ts';

export const mailConfigSchema = z.object({
  accountIds: z.union([z.literal('all'), z.array(z.string().min(1).max(512)).max(50)]).default('all'),
  maxMessages: z.number().int().min(MIN_MAIL_MESSAGES).max(MAX_MAIL_MESSAGES).default(10),
  unreadOnly: z.boolean().default(false),
  grouping: z.enum(['merged', 'byAccount']).default('merged'),
});
export type MailConfig = z.output<typeof mailConfigSchema>;

export const definition: WidgetDefinition<MailConfig> = {
  type: 'mail',
  title: 'Mail',
  description: 'Unread counts and recent messages from Gmail, Outlook.com and IMAP.',
  icon: Mail,
  defaultSize: { w: 4, h: 7, minW: 3, minH: 4 },
  configSchema: mailConfigSchema,
  Component: lazyWithPreload(() => import('./Widget.tsx')),
  stackSizing: 'content',
  Settings: lazy(() => import('./Settings.tsx')),
};
