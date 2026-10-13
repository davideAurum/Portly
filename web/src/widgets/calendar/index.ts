import { lazy } from 'react';
import { CalendarDays } from 'lucide-react';
import { z } from 'zod';
import { lazyWithPreload } from '../lazyWidget.ts';
import type { WidgetDefinition } from '../types.ts';

export const calendarConfigSchema = z.object({
  view: z.enum(['agenda', 'week', 'month']).default('agenda'),
  days: z.number().int().min(1).max(14).default(7),
  /** 'visible' = every calendar marked visible in Settings > Calendars. */
  calendarIds: z.union([z.literal('visible'), z.array(z.string().min(1).max(512)).max(100)]).default('visible'),
  showDeclined: z.boolean().default(false),
});
export type CalendarConfig = z.output<typeof calendarConfigSchema>;

export const definition: WidgetDefinition<CalendarConfig> = {
  type: 'calendar',
  title: 'Calendar',
  description: 'Upcoming events from your Google, Outlook, CalDAV and ICS calendars.',
  icon: CalendarDays,
  defaultSize: { w: 4, h: 8, minW: 3, minH: 4 },
  configSchema: calendarConfigSchema,
  Component: lazyWithPreload(() => import('./Widget.tsx')),
  // The agenda is a list; week and month grids need their fixed height.
  stackSizing: (config) => (config.view === 'agenda' ? 'content' : 'fixed'),
  Settings: lazy(() => import('./Settings.tsx')),
};
