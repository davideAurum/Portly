/**
 * Weather module of the static backend (port of server/src/modules/weather/index.ts) — Open-Meteo,
 * called directly from the browser (no key, CORS `*`).
 *
 * - `GET /api/weather?lat=&lon=` → `WeatherReport`. Units come from `settings.general`
 *   (`temperatureUnit`, `windUnit`, `precipUnit`); the contract has no units override (widgets
 *   that pin °C/°F convert client-side from `report.units`). Cached 10 min in memory, keyed by
 *   lat/lon rounded to 2 decimals + units.
 * - `GET /api/weather/geocode?q=` (2–100 chars) → `GeoPlace[]` (≤ 8), cached 1 day.
 * - `GET /api/weather/place?lat=&lon=` → `GeoPlace | null` (Nominatim reverse geocoding, the
 *   device location's name), cached 7 days by rounded lat/lon.
 *
 * Validation failures → 422 `validation_failed`; Open-Meteo 429 → `rate_limited`; other
 * non-2xx / malformed bodies → 502 `provider_error`; timeouts → 504 `upstream_timeout`. Failures
 * are never cached.
 *
 * The upstream calls run inside the cache's single flight, shared by every concurrent request for
 * the same key, so they never take one request's AbortSignal (as on the server): a caller that
 * gives up stops waiting while the shared call finishes under its own deadline and fills the cache.
 */
import type { StaticContext } from '../context.ts';
import { createMemoryCache, type MemoryCache } from '../lib/cache.ts';
import { parseQuery } from '../lib/validate.ts';
import {
  FORECAST_TTL_MS,
  GEOCODE_TTL_MS,
  GeocodeRouteQuerySchema,
  WeatherRouteQuerySchema,
  fetchForecast,
  fetchGeocode,
  forecastCacheKey,
  geocodeCacheKey,
  roundCoord,
  unitsFromSettings,
} from '../providers/openMeteo.ts';
import { REVERSE_TTL_MS, fetchPlace, reverseCacheKey } from '../providers/nominatim.ts';
import { json } from '../respond.ts';
import type { StaticRouter } from '../router.ts';
import { getSettings } from '../slices.ts';

const caches = new WeakMap<StaticContext, MemoryCache>();

/** The backend's forecast/geocode cache (one per context; exposed for tests). */
export function weatherCache(ctx: StaticContext): MemoryCache {
  let cache = caches.get(ctx);
  if (!cache) {
    cache = createMemoryCache({ now: ctx.now });
    caches.set(ctx, cache);
  }
  return cache;
}

export function register(router: StaticRouter): void {
  router.get('/api/weather', async (ctx, { url }) => {
    const query = parseQuery(url, WeatherRouteQuerySchema);
    const lat = roundCoord(query.lat);
    const lon = roundCoord(query.lon);
    const units = unitsFromSettings(getSettings(ctx).general);
    const report = await weatherCache(ctx).getOrSet(forecastCacheKey(lat, lon, units), FORECAST_TTL_MS, () =>
      fetchForecast(lat, lon, units),
    );
    return json(report);
  });

  router.get('/api/weather/geocode', async (ctx, { url }) => {
    const { q } = parseQuery(url, GeocodeRouteQuerySchema);
    const places = await weatherCache(ctx).getOrSet(geocodeCacheKey(q), GEOCODE_TTL_MS, () => fetchGeocode(q));
    return json(places);
  });

  router.get('/api/weather/place', async (ctx, { url }) => {
    const query = parseQuery(url, WeatherRouteQuerySchema);
    const lat = roundCoord(query.lat);
    const lon = roundCoord(query.lon);
    const place = await weatherCache(ctx).getOrSet(reverseCacheKey(lat, lon), REVERSE_TTL_MS, () => fetchPlace(lat, lon));
    return json(place);
  });
}
