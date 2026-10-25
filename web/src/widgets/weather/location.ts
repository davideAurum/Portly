/**
 * Where the weather widget looks, in order (§10.8 Weather):
 *   1. the widget's own `config.location`,
 *   2. `settings.weather.defaultLocation`,
 *   3. this device's location (`navigator.geolocation`) when `config.useDeviceLocation` is on; a
 *      page load only asks the browser when it already allows it (see `useDeviceLocation`).
 * Otherwise the widget shows its not-configured state ("Set location").
 *
 * A device location is named by `GET /api/weather/place` (Nominatim reverse geocoding) through
 * {@link nameDevicePlace}; until that answers, or when it cannot, it is "Current location".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeoPlace } from '@portly/shared';

export type DeviceLocationState =
  | { status: 'idle' }
  | { status: 'pending' }
  /** The browser would ask, and nothing the user did just now asked for it (see {@link useDeviceLocation}). */
  | { status: 'needs-permission' }
  | { status: 'ready'; lat: number; lon: number; at: number }
  | { status: 'denied' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

export type LocationSource = 'widget' | 'default' | 'device';

export type ResolvedLocation =
  /** Settings are still loading (the default location is not known yet). */
  | { status: 'loading' }
  | { status: 'ready'; place: GeoPlace; source: LocationSource }
  | { status: 'locating' }
  | { status: 'device-needs-permission' }
  | { status: 'device-denied' }
  | { status: 'device-unavailable' }
  | { status: 'device-error'; message: string }
  | { status: 'not-configured' };

export const DEVICE_PLACE_NAME = 'Current location';

export interface ResolveLocationInput {
  configLocation: GeoPlace | null;
  useDeviceLocation: boolean;
  /** `undefined` while settings are loading; `null` when no default is set. */
  defaultLocation: GeoPlace | null | undefined;
  device: DeviceLocationState;
}

export function resolveLocation({ configLocation, useDeviceLocation, defaultLocation, device }: ResolveLocationInput): ResolvedLocation {
  if (configLocation) return { status: 'ready', place: configLocation, source: 'widget' };
  if (defaultLocation === undefined) return { status: 'loading' };
  if (defaultLocation) return { status: 'ready', place: defaultLocation, source: 'default' };
  if (!useDeviceLocation) return { status: 'not-configured' };
  switch (device.status) {
    case 'ready':
      return { status: 'ready', place: { name: DEVICE_PLACE_NAME, lat: device.lat, lon: device.lon }, source: 'device' };
    case 'needs-permission':
      return { status: 'device-needs-permission' };
    case 'denied':
      return { status: 'device-denied' };
    case 'unavailable':
      return { status: 'device-unavailable' };
    case 'error':
      return { status: 'device-error', message: device.message };
    default:
      return { status: 'locating' };
  }
}

/**
 * The device place with its looked-up name ("Boise", admin1 "Idaho", ...), keeping the
 * device coordinates the forecast uses. Other places, and a missing or failed lookup, are
 * returned unchanged (still "Current location"), so `result !== place` means it was named.
 */
export function nameDevicePlace(place: GeoPlace, source: LocationSource, named: GeoPlace | null | undefined): GeoPlace {
  if (source !== 'device' || !named) return place;
  const result: GeoPlace = { name: named.name, lat: place.lat, lon: place.lon };
  if (named.admin1) result.admin1 = named.admin1;
  if (named.country) result.country = named.country;
  return result;
}

/** Whether the device location is needed (so the browser is only asked when it matters). */
export function needsDeviceLocation(input: Omit<ResolveLocationInput, 'device'>): boolean {
  return input.useDeviceLocation && input.configLocation === null && input.defaultLocation === null;
}

/** "Berlin, Germany" / "Springfield, Illinois". */
export function placeSubtitle(place: GeoPlace): string {
  return [place.admin1, place.country].filter((part) => part && part !== place.name).join(', ');
}

export function samePlace(a: GeoPlace | null | undefined, b: GeoPlace | null | undefined): boolean {
  if (!a || !b) return false;
  return a.name === b.name && Math.abs(a.lat - b.lat) < 0.005 && Math.abs(a.lon - b.lon) < 0.005;
}

// ---------------------------------------------------------------------------
// Device location
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'portly:weather:device-location';
/** A remembered position is shown immediately (then refreshed) when younger than this. */
const REMEMBER_MS = 6 * 60 * 60 * 1000;
/** The browser may answer from its own cache for this long. */
const MAX_AGE_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 15_000;

interface StoredPosition {
  lat: number;
  lon: number;
  at: number;
}

let memoryPosition: StoredPosition | null = null;

function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function readStored(now: number): StoredPosition | null {
  if (memoryPosition && now - memoryPosition.at < REMEMBER_MS) return memoryPosition;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPosition>;
    if (
      typeof parsed.lat === 'number' &&
      typeof parsed.lon === 'number' &&
      typeof parsed.at === 'number' &&
      Math.abs(parsed.lat) <= 90 &&
      Math.abs(parsed.lon) <= 180 &&
      now - parsed.at < REMEMBER_MS
    ) {
      memoryPosition = { lat: parsed.lat, lon: parsed.lon, at: parsed.at };
      return memoryPosition;
    }
  } catch {
    // Storage unavailable (private window, blocked site data): the position is simply re-requested.
  }
  return null;
}

