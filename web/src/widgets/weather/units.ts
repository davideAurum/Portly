/**
 * Unit conversion and number formatting for the weather widget. Reports arrive in the units of
 * `settings.general` at fetch time (`report.units`); the widget converts to the units it should
 * display (its own °C/°F override, or the current settings) so a cached report is always shown
 * correctly, even right after the settings changed.
 */
import type { PrecipUnit, TemperatureUnit, WindUnit } from '@homebase/shared';

export type UnitsChoice = 'inherit' | TemperatureUnit;

export function convertTemp(value: number, from: TemperatureUnit, to: TemperatureUnit): number {
  if (from === to) return value;
  return to === 'F' ? (value * 9) / 5 + 32 : ((value - 32) * 5) / 9;
}

const WIND_TO_MS: Record<WindUnit, number> = { ms: 1, kmh: 1 / 3.6, mph: 0.44704 };

export function convertWind(value: number, from: WindUnit, to: WindUnit): number {
  if (from === to) return value;
  return (value * WIND_TO_MS[from]) / WIND_TO_MS[to];
}

export function convertPrecip(value: number, from: PrecipUnit, to: PrecipUnit): number {
  if (from === to) return value;
  return to === 'in' ? value / 25.4 : value * 25.4;
}

/** The temperature unit to display: the widget's override, else settings, else the report's. */
export function displayTempUnit(choice: UnitsChoice, settingsUnit: TemperatureUnit | undefined, reportUnit: TemperatureUnit): TemperatureUnit {
  if (choice !== 'inherit') return choice;
  return settingsUnit ?? reportUnit;
}

export const WIND_LABELS: Record<WindUnit, string> = { kmh: 'km/h', mph: 'mph', ms: 'm/s' };
export const PRECIP_LABELS: Record<PrecipUnit, string> = { mm: 'mm', in: 'in' };

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string | undefined, digits: number): Intl.NumberFormat {
  const key = `${locale ?? ''}|${digits}`;
  let nf = numberFormats.get(key);
  if (!nf) {
    try {
      nf = new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
    } catch {
      nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
    }
    numberFormats.set(key, nf);
  }
  return nf;
}

/** Rounds without ever producing "-0". */
function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/** `21°` (whole degrees; the unit is shown separately where it matters). */
export function formatTemp(value: number, locale: string | undefined): string {
  return `${numberFormat(locale, 0).format(roundTo(value, 0))}°`;
}

/** `12 km/h`, `3.4 m/s`. */
export function formatWind(value: number, unit: WindUnit, locale: string | undefined): string {
  return `${numberFormat(locale, unit === 'ms' ? 1 : 0).format(roundTo(value, unit === 'ms' ? 1 : 0))} ${WIND_LABELS[unit]}`;
}

/** `0.4 mm`, `0.02 in`. */
export function formatPrecip(value: number, unit: PrecipUnit, locale: string | undefined): string {
  const digits = unit === 'in' ? 2 : 1;
  return `${numberFormat(locale, digits).format(roundTo(value, digits))} ${PRECIP_LABELS[unit]}`;
}

export function formatPercent(value: number, locale: string | undefined): string {
  return `${numberFormat(locale, 0).format(roundTo(value, 0))}%`;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'] as const;
const COMPASS_WORDS: Record<(typeof COMPASS)[number], string> = {
  N: 'north',
  NNE: 'north-northeast',
  NE: 'northeast',
  ENE: 'east-northeast',
  E: 'east',
  ESE: 'east-southeast',
  SE: 'southeast',
  SSE: 'south-southeast',
  S: 'south',
  SSW: 'south-southwest',
  SW: 'southwest',
  WSW: 'west-southwest',
  W: 'west',
  WNW: 'west-northwest',
  NW: 'northwest',
  NNW: 'north-northwest',
};

/** 16-point compass abbreviation for a meteorological direction (where the wind comes from). */
export function compassPoint(degrees: number): (typeof COMPASS)[number] {
  const normalized = ((degrees % 360) + 360) % 360;
  return COMPASS[Math.round(normalized / 22.5) % 16]!;
}

export function compassWords(degrees: number): string {
  return COMPASS_WORDS[compassPoint(degrees)];
}
