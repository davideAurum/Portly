/**
 * Static backend: weather (`GET /api/weather`, `GET /api/weather/geocode`) over Open-Meteo called
 * from the browser. Port of server/src/modules/weather/weather.test.ts: URL building, cache keys,
 * mapping, route validation and upstream error mapping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeoPlace, WeatherReport } from '@portly/shared';
import { boiseReverse, unableToGeocode } from '../providers/__fixtures__/nominatim.ts';
import { berlinForecast, springfieldGeocode } from '../providers/__fixtures__/openMeteo.ts';
import { mapReverse, reverseCacheKey } from '../providers/nominatim.ts';
import { createFakeFetch, failingFetch, hangingFetch, type FakeFetchRoute, type FakeResponseSpec } from '../providers/__fixtures__/fakeFetch.ts';
import {
  FORECAST_TTL_MS,
  GEOCODE_TTL_MS,
  WEATHER_TIMEOUT_MS,
  forecastCacheKey,
  forecastUrl,
  geocodeCacheKey,
  geocodeUrl,
  mapForecast,
  mapGeocode,
  roundCoord,
  unitsFromSettings,
} from '../providers/openMeteo.ts';
import { getSettings } from '../slices.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import * as weather from './weather.ts';

const METRIC = { temperature: 'C', wind: 'kmh', precip: 'mm' } as const;
const IMPERIAL = { temperature: 'F', wind: 'mph', precip: 'in' } as const;

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('open-meteo: request parameters and cache keys', () => {
  it('builds the forecast URL with current/hourly/daily variables, timezone=auto and 48 h / 7 days', () => {
    const url = forecastUrl(52.5234, 13.4115, METRIC);
    expect(url.startsWith('https://api.open-meteo.com/v1/forecast?')).toBe(true);
    const p = paramsOf(url);
    expect(p.get('latitude')).toBe('52.52');
    expect(p.get('longitude')).toBe('13.41');
    expect(p.get('current')?.split(',')).toEqual([
      'temperature_2m',
      'relative_humidity_2m',
      'apparent_temperature',
      'is_day',
      'precipitation',
      'weather_code',
      'wind_speed_10m',
      'wind_direction_10m',
    ]);
    expect(p.get('hourly')).toBe('temperature_2m,weather_code,precipitation_probability');
    expect(p.get('daily')).toBe('weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset');
    expect(p.get('timezone')).toBe('auto');
    expect(p.get('forecast_days')).toBe('7');
    expect(p.get('forecast_hours')).toBe('48');
    expect(p.get('temperature_unit')).toBe('celsius');
    expect(p.get('wind_speed_unit')).toBe('kmh');
    expect(p.get('precipitation_unit')).toBe('mm');
  });

  it('maps every Portly unit to its Open-Meteo parameter', () => {
    const p = paramsOf(forecastUrl(1, 2, IMPERIAL));
    expect(p.get('temperature_unit')).toBe('fahrenheit');
    expect(p.get('wind_speed_unit')).toBe('mph');
    expect(p.get('precipitation_unit')).toBe('inch');
    expect(paramsOf(forecastUrl(1, 2, { temperature: 'C', wind: 'ms', precip: 'mm' })).get('wind_speed_unit')).toBe('ms');
  });

  it('reads units from settings.general', () => {
    expect(unitsFromSettings({ temperatureUnit: 'F', windUnit: 'ms', precipUnit: 'in' })).toEqual({ temperature: 'F', wind: 'ms', precip: 'in' });
  });

  it('keys the cache by coordinates rounded to 2 decimals plus units', () => {
    expect(forecastCacheKey(52.5234, 13.4115, METRIC)).toBe('weather:forecast:52.52,13.41:C-kmh-mm');
    expect(forecastCacheKey(52.5249, 13.4149, METRIC)).toBe(forecastCacheKey(52.5234, 13.4115, METRIC));
    expect(forecastCacheKey(52.526, 13.41, METRIC)).not.toBe(forecastCacheKey(52.5234, 13.41, METRIC));
    expect(forecastCacheKey(52.52, 13.41, IMPERIAL)).toBe('weather:forecast:52.52,13.41:F-mph-in');
    expect(forecastCacheKey(-0.001, -0.004, METRIC)).toBe('weather:forecast:0.00,0.00:C-kmh-mm');
    expect(roundCoord(-0.001)).toBe(0);
    expect(Object.is(roundCoord(-0.001), -0)).toBe(false);
    expect(roundCoord(-33.8688)).toBe(-33.87);
  });

  it('builds the geocoding URL and a normalized, case-insensitive cache key', () => {
    const p = paramsOf(geocodeUrl('  New   York '));
    expect(new URL(geocodeUrl('x')).origin + new URL(geocodeUrl('x')).pathname).toBe('https://geocoding-api.open-meteo.com/v1/search');
    expect(p.get('name')).toBe('New York');
    expect(p.get('count')).toBe('8');
    expect(p.get('language')).toBe('en');
    expect(p.get('format')).toBe('json');
    expect(geocodeCacheKey('  New   York ')).toBe('weather:geocode:en:new york');
    expect(geocodeCacheKey('NEW YORK')).toBe(geocodeCacheKey('new york'));
  });
});

describe('open-meteo: forecast mapping', () => {
  it('maps current conditions, 48 h hourly from the current hour and 7 days', () => {
    const report = mapForecast(berlinForecast(), METRIC);
    expect(report.units).toEqual(METRIC);
    expect(report.timezone).toBe('Europe/Berlin');
    expect(report.utcOffsetSeconds).toBe(7200);
    expect(report.place).toBeUndefined();
    expect(report.current).toEqual({
      time: '2026-09-26T07:15',
      temp: 6.6,
      apparent: 4.9,
      humidity: 95,
      windSpeed: 4.7,
      windDir: 157,
      code: 45,
      isDay: true,
      precip: 0,
    });

    // The past 06:00 entry is skipped; 11:00 has no temperature and is dropped.
    expect(report.hourly[0]).toEqual({ time: '2026-09-26T07:00', temp: 6.3, code: 3, precipProb: 7 });
    expect(report.hourly.some((h) => h.time === '2026-09-26T06:00' || h.time === '2026-09-26T11:00')).toBe(false);
    expect(report.hourly).toHaveLength(47);
    expect(report.hourly.at(-1)?.time).toBe('2026-09-28T06:00');
    expect(report.hourly.find((h) => h.time === '2026-09-26T13:00')?.precipProb).toBeNull();

    expect(report.daily).toHaveLength(7);
    expect(report.daily[0]).toEqual({
      date: '2026-09-26',
      min: 6,
      max: 20.3,
      code: 45,
      precipProb: 3,
      sunrise: '2026-09-26T06:58',
      sunset: '2026-09-26T18:55',
    });
    expect(report.daily[6]).toMatchObject({ date: '2026-10-02', code: 95, precipProb: null, sunrise: null, sunset: '2026-10-02T18:55' });
  });

  it('caps hourly entries at 48 and falls back for optional current values', () => {
    const raw = berlinForecast() as { current: Record<string, unknown>; hourly: Record<string, unknown[]> };
    raw.current.apparent_temperature = null;
    raw.current.relative_humidity_2m = null;
    raw.current.wind_speed_10m = null;
    raw.current.wind_direction_10m = -90;
    raw.current.is_day = 0;
    const times = Array.from({ length: 60 }, (_, i) => `2026-09-${String(26 + Math.floor((7 + i) / 24)).padStart(2, '0')}T${String((7 + i) % 24).padStart(2, '0')}:00`);
    raw.hourly = {
      time: times,
      temperature_2m: times.map(() => 10),
      weather_code: times.map(() => 0),
      // precipitation_probability missing entirely → null
    };
    const report = mapForecast(raw, METRIC);
    expect(report.current).toMatchObject({ apparent: 6.6, humidity: 0, windSpeed: 0, windDir: 270, isDay: false });
    expect(report.hourly).toHaveLength(48);
    expect(report.hourly.every((h) => h.precipProb === null)).toBe(true);
  });

  it('drops an unknown time zone and swaps an inverted min/max', () => {
    const raw = berlinForecast() as { timezone: string; daily: Record<string, unknown[]> };
    raw.timezone = 'Not/AZone';
    raw.daily.temperature_2m_min = [25, 12.1, 12.1, 13.2, 11, 10.9, 9.5];
    const report = mapForecast(raw, METRIC);
    expect(report.timezone).toBeUndefined();
    expect(report.daily[0]).toMatchObject({ min: 20.3, max: 25 });
  });

  it('rejects responses that do not match the documented shape', () => {
    for (const bad of [null, {}, { error: true, reason: 'x' }, { ...berlinForecast(), current: { time: 'yesterday' } }]) {
      expect(() => mapForecast(bad, METRIC)).toThrow(expect.objectContaining({ code: 'provider_error' }));
    }
  });
});

describe('open-meteo: geocoding mapping', () => {
  it('maps results to GeoPlace with admin1, country and time zone; drops invalid entries', () => {
    expect(mapGeocode(springfieldGeocode())).toEqual<GeoPlace[]>([
      { name: 'Springfield', admin1: 'Missouri', country: 'United States', lat: 37.21533, lon: -93.29824, timezone: 'America/Chicago' },
      { name: 'Springfield', admin1: 'Illinois', country: 'United States', lat: 39.80172, lon: -89.64371, timezone: 'America/Chicago' },
      { name: 'Springfield', country: 'New Zealand', lat: -43.3, lon: 172.1 },
    ]);
  });

  it('returns [] when Open-Meteo has no results (the `results` key is absent)', () => {
    expect(mapGeocode({ generationtime_ms: 0.7 })).toEqual([]);
  });

  it('strips control characters, caps long names and limits to 8 places', () => {
    const results = Array.from({ length: 12 }, (_, i) => ({ name: `Place\u0007 ${i}${'x'.repeat(i === 0 ? 300 : 0)}`, latitude: i, longitude: i }));
    const places = mapGeocode({ results });
    expect(places).toHaveLength(8);
    expect(places[0]!.name).toHaveLength(200);
    expect(places[1]!.name).toBe('Place 1');
  });

  it('strips bidi overrides and invisible format characters that could disguise a place name', () => {
    const places = mapGeocode({
      results: [
        { name: 'Spring‮dleif‬', admin1: '⁦Illinois⁩', country: 'United​ States﻿', latitude: 1, longitude: 2 },
        { name: '‮​', latitude: 3, longitude: 4 },
      ],
    });
    expect(places).toEqual([{ name: 'Springdleif', admin1: 'Illinois', country: 'United States', lat: 1, lon: 2 }]);
  });

  it('rejects a non-object body', () => {
    expect(() => mapGeocode('nope')).toThrow(expect.objectContaining({ code: 'provider_error' }));
  });
});

describe('GET /api/weather', () => {
  let t: TestBackend;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    t?.close();
  });

  const forecastRoute = (respond: FakeResponseSpec = { json: berlinForecast() }): FakeFetchRoute => ({
    match: 'https://api.open-meteo.com/v1/forecast?',
    method: 'GET',
    respond,
  });

  const setup = async (routes: FakeFetchRoute[]) => {
    const fake = createFakeFetch(routes);
    vi.stubGlobal('fetch', fake.fetch);
    t = await createTestBackend([weather]);
    return fake;
  };

  it('returns a WeatherReport in the settings units and caches it for 10 minutes', async () => {
    const fake = await setup([forecastRoute()]);
    const res = await t.call('GET', '/api/weather?lat=52.5234&lon=13.4115');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as WeatherReport;
    expect(body.units).toEqual(METRIC);
    expect(body.current.temp).toBe(6.6);
    expect(body.hourly).toHaveLength(47);
    expect(body.daily).toHaveLength(7);

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    const p = paramsOf(call.url);
    expect([p.get('latitude'), p.get('longitude'), p.get('temperature_unit'), p.get('timezone')]).toEqual(['52.52', '13.41', 'celsius', 'auto']);
    expect(call.headers.get('accept')).toBe('application/json');
    expect(call.headers.has('user-agent')).toBe(false);
    expect(call.init.credentials).toBe('omit');

    // Same rounded coordinates → served from the cache.
    expect((await t.json('GET', '/api/weather?lat=52.5249&lon=13.4149')).status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(weather.weatherCache(t.ctx).get(forecastCacheKey(52.52, 13.41, METRIC))).toMatchObject({ units: METRIC });
    expect(FORECAST_TTL_MS).toBe(600_000);
    t.tick(FORECAST_TTL_MS + 1);
    await t.json('GET', '/api/weather?lat=52.52&lon=13.41');
    expect(fake.calls).toHaveLength(2);
  });

  it('follows settings.general units (a units change is a different cache entry)', async () => {
    const fake = await setup([forecastRoute()]);
    await t.json('GET', '/api/weather?lat=52.52&lon=13.41');
    const general = getSettings(t.ctx).general;
    general.temperatureUnit = 'F';
    general.windUnit = 'mph';
    general.precipUnit = 'in';
    const res = await t.json<WeatherReport>('GET', '/api/weather?lat=52.52&lon=13.41');
    expect(res.body.units).toEqual(IMPERIAL);
    expect(fake.calls).toHaveLength(2);
    const p = paramsOf(fake.calls[1]!.url);
    expect([p.get('temperature_unit'), p.get('wind_speed_unit'), p.get('precipitation_unit')]).toEqual(['fahrenheit', 'mph', 'inch']);
  });

  it('ignores a units query parameter (the contract takes units from settings)', async () => {
    const fake = await setup([forecastRoute()]);
    const res = await t.json<WeatherReport>('GET', '/api/weather?lat=52.52&lon=13.41&units=F&temperature_unit=fahrenheit');
    expect(res.body.units.temperature).toBe('C');
    expect(paramsOf(fake.calls[0]!.url).get('temperature_unit')).toBe('celsius');
  });

  it.each([
    ['missing lat', '/api/weather?lon=13.4'],
    ['missing lon', '/api/weather?lat=52.5'],
    ['empty lat', '/api/weather?lat=&lon=13.4'],
    ['lat out of range', '/api/weather?lat=90.5&lon=13.4'],
    ['lon out of range', '/api/weather?lat=52.5&lon=-180.01'],
    ['exponent', '/api/weather?lat=1e1&lon=13.4'],
    ['hex', '/api/weather?lat=0x10&lon=13.4'],
    ['Infinity', '/api/weather?lat=Infinity&lon=13.4'],
    ['text', '/api/weather?lat=north&lon=13.4'],
  ])('rejects invalid coordinates (%s) with 422 and no upstream call', async (_name, path) => {
    const fake = await setup([forecastRoute()]);
    const res = await t.json<ErrorBody>('GET', path);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.message).toBe('Invalid query');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it('accepts the extreme valid coordinates', async () => {
    await setup([forecastRoute()]);
    expect((await t.json('GET', '/api/weather?lat=-90&lon=180')).status).toBe(200);
    expect((await t.json('GET', '/api/weather?lat=+90.0&lon=-180')).status).toBe(200);
  });

  it.each([
    [500, 502, 'provider_error', 'The weather service returned an error (HTTP 500).'],
    [503, 502, 'provider_error', 'The weather service returned an error (HTTP 503).'],
    [400, 502, 'provider_error', 'The weather service returned an error (HTTP 400).'],
    [429, 429, 'rate_limited', 'The weather service is rate limiting requests. Try again in a minute.'],
    [408, 504, 'upstream_timeout', 'The weather service timed out.'],
    [504, 504, 'upstream_timeout', 'The weather service timed out.'],
  ])('maps an upstream %i to %i %s and does not cache the failure', async (upstream, status, code, message) => {
    const fake = await setup([forecastRoute({ status: upstream, text: '<html>busy</html>' })]);
    const res = await t.json<ErrorBody>('GET', '/api/weather?lat=52.52&lon=13.41');
    expect(res.status).toBe(status);
    expect(res.body.error).toEqual({ code, message });
    await t.json('GET', '/api/weather?lat=52.52&lon=13.41');
    expect(fake.calls).toHaveLength(2);
  });

  it('maps malformed JSON or an unexpected shape to 502 provider_error', async () => {
    await setup([
      { match: 'latitude=1.00', respond: { text: '{not json' } },
      { match: 'latitude=2.00', respond: { json: { error: true, reason: 'Nope' } } },
    ]);
    for (const path of ['/api/weather?lat=1&lon=1', '/api/weather?lat=2&lon=1']) {
      const res = await t.json<ErrorBody>('GET', path);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('provider_error');
      expect(res.body.error.message).toBe('The weather service returned an unexpected forecast response.');
    }
  });

  it('maps a transport timeout (8 s) to 504 upstream_timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch);
    t = await createTestBackend([weather]);
    const pending = t.json<ErrorBody>('GET', '/api/weather?lat=52.52&lon=13.41');
    await vi.advanceTimersByTimeAsync(WEATHER_TIMEOUT_MS + 1);
    const res = await pending;
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('upstream_timeout');
  });

  it('maps a network/CORS failure to 502 provider_error (never a thrown TypeError)', async () => {
    vi.stubGlobal('fetch', failingFetch);
    t = await createTestBackend([weather]);
    const res = await t.json<ErrorBody>('GET', '/api/weather?lat=52.52&lon=13.41');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('provider_error');
  });

  it('shares one upstream call between concurrent requests for the same place', async () => {
    const fake = await setup([forecastRoute()]);
    const [a, b] = await Promise.all([t.json<WeatherReport>('GET', '/api/weather?lat=52.52&lon=13.41'), t.json<WeatherReport>('GET', '/api/weather?lat=52.52&lon=13.41')]);
    expect(a.body.current).toEqual(b.body.current);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('GET /api/weather/geocode', () => {
  let t: TestBackend;
  afterEach(() => {
    vi.unstubAllGlobals();
    t?.close();
  });

  const setup = async (routes: FakeFetchRoute[]) => {
    const fake = createFakeFetch(routes);
    vi.stubGlobal('fetch', fake.fetch);
    t = await createTestBackend([weather]);
    return fake;
  };

  it('returns GeoPlace[] and caches by the normalized query for a day', async () => {
    const fake = await setup([{ match: 'https://geocoding-api.open-meteo.com/v1/search?', respond: { json: springfieldGeocode() } }]);
    const res = await t.json<GeoPlace[]>('GET', '/api/weather/geocode?q=Springfield');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0]).toEqual({
      name: 'Springfield',
      admin1: 'Missouri',
      country: 'United States',
      lat: 37.21533,
      lon: -93.29824,
      timezone: 'America/Chicago',
    });
    expect(paramsOf(fake.calls[0]!.url).get('name')).toBe('Springfield');

    expect((await t.json<GeoPlace[]>('GET', '/api/weather/geocode?q=%20%20springfield%20')).body).toHaveLength(3);
    expect(fake.calls).toHaveLength(1);
    expect(weather.weatherCache(t.ctx).get(geocodeCacheKey('springfield'))).toHaveLength(3);
    t.tick(GEOCODE_TTL_MS + 1);
    await t.json('GET', '/api/weather/geocode?q=Springfield');
    expect(fake.calls).toHaveLength(2);
  });

  it('returns [] for no results', async () => {
    await setup([{ match: 'geocoding-api.open-meteo.com', respond: { json: { generationtime_ms: 0.5 } } }]);
    const res = await t.json<GeoPlace[]>('GET', '/api/weather/geocode?q=zzqxqz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it.each([
    ['missing', '/api/weather/geocode'],
    ['1 char', '/api/weather/geocode?q=a'],
    ['whitespace only', '/api/weather/geocode?q=%20%20%20'],
    ['over 100 chars', `/api/weather/geocode?q=${'a'.repeat(101)}`],
  ])('rejects an invalid query (%s) with 422', async (_name, path) => {
    const fake = await setup([{ match: 'geocoding-api.open-meteo.com', respond: { json: { results: [] } } }]);
    const res = await t.json<ErrorBody>('GET', path);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(fake.calls).toHaveLength(0);
  });

  it('accepts exactly 2 and 100 characters', async () => {
    await setup([{ match: 'geocoding-api.open-meteo.com', respond: { json: { results: [] } } }]);
    expect((await t.json('GET', '/api/weather/geocode?q=ab')).status).toBe(200);
    expect((await t.json('GET', `/api/weather/geocode?q=${'b'.repeat(100)}`)).status).toBe(200);
  });

  it('maps upstream failures (429 → rate_limited, 500 → provider_error, bad body → provider_error)', async () => {
    await setup([
      { match: 'name=busy', respond: { status: 429, text: 'Too many' } },
      { match: 'name=broken', respond: { status: 500, json: { error: true } } },
      { match: 'name=odd', respond: { text: '[]' } },
    ]);
    expect((await t.json<ErrorBody>('GET', '/api/weather/geocode?q=busy')).body.error.code).toBe('rate_limited');
    const broken = await t.json<ErrorBody>('GET', '/api/weather/geocode?q=broken');
    expect(broken.status).toBe(502);
    expect(broken.body.error.code).toBe('provider_error');
    const odd = await t.json<ErrorBody>('GET', '/api/weather/geocode?q=odd');
    expect(odd.status).toBe(502);
    expect(odd.body.error.message).toBe('The weather service returned an unexpected geocoding response.');
  });
});

describe('weather: one caller cancelling a shared upstream call (server parity)', () => {
  let t: TestBackend;
  afterEach(() => {
    vi.unstubAllGlobals();
    t?.close();
  });

  const ROUTES = [
    { name: 'forecast', path: '/api/weather?lat=52.52&lon=13.41', match: 'https://api.open-meteo.com/v1/forecast?', body: () => berlinForecast() },
    { name: 'geocode', path: '/api/weather/geocode?q=Springfield', match: 'https://geocoding-api.open-meteo.com/v1/search?', body: () => springfieldGeocode() },
  ];

  /** An upstream that answers only when released and, like fetch, honours its signal meanwhile. */
  const gatedSetup = async (route: (typeof ROUTES)[number]) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = createFakeFetch([
      {
        match: route.match,
        respond: (req) =>
          new Promise((resolve, reject) => {
            const signal = req.init.signal;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            void gate.then(() => resolve({ json: route.body() }));
          }),
      },
    ]);
    vi.stubGlobal('fetch', fake.fetch);
    t = await createTestBackend([weather]);
    return { fake, release };
  };

  it.each(ROUTES)('$name: aborting one request never fails the others sharing the upstream call', async (route) => {
    const { fake, release } = await gatedSetup(route);
    const first = new AbortController();
    const second = new AbortController();
    const abandoned = t.fetch(route.path, { method: 'GET', signal: first.signal });
    const waiting = t.fetch(route.path, { method: 'GET', signal: second.signal });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    first.abort();
    release();
    const res = await waiting;
    expect(res.status).toBe(200);
    expect(await res.json()).toBeTruthy();
    // The upstream call ran without either caller's signal, like the server's: it finished and was
    // cached, and the abandoned request was answered too (its caller just no longer listens).
    expect((await abandoned).status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(weather.weatherCache(t.ctx).size).toBe(1);
  });

  it.each(ROUTES)('$name: a request issued right after an aborted one for the same key gets the answer', async (route) => {
    const { fake, release } = await gatedSetup(route);
    const cancelled = new AbortController();
    const abandoned = t.fetch(route.path, { method: 'GET', signal: cancelled.signal });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    // Like TanStack's cancelRefetch: abort the in-flight request, then immediately ask again.
    cancelled.abort();
    const retry = t.fetch(route.path, { method: 'GET', signal: new AbortController().signal });
    release();
    expect((await retry).status).toBe(200);
    expect((await abandoned).status).toBe(200);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('GET /api/weather/place (Nominatim)', () => {
  let t: TestBackend;
  afterEach(() => {
    vi.unstubAllGlobals();
    t?.close();
  });

  const setup = async (routes: FakeFetchRoute[]) => {
    const fake = createFakeFetch(routes);
    vi.stubGlobal('fetch', fake.fetch);
    t = await createTestBackend([weather]);
    return fake;
  };

  it('names the place at rounded coordinates and caches it, also a null answer', async () => {
    const fake = await setup([
      { match: 'https://nominatim.openstreetmap.org/reverse?lat=43.61', respond: { json: boiseReverse() } },
      { match: 'https://nominatim.openstreetmap.org/reverse?lat=0.00', respond: { json: unableToGeocode() } },
    ]);
    const res = await t.json<GeoPlace | null>('GET', '/api/weather/place?lat=43.6106&lon=-116.2025');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'Boise', admin1: 'Idaho', country: 'United States', lat: 43.61, lon: -116.2 });
    const p = paramsOf(fake.calls[0]!.url);
    expect([p.get('lat'), p.get('lon'), p.get('format'), p.get('zoom')]).toEqual(['43.61', '-116.20', 'jsonv2', '10']);
    expect((await t.json('GET', '/api/weather/place?lat=43.6149&lon=-116.1951')).status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(weather.weatherCache(t.ctx).get(reverseCacheKey(43.61, -116.2))).toMatchObject({ name: 'Boise' });

    expect((await t.json<GeoPlace | null>('GET', '/api/weather/place?lat=0&lon=0')).body).toBeNull();
    expect((await t.json<GeoPlace | null>('GET', '/api/weather/place?lat=0&lon=0')).body).toBeNull();
    expect(fake.calls).toHaveLength(2);
  });

  it('validates coordinates and maps upstream failures', async () => {
    await setup([{ match: 'nominatim.openstreetmap.org', respond: { status: 503, text: 'busy' } }]);
    expect((await t.json('GET', '/api/weather/place?lat=91&lon=0')).status).toBe(422);
    const res = await t.json<ErrorBody>('GET', '/api/weather/place?lat=1&lon=2');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('provider_error');
    expect(res.body.error.message).toBe('The place-name service returned an error (HTTP 503).');
  });

  it('maps the response like the server', () => {
    expect(mapReverse(boiseReverse(), 43.61064, -116.20249)).toEqual({ name: 'Boise', admin1: 'Idaho', country: 'United States', lat: 43.61, lon: -116.2 });
    expect(mapReverse({ address: { village: 'Smallton', region: 'North' } }, 1, 2)).toEqual({ name: 'Smallton', admin1: 'North', lat: 1, lon: 2 });
    expect(mapReverse(unableToGeocode(), 0, 0)).toBeNull();
    expect(() => mapReverse({ address: 'x' }, 0, 0)).toThrow(expect.objectContaining({ code: 'provider_error' }));
  });
});
