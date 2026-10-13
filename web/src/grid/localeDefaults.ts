/**
 * First-run defaults that follow the browser's locale (UX-2): the schema defaults are metric
 * with Monday as the first day, which is wrong for, e.g., a US user. Only applied while the
 * general settings are still exactly the schema defaults (see seed.ts).
 */
import type { GeneralSettings } from '@portly/shared';

/** Regions using °F, mph and inches (plus US territories). */
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM']);
/** Regions using mph for wind but otherwise metric. */
const MPH_REGIONS = new Set(['GB', 'IM', 'JE', 'GG']);
/** Where Intl has no week data: regions whose week starts on Sunday (CLDR). */
const SUNDAY_REGIONS = new Set([
  'US', 'CA', 'MX', 'BR', 'JP', 'IL', 'KR', 'TW', 'HK', 'MO', 'PH', 'IN', 'ZA', 'SA', 'AR', 'CO', 'PE', 'VE', 'GT', 'HN',
  'NI', 'PA', 'DO', 'PR', 'JM', 'TH', 'ID', 'KE', 'ET', 'ZW', 'PK', 'BD', 'NP', 'BT', 'KH', 'LA', 'MM', 'SG', 'AU', 'PY', 'SV', 'BZ', 'BS',
  'AG', 'DM', 'GU', 'VI', 'AS', 'MP', 'UM', 'WS', 'YE', 'MT', 'PT',
]);
/** Where Intl has no week data: regions whose week starts on Saturday. */
const SATURDAY_REGIONS = new Set(['AE', 'AF', 'BH', 'DJ', 'DZ', 'EG', 'IQ', 'IR', 'JO', 'KW', 'LY', 'OM', 'QA', 'SD', 'SY']);

export const SCHEMA_GENERAL_DEFAULTS: Pick<GeneralSettings, 'weekStartsOn' | 'temperatureUnit' | 'windUnit' | 'precipUnit'> = Object.freeze({
  weekStartsOn: 1,
  temperatureUnit: 'C',
  windUnit: 'kmh',
  precipUnit: 'mm',
});

type WeekInfoLocale = Intl.Locale & { getWeekInfo?: () => { firstDay?: number }; weekInfo?: { firstDay?: number } };

function regionOf(language: string): string | null {
  try {
    const locale = new Intl.Locale(language);
    return (locale.region ?? locale.maximize().region ?? null)?.toUpperCase() ?? null;
  } catch {
    return null;
  }
}

function weekStartOf(language: string, region: string | null): 0 | 1 | 6 {
  let firstDay: number | undefined;
  try {
    const locale = new Intl.Locale(language) as WeekInfoLocale;
    const info = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo;
    firstDay = info?.firstDay;
  } catch {
    firstDay = undefined;
  }
  if (firstDay === 7) return 0;
  if (firstDay === 6) return 6;
  if (firstDay === 1) return 1;
  if (region && SUNDAY_REGIONS.has(region)) return 0;
  if (region && SATURDAY_REGIONS.has(region)) return 6;
  return 1;
}

/** Week start and units for a BCP 47 language tag such as `navigator.language`. */
export function localeDefaults(language: string): Pick<GeneralSettings, 'weekStartsOn' | 'temperatureUnit' | 'windUnit' | 'precipUnit'> {
  const region = regionOf(language);
  const imperial = region !== null && IMPERIAL_REGIONS.has(region);
  return {
    weekStartsOn: weekStartOf(language, region),
    temperatureUnit: imperial ? 'F' : 'C',
    windUnit: imperial || (region !== null && MPH_REGIONS.has(region)) ? 'mph' : 'kmh',
    precipUnit: imperial ? 'in' : 'mm',
  };
}

/** The changes to make to `general` on first run, or null when the user already chose something. */
export function firstRunGeneralPatch(general: GeneralSettings, language: string): Partial<GeneralSettings> | null {
  const untouched = (Object.keys(SCHEMA_GENERAL_DEFAULTS) as (keyof typeof SCHEMA_GENERAL_DEFAULTS)[]).every(
    (key) => general[key] === SCHEMA_GENERAL_DEFAULTS[key],
  );
  if (!untouched) return null;
  const wanted = localeDefaults(language);
  const patch: Partial<GeneralSettings> = {};
  for (const key of Object.keys(wanted) as (keyof typeof wanted)[]) {
    if (wanted[key] !== general[key]) (patch as Record<string, unknown>)[key] = wanted[key];
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
