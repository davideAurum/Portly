/**
 * Nominatim reverse geocoding for the static backend: a copy of
 * server/src/modules/weather/nominatim.ts (URL, cache key, mapper) with `StaticApiError` in place
 * of the server's `HttpError`, plus the browser transport ({@link fetchPlace}). Nominatim sends
 * `Access-Control-Allow-Origin: *`, so the browser calls it directly; a browser cannot set
 * `User-Agent`, so the usage policy's identification is the page's `Referer`.
 *
 * Mapping rules (unchanged from the server): coordinates rounded to 2 decimals for the request,
 * the cache key and the returned place; the most specific settlement in `address` names it;
 * "Unable to geocode" → `null`; any other unexpected shape → 502 `provider_error`.
 */
import { z } from 'zod';
import { GeoPlaceSchema, type GeoPlace } from '@portly/shared';
import { fetchTextCapped, upstreamFailure } from '../lib/fetch.ts';
import { StaticApiError } from '../respond.ts';
import { errorName, hostOf, recordProviderFailure, statusFailureCode, stopwatch, transportFailureCode } from './diagnostics.ts';
import { WEATHER_MAX_BYTES, WEATHER_TIMEOUT_MS, cleanText, roundCoord, type WeatherFetchOptions } from './openMeteo.ts';

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
export function reverseUpstreamError(status: number): StaticApiError {
  if (status === 429) return new StaticApiError('rate_limited', 'The place-name service is rate limiting requests. Try again in a minute.');
  if (status === 408 || status === 504) return new StaticApiError('upstream_timeout', 'The place-name service timed out.');
  return new StaticApiError('provider_error', `The place-name service returned an error (HTTP ${status}).`);
}

function invalidResponse(): StaticApiError {
  return new StaticApiError('provider_error', 'The place-name service returned an unexpected response.');
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

// ---------------------------------------------------------------------------
// Browser transport (the server's `fetchPlace` in index.ts)
// ---------------------------------------------------------------------------

const SERVICE_LABEL = 'the place-name service';

/**
 * The place at (`lat`, `lon`), or null when nothing is there. Same deadline, size cap and failure
 * events as the Open-Meteo calls (provider `nominatim`; never the URL, which holds the coordinates).
 */
export async function fetchPlace(lat: number, lon: number, options: WeatherFetchOptions = {}): Promise<GeoPlace | null> {
  const url = reverseUrl(lat, lon);
  const elapsed = stopwatch();
  const host = hostOf(url);
  let status: number;
  let text: string;
  try {
    ({ status, text } = await fetchTextCapped(
      url,
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit' },
      { timeoutMs: WEATHER_TIMEOUT_MS, maxBytes: WEATHER_MAX_BYTES, signal: options.signal, fetch: options.fetch },
    ));
  } catch (err) {
    const code = transportFailureCode(err);
    if (code !== null) recordProviderFailure('nominatim', host, { code, errName: errorName(err), ms: elapsed() });
    throw upstreamFailure(err, SERVICE_LABEL);
  }
  if (status < 200 || status >= 300) {
    recordProviderFailure('nominatim', host, { status, code: statusFailureCode(status), ms: elapsed() });
    throw reverseUpstreamError(status);
  }
  try {
    return mapReverse(parseReverseBody(text), lat, lon);
  } catch (err) {
    recordProviderFailure('nominatim', host, { status, code: 'parse_error', ms: elapsed() });
    throw err;
  }
}
