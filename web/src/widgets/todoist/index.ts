import { lazy } from 'react';
import { ListChecks } from 'lucide-react';
import { z } from 'zod';
import { lazyWithPreload } from '../lazyWidget.ts';
import type { WidgetDefinition } from '../types.ts';

export const todoistConfigSchema = z.object({
  /** Todoist filter query; empty = settings.todoist.defaultFilter ('today | overdue'). */
  filter: z.string().trim().max(1024).default(''),
  /** Header title override. */
  title: z.string().trim().max(80).optional(),
  showProject: z.boolean().default(true),
  showDue: z.boolean().default(true),
  sort: z.enum(['todoist', 'due', 'priority']).default('todoist'),
});
export type TodoistConfig = z.output<typeof todoistConfigSchema>;

export const definition: WidgetDefinition<TodoistConfig> = {
  type: 'todoist',
  title: 'Todoist',
  description: 'Tasks from a Todoist filter with quick add and completion.',
  icon: ListChecks,
  defaultSize: { w: 4, h: 7, minW: 3, minH: 3 },
  configSchema: todoistConfigSchema,
  Component: lazyWithPreload(() => import('./Widget.tsx')),
  stackSizing: 'content',
  Settings: lazy(() => import('./Settings.tsx')),
};
