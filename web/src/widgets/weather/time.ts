/**
 * Place-local time helpers. Open-Meteo times are local to the place (`timezone=auto`) and carry
 * no offset (`2026-09-26T14:00`). Open-Meteo labels a whole report with ONE fixed offset
 * (`utc_offset_seconds`, the offset at request time) even when a DST change falls inside the
 * forecast, so:
 * - "now" is expressed on that same basis (the report's offset) before it is compared with the
 *   labels as strings;
 * - labels are shown in the place's real local time: label − offset = the UTC instant, formatted
 *   in the place's IANA zone. Without both a zone and an offset, a label's wall-clock time is
 *   shown as is (never shifted into the viewer's zone).
 */
import type { WeatherDay, WeatherHour, WeatherReport } from '@portly/shared';

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneParts(timeZone: string): Intl.DateTimeFormat | null {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      return null;
    }
    partsFormatters.set(timeZone, f);
  }
  return f;
}

function hasOffset(offset: number | undefined): offset is number {
  return typeof offset === 'number' && Number.isFinite(offset);
}

/**
 * "Now" at the report's place as a local `YYYY-MM-DDTHH:MM` string, on the same basis as the
 * report's labels: the report's fixed offset when known (so it stays aligned with the hourly
 * labels across a DST change), else the place's zone, else the report's own current time.
 */
export function placeNow(now: Date, report: Pick<WeatherReport, 'timezone' | 'utcOffsetSeconds' | 'current'>): string {
  if (hasOffset(report.utcOffsetSeconds)) {
    return new Date(now.getTime() + report.utcOffsetSeconds * 1000).toISOString().slice(0, 16);
  }
  if (report.timezone) {
    const f = zoneParts(report.timezone);
    if (f) {
      const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
      const hour = parts.hour === '24' ? '00' : parts.hour;
      return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
    }
  }
  return report.current.time.slice(0, 16);
}

/** Hourly entries from the current place-local hour on (the first one is "now"). */
export function upcomingHours(hourly: readonly WeatherHour[], nowLocal: string, limit: number): WeatherHour[] {
  const currentHour = `${nowLocal.slice(0, 13)}:00`;
  return hourly.filter((h) => h.time >= currentHour).slice(0, limit);
}

/** Days from the place-local today on. */
export function upcomingDays(daily: readonly WeatherDay[], nowLocal: string): WeatherDay[] {
  const today = nowLocal.slice(0, 10);
  return daily.filter((d) => d.date >= today);
}

/** Whether a local hour is in daylight, from that day's sunrise/sunset (unknown → day). */
export function isDaylight(time: string, daily: readonly WeatherDay[]): boolean {
  const day = daily.find((d) => d.date === time.slice(0, 10));
  if (!day || !day.sunrise || !day.sunset) return true;
  return time >= day.sunrise.slice(0, 16) && time < day.sunset.slice(0, 16);
}

/** A local (offset-less) time as a Date whose UTC fields are the wall-clock fields. */
export function wallClock(local: string): Date {
  const iso = local.length === 10 ? `${local}T12:00:00Z` : `${local.slice(0, 16)}:00Z`;
  return new Date(iso);
}

/** The report's zone and label offset (see the module comment). */
export type LabelZone = Partial<Pick<WeatherReport, 'timezone' | 'utcOffsetSeconds'>>;

/**
 * The Date + zone to format a report label with: the real instant in the place's zone when the
 * report has both (correct across DST changes), otherwise the label's wall-clock fields in UTC.
 */
function labelMoment(local: string, zone: LabelZone | undefined): { date: Date; timeZone: string } {
  const wall = wallClock(local);
  const offset = zone?.utcOffsetSeconds;
  if (zone?.timezone && hasOffset(offset) && zoneParts(zone.timezone)) {
    return { date: new Date(wall.getTime() - offset * 1000), timeZone: zone.timezone };
  }
  return { date: wall, timeZone: 'UTC' };
}

const labelFormatters = new Map<string, Intl.DateTimeFormat>();

function wallFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions, timeZone = 'UTC'): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${timeZone}|${JSON.stringify(options)}`;
  let f = labelFormatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    } catch {
      f = new Intl.DateTimeFormat(undefined, { ...options, timeZone });
    }
    if (labelFormatters.size > 200) labelFormatters.clear();
    labelFormatters.set(key, f);
  }
  return f;
}

export type HourCycle = 'h12' | 'h23' | undefined;

/** `14:00` / `2 PM` for an hourly entry (in the place's real local time when `zone` allows). */
export function hourLabel(local: string, locale: string | undefined, hourCycle: HourCycle, zone?: LabelZone): string {
  const twelve = hourCycle === 'h12' || (hourCycle === undefined && wallFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle?.startsWith('h1'));
  const options: Intl.DateTimeFormatOptions = twelve
    ? { hour: 'numeric', hourCycle: 'h12' }
    : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const { date, timeZone } = labelMoment(local, zone);
  return wallFormat(locale, options, timeZone).format(date);
}

/** `6:58 AM` / `06:58` for sunrise/sunset (in the place's real local time when `zone` allows). */
export function clockLabel(local: string, locale: string | undefined, hourCycle: HourCycle, zone?: LabelZone): string {
  const { date, timeZone } = labelMoment(local, zone);
  return wallFormat(locale, { hour: 'numeric', minute: '2-digit', ...(hourCycle ? { hourCycle } : {}) }, timeZone).format(date);
}

function capitalize(text: string, locale: string | undefined): string {
  return text.length === 0 ? text : text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/** `Today`, then short weekdays (`Sat`, `Sun`, …) for a daily entry. */
export function dayLabel(date: string, todayLocal: string, locale: string | undefined): string {
  if (date === todayLocal.slice(0, 10)) {
    try {
      return capitalize(new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'day'), locale);
    } catch {
      return 'Today';
    }
  }
  return wallFormat(locale, { weekday: 'short' }).format(wallClock(date));
}

/** Long weekday + date for accessible labels (`Saturday, 27 September`). */
export function dayLongLabel(date: string, locale: string | undefined): string {
  return wallFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(wallClock(date));
}
