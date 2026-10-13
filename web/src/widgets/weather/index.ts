import { lazy } from 'react';
import { CloudSun } from 'lucide-react';
import { z } from 'zod';
import { GeoPlaceSchema } from '@portly/shared';
import { lazyWithPreload } from '../lazyWidget.ts';
import type { WidgetDefinition } from '../types.ts';

export const weatherConfigSchema = z.object({
  /**
   * null = settings.weather.defaultLocation, then the device location when enabled.
   * An unreadable stored place (e.g. a time zone this browser no longer knows) falls back to
   * null instead of resetting the whole config.
   */
  location: GeoPlaceSchema.nullable().default(null).catch(null),
  /** Use navigator.geolocation when neither the widget nor the default has a location. */
  useDeviceLocation: z.boolean().default(false),
  show: z
    .object({
      hourly: z.boolean().default(true),
      daily: z.boolean().default(true),
    })
    .prefault({}),
  /** 'inherit' = settings.general.temperatureUnit. */
  units: z.enum(['inherit', 'C', 'F']).default('inherit'),
});
export type WeatherConfig = z.output<typeof weatherConfigSchema>;

export const definition: WidgetDefinition<WeatherConfig> = {
  type: 'weather',
  title: 'Weather',
  description: 'Current conditions, hourly and daily forecast (Open-Meteo).',
  icon: CloudSun,
  defaultSize: { w: 4, h: 5, minW: 2, minH: 3 },
  configSchema: weatherConfigSchema,
  Component: lazyWithPreload(() => import('./Widget.tsx')),
  Settings: lazy(() => import('./Settings.tsx')),
};
