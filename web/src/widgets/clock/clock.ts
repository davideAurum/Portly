/**
 * Pure clock helpers: effective time format, locale-aware time parts, greeting by time of day,
 * time-zone offsets / day differences for extra zones, and the searchable IANA zone list.
 * All Intl formatters are cached (the clock re-renders every second when seconds are shown).
 */
import { isValidTimeZone, type GeneralSettings } from '@portly/shared';
import { hourCycleFor } from '../../lib/format.ts';

export type ClockFormat = 'inherit' | '12h' | '24h';
export type TimeFormat = GeneralSettings['timeFormat'];

/** `inherit` → settings.general.timeFormat; `system` then means "the locale's default". */
export function effectiveTimeFormat(format: ClockFormat, settingsFormat: TimeFormat | undefined): TimeFormat {
  return format === 'inherit' ? (settingsFormat ?? 'system') : format;
}

const cache = new Map<string, Intl.DateTimeFormat>();

function dtf(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, options);
    } catch {
      const { timeZone: _ignored, ...rest } = options;
      f = new Intl.DateTimeFormat(undefined, rest);
    }
    if (cache.size > 300) cache.clear();
    cache.set(key, f);
  }
  return f;
}

export interface TimeOptions {
  locale: string | undefined;
  timeFormat: TimeFormat;
  seconds?: boolean;
  timeZone?: string;
}

export interface TimeParts {
  /** Full text, e.g. `2:05 PM` / `14:05`. */
  text: string;
  /** The digits without the day period, e.g. `2:05`. */
  main: string;
  /** `PM`, `午後`, … or null in 24-hour formats. */
  dayPeriod: string | null;
  /** Whether the day period precedes the digits (e.g. `오후 2:05`). */
  dayPeriodFirst: boolean;
}

function timeFormatter({ locale, timeFormat, seconds, timeZone }: TimeOptions): Intl.DateTimeFormat {
  const hourCycle = hourCycleFor(timeFormat);
  return dtf(locale, {
    hour: 'numeric',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    ...(hourCycle ? { hourCycle } : {}),
    ...(timeZone ? { timeZone } : {}),
  });
}

/** Locale-aware time split into digits and day period (so the period can be styled smaller). */
export function timeParts(date: Date, options: TimeOptions): TimeParts {
  const parts = timeFormatter(options).formatToParts(date);
  const text = parts.map((p) => p.value).join('');
  const periodIndex = parts.findIndex((p) => p.type === 'dayPeriod');
  if (periodIndex === -1) return { text, main: text.trim(), dayPeriod: null, dayPeriodFirst: false };
  const dayPeriod = parts[periodIndex]!.value.trim();
  const firstDigit = parts.findIndex((p) => p.type === 'hour');
  const main = parts
    .filter((_, i) => i !== periodIndex)
    .map((p) => p.value)
    .join('')
    .trim();
  return { text, main, dayPeriod, dayPeriodFirst: periodIndex < firstDigit };
}

/** `Saturday, 26 September` in the user's locale. */
export function longDate(date: Date, locale: string | undefined, timeZone?: string): string {
  return dtf(locale, { weekday: 'long', day: 'numeric', month: 'long', ...(timeZone ? { timeZone } : {}) }).format(date);
}

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

export type PartOfDay = 'night' | 'morning' | 'afternoon' | 'evening';

/** 00:00–04:59 night, 05:00–11:59 morning, 12:00–17:59 afternoon, 18:00–23:59 evening. */
export function partOfDay(hour: number): PartOfDay {
  if (hour >= 0 && hour < 5) return 'night';
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

/** `Good morning, Dana` (local time of day; the name is optional); a neutral `Hello` at night. */
export function greetingText(date: Date, userName?: string | null): string {
  const part = partOfDay(date.getHours());
  const base = part === 'night' ? 'Hello' : `Good ${part}`;
  const name = userName?.trim();
  return name ? `${base}, ${name}` : base;
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

/** The browser's own zone (the reference for extra-zone offsets). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function zoneFields(date: Date, timeZone: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts = dtf('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const h = get('hour');
  return { y: get('year'), m: get('month'), d: get('day'), h: h === 24 ? 0 : h, mi: get('minute'), s: get('second') };
}

/** UTC offset of `timeZone` at `date`, in minutes (e.g. 540 for Asia/Tokyo). */
export function zoneOffsetMinutes(timeZone: string, date: Date): number {
  const f = zoneFields(date, timeZone);
  const asUtc = Date.UTC(f.y, f.m - 1, f.d, f.h, f.mi, f.s);
  const actual = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - actual) / 60_000);
}

/** Calendar-day difference of `timeZone` relative to `home` at `date` (-1, 0, 1). */
export function zoneDayDiff(timeZone: string, home: string, date: Date): number {
  const a = zoneFields(date, timeZone);
  const b = zoneFields(date, home);
  return Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / 86_400_000);
}

const MINUS = '−';

/** `+9h`, `−3h`, `+5h 30m`, `+45m`, or `Same time`. */
export function formatOffsetDiff(minutes: number): string {
  if (minutes === 0) return 'Same time';
  const sign = minutes > 0 ? '+' : MINUS;
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return `${sign}${m}m`;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}

