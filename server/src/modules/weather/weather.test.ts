import { afterEach, describe, expect, it } from 'vitest';
import type { GeoPlace, WeatherReport } from '@portly/shared';
import { SafeFetchError } from '../../security/safe-fetch.ts';
import type { FakeFetchRoute } from '../../testing/fake-fetch.ts';
import { berlinForecast, springfieldGeocode, weatherTestbed, type WeatherTestbed } from './__fixtures__/open-meteo.ts';
import {
  FORECAST_TTL_MS,
  forecastCacheKey,
  forecastUrl,
  geocodeCacheKey,
  geocodeUrl,
  mapForecast,
  mapGeocode,
  roundCoord,
  unitsFromSettings,
} from './open-meteo.ts';

const METRIC = { temperature: 'C', wind: 'kmh', precip: 'mm' } as const;
const IMPERIAL = { temperature: 'F', wind: 'mph', precip: 'in' } as const;

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
      expect(() => mapForecast(bad, METRIC)).toThrow(expect.objectContaining({ status: 502, code: 'provider_error' }));
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
  let t: WeatherTestbed;
  afterEach(() => t.close());

  const forecastRoute = (respond: FakeFetchRoute['respond'] = { json: berlinForecast() }): FakeFetchRoute => ({
    match: 'https://api.open-meteo.com/v1/forecast?',
    method: 'GET',
    respond,
  });

  it('returns a WeatherReport in the settings units and caches it for 10 minutes', async () => {
    t = weatherTestbed({ fetchRoutes: [forecastRoute()] });
    const res = await t.json<WeatherReport>('/api/weather?lat=52.5234&lon=13.4115');
    expect(res.status).toBe(200);
    expect(res.res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.units).toEqual(METRIC);
    expect(res.body.current.temp).toBe(6.6);
    expect(res.body.hourly).toHaveLength(47);
    expect(res.body.daily).toHaveLength(7);

    const calls = t.ctx.fakeFetch!.calls;
    expect(calls).toHaveLength(1);
    const p = paramsOf(calls[0]!.url);
    expect([p.get('latitude'), p.get('longitude'), p.get('temperature_unit'), p.get('timezone')]).toEqual(['52.52', '13.41', 'celsius', 'auto']);
    expect(calls[0]!.headers.get('user-agent')).toMatch(/^Portly\//);

    // Same rounded coordinates → served from the cache.
    expect((await t.json('/api/weather?lat=52.5249&lon=13.4149')).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(t.ctx.cache.get(forecastCacheKey(52.52, 13.41, METRIC))).toMatchObject({ units: METRIC });
    expect(FORECAST_TTL_MS).toBe(600_000);
  });

  it('follows settings.general units (a units change is a different cache entry)', async () => {
    t = weatherTestbed({ fetchRoutes: [forecastRoute()] });
    await t.json('/api/weather?lat=52.52&lon=13.41');
    t.ctx.settings.patch({ general: { temperatureUnit: 'F', windUnit: 'mph', precipUnit: 'in' } });
    const res = await t.json<WeatherReport>('/api/weather?lat=52.52&lon=13.41');
    expect(res.body.units).toEqual(IMPERIAL);
    const calls = t.ctx.fakeFetch!.calls;
    expect(calls).toHaveLength(2);
    const p = paramsOf(calls[1]!.url);
    expect([p.get('temperature_unit'), p.get('wind_speed_unit'), p.get('precipitation_unit')]).toEqual(['fahrenheit', 'mph', 'inch']);
  });

  it('ignores a units query parameter (the contract takes units from settings)', async () => {
    t = weatherTestbed({ fetchRoutes: [forecastRoute()] });
    const res = await t.json<WeatherReport>('/api/weather?lat=52.52&lon=13.41&units=F&temperature_unit=fahrenheit');
    expect(res.body.units.temperature).toBe('C');
    expect(paramsOf(t.ctx.fakeFetch!.calls[0]!.url).get('temperature_unit')).toBe('celsius');
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
    t = weatherTestbed();
    const res = await t.json<{ error: { code: string; details: unknown[] } }>(path);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(t.ctx.fakeFetch!.calls).toHaveLength(0);
  });

  it('accepts the extreme valid coordinates', async () => {
    t = weatherTestbed({ fetchRoutes: [forecastRoute()] });
    expect((await t.json('/api/weather?lat=-90&lon=180')).status).toBe(200);
    expect((await t.json('/api/weather?lat=+90.0&lon=-180')).status).toBe(200);
  });

  it.each([
    [500, 502, 'provider_error'],
    [503, 502, 'provider_error'],
    [400, 502, 'provider_error'],
    [429, 429, 'rate_limited'],
    [504, 504, 'upstream_timeout'],
  ])('maps an upstream %i to %i %s and does not cache the failure', async (upstream, status, code) => {
    t = weatherTestbed({
      fetchRoutes: [
        forecastRoute({ status: upstream, text: '<html>busy</html>' }),
      ],
    });
    const res = await t.json<{ error: { code: string; message: string } }>('/api/weather?lat=52.52&lon=13.41');
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.message).not.toContain('busy');
    await t.json('/api/weather?lat=52.52&lon=13.41');
    expect(t.ctx.fakeFetch!.calls).toHaveLength(2);
  });

  it('maps malformed JSON or an unexpected shape to 502 provider_error', async () => {
    t = weatherTestbed({
      fetchRoutes: [
        { match: 'latitude=1.00', respond: { text: '{not json' } },
        { match: 'latitude=2.00', respond: { json: { error: true, reason: 'Nope' } } },
      ],
    });
    for (const path of ['/api/weather?lat=1&lon=1', '/api/weather?lat=2&lon=1']) {
      const res = await t.json<{ error: { code: string } }>(path);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('provider_error');
    }
  });

  it('maps a transport timeout to 504 upstream_timeout', async () => {
    t = weatherTestbed({
      fetch: async () => {
        throw new SafeFetchError('timeout', 'Request to api.open-meteo.com timed out', 'api.open-meteo.com');
      },
    });
    const res = await t.json<{ error: { code: string } }>('/api/weather?lat=52.52&lon=13.41');
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('upstream_timeout');
  });

  it('is gated like every non-exempt API route', async () => {
    t = weatherTestbed();
    expect((await t.json('/api/weather?lat=1&lon=1', { headers: { 'X-Portly': null } })).status).toBe(403);
    expect((await t.json('/api/weather?lat=1&lon=1', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  });
});

describe('GET /api/weather/geocode', () => {
  let t: WeatherTestbed;
  afterEach(() => t.close());

  it('returns GeoPlace[] and caches by the normalized query for a day', async () => {
    t = weatherTestbed({ fetchRoutes: [{ match: 'https://geocoding-api.open-meteo.com/v1/search?', respond: { json: springfieldGeocode() } }] });
    const res = await t.json<GeoPlace[]>('/api/weather/geocode?q=Springfield');
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
    const calls = t.ctx.fakeFetch!.calls;
    expect(paramsOf(calls[0]!.url).get('name')).toBe('Springfield');

    expect((await t.json<GeoPlace[]>('/api/weather/geocode?q=%20%20springfield%20')).body).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(t.ctx.cache.get(geocodeCacheKey('springfield'))).toHaveLength(3);
  });

  it('returns [] for no results', async () => {
    t = weatherTestbed({ fetchRoutes: [{ match: 'geocoding-api.open-meteo.com', respond: { json: { generationtime_ms: 0.5 } } }] });
    const res = await t.json<GeoPlace[]>('/api/weather/geocode?q=zzqxqz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it.each([
    ['missing', '/api/weather/geocode'],
    ['1 char', '/api/weather/geocode?q=a'],
    ['whitespace only', '/api/weather/geocode?q=%20%20%20'],
    ['over 100 chars', `/api/weather/geocode?q=${'a'.repeat(101)}`],
  ])('rejects an invalid query (%s) with 422', async (_name, path) => {
    t = weatherTestbed();
    const res = await t.json<{ error: { code: string } }>(path);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(t.ctx.fakeFetch!.calls).toHaveLength(0);
  });

  it('accepts exactly 2 and 100 characters', async () => {
    t = weatherTestbed({ fetchRoutes: [{ match: 'geocoding-api.open-meteo.com', respond: { json: { results: [] } } }] });
    expect((await t.json('/api/weather/geocode?q=ab')).status).toBe(200);
    expect((await t.json(`/api/weather/geocode?q=${'b'.repeat(100)}`)).status).toBe(200);
  });

  it('maps upstream failures (429 → rate_limited, 500 → provider_error)', async () => {
    t = weatherTestbed({
      fetchRoutes: [
        { match: 'name=busy', respond: { status: 429, text: 'Too many' } },
        { match: 'name=broken', respond: { status: 500, json: { error: true } } },
      ],
    });
    expect((await t.json<{ error: { code: string } }>('/api/weather/geocode?q=busy')).body.error.code).toBe('rate_limited');
    const broken = await t.json<{ error: { code: string } }>('/api/weather/geocode?q=broken');
    expect(broken.status).toBe(502);
    expect(broken.body.error.code).toBe('provider_error');
  });
});

describe('weather: health (diagnostics)', () => {
  let t: WeatherTestbed;
  afterEach(() => t.close());

  const health = () => t.ctx.health.get('weather');

  it('records each Open-Meteo call with its op (on demand: never stale); cache hits are not checks', async () => {
    t = weatherTestbed({
      fetchRoutes: [
        { match: 'https://api.open-meteo.com/v1/forecast?', respond: { json: berlinForecast() } },
        { match: 'https://geocoding-api.open-meteo.com/v1/search?', respond: { json: springfieldGeocode() } },
      ],
    });
    await t.json('/api/weather?lat=52.52&lon=13.41');
    expect(health()).toMatchObject({ key: 'weather', area: 'weather', label: 'Open-Meteo', status: 'ok', expectEveryMs: null, detail: { op: 'forecast' } });
    await t.json('/api/weather/geocode?q=Springfield');
    expect(health()?.detail).toEqual({ op: 'geocode' });
    const checked = health()!.lastCheckedAt;
    await t.json('/api/weather?lat=52.52&lon=13.41');
    expect(health()!.lastCheckedAt).toBe(checked);
    expect(t.ctx.fakeFetch!.calls).toHaveLength(2);
  });

  it.each([
    [{ status: 503, text: 'busy' }, 'http_5xx', 503],
    [{ status: 429, text: 'slow down' }, 'rate_limited', 429],
    [{ status: 504, text: 'gateway' }, 'timeout', 504],
    [{ text: '{not json' }, 'parse_error', 200],
    [{ json: { error: true, reason: 'Nope' } }, 'parse_error', 200],
  ])('records a failed forecast (%o) as %s', async (respond, code, status) => {
    t = weatherTestbed({ fetchRoutes: [{ match: 'https://api.open-meteo.com/v1/forecast?', respond }] });
    await t.json('/api/weather?lat=52.52&lon=13.41');
    expect(health()).toMatchObject({ status: 'failing', lastCode: code, lastStatus: status, detail: { op: 'forecast' } });
  });

  it('records transport failures with their code, and recovery', async () => {
    let fail = true;
    t = weatherTestbed({ fetchRoutes: [{ match: 'https://api.open-meteo.com/v1/forecast?', respond: { json: berlinForecast() } }] });
    const real = t.ctx.fetch;
    t.ctx.fetch = async (url, options) => {
      if (fail) throw new SafeFetchError('timeout', 'Request to api.open-meteo.com timed out', 'api.open-meteo.com');
      return real(url, options);
    };
    await t.json('/api/weather?lat=52.52&lon=13.41');
    expect(health()).toMatchObject({ status: 'failing', lastCode: 'timeout', lastMessage: 'Request to api.open-meteo.com timed out' });
    fail = false;
    await t.json('/api/weather?lat=52.52&lon=13.41');
    expect(health()?.status).toBe('ok');
  });

  it('never records or logs coordinates or place names, and tells safe-fetch the purpose', async () => {
    t = weatherTestbed({
      fetchRoutes: [
        { match: 'https://api.open-meteo.com/v1/forecast?', respond: { status: 500, text: 'x' } },
        { match: 'https://geocoding-api.open-meteo.com/v1/search?', respond: { status: 500, text: 'x' } },
      ],
    });
    const purposes: (string | undefined)[] = [];
    const real = t.ctx.fetch;
    t.ctx.fetch = async (url, options) => {
      purposes.push(options.purpose);
      return real(url, options);
    };
    await t.json('/api/weather?lat=52.5234&lon=13.4115');
    await t.json('/api/weather/geocode?q=Springfield');
    expect(purposes).toEqual(['weather.forecast', 'weather.geocode']);
    const failing = t.ctx.logs.query({ q: 'weather failing' }).records;
    expect(failing[0]).toMatchObject({ level: 'warn', area: 'weather', fields: { key: 'weather', op: 'forecast', code: 'http_5xx' } });
    const everything = JSON.stringify([t.ctx.logs.query({}).records, t.ctx.health.list(), t.ctx.health.history('weather')]);
    for (const secret of ['52.52', '13.41', 'Springfield', 'springfield']) expect(everything).not.toContain(secret);
  });
});
