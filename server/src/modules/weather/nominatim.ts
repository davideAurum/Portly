/**
 * Reverse geocoding via OpenStreetMap Nominatim (§8 Weather): names the place at the device
 * location ("Boise, Idaho, United States") so the weather widget can show it instead of
 * "Current location". Open-Meteo has no reverse geocoding. No network here — see `index.ts`.
 *
 * Mapping rules:
 * - Coordinates are rounded to 2 decimals (~1 km) for the request and the cache key, like the
 *   forecast. The returned place keeps those coordinates (the forecast stays at the device
 *   position; Nominatim's own point for the town is ignored).
 * - The name is the most specific settlement in `address` (city, town, village, ...), then the
 *   county, then Nominatim's `name`. `admin1` is the state/region, `country` the country.
 * - "Unable to geocode" (open sea, nothing nearby) → `null`. Anything else that does not match
 *   the documented shape → 502 `provider_error`.
 * - Usage policy (https://operations.osmfoundation.org/policies/nominatim/): at most 1 request
 *   per second and an identifying User-Agent (safe-fetch sends `Portly/<version>`). A single
 *   user with a week-long cache per ~1 km cell stays far below that.
 */
import { z } from 'zod';
import { GeoPlaceSchema, type GeoPlace } from '@portly/shared';
import { HttpError } from '../../lib/errors.ts';
import { cleanText, roundCoord } from './open-meteo.ts';

export const REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';

/** Place names at a spot change rarely; Nominatim asks clients to cache (7 days). */
export const REVERSE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Nominatim zoom 10 = city level. */
export const REVERSE_ZOOM = 10;
export const REVERSE_LANGUAGE = 'en';

function coordText(value: number): string {
  return roundCoord(value).toFixed(2);
}

export function reverseCacheKey(lat: number, lon: number): string {
  return `weather:reverse:${REVERSE_LANGUAGE}:${coordText(lat)},${coordText(lon)}`;
}

export function reverseUrl(lat: number, lon: number): string {
  const params = new URLSearchParams({
    lat: coordText(lat),
    lon: coordText(lon),
    format: 'jsonv2',
    zoom: String(REVERSE_ZOOM),
    addressdetails: '1',
    'accept-language': REVERSE_LANGUAGE,
  });
  return `${REVERSE_URL}?${params.toString()}`;
}

/** Maps a non-2xx Nominatim status to an API error (provider text is never reflected). */
export function reverseUpstreamError(status: number): HttpError {
  if (status === 429) return new HttpError(429, 'rate_limited', 'The place-name service is rate limiting requests. Try again in a minute.');
  if (status === 408 || status === 504) return new HttpError(504, 'upstream_timeout', 'The place-name service timed out.');
  return new HttpError(502, 'provider_error', `The place-name service returned an error (HTTP ${status}).`);
}

function invalidResponse(): HttpError {
  return new HttpError(502, 'provider_error', 'The place-name service returned an unexpected response.');
}

/** Parses a JSON body read as text (so status mapping happens before JSON errors). */
export function parseReverseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse();
  }
}

const optText = z.string().nullable().optional();

const AddressSchema = z
  .object({
    city: optText,
    town: optText,
    village: optText,
    hamlet: optText,
    municipality: optText,
    suburb: optText,
    county: optText,
    state: optText,
    region: optText,
    country: optText,
  })
  .partial();

const ReverseResponseSchema = z.union([
  z.object({ error: z.string() }),
  z.object({
    name: optText,
    address: AddressSchema.optional(),
  }),
]);

/** The address keys tried for the place name, most specific settlement first. */
export const NAME_KEYS = ['city', 'town', 'village', 'hamlet', 'municipality', 'suburb', 'county'] as const;

/**
 * Nominatim `/reverse?format=jsonv2&addressdetails=1` response → `GeoPlace` at (`lat`, `lon`),
 * or `null` when nothing is there. Throws 502 `provider_error` on a bad shape.
 */
export function mapReverse(raw: unknown, lat: number, lon: number): GeoPlace | null {
  const parsed = ReverseResponseSchema.safeParse(raw);
  if (!parsed.success) throw invalidResponse();
  const data = parsed.data;
  if ('error' in data) return null;
  const address = data.address ?? {};
  let name: string | undefined;
  for (const key of NAME_KEYS) {
    name = cleanText(address[key]);
    if (name !== undefined) break;
  }
  name ??= cleanText(data.name);
  if (name === undefined) return null;
  const candidate: Record<string, unknown> = { name, lat: roundCoord(lat), lon: roundCoord(lon) };
  const admin1 = cleanText(address.state) ?? cleanText(address.region);
  const country = cleanText(address.country);
  if (admin1 !== undefined) candidate.admin1 = admin1;
  if (country !== undefined) candidate.country = country;
  const place = GeoPlaceSchema.safeParse(candidate);
  return place.success ? place.data : null;
}
