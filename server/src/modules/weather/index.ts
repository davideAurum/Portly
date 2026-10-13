/**
 * Weather via Open-Meteo (§7 Weather, §8). No key, no account: `policy: 'provider'` fetches.
 * Both routes are declared `paired()` (the paired Pages site may use them too).
 *
 * - `GET /api/weather?lat=&lon=` → `WeatherReport`. Units come from `settings.general`
 *   (`temperatureUnit`, `windUnit`, `precipUnit`); the contract has no units override (widgets
 *   that pin °C/°F convert client-side from `report.units`). Cached 10 min in the SQLite cache,
 *   keyed by lat/lon rounded to 2 decimals + units.
 * - `GET /api/weather/geocode?q=` (2–100 chars) → `GeoPlace[]` (≤ 8), cached 1 day.
 *
 * Validation failures → 422 `validation_failed`; Open-Meteo 429 → `rate_limited`; other
 * non-2xx / malformed bodies → 502 `provider_error`; timeouts → 504 `upstream_timeout`.
 *
 * Diagnostics (§17): every Open-Meteo call (a cache miss) records health key `weather` (on
 * demand, never stale) with detail `{op: forecast|geocode}` — never coordinates or place names —
 * and runs in `withLogContext({area: 'weather', op})`; outbound purpose `weather.<op>`. Failures
 * carry an HTTP code with Open-Meteo's status, `parse_error` for an unreadable answer, or a
 * transport code.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { Latitude, Longitude, type GeoPlace, type WeatherReport, type WeatherUnits } from '@homebase/shared';
import type { AppContext, AppEnv } from '../../context.ts';
import type { HttpError } from '../../lib/errors.ts';
import { outcomeFromError, type HealthSubject, type Outcome } from '../../lib/health.ts';
import { withLogContext } from '../../lib/log-context.ts';
import { paired } from '../../lib/routes.ts';
import { parseQuery } from '../../lib/validate.ts';
import { SIZE_CAPS } from '../../security/safe-fetch.ts';
import {
  FORECAST_TTL_MS,
  GEOCODE_TTL_MS,
  forecastCacheKey,
  forecastUrl,
  geocodeCacheKey,
  geocodeUrl,
  mapForecast,
  mapGeocode,
  parseJsonBody,
  roundCoord,
  unitsFromSettings,
  upstreamError,
} from './open-meteo.ts';

export const prefixes = ['/api/weather'] as const;

/** Upstream timeout for Open-Meteo calls (a widget should not hang for long). */
export const WEATHER_TIMEOUT_MS = 8000;

/**
 * A plain decimal coordinate (no empty strings, exponents, hex or `Infinity`, which
 * `z.coerce.number()` would accept).
 */
function coordinate(range: z.ZodNumber) {
  return z
    .string({ error: 'Required' })
    .trim()
    .max(24)
    .regex(/^[-+]?\d{1,3}(?:\.\d{1,12})?$/, { message: 'Must be a decimal number' })
    .transform(Number)
    .pipe(range);
}

export const WeatherRouteQuerySchema = z.object({
  lat: coordinate(Latitude),
  lon: coordinate(Longitude),
});

export const GeocodeRouteQuerySchema = z.object({
  q: z
    .string({ error: 'Required' })
    .trim()
    .min(2, { message: 'Enter at least 2 characters' })
    .max(100, { message: 'Use at most 100 characters' }),
});

/** Open-Meteo, as one subject (key `weather`): checked on demand, so never stale. */
export const WEATHER_HEALTH: HealthSubject = { key: 'weather', area: 'weather', label: 'Open-Meteo', expectEveryMs: null };

export type WeatherOp = 'forecast' | 'geocode';

/** How far one call got: Open-Meteo's status, and whether its 2xx answer was being read. */
interface Attempt {
  status: number | null;
  reading: boolean;
}

/**
 * The API error for an Open-Meteo status, carrying that status as `httpStatus` (logged as
 * `upstreamStatus`; `outcomeFromError` maps it to `http_4xx`/`http_5xx`/`not_found`).
 */
function statusError(status: number): HttpError & { httpStatus: number } {
  return Object.assign(upstreamError(status), { httpStatus: status });
}

/** One Open-Meteo call, logged under `op`, its outcome recorded on `weather`. */
function tracked<T>(ctx: AppContext, op: WeatherOp, fn: (attempt: Attempt) => Promise<T>): Promise<T> {
  return withLogContext({ area: 'weather', op }, async () => {
    const attempt: Attempt = { status: null, reading: false };
    const started = Date.now();
    try {
      const value = await fn(attempt);
      ctx.health.record(WEATHER_HEALTH, { ok: true, ms: Date.now() - started, detail: { op } });
      return value;
    } catch (err) {
      const extra: Partial<Outcome> = { ms: Date.now() - started, detail: { op } };
      if (attempt.reading) {
        extra.code = 'parse_error';
        if (attempt.status !== null) extra.status = attempt.status;
      }
      ctx.health.record(WEATHER_HEALTH, outcomeFromError(err, extra));
      throw err;
    }
  });
}

async function fetchText(ctx: AppContext, url: string, op: WeatherOp, attempt: Attempt): Promise<string> {
  const res = await ctx.fetch(url, {
    policy: 'provider',
    as: 'text',
    maxBytes: SIZE_CAPS.json,
    timeoutMs: WEATHER_TIMEOUT_MS,
    headers: { Accept: 'application/json' },
    purpose: `weather.${op}`,
  });
  attempt.status = res.status;
  if (res.status < 200 || res.status >= 300) throw statusError(res.status);
  attempt.reading = true;
  return res.data;
}

export async function fetchForecast(ctx: AppContext, lat: number, lon: number, units: WeatherUnits): Promise<WeatherReport> {
  return tracked(ctx, 'forecast', async (attempt) => {
    const text = await fetchText(ctx, forecastUrl(lat, lon, units), 'forecast', attempt);
    return mapForecast(parseJsonBody(text, 'forecast'), units);
  });
}

export async function fetchGeocode(ctx: AppContext, q: string): Promise<GeoPlace[]> {
  return tracked(ctx, 'geocode', async (attempt) => {
    const text = await fetchText(ctx, geocodeUrl(q), 'geocode', attempt);
    return mapGeocode(parseJsonBody(text, 'geocoding'));
  });
}

export function register(app: Hono<AppEnv>, ctx: AppContext): void {
  app.get('/api/weather', paired(), async (c) => {
    const query = parseQuery(c, WeatherRouteQuerySchema);
    const lat = roundCoord(query.lat);
    const lon = roundCoord(query.lon);
    const units = unitsFromSettings(ctx.settings.get('general'));
    const report = await ctx.cache.getOrSet(forecastCacheKey(lat, lon, units), FORECAST_TTL_MS, () =>
      fetchForecast(ctx, lat, lon, units),
    );
    return c.json(report);
  });

  app.get('/api/weather/geocode', paired(), async (c) => {
    const { q } = parseQuery(c, GeocodeRouteQuerySchema);
    const places = await ctx.cache.getOrSet(geocodeCacheKey(q), GEOCODE_TTL_MS, () => fetchGeocode(ctx, q));
    return c.json(places);
  });
}
