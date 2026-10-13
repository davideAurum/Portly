/**
 * Open-Meteo client pieces (§8 Weather): request URLs, cache keys, unit mapping and the pure
 * mappers from Open-Meteo's forecast / geocoding responses to the shared `WeatherReport` /
 * `GeoPlace` contracts (§7a weather.ts). No network here — see `index.ts` for the routes.
 *
 * Mapping rules:
 * - Coordinates are rounded to 2 decimals (~1 km) for both the upstream request and the cache
 *   key, so a cached report always belongs to exactly the coordinates it was fetched for.
 * - Local times stay as Open-Meteo returns them with `timezone=auto` (ISO without offset).
 * - Hourly entries start at the current local hour and are capped at 48; daily at 7.
 * - Rows missing a temperature or weather code are dropped (never invented); optional numbers
 *   fall back to sensible values (apparent → temperature, humidity/wind/precip → 0).
 * - Anything that does not match the documented shape → 502 `provider_error`.
 */
import { z } from 'zod';
import {
  GeoPlaceSchema,
  isValidTimeZone,
  type GeneralSettings,
  type GeoPlace,
  type PrecipUnit,
  type TemperatureUnit,
  type WeatherCurrent,
  type WeatherDay,
  type WeatherHour,
  type WeatherReport,
  type WeatherUnits,
  type WindUnit,
} from '@homebase/shared';
import { HttpError } from '../../lib/errors.ts';

export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

/** Forecast cache lifetime (§8: 10 min). */
export const FORECAST_TTL_MS = 10 * 60 * 1000;
/** Geocoding results change rarely (1 day). */
export const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;

export const HOURLY_HOURS = 48;
export const FORECAST_DAYS = 7;
export const GEOCODE_COUNT = 8;
export const GEOCODE_LANGUAGE = 'en';

export const CURRENT_VARIABLES = [
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'is_day',
  'precipitation',
  'weather_code',
  'wind_speed_10m',
  'wind_direction_10m',
] as const;
export const HOURLY_VARIABLES = ['temperature_2m', 'weather_code', 'precipitation_probability'] as const;
export const DAILY_VARIABLES = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_probability_max',
  'sunrise',
  'sunset',
] as const;

/** Homebase unit → Open-Meteo query value. */
export const OPEN_METEO_UNITS = {
  temperature: { C: 'celsius', F: 'fahrenheit' } satisfies Record<TemperatureUnit, string>,
  wind: { kmh: 'kmh', mph: 'mph', ms: 'ms' } satisfies Record<WindUnit, string>,
  precip: { mm: 'mm', in: 'inch' } satisfies Record<PrecipUnit, string>,
} as const;

/** Units of a report, from `settings.general`. */
export function unitsFromSettings(general: Pick<GeneralSettings, 'temperatureUnit' | 'windUnit' | 'precipUnit'>): WeatherUnits {
  return { temperature: general.temperatureUnit, wind: general.windUnit, precip: general.precipUnit };
}

