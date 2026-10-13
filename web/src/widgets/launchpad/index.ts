import { lazy } from 'react';
import { LayoutGrid } from 'lucide-react';
import { z } from 'zod';
import { lazyWithPreload } from '../lazyWidget.ts';
import type { WidgetDefinition } from '../types.ts';

export const MAX_GROUP_COLUMNS = 6;

export const launchpadConfigSchema = z.object({
  groupIds: z.union([z.literal('all'), z.array(z.string().min(1).max(512)).max(200)]).default('all'),
  iconSize: z.enum(['s', 'm', 'l']).default('m'),
  showLabels: z.boolean().default(true),
  columns: z.union([z.literal('auto'), z.number().int().min(1).max(12)]).default('auto'),
  style: z.enum(['tiles', 'list']).default('tiles'),
  /** `stack`: groups one under another; `columns`: groups side by side in a grid of group columns. */
  groupLayout: z.enum(['stack', 'columns']).default('stack'),
  groupColumns: z.union([z.literal('auto'), z.number().int().min(1).max(MAX_GROUP_COLUMNS)]).default('auto'),
  /** Group id → how many group columns it spans (fixed `groupColumns` only; missing = 1). */
  groupSpans: z.record(z.string().min(1).max(512), z.number().int().min(1).max(MAX_GROUP_COLUMNS)).default({}),
  /** Group headers (name, color, count, collapse) when the launch pad shows more than one group. */
  showGroupHeaders: z.boolean().default(true),
  /** List style: the page name, the address (none / domain / full URL) and where it sits, icons, row spacing. */
  listTitle: z.boolean().default(true),
  listDetail: z.enum(['none', 'domain', 'url']).default('domain'),
  listDetailPlacement: z.enum(['inline', 'below']).default('inline'),
  listIcons: z.boolean().default(true),
  listDensity: z.enum(['compact', 'normal', 'roomy']).default('normal'),
});
export type LaunchpadConfig = z.output<typeof launchpadConfigSchema>;

export const definition: WidgetDefinition<LaunchpadConfig> = {
  type: 'launchpad',
  title: 'Launch pad',
  description: 'Your bookmarks as tiles or a list, grouped and reorderable.',
  icon: LayoutGrid,
  defaultSize: { w: 8, h: 6, minW: 3, minH: 3 },
  configSchema: launchpadConfigSchema,
  Component: lazyWithPreload(() => import('./Widget.tsx')),
  stackSizing: 'content',
  Settings: lazy(() => import('./Settings.tsx')),
};