/** Spoken form for labels: `9 hours ahead`, `3 hours 30 minutes behind`, `same time`. */
export function describeOffsetDiff(minutes: number): string {
  if (minutes === 0) return 'same time';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const parts = [h ? `${h} hour${h === 1 ? '' : 's'}` : '', m ? `${m} minute${m === 1 ? '' : 's'}` : ''].filter(Boolean);
  return `${parts.join(' ')} ${minutes > 0 ? 'ahead' : 'behind'}`;
}

/** `UTC+9`, `UTC+5:30`, `UTC−3`, `UTC`. */
export function offsetLabel(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : MINUS;
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** `Today` / `Tomorrow` / `Yesterday` in the user's locale. */
export function relativeDay(diff: number, locale: string | undefined): string {
  let text: string;
  try {
    text = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(diff, 'day');
  } catch {
    text = diff === 0 ? 'today' : diff > 0 ? 'tomorrow' : 'yesterday';
  }
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/** A readable default label for a zone: `Asia/Tokyo` → `Tokyo`, `America/Argentina/Buenos_Aires` → `Buenos Aires`. */
export function defaultZoneLabel(timeZone: string): string {
  const last = timeZone.split('/').at(-1) ?? timeZone;
  return last.replace(/_/g, ' ').slice(0, 40) || timeZone.slice(0, 40);
}

const FALLBACK_ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'America/Sao_Paulo',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Pacific/Honolulu',
];

/**
 * Browsers list CLDR's canonical ids, some of which are the old names (`Asia/Calcutta`,
 * `Europe/Kiev`, …). The current IANA name is offered instead when this browser accepts it;
 * the old name stays searchable.
 */
export const MODERN_ZONE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
});

/** The current IANA name for a (possibly legacy) zone id, when this browser accepts it. */
export function modernZoneName(tz: string): string {
  const modern = MODERN_ZONE_NAMES[tz];
  return modern !== undefined && isValidTimeZone(modern) ? modern : tz;
}

/** Every IANA zone this browser knows (`Intl.supportedValuesOf`, modern names), plus `UTC`. */
export function listTimeZones(): string[] {
  let zones: string[] = [];
  try {
    zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  } catch {
    zones = [];
  }
  if (zones.length === 0) zones = FALLBACK_ZONES.filter(isValidTimeZone);
  const unique = [...new Set(zones.map(modernZoneName))];
  return unique.includes('UTC') ? unique : ['UTC', ...unique];
}

export interface ZoneOption {
  tz: string;
  city: string;
  offset: number;
  offsetText: string;
  /** Lower-cased search text. */
  haystack: string;
}

const LEGACY_NAMES: ReadonlyMap<string, string> = new Map(Object.entries(MODERN_ZONE_NAMES).map(([legacy, modern]) => [modern, legacy]));

export function zoneOptions(zones: readonly string[], date: Date): ZoneOption[] {
  return zones.map((tz) => {
    const offset = zoneOffsetMinutes(tz, date);
    const city = defaultZoneLabel(tz);
    const offsetText = offsetLabel(offset);
    const hours = offset / 60;
    const plain = offset === 0 ? 'utc gmt' : `utc${offset > 0 ? '+' : '-'}${Math.abs(hours)} gmt${offset > 0 ? '+' : '-'}${Math.abs(hours)}`;
    const legacy = LEGACY_NAMES.get(tz) ?? '';
    const haystack = `${tz.replace(/[_/]/g, ' ')} ${tz} ${legacy.replace(/[_/]/g, ' ')} ${offsetText.replace(MINUS, '-')} ${plain}`.toLowerCase();
    return { tz, city, offset, offsetText, haystack };
  });
}

/** Zones matching every word of `query` (city-name prefix matches first). */
export function searchTimeZones(options: readonly ZoneOption[], query: string, limit = 50): ZoneOption[] {
  const tokens = query
    .toLowerCase()
    .replace(/−/g, '-')
    .split(/[\s,]+/)
    .map((t) => t.replace(/_/g, ' ').trim())
    .filter(Boolean);
  if (tokens.length === 0) return [];
  const first = tokens[0]!;
  const matches = options.filter((o) => tokens.every((t) => o.haystack.includes(t)));
  const rank = (o: ZoneOption) => (o.city.toLowerCase().startsWith(first) ? 0 : o.tz.toLowerCase().includes(first) ? 1 : 2);
  return matches.sort((a, b) => rank(a) - rank(b) || a.tz.localeCompare(b.tz)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type ClockTier = 'compact' | 'medium' | 'large';

/**
 * compact (≤ 2 rows): time (+ date); medium: + greeting and zone chips; large (≥ 5 rows and ≥ 4
 * columns): big time and a zone list. Container queries scale the type within each tier.
 */
export function clockTier(size: { w: number; h: number }): ClockTier {
  if (size.h <= 2) return 'compact';
  if (size.h >= 5 && size.w >= 4) return 'large';
  return 'medium';
}
