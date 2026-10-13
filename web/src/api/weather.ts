/**
 * Weather API (§7 Weather): `GET /api/weather?lat=&lon=` → WeatherReport (units from settings)
 * and `GET /api/weather/geocode?q=` → GeoPlace[]. Coordinates are rounded to 2 decimals exactly
 * like the query key (qk.weather) and the server cache, so a cached report always matches.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { GeoPlace, SettingsPatch, WeatherReport } from '@portly/shared';
import { useUpdateSettings } from './settings.ts';
import { apiGet } from './client.ts';
import { qk } from './keys.ts';

/** Default staleTime for weather (§10.7). */
export const WEATHER_STALE_MS = 10 * 60 * 1000;
/** Background refresh so a long-open tab keeps current conditions fresh. */
export const WEATHER_REFETCH_MS = 15 * 60 * 1000;
export const GEOCODE_MIN_CHARS = 2;
export const GEOCODE_MAX_CHARS = 100;

/** Rounds like the server cache and `qk.weather` (2 decimals); never -0. */
export function roundCoord(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

export function weatherPath(lat: number, lon: number): string {
  const params = new URLSearchParams({ lat: roundCoord(lat).toFixed(2), lon: roundCoord(lon).toFixed(2) });
  return `/api/weather?${params.toString()}`;
}

export function fetchWeather(lat: number, lon: number, signal?: AbortSignal): Promise<WeatherReport> {
  return apiGet<WeatherReport>(weatherPath(lat, lon), { signal });
}

export function normalizeGeocodeQuery(q: string): string {
  return q.trim().replace(/\s+/g, ' ');
}

export function fetchGeocode(q: string, signal?: AbortSignal): Promise<GeoPlace[]> {
  const params = new URLSearchParams({ q: normalizeGeocodeQuery(q) });
  return apiGet<GeoPlace[]>(`/api/weather/geocode?${params.toString()}`, { signal });
}

/** Forecast for a location (disabled while `coords` is null). */
export function useWeather(coords: { lat: number; lon: number } | null) {
  const lat = coords ? roundCoord(coords.lat) : 0;
  const lon = coords ? roundCoord(coords.lon) : 0;
  return useQuery({
    queryKey: qk.weather(lat, lon),
    queryFn: ({ signal }) => fetchWeather(lat, lon, signal),
    enabled: coords !== null,
    staleTime: WEATHER_STALE_MS,
    refetchInterval: WEATHER_REFETCH_MS,
    refetchOnWindowFocus: true,
  });
}

/** Place search; runs only for 2–100 characters. Keeps the previous results while typing. */
export function useGeocode(q: string) {
  const query = normalizeGeocodeQuery(q);
  const enabled = query.length >= GEOCODE_MIN_CHARS && query.length <= GEOCODE_MAX_CHARS;
  return useQuery({
    queryKey: qk.geocode(query.toLowerCase()),
    queryFn: ({ signal }) => fetchGeocode(query, signal),
    enabled,
    staleTime: 24 * 60 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}

/**
 * Merge patch that replaces `settings.weather.defaultLocation` as a whole: RFC 7396 merges
 * objects, so optional keys the new place lacks are sent as `null` (removed) rather than being
 * left over from the previous default.
 */
export function defaultLocationPatch(place: GeoPlace | null): SettingsPatch {
  if (place === null) return { weather: { defaultLocation: null } };
  const defaultLocation = {
    name: place.name,
    lat: place.lat,
    lon: place.lon,
    admin1: place.admin1 ?? null,
    country: place.country ?? null,
    timezone: place.timezone ?? null,
  };
  // MergePatch<Settings> types nullable objects as whole values; the nested nulls are valid RFC
  // 7396 deletions (the server and the optimistic cache update both apply them as such).
  return { weather: { defaultLocation } } as unknown as SettingsPatch;
}

/** `PATCH /api/settings {weather: {defaultLocation}}` (optimistic, toast on failure). */
export function useSetDefaultLocation() {
  const update = useUpdateSettings();
  return {
    ...update,
    setDefaultLocation: (place: GeoPlace | null) => update.mutateAsync(defaultLocationPatch(place)),
  };
}
