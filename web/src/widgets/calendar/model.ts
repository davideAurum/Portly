/**
 * Calendar widget model (pure, browser-local time): date keys, visible ranges per view, agenda
 * grouping, week/month layouts, event filtering, text linkification and the event form's
 * conversions/validation. All-day events are `YYYY-MM-DD` with an exclusive end; timed events are
 * ISO instants shown in the browser's zone.
 */
import { isSafeHttpUrl, type Calendar, type CalendarEvent } from '@portly/shared';

export type CalendarView = 'agenda' | 'week' | 'month';
export type WeekStart = 0 | 1 | 6;

export const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Date keys (local)
// ---------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD` of a Date in the browser's zone. */
export function dateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight of a `YYYY-MM-DD` key. */
export function keyToDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

export function addDaysKey(key: string, days: number): string {
  const d = keyToDate(key);
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

export function daysBetweenKeys(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** First day of the week containing `key`. */
export function startOfWeekKey(key: string, weekStartsOn: WeekStart): string {
  const day = keyToDate(key).getDay();
  const diff = (day - weekStartsOn + 7) % 7;
  return addDaysKey(key, -diff);
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export interface DayRange {
  /** First day (inclusive). */
  from: string;
  /** Day after the last (exclusive). */
  to: string;
}

/** Days shown for a view around `anchor` (agenda: `days` from anchor; week; 6-week month grid). */
export function viewRange(view: CalendarView, anchor: string, days: number, weekStartsOn: WeekStart): DayRange {
  if (view === 'week') {
    const from = startOfWeekKey(anchor, weekStartsOn);
    return { from, to: addDaysKey(from, 7) };
  }
  if (view === 'month') {
    const first = `${anchor.slice(0, 8)}01`;
    const from = startOfWeekKey(first, weekStartsOn);
    return { from, to: addDaysKey(from, 42) };
  }
  return { from: anchor, to: addDaysKey(anchor, Math.max(1, Math.min(14, days))) };
}

/** The anchor after moving one page forward (+1) or back (−1). */
export function shiftAnchor(view: CalendarView, anchor: string, direction: 1 | -1, days: number): string {
  if (view === 'week') return addDaysKey(anchor, 7 * direction);
  if (view === 'month') {
    const d = keyToDate(`${anchor.slice(0, 8)}01`);
    d.setMonth(d.getMonth() + direction);
    return dateKey(d);
  }
  return addDaysKey(anchor, Math.max(1, Math.min(14, days)) * direction);
}

/** Client-side estimate of the synced window (§9) until the server reports it. */
export function estimatedSyncedWindow(today: string): DayRange {
  return { from: addDaysKey(today, -30), to: addDaysKey(today, 365) };
}

export function datesInRange(range: DayRange): string[] {
  const out: string[] = [];
  for (let key = range.from; key < range.to && out.length < 60; key = addDaysKey(key, 1)) out.push(key);
  return out;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventFilter {
  calendarIds: 'visible' | string[];
  showDeclined: boolean;
}

/** Events of the selected calendars; declined ones only when asked. */
export function filterEvents(events: readonly CalendarEvent[], calendars: ReadonlyMap<string, Calendar>, filter: EventFilter): CalendarEvent[] {
  const explicit = filter.calendarIds === 'visible' ? null : new Set(filter.calendarIds);
  return events.filter((e) => {
    const calendar = calendars.get(e.calendarId);
    if (!calendar) return e.id.startsWith('pending:');
    if (explicit ? !explicit.has(e.calendarId) : !calendar.visible) return false;
    if (e.status === 'declined' && !filter.showDeclined) return false;
    return true;
  });
}

/** Start/end instants (all-day: local midnights). */
export function eventBounds(event: CalendarEvent): { start: Date; end: Date } {
  if (event.allDay) return { start: keyToDate(event.start), end: keyToDate(event.end) };
  const start = new Date(event.start);
  const end = new Date(event.end);
  return { start, end: end.getTime() < start.getTime() ? start : end };
}

/** Days (keys) the event covers. */
export function eventDayKeys(event: CalendarEvent, limit = 62): string[] {
  if (event.allDay) {
    const out: string[] = [];
    for (let key = event.start; key < event.end && out.length < limit; key = addDaysKey(key, 1)) out.push(key);
    return out.length > 0 ? out : [event.start];
  }
  const { start, end } = eventBounds(event);
  const first = dateKey(start);
  // An event ending exactly at midnight does not cover the next day.
  const last = end.getTime() > start.getTime() ? dateKey(new Date(end.getTime() - 1)) : first;
  const out: string[] = [];
  for (let key = first; key <= last && out.length < limit; key = addDaysKey(key, 1)) out.push(key);
  return out;
}

export function overlapsDay(event: CalendarEvent, day: string): boolean {
  if (event.allDay) return event.start <= day && event.end > day;
  const { start, end } = eventBounds(event);
  const dayStart = keyToDate(day).getTime();
  const dayEnd = keyToDate(addDaysKey(day, 1)).getTime();
  if (end.getTime() === start.getTime()) return start.getTime() >= dayStart && start.getTime() < dayEnd;
  return start.getTime() < dayEnd && end.getTime() > dayStart;
}

/** All-day, or timed and covering the whole day (shown in the all-day row). */
export function isAllDayOn(event: CalendarEvent, day: string): boolean {
  if (event.allDay) return true;
  const { start, end } = eventBounds(event);
  return start.getTime() <= keyToDate(day).getTime() && end.getTime() >= keyToDate(addDaysKey(day, 1)).getTime();
}

export function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  const sa = eventBounds(a).start.getTime();
  const sb = eventBounds(b).start.getTime();
  if (sa !== sb) return sa - sb;
  const ea = eventBounds(a).end.getTime();
  const eb = eventBounds(b).end.getTime();
  if (ea !== eb) return eb - ea;
  return a.title.localeCompare(b.title);
}

export interface AgendaItem {
  event: CalendarEvent;
  /** Began on an earlier day. */
  continued: boolean;
  /** Ends on a later day. */
  continues: boolean;
  /** 1-based day of a multi-day event and its length in days (null for single-day events). */
  dayOf: { day: number; days: number } | null;
}

export interface AgendaDay {
  day: string;
  allDay: AgendaItem[];
  timed: AgendaItem[];
}

function agendaItem(event: CalendarEvent, day: string): AgendaItem {
  const keys = eventDayKeys(event);
  const index = keys.indexOf(day);
  return {
    event,
    continued: index > 0,
    continues: index >= 0 && index < keys.length - 1,
    dayOf: keys.length > 1 && index >= 0 ? { day: index + 1, days: keys.length } : null,
  };
}

/**
 * Agenda groups for `range`: days with events (plus `today` when in range, even if empty). A
 * multi-day event appears on every day it covers; whole-day spans of timed events join the
 * all-day row.
 */
export function groupAgenda(events: readonly CalendarEvent[], range: DayRange, today: string): AgendaDay[] {
  const sorted = [...events].sort(compareEvents);
  const out: AgendaDay[] = [];
  for (const day of datesInRange(range)) {
    const allDay: AgendaItem[] = [];
    const timed: AgendaItem[] = [];
    for (const event of sorted) {
      if (!overlapsDay(event, day)) continue;
      if (isAllDayOn(event, day)) allDay.push(agendaItem(event, day));
      else timed.push(agendaItem(event, day));
    }
    if (allDay.length > 0 || timed.length > 0 || day === today) out.push({ day, allDay, timed });
  }
  return out;
}

/** Index in `timed` before which the "now" marker goes (only meaningful for today). */
export function nowMarkerIndex(timed: readonly AgendaItem[], now: Date): number {
  const t = now.getTime();
  const index = timed.findIndex((item) => eventBounds(item.event).start.getTime() > t);
  return index === -1 ? timed.length : index;
}

export function isPast(event: CalendarEvent, now: Date): boolean {
  return eventBounds(event).end.getTime() <= now.getTime();
}

export function isOngoing(event: CalendarEvent, now: Date): boolean {
  const { start, end } = eventBounds(event);
  return start.getTime() <= now.getTime() && end.getTime() > now.getTime();
}

// ---------------------------------------------------------------------------
// Week view layout
// ---------------------------------------------------------------------------

export interface TimedBlock {
  event: CalendarEvent;
  /** Minutes from the day's midnight (clipped to the day). */
  startMin: number;
  endMin: number;
  column: number;
  columns: number;
}

/** Positions timed events of one day in side-by-side columns where they overlap. */
export function layoutDay(events: readonly CalendarEvent[], day: string, minDurationMin = 20): TimedBlock[] {
  const dayStart = keyToDate(day).getTime();
  const dayEnd = keyToDate(addDaysKey(day, 1)).getTime();
  const dayMinutes = Math.round((dayEnd - dayStart) / 60_000);
  const items = events
    .filter((e) => !e.allDay && overlapsDay(e, day) && !isAllDayOn(e, day))
    .map((event) => {
      const { start, end } = eventBounds(event);
      const startMin = Math.max(0, Math.round((start.getTime() - dayStart) / 60_000));
      const endMin = Math.min(dayMinutes, Math.max(startMin + minDurationMin, Math.round((end.getTime() - dayStart) / 60_000)));
      return { event, startMin, endMin, column: 0, columns: 1 };
    })
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  const out: TimedBlock[] = [];
  let cluster: TimedBlock[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const columns = cluster.reduce((max, b) => Math.max(max, b.column + 1), 1);
    for (const b of cluster) b.columns = columns;
    out.push(...cluster);
    cluster = [];
  };
  for (const item of items) {
    if (cluster.length > 0 && item.startMin >= clusterEnd) {
      flush();
      clusterEnd = -1;
    }
    const used = new Set(cluster.filter((b) => b.endMin > item.startMin).map((b) => b.column));
    let column = 0;
    while (used.has(column)) column++;
    item.column = column;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.endMin);
  }
  if (cluster.length > 0) flush();
  return out;
}

export interface SpanBar {
  event: CalendarEvent;
  /** Column index of the first covered day within `days`. */
  start: number;
  /** Number of columns. */
  span: number;
  lane: number;
  continued: boolean;
  continues: boolean;
}

/** All-day (and whole-day) events as bars over a row of consecutive days, stacked in lanes. */
export function layoutSpans(events: readonly CalendarEvent[], days: readonly string[]): SpanBar[] {
  if (days.length === 0) return [];
  const bars: SpanBar[] = [];
  const lanes: number[] = []; // last occupied column per lane
  const candidates = [...events].filter((e) => days.some((d) => overlapsDay(e, d) && isAllDayOn(e, d))).sort(compareEvents);
  for (const event of candidates) {
    const covered = days.map((d, i) => (overlapsDay(event, d) && isAllDayOn(event, d) ? i : -1)).filter((i) => i >= 0);
    const start = covered[0]!;
    const end = covered[covered.length - 1]!;
    let lane = lanes.findIndex((last) => last < start);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(end);
    } else {
      lanes[lane] = end;
    }
    const keys = eventDayKeys(event);
    bars.push({
      event,
      start,
      span: end - start + 1,
      lane,
      continued: keys[0] !== undefined && keys[0] < days[start]!,
      continues: keys[keys.length - 1] !== undefined && keys[keys.length - 1]! > days[end]!,
    });
  }
  return bars;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export type TextPart = { type: 'text'; value: string } | { type: 'link'; value: string; href: string };

const URL_REGEX = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?\]}'"»”’]/;

