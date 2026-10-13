/**
 * Display strings for the calendar widget, formatted with the user's locale and time format
 * (`settings.general.locale` / `.timeFormat` through the Formatters).
 */
import type { CSSProperties } from 'react';
import type { Calendar, CalendarEvent } from '@homebase/shared';
import type { Formatters } from '../../lib/format.ts';
import { readableTextColor, safeColor } from '../../lib/color.ts';
import { addDaysKey, dateKey, daysBetweenKeys, eventBounds, keyToDate, type AgendaItem, type CalendarView, type DayRange } from './model.ts';

const FALLBACK_COLOR = '#64748b';

/** CSS variables for an event's calendar color (validated hex) and readable text on it. */
export function eventColorStyle(calendar: Calendar | undefined): CSSProperties {
  const color = safeColor(calendar?.color, FALLBACK_COLOR);
  return { '--event-color': color, '--event-text': readableTextColor(color) } as CSSProperties;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function dtf(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let f = formatterCache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, options);
    } catch {
      f = new Intl.DateTimeFormat(undefined, options);
    }
    if (formatterCache.size > 100) formatterCache.clear();
    formatterCache.set(key, f);
  }
  return f;
}

export function weekdayShort(key: string, fmt: Formatters): string {
  return dtf(fmt.locale, { weekday: 'short' }).format(keyToDate(key));
}

export function weekdayNarrow(key: string, fmt: Formatters): string {
  return dtf(fmt.locale, { weekday: 'narrow' }).format(keyToDate(key));
}

export function dayNumber(key: string): string {
  return String(Number(key.slice(8, 10)));
}

/** "Today", "Tomorrow", "Yesterday" or null. */
export function relativeDayName(key: string, today: string, fmt: Formatters): string | null {
  const diff = daysBetweenKeys(today, key);
  if (diff < -1 || diff > 1) return null;
  try {
    const text = new Intl.RelativeTimeFormat(fmt.locale, { numeric: 'auto' }).format(diff, 'day');
    return text.charAt(0).toLocaleUpperCase(fmt.locale) + text.slice(1);
  } catch {
    return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : 'Yesterday';
  }
}

/** Agenda day header: "Fri, Sep 25" (plus the year when not the current one). */
export function dayHeading(key: string, today: string, fmt: Formatters): string {
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return dtf(fmt.locale, { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(keyToDate(key));
}

export function fullDay(key: string, fmt: Formatters): string {
  return dtf(fmt.locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(keyToDate(key));
}

/** Toolbar label for the visible range. */
export function rangeLabel(view: CalendarView, range: DayRange, anchor: string, fmt: Formatters): string {
  if (view === 'month') return dtf(fmt.locale, { month: 'long', year: 'numeric' }).format(keyToDate(anchor));
  const first = keyToDate(range.from);
  const last = keyToDate(addDaysKey(range.to, -1));
  if (range.from === addDaysKey(range.to, -1)) return dtf(fmt.locale, { weekday: 'short', month: 'short', day: 'numeric' }).format(first);
  const f = dtf(fmt.locale, { month: 'short', day: 'numeric' });
  const withYear = first.getFullYear() !== last.getFullYear();
  if (withYear) {
    const fy = dtf(fmt.locale, { month: 'short', day: 'numeric', year: 'numeric' });
    return fy.formatRange ? fy.formatRange(first, last) : `${fy.format(first)} – ${fy.format(last)}`;
  }
  return f.formatRange ? f.formatRange(first, last) : `${f.format(first)} – ${f.format(last)}`;
}

/** Start/end lines for an agenda row on `day`. */
export function agendaTimes(item: AgendaItem, fmt: Formatters): { start: string; end: string | null } {
  const { start, end } = eventBounds(item.event);
  if (item.continued && !item.continues) return { start: 'Until', end: fmt.time(end) };
  if (!item.continued && item.continues) return { start: fmt.time(start), end: '→' };
  if (end.getTime() === start.getTime()) return { start: fmt.time(start), end: null };
  return { start: fmt.time(start), end: fmt.time(end) };
}

/** "10:00 – 11:30" for compact blocks. */
export function timeRange(event: CalendarEvent, fmt: Formatters): string {
  const { start, end } = eventBounds(event);
  if (end.getTime() === start.getTime()) return fmt.time(start);
  return `${fmt.time(start)} – ${fmt.time(end)}`;
}

/** Popover "when" line: date(s) and time range per locale and time format. */
export function whenLabel(event: CalendarEvent, fmt: Formatters): string {
  if (event.allDay) {
    const last = addDaysKey(event.end, -1);
    if (last <= event.start) return `${fullDay(event.start, fmt)} · All day`;
    const f = dtf(fmt.locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const a = keyToDate(event.start);
    const b = keyToDate(last);
    return `${f.formatRange ? f.formatRange(a, b) : `${f.format(a)} – ${f.format(b)}`} · All day`;
  }
  const { start, end } = eventBounds(event);
  if (dateKey(start) === dateKey(new Date(Math.max(start.getTime(), end.getTime() - 1)))) {
    return `${fullDay(dateKey(start), fmt)} · ${timeRange(event, fmt)}`;
  }
  return `${fmt.dateTime(start)} – ${fmt.dateTime(end)}`;
}

/** Accessible name for an event button. */
export function eventAriaLabel(event: CalendarEvent, calendar: Calendar | undefined, fmt: Formatters): string {
  const status = event.status === 'cancelled' ? ', cancelled' : event.status === 'declined' ? ', declined' : event.status === 'tentative' ? ', tentative' : '';
  return `${event.title}, ${whenLabel(event, fmt)}${calendar ? `, ${calendar.name}` : ''}${status}`;
}
