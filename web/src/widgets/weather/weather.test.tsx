import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeoPlace, Settings, WeatherReport } from '@portly/shared';
import { defaultLocationPatch, roundCoord, weatherPath } from '../../api/weather.ts';
import { qk } from '../../api/keys.ts';
import { WidgetFrameContext, type WidgetFrameContextValue } from '../../grid/WidgetContext.tsx';
import { Dialog } from '../../ui/Dialog.tsx';
import { settings as makeSettings } from '../../test/fixtures.ts';
import { createTestQueryClient, mockError, renderWithProviders, type ApiMock } from '../../test/render.tsx';
import { weatherConfigSchema, type WeatherConfig } from './index.ts';
import { isWideCompact, weatherTier } from './layout.ts';
import {
  DEVICE_PLACE_NAME,
  allowLocationPrompt,
  needsDeviceLocation,
  resetDeviceLocationMemory,
  resolveLocation,
  type DeviceLocationState,
} from './location.ts';
import WeatherSettings from './Settings.tsx';
import { clockLabel, dayLabel, hourLabel, isDaylight, placeNow, upcomingDays, upcomingHours } from './time.ts';
import { compassPoint, convertPrecip, convertTemp, convertWind, displayTempUnit, formatTemp, formatWind } from './units.ts';
import WeatherWidget from './Widget.tsx';

// 07:15 in Berlin (UTC+2) on Saturday 26 September 2026.
const NOW = new Date('2026-09-26T05:15:00Z');

const BERLIN: GeoPlace = { name: 'Berlin', admin1: 'Land Berlin', country: 'Germany', lat: 52.52437, lon: 13.41053, timezone: 'Europe/Berlin' };
const PARIS: GeoPlace = { name: 'Paris', admin1: 'Île-de-France', country: 'France', lat: 48.85341, lon: 2.3488, timezone: 'Europe/Paris' };

