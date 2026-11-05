import { lazy } from 'react';
import { FolderGit2 } from 'lucide-react';
import { z } from 'zod';
import { lazyWithPreload } from '../lazyWidget.ts';
import type { WidgetDefinition } from '../types.ts';

export const githubConfigSchema = z.object({
  /** `attention`: failing, then running, then most recently pushed. */
  sort: z.enum(['attention', 'pushed', 'name']).default('attention'),
  showArchived: z.boolean().default(false),
  showForks: z.boolean().default(false),
});
export type GitHubConfig = z.output<typeof githubConfigSchema>;

export const definition: WidgetDefinition<GitHubConfig> = {
  type: 'github',
  title: 'GitHub',
  description: 'A status board of your repositories: CI results, open pull requests and issues, and a quick way into GitHub Desktop.',
  icon: FolderGit2,
  defaultSize: { w: 4, h: 7, minW: 3, minH: 3 },
  configSchema: githubConfigSchema,
  Component: lazyWithPreload(() => import('./Widget.tsx')),
  Settings: lazy(() => import('./Settings.tsx')),
  stackSizing: 'content',
};
