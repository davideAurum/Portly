/**
 * Weather contracts (§7a weather.ts): places, reports (Open-Meteo, mapped server-side),
 * the `weather` settings namespace and the WMO weather-code → label/icon map.
 */
import { z } from 'zod';
import { IanaTimeZone } from './core.ts';

export const TEMPERATURE_UNITS = ['C', 'F'] as const;
export const WIND_UNITS = ['kmh', 'mph', 'ms'] as const;
export const PRECIP_UNITS = ['mm', 'in'] as const;

export const TemperatureUnitSchema = z.enum(TEMPERATURE_UNITS);
export const WindUnitSchema = z.enum(WIND_UNITS);
export const PrecipUnitSchema = z.enum(PRECIP_UNITS);
export type TemperatureUnit = z.output<typeof TemperatureUnitSchema>;
export type WindUnit = z.output<typeof WindUnitSchema>;
export type PrecipUnit = z.output<typeof PrecipUnitSchema>;

export const Latitude = z.number().min(-90).max(90);
export const Longitude = z.number().min(-180).max(180);

export const GeoPlaceSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    admin1: z.string().trim().max(200).optional(),
    country: z.string().trim().max(200).optional(),
    lat: Latitude,
    lon: Longitude,
    timezone: IanaTimeZone.optional(),
  })
  .strict();
export type GeoPlace = z.output<typeof GeoPlaceSchema>;

export interface WeatherUnits {
  temperature: TemperatureUnit;
  wind: WindUnit;
  precip: PrecipUnit;
}

export interface WeatherCurrent {
  /** Local time at the place, ISO-8601 without offset (as returned with `timezone=auto`). */
  time: string;
  temp: number;
  apparent: number;
  /** Relative humidity, %. */
  humidity: number;
  windSpeed: number;
  /** Degrees, meteorological (direction the wind comes from). */
  windDir: number;
  /** WMO weather code (see {@link WMO_CODES}). */
  code: number;
  isDay: boolean;
  precip: number;
}

export interface WeatherHour {
  time: string;
  temp: number;
  code: number;
  /** Probability of precipitation, % (null when the model has none). */
  precipProb: number | null;
}

export interface WeatherDay {
  /** `YYYY-MM-DD` (local to the place). */
  date: string;
  min: number;
  max: number;
  code: number;
  precipProb: number | null;
  /** Local ISO time without offset, or null in polar day/night. */
  sunrise: string | null;
  sunset: string | null;
}

/** `GET /api/weather?lat=&lon=` (units from settings). */
export interface WeatherReport {
  place?: GeoPlace;
  units: WeatherUnits;
  /** IANA zone of the place (Open-Meteo `timezone=auto`). */
  timezone?: string;
  /** Offset of the place's local time from UTC, seconds. */
  utcOffsetSeconds?: number;
  current: WeatherCurrent;
  hourly: WeatherHour[];
  daily: WeatherDay[];
}

/** Query of `GET /api/weather`. */
export const WeatherQuerySchema = z
  .object({
    lat: z.coerce.number().pipe(Latitude),
    lon: z.coerce.number().pipe(Longitude),
  });
export type WeatherQuery = z.output<typeof WeatherQuerySchema>;

/** Query of `GET /api/weather/geocode?q=` → `GeoPlace[]`. */
export const GeocodeQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100),
  });
export type GeocodeQuery = z.output<typeof GeocodeQuerySchema>;

/** `settings.weather` */
export const WeatherSettingsSchema = z
  .object({
    defaultLocation: GeoPlaceSchema.nullable().default(null),
  })
  .strict();
export type WeatherSettings = z.output<typeof WeatherSettingsSchema>;

// ---------------------------------------------------------------------------
// WMO weather interpretation codes (Open-Meteo `weather_code`)
// ---------------------------------------------------------------------------

/** lucide-react icon component names used for weather (the web maps names → components). */
export const WEATHER_ICON_NAMES = [
  'Sun',
  'Moon',
  'CloudSun',
  'CloudMoon',
  'Cloud',
  'CloudFog',
  'CloudDrizzle',
  'CloudRain',
  'CloudRainWind',
  'CloudSunRain',
  'CloudMoonRain',
  'CloudSnow',
  'Snowflake',
  'CloudHail',
  'CloudLightning',
] as const;
export type WeatherIconName = (typeof WEATHER_ICON_NAMES)[number];

export interface WeatherCodeInfo {
  label: string;
  /** lucide icon name for daytime (or any time when `nightIcon` is absent). */
  icon: WeatherIconName;
  /** lucide icon name at night, when it differs. */
  nightIcon?: WeatherIconName;
}

export const WMO_CODES: Readonly<Record<number, WeatherCodeInfo>> = Object.freeze({
  0: { label: 'Clear sky', icon: 'Sun', nightIcon: 'Moon' },
  1: { label: 'Mainly clear', icon: 'CloudSun', nightIcon: 'CloudMoon' },
  2: { label: 'Partly cloudy', icon: 'CloudSun', nightIcon: 'CloudMoon' },
  3: { label: 'Overcast', icon: 'Cloud' },
  45: { label: 'Fog', icon: 'CloudFog' },
  48: { label: 'Depositing rime fog', icon: 'CloudFog' },
  51: { label: 'Light drizzle', icon: 'CloudDrizzle' },
  53: { label: 'Drizzle', icon: 'CloudDrizzle' },
  55: { label: 'Dense drizzle', icon: 'CloudDrizzle' },
  56: { label: 'Light freezing drizzle', icon: 'CloudDrizzle' },
  57: { label: 'Dense freezing drizzle', icon: 'CloudDrizzle' },
  61: { label: 'Slight rain', icon: 'CloudRain' },
  63: { label: 'Rain', icon: 'CloudRain' },
  65: { label: 'Heavy rain', icon: 'CloudRainWind' },
  66: { label: 'Light freezing rain', icon: 'CloudHail' },
  67: { label: 'Heavy freezing rain', icon: 'CloudHail' },
  71: { label: 'Slight snowfall', icon: 'CloudSnow' },
  73: { label: 'Snowfall', icon: 'CloudSnow' },
  75: { label: 'Heavy snowfall', icon: 'Snowflake' },
  77: { label: 'Snow grains', icon: 'Snowflake' },
  80: { label: 'Slight rain showers', icon: 'CloudSunRain', nightIcon: 'CloudMoonRain' },
  81: { label: 'Rain showers', icon: 'CloudRain' },
  82: { label: 'Violent rain showers', icon: 'CloudRainWind' },
  85: { label: 'Slight snow showers', icon: 'CloudSnow' },
  86: { label: 'Heavy snow showers', icon: 'Snowflake' },
  95: { label: 'Thunderstorm', icon: 'CloudLightning' },
  96: { label: 'Thunderstorm with slight hail', icon: 'CloudLightning' },
  99: { label: 'Thunderstorm with heavy hail', icon: 'CloudLightning' },
});

const UNKNOWN_WEATHER: WeatherCodeInfo = Object.freeze({ label: 'Unknown', icon: 'Cloud' });

/** Label + icon for a WMO code; unknown codes map to a neutral cloud. */
export function weatherCodeInfo(code: number, isDay = true): { label: string; icon: WeatherIconName } {
  const info = WMO_CODES[code] ?? UNKNOWN_WEATHER;
  return { label: info.label, icon: !isDay && info.nightIcon ? info.nightIcon : info.icon };
}
