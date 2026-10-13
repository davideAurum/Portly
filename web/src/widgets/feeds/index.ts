import { lazy } from 'react';
import { Rss } from 'lucide-react';
import { z } from 'zod';
import { SafeHttpUrl } from '@portly/shared';
import { lazyWithPreload } from '../lazyWidget.ts';
import type { WidgetDefinition } from '../types.ts';

export const MAX_FEEDS = 20;
export const MIN_FEED_ITEMS = 3;
export const MAX_FEED_ITEMS_SHOWN = 50;

export const FeedSourceSchema = z.object({
  url: SafeHttpUrl,
  /** Display name; '' = the feed's own title. */
  title: z.string().trim().max(120).default(''),
});
export type FeedSource = z.output<typeof FeedSourceSchema>;

export const feedsConfigSchema = z.object({
  feeds: z.array(FeedSourceSchema).max(MAX_FEEDS).default([]),
  /** Headlines shown across all feeds, newest first. */
  maxItems: z.number().int().min(MIN_FEED_ITEMS).max(MAX_FEED_ITEMS_SHOWN).default(15),
  showSummary: z.boolean().default(false),
  /** Show which feed each headline comes from (only when there is more than one feed). */
  showSource: z.boolean().default(true),
});
export type FeedsConfig = z.output<typeof feedsConfigSchema>;

export const definition: WidgetDefinition<FeedsConfig> = {
  type: 'feeds',
  title: 'RSS feeds',
  description: 'Latest headlines from RSS and Atom feeds, merged newest first.',
  icon: Rss,
  defaultSize: { w: 4, h: 7, minW: 3, minH: 3 },
  configSchema: feedsConfigSchema,
  Component: lazyWithPreload(() => import('./Widget.tsx')),
  Settings: lazy(() => import('./Settings.tsx')),
  stackSizing: 'content',
};
