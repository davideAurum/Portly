import { lazy } from 'react';
import { Plane } from 'lucide-react';
import { z } from 'zod';
import { FlightDateSchema, normalizeFlightIdent } from '@portly/shared';
import { lazyWithPreload } from '../lazyWidget.ts';
import type { WidgetDefinition } from '../types.ts';

export const MAX_TRACKED_FLIGHTS = 20;
export const MAX_DISMISSED = 100;

const IdentSchema = z
  .string()
  .max(20)
  .transform((value, ctx) => {
    const ident = normalizeFlightIdent(value);
    if (ident === null) {
      ctx.addIssue({ code: 'custom', message: 'Not a flight number' });
      return z.NEVER;
    }
    return ident;
  });

export const TrackedFlightSchema = z.object({ ident: IdentSchema, date: FlightDateSchema });

export const flightsConfigSchema = z.object({
  /** Flights typed in (flight number and local departure date). Invalid entries are dropped. */
  flights: z
    .array(z.unknown())
    .max(MAX_TRACKED_FLIGHTS)
    .catch([])
    .transform((list) => list.flatMap((item) => {
      const parsed = TrackedFlightSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }))
    .default([]),
  /** Also track flight numbers found in upcoming calendar events. */
  fromCalendar: z.boolean().catch(true).default(true),
  /** Calendar flights the user removed (`<ident>@<date>`), so they don't come back. */
  dismissed: z.array(z.string().max(40)).max(MAX_DISMISSED).catch([]).default([]),
});
export type FlightsConfig = z.output<typeof flightsConfigSchema>;

export const definition: WidgetDefinition<FlightsConfig> = {
  type: 'flights',
  title: 'Flights',
  description: 'Track your flights by number: times, delays, gates and progress from FlightAware, including flights found in your calendar.',
  icon: Plane,
  defaultSize: { w: 4, h: 5, minW: 3, minH: 3 },
  configSchema: flightsConfigSchema,
  Component: lazyWithPreload(() => import('./Widget.tsx')),
  Settings: lazy(() => import('./Settings.tsx')),
  stackSizing: 'content',
};
