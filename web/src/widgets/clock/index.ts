import { lazy } from 'react';
import { Clock } from 'lucide-react';
import { z } from 'zod';
import { IanaTimeZone } from '@homebase/shared';
import { lazyWithPreload } from '../lazyWidget.ts';
import type { WidgetDefinition } from '../types.ts';

export const MAX_EXTRA_ZONES = 6;

export const extraZoneSchema = z.object({
  label: z.string().trim().min(1).max(40),
  /** IANA zone, validated with Intl (`isValidTimeZone`). */
  tz: IanaTimeZone,
});
export type ExtraZone = z.output<typeof extraZoneSchema>;

export const clockConfigSchema = z.object({
  format: z.enum(['inherit', '12h', '24h']).default('inherit'),
  showSeconds: z.boolean().default(false),
  showDate: z.boolean().default(true),
  /** Greeting uses general.userName and the time of day. */
  greeting: z.boolean().default(true),
  /**
   * Entries this browser cannot use (e.g. a zone its Intl data does not know) are dropped
   * individually (and a malformed list is emptied) instead of resetting the whole widget config.
   */
  extraZones: z
    .preprocess(
      (value) =>
        value === undefined
          ? value
          : Array.isArray(value)
            ? value.filter((zone) => extraZoneSchema.safeParse(zone).success).slice(0, MAX_EXTRA_ZONES)
            : [],
      z.array(extraZoneSchema).max(MAX_EXTRA_ZONES),
    )
    .default([]),
});
export type ClockConfig = z.output<typeof clockConfigSchema>;

export const definition: WidgetDefinition<ClockConfig> = {
  type: 'clock',
  title: 'Clock',
  description: 'Time, date, a greeting and extra time zones.',
  icon: Clock,
  defaultSize: { w: 4, h: 3, minW: 2, minH: 2 },
  configSchema: clockConfigSchema,
  Component: lazyWithPreload(() => import('./Widget.tsx')),
  Settings: lazy(() => import('./Settings.tsx')),
};
