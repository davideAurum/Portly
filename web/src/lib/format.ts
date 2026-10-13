/**
 * Locale-aware formatting that respects `settings.general.locale` and `.timeFormat` (§7a). The
 * pure functions take explicit preferences (easy to test); {@link useFormatters} binds them to the
 * current settings. Intl formatters are cached because widgets format on every tick.
 */
import { useMemo } from 'react';
import type { GeneralSettings } from '@portly/shared';
import { useSettings } from '../api/settings.ts';

export type TimeFormat = GeneralSettings['timeFormat'];

export interface FormatPrefs {
  /** 'system' or a BCP 47 tag. */
  locale: string;
  timeFormat: TimeFormat;
}

export const DEFAULT_FORMAT_PREFS: FormatPrefs = Object.freeze({ locale: 'system', timeFormat: 'system' });

export type DateInput = Date | string | number;

/** `undefined` means "the browser's default locale". Invalid tags fall back to the default. */
export function resolveLocale(locale: string | undefined): string | undefined {
  if (locale === undefined || locale === 'system' || locale === '') return undefined;
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
}

/** Intl hourCycle for a time-format preference (`undefined` = locale default). */
export function hourCycleFor(timeFormat: TimeFormat): 'h12' | 'h23' | undefined {
  if (timeFormat === '12h') return 'h12';
  if (timeFormat === '24h') return 'h23';
  return undefined;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat(locale, options);
    } catch {
      // Unknown time zone or locale data: fall back to the defaults rather than crash a widget.
      const { timeZone: _ignored, ...rest } = options;
      formatter = new Intl.DateTimeFormat(undefined, rest);
    }
    if (formatterCache.size > 200) formatterCache.clear();
    formatterCache.set(key, formatter);
  }
  return formatter;
}

export function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

function isValid(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

export interface TimeOptions {
  seconds?: boolean;
  timeZone?: string;
}

/** e.g. `14:05` / `2:05 PM`. */
export function formatTime(value: DateInput, prefs: FormatPrefs, options: TimeOptions = {}): string {
  const date = toDate(value);
  if (!isValid(date)) return '';
  return dateTimeFormat(resolveLocale(prefs.locale), {
    hour: 'numeric',
    minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' } : {}),
    ...(hourCycleFor(prefs.timeFormat) ? { hourCycle: hourCycleFor(prefs.timeFormat) } : {}),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}

export type DateStyle = 'short' | 'medium' | 'long' | 'full' | 'weekday-short' | 'day-month';

const DATE_STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { dateStyle: 'short' },
  medium: { dateStyle: 'medium' },
  long: { dateStyle: 'long' },
  full: { dateStyle: 'full' },
  'weekday-short': { weekday: 'short', day: 'numeric', month: 'short' },
  'day-month': { day: 'numeric', month: 'short' },
};

/** Date only, e.g. `Fri, 25 Sep` (weekday-short) or `Friday, 25 September 2026` (full). */
export function formatDate(value: DateInput, prefs: FormatPrefs, style: DateStyle = 'medium', timeZone?: string): string {
  const date = toDate(value);
  if (!isValid(date)) return '';
  return dateTimeFormat(resolveLocale(prefs.locale), { ...DATE_STYLES[style], ...(timeZone ? { timeZone } : {}) }).format(date);
}

/** Date and time, e.g. `25 Sep 2026, 14:05`. */
export function formatDateTime(value: DateInput, prefs: FormatPrefs, timeZone?: string): string {
  const date = toDate(value);
  if (!isValid(date)) return '';
  const hourCycle = hourCycleFor(prefs.timeFormat);
  return dateTimeFormat(resolveLocale(prefs.locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(hourCycle ? { hourCycle } : {}),
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** e.g. `just now`, `5 min. ago`, `in 3 hours`, `yesterday`. */
export function formatRelative(value: DateInput, now: DateInput, prefs: Pick<FormatPrefs, 'locale'>): string {
  const date = toDate(value);
  const reference = toDate(now);
  if (!isValid(date) || !isValid(reference)) return '';
  const seconds = Math.round((date.getTime() - reference.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(resolveLocale(prefs.locale), { numeric: 'auto', style: 'short' });
  if (abs < 45) return rtf.format(0, 'second');
  for (const [unit, size] of RELATIVE_UNITS) {
    if (abs >= size * 0.95 || unit === 'minute') return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(Math.round(seconds / 60), 'minute');
}

/** Whether the effective time format is 12-hour (resolving 'system' through the locale). */
export function uses12Hour(prefs: FormatPrefs): boolean {
  const cycle = hourCycleFor(prefs.timeFormat);
  if (cycle) return cycle === 'h12';
  const resolved = dateTimeFormat(resolveLocale(prefs.locale), { hour: 'numeric' }).resolvedOptions();
  return resolved.hourCycle === 'h11' || resolved.hourCycle === 'h12';
}

export interface Formatters {
  prefs: FormatPrefs;
  /** Resolved BCP 47 tag, or undefined for the browser default. */
  locale: string | undefined;
  weekStartsOn: GeneralSettings['weekStartsOn'];
  time(value: DateInput, options?: TimeOptions): string;
  date(value: DateInput, style?: DateStyle, timeZone?: string): string;
  dateTime(value: DateInput, timeZone?: string): string;
  relative(value: DateInput, now?: DateInput): string;
  is12Hour: boolean;
}

export function createFormatters(general: Pick<GeneralSettings, 'locale' | 'timeFormat' | 'weekStartsOn'>): Formatters {
  const prefs: FormatPrefs = { locale: general.locale, timeFormat: general.timeFormat };
  return {
    prefs,
    locale: resolveLocale(prefs.locale),
    weekStartsOn: general.weekStartsOn,
    time: (value, options) => formatTime(value, prefs, options),
    date: (value, style, timeZone) => formatDate(value, prefs, style, timeZone),
    dateTime: (value, timeZone) => formatDateTime(value, prefs, timeZone),
    relative: (value, now = Date.now()) => formatRelative(value, now, prefs),
    is12Hour: uses12Hour(prefs),
  };
}

/** Formatters bound to the current general settings (defaults until settings load). */
export function useFormatters(): Formatters {
  const settings = useSettings();
  const general = settings.data?.general;
  const locale = general?.locale ?? 'system';
  const timeFormat = general?.timeFormat ?? 'system';
  const weekStartsOn = general?.weekStartsOn ?? 1;
  return useMemo(() => createFormatters({ locale, timeFormat, weekStartsOn }), [locale, timeFormat, weekStartsOn]);
}