/** Rounds to 2 decimals (the cache granularity, §8); never returns -0. */
export function roundCoord(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function coordText(value: number): string {
  return roundCoord(value).toFixed(2);
}

export function forecastCacheKey(lat: number, lon: number, units: WeatherUnits): string {
  return `weather:forecast:${coordText(lat)},${coordText(lon)}:${units.temperature}-${units.wind}-${units.precip}`;
}

export function forecastUrl(lat: number, lon: number, units: WeatherUnits): string {
  const params = new URLSearchParams({
    latitude: coordText(lat),
    longitude: coordText(lon),
    current: CURRENT_VARIABLES.join(','),
    hourly: HOURLY_VARIABLES.join(','),
    daily: DAILY_VARIABLES.join(','),
    timezone: 'auto',
    forecast_days: String(FORECAST_DAYS),
    forecast_hours: String(HOURLY_HOURS),
    temperature_unit: OPEN_METEO_UNITS.temperature[units.temperature],
    wind_speed_unit: OPEN_METEO_UNITS.wind[units.wind],
    precipitation_unit: OPEN_METEO_UNITS.precip[units.precip],
  });
  return `${FORECAST_URL}?${params.toString()}`;
}

/** Trimmed, whitespace-collapsed query (what is sent upstream). */
export function normalizeGeocodeQuery(q: string): string {
  return q.trim().replace(/\s+/g, ' ');
}

export function geocodeCacheKey(q: string): string {
  return `weather:geocode:${GEOCODE_LANGUAGE}:${normalizeGeocodeQuery(q).toLowerCase()}`;
}

export function geocodeUrl(q: string): string {
  const params = new URLSearchParams({
    name: normalizeGeocodeQuery(q),
    count: String(GEOCODE_COUNT),
    language: GEOCODE_LANGUAGE,
    format: 'json',
  });
  return `${GEOCODE_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Upstream errors
// ---------------------------------------------------------------------------

/** Maps a non-2xx Open-Meteo status to an API error (provider text is never reflected). */
export function upstreamError(status: number): HttpError {
  if (status === 429) return new HttpError(429, 'rate_limited', 'The weather service is rate limiting requests. Try again in a minute.');
  if (status === 408 || status === 504) return new HttpError(504, 'upstream_timeout', 'The weather service timed out.');
  return new HttpError(502, 'provider_error', `The weather service returned an error (HTTP ${status}).`);
}

function invalidResponse(what: string): HttpError {
  return new HttpError(502, 'provider_error', `The weather service returned an unexpected ${what} response.`);
}

/** Parses a JSON body read as text (so status mapping happens before JSON errors). */
export function parseJsonBody(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse(what);
  }
}

// ---------------------------------------------------------------------------
// Forecast mapping
// ---------------------------------------------------------------------------

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

const num = z.number().finite();
const nullableNum = num.nullable().optional();
const numArray = z.array(num.nullable());
const strArray = z.array(z.string().nullable());

const ForecastResponseSchema = z.object({
  utc_offset_seconds: z.number().int().optional(),
  timezone: z.string().optional(),
  current: z.object({
    time: z.string().regex(LOCAL_TIME),
    temperature_2m: num,
    relative_humidity_2m: nullableNum,
    apparent_temperature: nullableNum,
    is_day: z.union([z.literal(0), z.literal(1), z.boolean()]),
    precipitation: nullableNum,
    weather_code: num,
    wind_speed_10m: nullableNum,
    wind_direction_10m: nullableNum,
  }),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: numArray,
    weather_code: numArray,
    precipitation_probability: numArray.optional(),
  }),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: numArray,
    temperature_2m_max: numArray,
    temperature_2m_min: numArray,
    precipitation_probability_max: numArray.optional(),
    sunrise: strArray.optional(),
    sunset: strArray.optional(),
  }),
});

type ForecastResponse = z.output<typeof ForecastResponseSchema>;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function percent(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function localTimeOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && LOCAL_TIME.test(value) ? value : null;
}

function mapCurrent(c: ForecastResponse['current']): WeatherCurrent {
  const temp = round1(c.temperature_2m);
  return {
    time: c.time,
    temp,
    apparent: c.apparent_temperature === null || c.apparent_temperature === undefined ? temp : round1(c.apparent_temperature),
    humidity: percent(c.relative_humidity_2m) ?? 0,
    windSpeed: round1(Math.max(0, c.wind_speed_10m ?? 0)),
    windDir: Math.round((((c.wind_direction_10m ?? 0) % 360) + 360) % 360),
    code: Math.round(c.weather_code),
    isDay: c.is_day === 1 || c.is_day === true,
    precip: Math.max(0, c.precipitation ?? 0),
  };
}

function mapHourly(h: ForecastResponse['hourly'], currentTime: string): WeatherHour[] {
  // Start at the current local hour (Open-Meteo local times sort lexicographically).
  const currentHour = `${currentTime.slice(0, 13)}:00`;
  const hours: WeatherHour[] = [];
  for (let i = 0; i < h.time.length && hours.length < HOURLY_HOURS; i++) {
    const time = h.time[i];
    const temp = h.temperature_2m[i];
    const code = h.weather_code[i];
    if (time === undefined || !LOCAL_TIME.test(time) || time < currentHour) continue;
    if (temp === null || temp === undefined || code === null || code === undefined) continue;
    hours.push({ time, temp: round1(temp), code: Math.round(code), precipProb: percent(h.precipitation_probability?.[i]) });
  }
  return hours;
}

function mapDaily(d: ForecastResponse['daily']): WeatherDay[] {
  const days: WeatherDay[] = [];
  for (let i = 0; i < d.time.length && days.length < FORECAST_DAYS; i++) {
    const date = d.time[i];
    const min = d.temperature_2m_min[i];
    const max = d.temperature_2m_max[i];
    const code = d.weather_code[i];
    if (date === undefined || !LOCAL_DATE.test(date)) continue;
    if (min === null || min === undefined || max === null || max === undefined || code === null || code === undefined) continue;
    days.push({
      date,
      min: round1(Math.min(min, max)),
      max: round1(Math.max(min, max)),
      code: Math.round(code),
      precipProb: percent(d.precipitation_probability_max?.[i]),
      sunrise: localTimeOrNull(d.sunrise?.[i]),
      sunset: localTimeOrNull(d.sunset?.[i]),
    });
  }
  return days;
}

/** Open-Meteo forecast response → `WeatherReport` (throws 502 `provider_error` on a bad shape). */
export function mapForecast(raw: unknown, units: WeatherUnits): WeatherReport {
  const parsed = ForecastResponseSchema.safeParse(raw);
  if (!parsed.success) throw invalidResponse('forecast');
  const data = parsed.data;
  const report: WeatherReport = {
    units: { ...units },
    current: mapCurrent(data.current),
    hourly: mapHourly(data.hourly, data.current.time),
    daily: mapDaily(data.daily),
  };
  if (data.timezone !== undefined && isValidTimeZone(data.timezone)) report.timezone = data.timezone;
  if (data.utc_offset_seconds !== undefined && Math.abs(data.utc_offset_seconds) <= 18 * 3600) {
    report.utcOffsetSeconds = data.utc_offset_seconds;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Geocoding mapping
// ---------------------------------------------------------------------------

const GeocodeResultSchema = z.object({
  name: z.string(),
  latitude: num,
  longitude: num,
  admin1: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
});

const GeocodeResponseSchema = z.object({
  results: z.array(z.unknown()).optional(),
});

/**
 * Control characters, plus invisible format characters that could disguise a name: zero-width
 * spaces/joiners, LRM/RLM, bidi embeddings/overrides/isolates and the BOM.
 */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

function cleanText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Strip unsafe characters; cap to the contract's 200 chars.
  const text = value.replace(UNSAFE_TEXT, '').trim().slice(0, 200).trim();
  return text === '' ? undefined : text;
}

/** Open-Meteo geocoding response → `GeoPlace[]` (invalid entries dropped; ≤ 8). */
export function mapGeocode(raw: unknown): GeoPlace[] {
  const parsed = GeocodeResponseSchema.safeParse(raw);
  if (!parsed.success) throw invalidResponse('geocoding');
  const places: GeoPlace[] = [];
  const seen = new Set<string>();
  for (const item of parsed.data.results ?? []) {
    const result = GeocodeResultSchema.safeParse(item);
    if (!result.success) continue;
    const r = result.data;
    const candidate: Record<string, unknown> = { name: cleanText(r.name), lat: r.latitude, lon: r.longitude };
    const admin1 = cleanText(r.admin1);
    const country = cleanText(r.country);
    if (admin1 !== undefined) candidate.admin1 = admin1;
    if (country !== undefined) candidate.country = country;
    if (typeof r.timezone === 'string' && isValidTimeZone(r.timezone)) candidate.timezone = r.timezone;
    const place = GeoPlaceSchema.safeParse(candidate);
    if (!place.success) continue;
    const key = `${place.data.name}|${place.data.admin1 ?? ''}|${place.data.country ?? ''}|${place.data.lat}|${place.data.lon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push(place.data);
    if (places.length >= GEOCODE_COUNT) break;
  }
  return places;
}