/** Drops sentence punctuation after a URL; keeps a `)` that closes a `(` inside it (Wikipedia). */
function trimTrailing(candidate: string): string {
  let url = candidate;
  for (;;) {
    const last = url.slice(-1);
    if (last !== '' && TRAILING_PUNCTUATION.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')' && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/** Splits text into plain parts and SafeHttpUrl links (rendered as React elements by the UI). */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_REGEX)) {
    const index = match.index ?? 0;
    const url = trimTrailing(match[0]);
    if (!isSafeHttpUrl(url)) continue;
    if (index > last) parts.push({ type: 'text', value: text.slice(last, index) });
    parts.push({ type: 'link', value: url, href: url });
    last = index + url.length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

// ---------------------------------------------------------------------------
// Event form
// ---------------------------------------------------------------------------

export interface EventFormValues {
  title: string;
  calendarId: string;
  allDay: boolean;
  /** `YYYY-MM-DD` */
  startDate: string;
  /** `HH:mm` */
  startTime: string;
  /** `YYYY-MM-DD` (all-day: the last day, inclusive) */
  endDate: string;
  endTime: string;
  location: string;
  description: string;
}

export type EventFormErrors = Partial<Record<keyof EventFormValues, string>>;

function timeKey(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Local date + `HH:mm` → Date (null when invalid). */
export function combine(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [h, m] = time.split(':').map(Number) as [number, number];
  const d = keyToDate(date);
  d.setHours(h, m, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO 8601 with the local offset, e.g. `2026-09-25T10:00:00+02:00`. */
export function isoWithOffset(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${dateKey(date)}T${timeKey(date)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** New-event defaults: the next full hour (on `day` if given, else today), one hour long. */
export function defaultFormValues(now: Date, calendarId: string, day?: string, hour?: number): EventFormValues {
  let start: Date;
  if (day !== undefined) {
    start = keyToDate(day);
    const h = hour ?? (day === dateKey(now) ? Math.min(23, now.getHours() + 1) : 9);
    start.setHours(h, 0, 0, 0);
  } else {
    start = new Date(now);
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
  }
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    title: '',
    calendarId,
    allDay: false,
    startDate: dateKey(start),
    startTime: timeKey(start),
    endDate: dateKey(end),
    endTime: timeKey(end),
    location: '',
    description: '',
  };
}

/** Form values of an existing event (all-day end shown inclusive). */
export function formValuesFromEvent(event: CalendarEvent): EventFormValues {
  if (event.allDay) {
    return {
      title: event.title,
      calendarId: event.calendarId,
      allDay: true,
      startDate: event.start,
      startTime: '09:00',
      endDate: addDaysKey(event.end, -1) >= event.start ? addDaysKey(event.end, -1) : event.start,
      endTime: '10:00',
      location: event.location ?? '',
      description: event.description ?? '',
    };
  }
  const { start, end } = eventBounds(event);
  return {
    title: event.title,
    calendarId: event.calendarId,
    allDay: false,
    startDate: dateKey(start),
    startTime: timeKey(start),
    endDate: dateKey(end),
    endTime: timeKey(end),
    location: event.location ?? '',
    description: event.description ?? '',
  };
}

export const TITLE_MAX = 500;
export const LOCATION_MAX = 1000;
export const DESCRIPTION_MAX = 8 * 1024;

export function validateEventForm(values: EventFormValues, writableIds: ReadonlySet<string>): EventFormErrors {
  const errors: EventFormErrors = {};
  const title = values.title.trim();
  if (title === '') errors.title = 'Give the event a title.';
  else if (title.length > TITLE_MAX) errors.title = `Use at most ${TITLE_MAX} characters.`;
  if (!writableIds.has(values.calendarId)) errors.calendarId = 'Choose a calendar you can add events to.';
  if (values.location.length > LOCATION_MAX) errors.location = `Use at most ${LOCATION_MAX} characters.`;
  if (values.description.length > DESCRIPTION_MAX) errors.description = 'The description is too long.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.startDate)) errors.startDate = 'Enter a start date.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.endDate)) errors.endDate = 'Enter an end date.';
  if (errors.startDate || errors.endDate) return errors;
  if (values.allDay) {
    if (values.endDate < values.startDate) errors.endDate = 'The event must end on or after its first day.';
    return errors;
  }
  const start = combine(values.startDate, values.startTime);
  const end = combine(values.endDate, values.endTime);
  if (!start) errors.startTime = 'Enter a start time.';
  if (!end) errors.endTime = 'Enter an end time.';
  if (start && end && end.getTime() <= start.getTime()) errors.endTime = 'The event must end after it starts.';
  return errors;
}

export interface EventTimes {
  allDay: boolean;
  start: string;
  end: string;
  timezone: string;
}

/** Validated form → API times (timed: ISO with offset; all-day: exclusive end date). */
export function formTimes(values: EventFormValues, timezone: string): EventTimes {
  if (values.allDay) return { allDay: true, start: values.startDate, end: addDaysKey(values.endDate, 1), timezone };
  return {
    allDay: false,
    start: isoWithOffset(combine(values.startDate, values.startTime)!),
    end: isoWithOffset(combine(values.endDate, values.endTime)!),
    timezone,
  };
}

/** True when `times` (from the form) describe exactly the event's current start/end. */
export function sameEventTimes(event: CalendarEvent, times: EventTimes): boolean {
  if (event.allDay !== times.allDay) return false;
  if (times.allDay) return event.start === times.start && event.end === times.end;
  return Date.parse(event.start) === Date.parse(times.start) && Date.parse(event.end) === Date.parse(times.end);
}

/** The calendar a new event goes to: the default (if writable), else a primary, else the first. */
export function defaultCalendarId(writable: readonly Calendar[], preferred: string | null): string {
  if (preferred && writable.some((c) => c.id === preferred)) return preferred;
  return (writable.find((c) => c.isPrimary) ?? writable[0])?.id ?? '';
}

export function providerName(calendar: Calendar | undefined): string {
  if (calendar?.source === 'google') return 'Google Calendar';
  if (calendar?.source === 'microsoft') return 'Outlook';
  return 'the provider';
}