function writeStored(position: StoredPosition | null): void {
  memoryPosition = position;
  try {
    if (position) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best effort only.
  }
}

/** Test hook: forget the remembered position. */
export function resetDeviceLocationMemory(): void {
  writeStored(null);
}

function geolocation(): Geolocation | null {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator) || !navigator.geolocation) return null;
  return navigator.geolocation;
}

/** The browser's lasting geolocation decision for this site, or 'unknown' without the Permissions API. */
async function geolocationPermission(): Promise<PermissionState | 'unknown'> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unknown';
    return (await navigator.permissions.query({ name: 'geolocation' })).state;
  } catch {
    return 'unknown';
  }
}

/** Set by a user action that asks for the device location (the next lookup may make the browser ask). */
let promptAllowed = false;

/**
 * Call from a click or toggle that turns the device location on ("Use my location"): the next
 * lookup may then make the browser ask. Without it, a page load never does.
 */
export function allowLocationPrompt(): void {
  promptAllowed = true;
}

/**
 * The device position (rounded to ~1 km) while `enabled`. The browser is asked on page load only
 * when it already has a lasting "Allow" for this site (then the position is refreshed); otherwise
 * a recently remembered position is shown as it is, and without one the state is
 * `needs-permission` until the user asks (`retry`, or {@link allowLocationPrompt} before turning
 * it on). So a one-time "Allow this time" does not bring the prompt back on every new tab. Without
 * the Permissions API the browser is asked as before. A denial is reported (and forgets the position).
 */
export function useDeviceLocation(enabled: boolean): DeviceLocationState & { retry(): void } {
  const [state, setState] = useState<DeviceLocationState>(() => {
    if (!enabled) return { status: 'idle' };
    const stored = readStored(Date.now());
    return stored ? { status: 'ready', ...stored } : { status: 'pending' };
  });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(state);
  latest.current = state;
  const asked = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle' });
      return;
    }
    const geo = geolocation();
    if (!geo) {
      setState({ status: 'unavailable' });
      return;
    }
    let cancelled = false;
    const stored = readStored(Date.now());
    if (stored) setState({ status: 'ready', ...stored });
    else if (latest.current.status !== 'ready') setState({ status: 'pending' });
    // A user action (retry, or turning it on) may make the browser ask; a page load may not.
    const interactive = asked.current || promptAllowed;
    asked.current = false;
    promptAllowed = false;

    const lookup = (): void => {
      geo.getCurrentPosition(
        (position) => {
          if (cancelled) return;
          const next: StoredPosition = { lat: round2(position.coords.latitude), lon: round2(position.coords.longitude), at: Date.now() };
          writeStored(next);
          setState({ status: 'ready', ...next });
        },
        (error) => {
          if (cancelled) return;
          if (error.code === error.PERMISSION_DENIED) {
            writeStored(null);
            setState({ status: 'denied' });
            return;
          }
          // Keep showing a remembered position when a refresh merely failed.
          if (latest.current.status === 'ready') return;
          setState({
            status: 'error',
            message: error.code === error.TIMEOUT ? 'Finding your location took too long.' : 'Your location is not available right now.',
          });
        },
        { enableHighAccuracy: false, maximumAge: MAX_AGE_MS, timeout: TIMEOUT_MS },
      );
    };

    if (interactive) lookup();
    else {
      void geolocationPermission().then((permission) => {
        if (cancelled) return;
        if (permission === 'granted' || (permission === 'unknown' && !stored)) lookup();
        else if (permission === 'denied') {
          writeStored(null);
          setState({ status: 'denied' });
        } else if (!stored) setState({ status: 'needs-permission' });
        // Otherwise ('prompt' or unknown, with a remembered position): show it, ask nobody.
      });
    }
    return () => {
      cancelled = true;
      // A user's request survives an effect that is torn down and run again (StrictMode).
      if (interactive) asked.current = true;
    };
  }, [enabled, attempt]);

  const retry = useCallback(() => {
    asked.current = true;
    setAttempt((n) => n + 1);
  }, []);
  return { ...state, retry };
}
