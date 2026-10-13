import { lazy } from 'react';
import { Search } from 'lucide-react';
import { z } from 'zod';
import { lazyWithPreload } from '../lazyWidget.ts';
import type { WidgetDefinition } from '../types.ts';

export const searchConfigSchema = z.object({
  /** Engines offered in this widget ('all' = every engine in settings.search). */
  engineIds: z.union([z.literal('all'), z.array(z.string().min(1).max(64)).max(50)]).default('all'),
  showEngineSwitcher: z.boolean().default(true),
  /** Focus the input on load (the first search widget with autofocus wins). */
  autofocus: z.boolean().default(true),
  placeholder: z.string().max(100).default('Search the web'),
});
export type SearchConfig = z.output<typeof searchConfigSchema>;

export const definition: WidgetDefinition<SearchConfig> = {
  type: 'search',
  title: 'Search',
  description: 'Search the web with your engines, keywords and suggestions.',
  icon: Search,
  defaultSize: { w: 8, h: 2, minW: 4, minH: 2, maxH: 3 },
  configSchema: searchConfigSchema,
  Component: lazyWithPreload(() => import('./Widget.tsx')),
  Settings: lazy(() => import('./Settings.tsx')),
};