function localHours(start: string, count: number): string[] {
  const base = Date.parse(`${start}:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(base + i * 3_600_000).toISOString().slice(0, 16));
}

function report(overrides: Partial<WeatherReport> = {}): WeatherReport {
  const hours = localHours('2026-09-26T07:00', 48);
  const days = ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];
  return {
    units: { temperature: 'C', wind: 'kmh', precip: 'mm' },
    timezone: 'Europe/Berlin',
    utcOffsetSeconds: 7200,
    current: { time: '2026-09-26T07:15', temp: 6.6, apparent: 4.9, humidity: 95, windSpeed: 12.4, windDir: 315, code: 2, isDay: true, precip: 0 },
    hourly: hours.map((time, i) => ({ time, temp: 7 + i * 0.5, code: i % 5 === 0 ? 61 : 3, precipProb: i % 5 === 0 ? 60 : 5 })),
    daily: days.map((date, i) => ({
      date,
      min: 6 + i,
      max: 20 + i,
      code: i === 3 ? 95 : 1,
      precipProb: i === 3 ? 80 : 0,
      sunrise: `${date}T06:58`,
      sunset: `${date}T18:55`,
    })),
    ...overrides,
  };
}

function settingsWith(patch: { defaultLocation?: GeoPlace | null; general?: Partial<Settings['general']> } = {}): Settings {
  const base = makeSettings();
  return {
    ...base,
    general: { ...base.general, locale: 'en-US', timeFormat: '24h', ...patch.general },
    weather: { defaultLocation: patch.defaultLocation ?? null },
  };
}

interface RenderOptions {
  config?: Partial<WeatherConfig>;
  size?: { w: number; h: number };
  settings?: Settings;
  mocks?: Record<string, ApiMock>;
  frame?: Partial<WidgetFrameContextValue>;
  queryClient?: ReturnType<typeof createTestQueryClient>;
}

function renderWeather({ config = {}, size = { w: 4, h: 5 }, settings = settingsWith(), mocks = {}, frame = {}, queryClient }: RenderOptions = {}) {
  const setConfig = vi.fn(async (_patch: Partial<WeatherConfig>) => {});
  const openSettings = vi.fn();
  const context: WidgetFrameContextValue = {
    instanceId: 'w-weather',
    title: 'Weather',
    openSettings,
    canOpenSettings: true,
    actionsTarget: null,
    ...frame,
  };
  const result = renderWithProviders(
    <WidgetFrameContext.Provider value={context}>
      <WeatherWidget instanceId="w-weather" config={weatherConfigSchema.parse(config)} setConfig={setConfig} size={size} editMode={false} />
    </WidgetFrameContext.Provider>,
    {
      apiMocks: { 'GET /api/settings': settings, 'GET /api/weather': report(), ...mocks },
      ...(queryClient ? { queryClient } : {}),
    },
  );
  return { ...result, setConfig, openSettings, user: userEvent.setup() };
}

function mockGeolocation(impl: (success: PositionCallback, error: PositionErrorCallback) => void) {
  const getCurrentPosition = vi.fn(impl);
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
  return getCurrentPosition;
}

/** The browser's lasting geolocation decision (`navigator.permissions.query`), absent by default (jsdom). */
function mockPermission(state: PermissionState) {
  const query = vi.fn(async () => ({ state }) as PermissionStatus);
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query } });
  return query;
}

function geoError(code: 1 | 2 | 3): GeolocationPositionError {
  return { code, message: 'x', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  resetDeviceLocationMemory();
});

afterEach(() => {
  delete (navigator as { geolocation?: unknown }).geolocation;
  delete (navigator as { permissions?: unknown }).permissions;
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('weather location resolution order', () => {
  const idle: DeviceLocationState = { status: 'idle' };
  const ready: DeviceLocationState = { status: 'ready', lat: 1.23, lon: 4.56, at: 0 };

  it('prefers the widget location, then the default, then the device', () => {
    expect(resolveLocation({ configLocation: PARIS, defaultLocation: BERLIN, useDeviceLocation: true, device: ready })).toEqual({
      status: 'ready',
      place: PARIS,
      source: 'widget',
    });
    expect(resolveLocation({ configLocation: null, defaultLocation: BERLIN, useDeviceLocation: true, device: ready })).toEqual({
      status: 'ready',
      place: BERLIN,
      source: 'default',
    });
    expect(resolveLocation({ configLocation: null, defaultLocation: null, useDeviceLocation: true, device: ready })).toEqual({
      status: 'ready',
      place: { name: DEVICE_PLACE_NAME, lat: 1.23, lon: 4.56 },
      source: 'device',
    });
  });

  it('is not configured without any location, and waits for settings before deciding', () => {
    expect(resolveLocation({ configLocation: null, defaultLocation: null, useDeviceLocation: false, device: idle }).status).toBe('not-configured');
    expect(resolveLocation({ configLocation: null, defaultLocation: undefined, useDeviceLocation: true, device: ready }).status).toBe('loading');
    // A widget location never waits for settings.
    expect(resolveLocation({ configLocation: PARIS, defaultLocation: undefined, useDeviceLocation: false, device: idle }).status).toBe('ready');
  });

  it('maps device states and only asks for the device location when it would be used', () => {
    const base = { configLocation: null, defaultLocation: null, useDeviceLocation: true };
    expect(resolveLocation({ ...base, device: { status: 'pending' } }).status).toBe('locating');
    expect(resolveLocation({ ...base, device: { status: 'denied' } }).status).toBe('device-denied');
    expect(resolveLocation({ ...base, device: { status: 'unavailable' } }).status).toBe('device-unavailable');
    expect(resolveLocation({ ...base, device: { status: 'error', message: 'Timeout' } })).toEqual({ status: 'device-error', message: 'Timeout' });

    expect(needsDeviceLocation(base)).toBe(true);
    expect(needsDeviceLocation({ ...base, useDeviceLocation: false })).toBe(false);
    expect(needsDeviceLocation({ ...base, defaultLocation: BERLIN })).toBe(false);
    expect(needsDeviceLocation({ ...base, defaultLocation: undefined })).toBe(false);
    expect(needsDeviceLocation({ ...base, configLocation: PARIS })).toBe(false);
  });
});

describe('weather units and time helpers', () => {
  it('converts temperature, wind and precipitation', () => {
    expect(convertTemp(0, 'C', 'F')).toBe(32);
    expect(convertTemp(212, 'F', 'C')).toBe(100);
    expect(convertTemp(21, 'C', 'C')).toBe(21);
    expect(convertWind(36, 'kmh', 'ms')).toBeCloseTo(10);
    expect(convertWind(10, 'mph', 'kmh')).toBeCloseTo(16.09, 2);
    expect(convertPrecip(25.4, 'mm', 'in')).toBeCloseTo(1);
    expect(convertPrecip(0.5, 'in', 'mm')).toBeCloseTo(12.7);
  });

  it('picks the displayed temperature unit: widget override, else settings, else the report', () => {
    expect(displayTempUnit('F', 'C', 'C')).toBe('F');
    expect(displayTempUnit('inherit', 'F', 'C')).toBe('F');
    expect(displayTempUnit('inherit', undefined, 'C')).toBe('C');
  });

  it('formats numbers without "-0" and with wind units', () => {
    expect(formatTemp(-0.4, 'en-US')).toBe('0°');
    expect(formatTemp(21.6, 'en-US')).toBe('22°');
    expect(formatWind(12.4, 'kmh', 'en-US')).toBe('12 km/h');
    expect(formatWind(3.44, 'ms', 'en-US')).toBe('3.4 m/s');
    expect(compassPoint(315)).toBe('NW');
    expect(compassPoint(-10)).toBe('N');
  });

  it('computes "now" in the place zone and drops past hours and days', () => {
    const r = report();
    const nowLocal = placeNow(NOW, r);
    expect(nowLocal).toBe('2026-09-26T07:15');
    expect(placeNow(NOW, { current: r.current, utcOffsetSeconds: -18000 })).toBe('2026-09-26T00:15');
    expect(placeNow(NOW, { current: r.current })).toBe('2026-09-26T07:15');

    const later = placeNow(new Date('2026-09-26T09:40:00Z'), r); // 11:40 in Berlin
    expect(upcomingHours(r.hourly, later, 24)[0]!.time).toBe('2026-09-26T11:00');
    expect(upcomingHours(r.hourly, later, 24)).toHaveLength(24);
    expect(upcomingDays(r.daily, '2026-09-28T01:00')[0]!.date).toBe('2026-09-28');
  });

  it('handles a DST change inside the forecast (Open-Meteo labels every time with one fixed offset)', () => {
    // New Zealand DST starts 2026-09-27 02:00 NZST (UTC+12) → 03:00 NZDT (UTC+13); Open-Meteo keeps
    // labelling the whole report in the offset of the request time (utc_offset_seconds 43200).
    const auckland = { timezone: 'Pacific/Auckland', utcOffsetSeconds: 43_200 };
    expect(hourLabel('2026-09-27T01:00', 'en-US', 'h23', auckland)).toBe('01:00');
    expect(hourLabel('2026-09-27T02:00', 'en-US', 'h23', auckland)).toBe('03:00');
    expect(hourLabel('2026-09-27T05:00', 'en-US', 'h12', auckland)).toBe('6 AM');
    expect(clockLabel('2026-09-28T06:02', 'en-US', 'h23', auckland)).toBe('07:02');
    // Without both a zone and an offset, labels are the report's wall-clock times.
    expect(hourLabel('2026-09-27T02:00', 'en-US', 'h23', { timezone: 'Pacific/Auckland' })).toBe('02:00');
    expect(hourLabel('2026-09-27T02:00', 'en-US', 'h23')).toBe('02:00');

    // "Now" is compared with the labels, so it uses the same fixed offset (not the zone's new one):
    // 14:05 UTC on the 27th is 03:05 NZDT, i.e. the hour labelled 02:00 in the report.
    const r = { ...auckland, current: report().current };
    const nowLocal = placeNow(new Date('2026-09-27T14:05:00Z'), r);
    expect(nowLocal).toBe('2026-09-28T02:05');
    const hours = localHours('2026-09-28T00:00', 6).map((time) => ({ time, temp: 10, code: 0, precipProb: null }));
    expect(upcomingHours(hours, nowLocal, 3).map((h) => h.time)).toEqual(['2026-09-28T02:00', '2026-09-28T03:00', '2026-09-28T04:00']);
  });

  it('derives day/night for an hour from that day’s sunrise and sunset', () => {
    const { daily } = report();
    expect(isDaylight('2026-09-26T12:00', daily)).toBe(true);
    expect(isDaylight('2026-09-26T05:00', daily)).toBe(false);
    expect(isDaylight('2026-09-26T19:00', daily)).toBe(false);
    expect(isDaylight('2030-01-01T02:00', daily)).toBe(true);
  });

  it('labels hours and days in the place’s wall-clock time', () => {
    expect(hourLabel('2026-09-26T14:00', 'en-US', 'h23')).toBe('14:00');
    expect(hourLabel('2026-09-26T14:00', 'en-US', 'h12')).toBe('2 PM');
    expect(dayLabel('2026-09-26', '2026-09-26T07:15', 'en-US')).toBe('Today');
    expect(dayLabel('2026-09-27', '2026-09-26T07:15', 'en-US')).toBe('Sun');
    expect(dayLabel('2026-09-27', '2026-09-26T07:15', 'de-DE')).toMatch(/^So/);
  });

  it('chooses the layout tier from the grid size', () => {
    expect(weatherTier({ w: 2, h: 3 })).toBe('compact');
    expect(weatherTier({ w: 4, h: 5 })).toBe('medium');
    expect(weatherTier({ w: 4, h: 7 })).toBe('large');
  });

  it('builds rounded request paths and a merge patch that replaces the default location', () => {
    expect(roundCoord(-0.001)).toBe(0);
    expect(weatherPath(52.52437, 13.41053)).toBe('/api/weather?lat=52.52&lon=13.41');
    expect(defaultLocationPatch({ name: 'Somewhere', lat: 1, lon: 2 })).toEqual({
      weather: { defaultLocation: { name: 'Somewhere', lat: 1, lon: 2, admin1: null, country: null, timezone: null } },
    });
    expect(defaultLocationPatch(null)).toEqual({ weather: { defaultLocation: null } });
  });

  it('keeps the config when a stored location is unreadable', () => {
    const parsed = weatherConfigSchema.parse({ location: { name: 'X', lat: 999, lon: 0 }, units: 'F', show: { hourly: false } });
    expect(parsed).toEqual({ location: null, useDeviceLocation: false, show: { hourly: false, daily: true }, units: 'F' });
  });
});

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

describe('weather widget', () => {
  it('shows the not-configured state with "Set location" (opens widget settings) and "Use my location"', async () => {
    const { user, openSettings, setConfig, requestsTo } = renderWeather();
    expect(await screen.findByText('Set a location')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set location' }));
    expect(openSettings).toHaveBeenCalledTimes(1);
    // Straight to the city search (UX-10).
    expect(openSettings).toHaveBeenCalledWith({ focus: 'location' });
    await user.click(screen.getByRole('button', { name: 'Use my location' }));
    expect(setConfig).toHaveBeenCalledWith({ useDeviceLocation: true });
    expect(requestsTo('GET /api/weather')).toHaveLength(0);
  });

  it('at its 2×3 minimum the location states are one compact row with a single action (UX-4)', async () => {
    const { container } = renderWeather({ size: { w: 2, h: 3 } });
    expect(await screen.findByText('Set a location')).toBeInTheDocument();
    expect(container.querySelector('[data-compact="true"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Set location' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use my location' })).toBeNull();
  });

  it('a wide card keeps the full state with both actions', async () => {
    const { container } = renderWeather({ size: { w: 4, h: 5 } });
    expect(await screen.findByText('Set a location')).toBeInTheDocument();
    expect(container.querySelector('[data-compact="true"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Use my location' })).toBeInTheDocument();
  });

  it('uses the default location from settings and renders current conditions', async () => {
    const { requestsTo } = renderWeather({ settings: settingsWith({ defaultLocation: BERLIN }) });
    const view = await screen.findByTestId('weather-view');
    expect(requestsTo('GET /api/weather')[0]!.search).toBe('?lat=52.52&lon=13.41');
    expect(within(view).getByText('Berlin')).toBeInTheDocument();
    // The region/country line is shown from the large size on; medium keeps it in the tooltip.
    expect(within(view).queryByText('Land Berlin, Germany')).toBeNull();
    expect(within(view).getByText('Berlin').closest('p')).toHaveAttribute('title', 'Berlin, Land Berlin, Germany');
    const current = within(view).getByRole('region', { name: 'Current weather in Berlin' });
    expect(within(current).getByText('7°')).toBeInTheDocument();
    expect(within(current).getByText('C')).toBeInTheDocument();
    expect(within(view).getByText('Partly cloudy')).toBeInTheDocument();
    expect(within(view).getByText('Feels like 5°')).toBeInTheDocument();
    expect(within(view).getByText('12 km/h')).toBeInTheDocument();
    expect(within(view).getByText('NW')).toBeInTheDocument();
    expect(within(view).getByText('95%')).toBeInTheDocument();
  });

  it('prefers the widget location over the default', async () => {
    const { requestsTo } = renderWeather({ config: { location: PARIS }, settings: settingsWith({ defaultLocation: BERLIN }) });
    await screen.findByTestId('weather-view');
    expect(requestsTo('GET /api/weather').map((r) => r.search)).toEqual(['?lat=48.85&lon=2.35']);
    expect(screen.getByText('Paris')).toBeInTheDocument();
  });

  it('falls back to the device location when enabled', async () => {
    const geo = mockGeolocation((success) => success({ coords: { latitude: 40.71277, longitude: -74.00597 } } as GeolocationPosition));
    const { requestsTo } = renderWeather({ config: { useDeviceLocation: true } });
    await screen.findByTestId('weather-view');
    expect(geo).toHaveBeenCalledTimes(1);
    expect(requestsTo('GET /api/weather')[0]!.search).toBe('?lat=40.71&lon=-74.01');
    expect(screen.getByText(DEVICE_PLACE_NAME)).toBeInTheDocument();
  });

  it('names the device location once the place lookup answers', async () => {
    mockGeolocation((success) => success({ coords: { latitude: 43.61064, longitude: -116.20249 } } as GeolocationPosition));
    const { requestsTo } = renderWeather({
      config: { useDeviceLocation: true },
      size: { w: 6, h: 6 },
      mocks: { 'GET /api/weather/place': { name: 'Boise', admin1: 'Idaho', country: 'United States', lat: 43.61, lon: -116.2 } },
    });
    await screen.findByText('Boise');
    expect(screen.queryByText(DEVICE_PLACE_NAME)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /OpenStreetMap/ })).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
    expect(requestsTo('GET /api/weather/place')[0]!.search).toBe('?lat=43.61&lon=-116.20');
    // The forecast stays at the device position, not the town's own point.
    expect(requestsTo('GET /api/weather')[0]!.search).toBe('?lat=43.61&lon=-116.20');
  });

  it('keeps "Current location" when nothing is found there', async () => {
    mockGeolocation((success) => success({ coords: { latitude: 0, longitude: 0 } } as GeolocationPosition));
    const { requestsTo } = renderWeather({ config: { useDeviceLocation: true }, mocks: { 'GET /api/weather/place': null } });
    await screen.findByTestId('weather-view');
    await vi.waitFor(() => expect(requestsTo('GET /api/weather/place')).toHaveLength(1));
    expect(screen.getByText(DEVICE_PLACE_NAME)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /OpenStreetMap/ })).not.toBeInTheDocument();
  });

  it('never looks up a name for a chosen place', async () => {
    const { requestsTo } = renderWeather({ config: { location: PARIS } });
    await screen.findByTestId('weather-view');
    expect(requestsTo('GET /api/weather/place')).toEqual([]);
  });

  it('never asks for the device location when a default exists', async () => {
    const geo = mockGeolocation(() => {});
    renderWeather({ config: { useDeviceLocation: true }, settings: settingsWith({ defaultLocation: BERLIN }) });
    await screen.findByTestId('weather-view');
    expect(geo).not.toHaveBeenCalled();
  });

  it('handles a denied device location gracefully', async () => {
    mockGeolocation((_success, error) => error(geoError(1)));
    const { user, openSettings } = renderWeather({ config: { useDeviceLocation: true } });
    expect(await screen.findByText('Location access is blocked')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set location' }));
    expect(openSettings).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('reports an unavailable geolocation API', async () => {
    renderWeather({ config: { useDeviceLocation: true } });
    expect(await screen.findByText('Device location is unavailable')).toBeInTheDocument();
  });

  describe('when the browser would ask (no lasting "Allow")', () => {
    const NYC = (success: PositionCallback) => success({ coords: { latitude: 40.71277, longitude: -74.00597 } } as GeolocationPosition);

    it('does not make a page load ask: it offers "Use my location", which asks', async () => {
      mockPermission('prompt');
      const geo = mockGeolocation(NYC);
      const { user } = renderWeather({ config: { useDeviceLocation: true } });
      expect(await screen.findByText('Show weather for your location')).toBeInTheDocument();
      expect(geo).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Use my location' }));
      await screen.findByTestId('weather-view');
      expect(geo).toHaveBeenCalledTimes(1);
    });

    it('shows a remembered position without asking again', async () => {
      mockPermission('prompt');
      window.localStorage.setItem('portly:weather:device-location', JSON.stringify({ lat: 52.52, lon: 13.4, at: NOW.getTime() - 60_000 }));
      const geo = mockGeolocation(NYC);
      const { requestsTo } = renderWeather({ config: { useDeviceLocation: true } });
      await screen.findByTestId('weather-view');
      expect(geo).not.toHaveBeenCalled();
      expect(requestsTo('GET /api/weather')[0]!.search).toBe('?lat=52.52&lon=13.40');
    });

    it('asks right away when the user has just turned the device location on', async () => {
      mockPermission('prompt');
      const geo = mockGeolocation(NYC);
      allowLocationPrompt();
      renderWeather({ config: { useDeviceLocation: true } });
      await screen.findByTestId('weather-view');
      expect(geo).toHaveBeenCalledTimes(1);
    });

    it('refreshes on a page load when the browser allows it for good, and never asks when it is blocked', async () => {
      mockPermission('granted');
      const geo = mockGeolocation(NYC);
      const first = renderWeather({ config: { useDeviceLocation: true } });
      await screen.findByTestId('weather-view');
      expect(geo).toHaveBeenCalledTimes(1);
      first.unmount();

      resetDeviceLocationMemory();
      mockPermission('denied');
      const blocked = mockGeolocation(NYC);
      renderWeather({ config: { useDeviceLocation: true } });
      expect(await screen.findByText('Location access is blocked')).toBeInTheDocument();
      expect(blocked).not.toHaveBeenCalled();
    });
  });

  it('compact size shows only icon, temperature and place', async () => {
    renderWeather({ size: { w: 2, h: 3 }, config: { location: BERLIN } });
    const view = await screen.findByTestId('weather-view');
    expect(view).toHaveAttribute('data-tier', 'compact');
    expect(within(view).getByText('7°')).toBeInTheDocument();
    // The place is in the aside and, for narrow cards, in place of the condition (CSS picks one).
    expect(within(view).getAllByText('Berlin')).toHaveLength(2);
    expect(within(view).queryByText('Feels like 5°')).toBeNull();
    expect(within(view).queryByRole('region', { name: 'Hourly forecast' })).toBeNull();
    expect(within(view).queryByRole('list', { name: '7-day forecast' })).toBeNull();
    expect(within(view).queryByRole('list', { name: 'Conditions' })).toBeNull();
  });

  it('a short but wide card (8×3) adds a short hourly strip beside the current conditions (UX-9)', async () => {
    expect(isWideCompact({ w: 8, h: 3 })).toBe(true);
    expect(isWideCompact({ w: 4, h: 3 })).toBe(false);
    expect(isWideCompact({ w: 8, h: 5 })).toBe(false);
    renderWeather({ size: { w: 8, h: 3 }, config: { location: BERLIN } });
    const view = await screen.findByTestId('weather-view');
    expect(view).toHaveAttribute('data-tier', 'compact');
    expect(view).toHaveAttribute('data-wide', 'true');
    expect(within(view).getByRole('region', { name: 'Hourly forecast' })).toBeInTheDocument();
    expect(within(view).queryByRole('list', { name: 'Conditions' })).toBeNull();
  });

  it('keeps sunrise and sunset together in one item (they wrap as a pair)', async () => {
    renderWeather({ size: { w: 4, h: 8 }, config: { location: BERLIN } });
    const conditions = within(await screen.findByTestId('weather-view')).getByRole('list', { name: 'Conditions' });
    const sun = within(conditions).getByText('06:58').closest('li')!;
    expect(sun).toHaveTextContent(/Sunrise.*Sunset/);
  });

  it('medium size adds details and the hourly strip (starting with "Now")', async () => {
    renderWeather({ size: { w: 4, h: 5 }, config: { location: BERLIN } });
    const view = await screen.findByTestId('weather-view');
    expect(view).toHaveAttribute('data-tier', 'medium');
    const strip = within(view).getByRole('region', { name: 'Hourly forecast' });
    const items = within(strip).getAllByRole('listitem');
    expect(items).toHaveLength(24);
    expect(items[0]).toHaveTextContent('Now');
    expect(items[1]).toHaveTextContent('08:00');
    expect(within(view).queryByRole('list', { name: '7-day forecast' })).toBeNull();
  });

  it('large size adds the 7-day list with min/max bars', async () => {
    renderWeather({ size: { w: 4, h: 8 }, config: { location: BERLIN } });
    const view = await screen.findByTestId('weather-view');
    expect(view).toHaveAttribute('data-tier', 'large');
    const list = within(view).getByRole('list', { name: '7-day forecast' });
    const days = within(list).getAllByRole('listitem');
    expect(days).toHaveLength(7);
    expect(days[0]).toHaveTextContent('Today');
    expect(days[3]).toHaveTextContent('80%');
    expect(within(view).getByText('06:58')).toBeInTheDocument();
    expect(within(view).getByText('Land Berlin, Germany')).toBeInTheDocument();
  });

  it.each([
    ['compact', { w: 2, h: 3 }],
    ['wide compact', { w: 8, h: 3 }],
    ['medium', { w: 4, h: 5 }],
    ['large', { w: 4, h: 8 }],
  ])('links Open-Meteo next to its data at the %s size (CC BY 4.0 attribution)', async (_name, size) => {
    renderWeather({ size, config: { location: BERLIN } });
    const view = await screen.findByTestId('weather-view');
    const link = within(view).getByRole('link', { name: /Weather data by Open-Meteo\.com/ });
    expect(link).toHaveAttribute('href', 'https://open-meteo.com/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('shows no attribution while there is no Open-Meteo data (location states)', async () => {
    renderWeather();
    expect(await screen.findByText('Set a location')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open-Meteo/ })).toBeNull();
  });

  it('respects the show toggles (medium without hourly shows a day strip)', async () => {
    renderWeather({ size: { w: 4, h: 5 }, config: { location: BERLIN, show: { hourly: false, daily: true } } });
    const view = await screen.findByTestId('weather-view');
    expect(within(view).queryByRole('region', { name: 'Hourly forecast' })).toBeNull();
    expect(within(view).getByRole('region', { name: 'Daily forecast' })).toBeInTheDocument();
  });

  it('converts to the widget’s unit override', async () => {
    renderWeather({ config: { location: BERLIN, units: 'F' } });
    const view = await screen.findByTestId('weather-view');
    // 6.6 °C = 43.9 °F
    const current = within(view).getByRole('region', { name: 'Current weather in Berlin' });
    expect(within(current).getByText('44°')).toBeInTheDocument();
    expect(within(current).getByText('F')).toBeInTheDocument();
    // The hourly strip converts too (7 °C → 45 °F for 08:00 = 7.5 °C).
    expect(within(view).getByRole('region', { name: 'Hourly forecast' })).toHaveTextContent('08:0046°');
  });

  it('follows the settings unit when inheriting, even for a report fetched in another unit', async () => {
    renderWeather({ config: { location: BERLIN }, settings: settingsWith({ general: { temperatureUnit: 'F', windUnit: 'mph' } }) });
    const view = await screen.findByTestId('weather-view');
    expect(within(within(view).getByRole('region', { name: 'Current weather in Berlin' })).getByText('44°')).toBeInTheDocument();
    expect(within(view).getByText('8 mph')).toBeInTheDocument();
  });

  it('shows an error with Retry when the provider fails', async () => {
    let calls = 0;
    const { user } = renderWeather({
      config: { location: BERLIN },
      mocks: {
        'GET /api/weather': () => (++calls === 1 ? mockError(502, 'provider_error', 'The weather service returned an error (HTTP 503).') : report()),
      },
    });
    expect(await screen.findByText('The weather service returned an error (HTTP 503).')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('weather-view')).toBeInTheDocument();
  });

  it('keeps stale data when a refresh fails and marks it as stale', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(qk.weather(BERLIN.lat, BERLIN.lon), report(), { updatedAt: NOW.getTime() - 45 * 60_000 });
    const actionsTarget = document.createElement('div');
    document.body.append(actionsTarget);
    renderWeather({
      config: { location: BERLIN },
      queryClient,
      frame: { actionsTarget },
      mocks: { 'GET /api/weather': mockError(504, 'upstream_timeout', 'The weather service timed out.') },
    });
    expect(await screen.findByTestId('weather-view')).toBeInTheDocument();
    await waitFor(() => expect(actionsTarget).toHaveTextContent(/Updated 45 min/));
    expect(actionsTarget).toHaveTextContent('Refresh failed: The weather service timed out.');
    expect(within(screen.getByRole('region', { name: 'Current weather in Berlin' })).getByText('7°')).toBeInTheDocument();
    actionsTarget.remove();
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const GEOCODE_RESULTS: GeoPlace[] = [
  { name: 'Springfield', admin1: 'Missouri', country: 'United States', lat: 37.21533, lon: -93.29824, timezone: 'America/Chicago' },
  { name: 'Springfield', admin1: 'Illinois', country: 'United States', lat: 39.80172, lon: -89.64371, timezone: 'America/Chicago' },
];

function renderSettings(value: Partial<WeatherConfig> = {}, settings = settingsWith()) {
  const onChange = vi.fn();
  const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
  const result = renderWithProviders(
    <form onSubmit={(e) => onSubmit(e.nativeEvent as SubmitEvent)}>
      <WeatherSettings value={weatherConfigSchema.parse(value)} onChange={onChange} />
    </form>,
    {
      apiMocks: {
        'GET /api/settings': settings,
        'GET /api/weather/geocode': (req: { search: string }) => (new URLSearchParams(req.search).get('q') === 'Springfield' ? GEOCODE_RESULTS : []),
        'PATCH /api/settings': (req: { body: unknown }) => ({ ...settings, weather: (req.body as { weather: Settings['weather'] }).weather }),
      },
    },
  );
  return { ...result, onChange, onSubmit, user: userEvent.setup() };
}

describe('weather settings', () => {
  it('searches places (debounced) and selects one with the keyboard without submitting the form', async () => {
    const { user, onChange, onSubmit, requestsTo } = renderSettings();
    const search = screen.getByRole('combobox', { name: 'Location' });
    await user.type(search, 'Springfield');
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[1]).toHaveAccessibleName('Springfield, Illinois, United States');
    // Debounced: one request for the whole word, not one per keystroke.
    expect(requestsTo('GET /api/weather/geocode').map((r) => r.search)).toEqual(['?q=Springfield']);

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(search).toHaveAttribute('aria-activedescendant', options[1]!.id);
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ location: GEOCODE_RESULTS[1] }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(search).toHaveValue('');
  });

  it('Escape clears the search without closing the surrounding settings dialog; a second Escape closes it', async () => {
    const onOpenChange = vi.fn();
    const onChange = vi.fn();
    renderWithProviders(
      <Dialog open onOpenChange={onOpenChange} title="Weather settings">
        <WeatherSettings value={weatherConfigSchema.parse({})} onChange={onChange} />
      </Dialog>,
      {
        apiMocks: {
          'GET /api/settings': settingsWith(),
          'GET /api/weather/geocode': GEOCODE_RESULTS,
        },
      },
    );
    const user = userEvent.setup();
    const search = await screen.findByRole('combobox', { name: 'Location' });
    await user.type(search, 'Springfield');
    expect(await screen.findAllByRole('option')).toHaveLength(2);

    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('option')).toHaveLength(0);

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('settles on a query longer than the 100-character limit (searching the first 100)', async () => {
    const { user, requestsTo } = renderSettings();
    const search = screen.getByRole('combobox', { name: 'Location' });
    await user.click(search);
    await user.paste('x'.repeat(120));
    expect(await screen.findByText(/^No places found for/)).toBeInTheDocument();
    expect(requestsTo('GET /api/weather/geocode').map((r) => new URLSearchParams(r.search).get('q'))).toEqual(['x'.repeat(100)]);
  });

  it('says when nothing matches', async () => {
    const { user } = renderSettings();
    await user.type(screen.getByRole('combobox', { name: 'Location' }), 'zzqxqz');
    expect(await screen.findByText('No places found for “zzqxqz”.')).toBeInTheDocument();
  });

  it('saves the selected place as the default location with a whole-object merge patch', async () => {
    const { user, requestsTo } = renderSettings({ location: GEOCODE_RESULTS[0] }, settingsWith({ defaultLocation: BERLIN }));
    await user.click(await screen.findByRole('button', { name: 'Use as default location' }));
    await waitFor(() => expect(requestsTo('PATCH /api/settings')).toHaveLength(1));
    expect(requestsTo('PATCH /api/settings')[0]!.body).toEqual({
      weather: {
        defaultLocation: {
          name: 'Springfield',
          lat: 37.21533,
          lon: -93.29824,
          admin1: 'Missouri',
          country: 'United States',
          timezone: 'America/Chicago',
        },
      },
    });
    expect(await screen.findByText('Springfield is now your default location.')).toBeInTheDocument();

    // Undo restores the previous default (again as a whole-object patch). fireEvent: sonner's
    // focus restoration trips over jsdom's focus events under userEvent (see ui.test.tsx).
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(requestsTo('PATCH /api/settings')).toHaveLength(2));
    expect(requestsTo('PATCH /api/settings')[1]!.body).toEqual(defaultLocationPatch(BERLIN));
  });

  it('shows the default location in use and toggles options', async () => {
    const { user, onChange } = renderSettings({}, settingsWith({ defaultLocation: BERLIN, general: { temperatureUnit: 'F' } }));
    expect(await screen.findByText('Berlin, Land Berlin, Germany')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: /Use this device's location/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ useDeviceLocation: true }));
    await user.click(screen.getByRole('switch', { name: 'Hourly forecast' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ show: { hourly: false, daily: true } }));
    expect(screen.getByRole('radio', { name: 'Default (°F)' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: '°C' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ units: 'C' }));
  });

  it('removes the widget location', async () => {
    const { user, onChange } = renderSettings({ location: PARIS });
    await user.click(await screen.findByRole('button', { name: 'Remove Paris' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ location: null }));
  });
});
