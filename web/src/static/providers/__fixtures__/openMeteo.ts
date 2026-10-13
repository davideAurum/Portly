/**
 * Open-Meteo fixtures (copied from server/src/modules/weather/__fixtures__/open-meteo.ts, pure
 * builders only) modelled on the documented (and observed) response shapes of
 * `GET https://api.open-meteo.com/v1/forecast?...&timezone=auto&forecast_hours=48&forecast_days=7`
 * and `GET https://geocoding-api.open-meteo.com/v1/search?name=...&count=8&language=en&format=json`.
 * Values are deterministic so mapping tests can assert exact numbers.
 */

/** Local hour strings `YYYY-MM-DDTHH:00` starting at `start` (a local ISO hour). */
function hoursFrom(start: string, count: number): string[] {
  const base = Date.parse(`${start}:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(base + i * 3_600_000).toISOString().slice(0, 13) + ':00');
}

function daysFrom(start: string, count: number): string[] {
  const base = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(base + i * 86_400_000).toISOString().slice(0, 10));
}

/** Berlin, 2026-09-26 07:15 local (UTC+2), °C / km/h / mm. */
export function berlinForecast(): Record<string, unknown> {
  // Open-Meteo returns the current hour first when `forecast_hours` is used; one extra past hour
  // is included here to prove the mapper starts at the current hour regardless.
  const hourly = hoursFrom('2026-09-26T06', 49);
  const days = daysFrom('2026-09-26', 7);
  return {
    latitude: 52.52,
    longitude: 13.419998,
    generationtime_ms: 0.21,
    utc_offset_seconds: 7200,
    timezone: 'Europe/Berlin',
    timezone_abbreviation: 'GMT+2',
    elevation: 38,
    current_units: {
      time: 'iso8601',
      interval: 'seconds',
      temperature_2m: '°C',
      relative_humidity_2m: '%',
      apparent_temperature: '°C',
      is_day: '',
      precipitation: 'mm',
      weather_code: 'wmo code',
      wind_speed_10m: 'km/h',
      wind_direction_10m: '°',
    },
    current: {
      time: '2026-09-26T07:15',
      interval: 900,
      temperature_2m: 6.64,
      relative_humidity_2m: 95,
      apparent_temperature: 4.9,
      is_day: 1,
      precipitation: 0,
      weather_code: 45,
      wind_speed_10m: 4.7,
      wind_direction_10m: 157,
    },
    hourly_units: { time: 'iso8601', temperature_2m: '°C', weather_code: 'wmo code', precipitation_probability: '%' },
    hourly: {
      time: hourly,
      temperature_2m: hourly.map((_, i) => (i === 5 ? null : Math.round((6 + i * 0.3) * 10) / 10)),
      weather_code: hourly.map((_, i) => (i % 6 === 0 ? 45 : i % 6 === 3 ? 61 : 3)),
      precipitation_probability: hourly.map((_, i) => (i === 7 ? null : (i * 7) % 100)),
    },
    daily_units: {
      time: 'iso8601',
      weather_code: 'wmo code',
      temperature_2m_max: '°C',
      temperature_2m_min: '°C',
      precipitation_probability_max: '%',
      sunrise: 'iso8601',
      sunset: 'iso8601',
    },
    daily: {
      time: days,
      weather_code: [45, 3, 3, 61, 2, 0, 95],
      temperature_2m_max: [20.3, 22.5, 22.2, 23.1, 21.4, 21.6, 20.4],
      temperature_2m_min: [6, 12.1, 12.1, 13.2, 11, 10.9, 9.5],
      precipitation_probability_max: [3, 0, 0, 80, 0, 2, null],
      sunrise: days.map((d, i) => (i === 6 ? null : `${d}T06:58`)),
      sunset: days.map((d) => `${d}T18:55`),
    },
  };
}

/** Geocoding results for "Springfield" (trimmed to the fields that matter + a few extras). */
export function springfieldGeocode(): Record<string, unknown> {
  return {
    results: [
      {
        id: 4409896,
        name: 'Springfield',
        latitude: 37.21533,
        longitude: -93.29824,
        elevation: 396,
        feature_code: 'PPLA2',
        country_code: 'US',
        admin1_id: 4398678,
        timezone: 'America/Chicago',
        population: 170188,
        postcodes: ['65801', '65802'],
        country_id: 6252001,
        country: 'United States',
        admin1: 'Missouri',
        admin2: 'Greene',
      },
      {
        id: 4250542,
        name: 'Springfield',
        latitude: 39.80172,
        longitude: -89.64371,
        feature_code: 'PPLA',
        country_code: 'US',
        timezone: 'America/Chicago',
        country: 'United States',
        admin1: 'Illinois',
      },
      // No admin1, unknown time zone → kept without them.
      { id: 1, name: 'Springfield', latitude: -43.3, longitude: 172.1, country: 'New Zealand', timezone: 'Mars/Olympus_Mons' },
      // Invalid entries → dropped.
      { id: 2, name: 'Nowhere', latitude: 123, longitude: 10 },
      { id: 3, name: '', latitude: 10, longitude: 10 },
      { id: 4, latitude: 10, longitude: 10 },
    ],
    generationtime_ms: 0.74,
  };
}
