/**
 * Pure helpers of the Todoist widget: filter presets, due-date classification and labels, task
 * sorting and markdown-ish content → plain text. No React, no DOM — easy to test.
 */
import type { Task, TaskDue } from '@homebase/shared';
import type { Formatters } from '../../lib/format.ts';

// ---------------------------------------------------------------------------
// Filter presets
// ---------------------------------------------------------------------------

export interface FilterPreset {
  label: string;
  query: string;
}

/** Common Todoist filter queries (Todoist filter syntax). */
export const FILTER_PRESETS: readonly FilterPreset[] = Object.freeze([
  { label: 'Today', query: 'today | overdue' },
  { label: 'Overdue', query: 'overdue' },
  { label: 'Next 7 days', query: '7 days' },
  { label: 'No date', query: 'no date' },
  { label: 'Priority 1', query: 'p1' },
]);

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The preset matching a query (case/whitespace-insensitive), if any. */
export function presetFor(query: string): FilterPreset | undefined {
  const q = normalizeQuery(query);
  return FILTER_PRESETS.find((p) => normalizeQuery(p.query) === q);
}

/** Heading for a list: the configured title, else the preset name, else the query itself. */
export function listTitle(title: string | undefined, filter: string): string {
  const custom = title?.trim();
  if (custom) return custom;
  return presetFor(filter)?.label ?? filter;
}

// ---------------------------------------------------------------------------
// Due dates
// ---------------------------------------------------------------------------

export type DueStatus = 'overdue' | 'today' | 'tomorrow' | 'upcoming';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight of a `YYYY-MM-DD` date (null when malformed). */
export function localDay(date: string): Date | null {
  const m = DATE_ONLY.exec(date);
  if (!m) return null;
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(day.getTime()) ? null : day;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * The instant of a timed due date. Floating times (no zone) are read as local wall time, which is
 * what `new Date('YYYY-MM-DDTHH:MM:SS')` does; fixed times carry `Z` or an offset.
 */
export function dueInstant(due: TaskDue): Date | null {
  if (!due.datetime) return null;
  const instant = new Date(due.datetime);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/** The local calendar day the task is due on. */
export function dueDay(due: TaskDue): Date | null {
  const instant = dueInstant(due);
  return instant ? startOfDay(instant) : localDay(due.date);
}

/** Whole days from today (local) to the due day: 0 today, 1 tomorrow, -1 yesterday. */
export function dayOffset(due: TaskDue, now: Date): number | null {
  const day = dueDay(due);
  if (!day) return null;
  return Math.round((day.getTime() - startOfDay(now).getTime()) / DAY_MS);
}

export function dueStatus(due: TaskDue, now: Date): DueStatus {
  const instant = dueInstant(due);
  if (instant && instant.getTime() < now.getTime()) return 'overdue';
  const offset = dayOffset(due, now);
  if (offset === null) return 'upcoming';
  if (offset < 0) return 'overdue';
  if (offset === 0) return 'today';
  if (offset === 1) return 'tomorrow';
  return 'upcoming';
}

function capitalize(text: string, locale: string | undefined): string {
  return text.length === 0 ? text : text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

function weekday(date: Date, locale: string | undefined): string {
  const key = locale ?? '';
  let formatter = weekdayFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { weekday: 'long' });
    weekdayFormatters.set(key, formatter);
  }
  return formatter.format(date);
}

/**
 * Short, locale-aware due label: "Today" / "14:30", "Tomorrow 09:00", "Yesterday", "Friday",
 * "12 Oct", "3 Jan 2027".
 */
export function formatDue(due: TaskDue, now: Date, fmt: Pick<Formatters, 'locale' | 'time' | 'date'>): string {
  const day = dueDay(due);
  if (!day) return due.string || due.date;
  const instant = dueInstant(due);
  const offset = dayOffset(due, now) ?? 0;
  const time = instant ? fmt.time(instant) : null;

  let dayLabel: string;
  if (offset >= -1 && offset <= 1) {
    const rtf = new Intl.RelativeTimeFormat(fmt.locale, { numeric: 'auto' });
    dayLabel = capitalize(rtf.format(offset, 'day'), fmt.locale);
  } else if (offset > 1 && offset < 7) {
    dayLabel = capitalize(weekday(day, fmt.locale), fmt.locale);
  } else if (day.getFullYear() === now.getFullYear()) {
    dayLabel = fmt.date(day, 'day-month');
  } else {
    dayLabel = fmt.date(day, 'medium');
  }

  if (time === null) return dayLabel;
  return offset === 0 ? time : `${dayLabel} ${time}`;
}

/** Sort key: timed tasks by instant, all-day tasks at the start of their day; no due date → null. */
export function dueSortKey(due: TaskDue | null): number | null {
  if (!due) return null;
  const instant = dueInstant(due);
  if (instant) return instant.getTime();
  return localDay(due.date)?.getTime() ?? null;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type TaskSort = 'todoist' | 'due' | 'priority';

function compareDue(a: Task, b: Task): number {
  const ka = dueSortKey(a.due);
  const kb = dueSortKey(b.due);
  if (ka === kb) return 0;
  if (ka === null) return 1;
  if (kb === null) return -1;
  return ka - kb;
}

/**
 * `todoist` keeps Todoist's own order; `due` puts the earliest first (no date last), then higher
 * priority; `priority` puts p1 first, then the earliest due date. Ties keep Todoist's order.
 */
export function sortTasks(tasks: readonly Task[], sort: TaskSort): Task[] {
  if (sort === 'todoist') return [...tasks];
  const indexed = tasks.map((task, index) => ({ task, index }));
  indexed.sort((x, y) => {
    const byPriority = y.task.priority - x.task.priority;
    const byDue = compareDue(x.task, y.task);
    const primary = sort === 'due' ? byDue || byPriority : byPriority || byDue;
    return primary || x.index - y.index;
  });
  return indexed.map((entry) => entry.task);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Todoist priority 4 is "p1" (urgent) … 1 is "p4" (normal). */
export function priorityLabel(priority: Task['priority']): string {
  return `Priority ${5 - priority}`;
}

/**
 * Todoist content is lightly formatted Markdown. We show plain text only (never HTML): links
 * `[label](url)` and the legacy `url (label)` become their label, and emphasis/code markers are
 * dropped. Everything is rendered as React text, so nothing here can inject markup.
 */
export function plainTaskText(text: string): string {
  return (
    text
      // [label](https://…) — balanced parentheses one level deep inside the URL. The label can't
      // contain `[`, so a run of brackets (task text can come from shared projects) stays linear.
      .replace(/\[([^[\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g, (_m, label: string, url: string) => label.trim() || url)
      // Legacy Todoist link syntax: https://example.com (Label)
      .replace(/\bhttps?:\/\/[^\s()]+ \(([^()\n]+)\)/g, '$1')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/~~([^~\n]+)~~/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/(^|[\s([{])\*([^*\s][^*\n]*?)\*(?=$|[\s)\]}.,!?:;])/g, '$1$2')
      .replace(/(^|[\s([{])_([^_\s][^_\n]*?)_(?=$|[\s)\]}.,!?:;])/g, '$1$2')
      .replace(/^#{1,6}\s+/, '')
  );
}

/** Longest description line considered for the one-line preview (it is ellipsized anyway). */
export const DESCRIPTION_PREVIEW_CHARS = 300;

/** First non-empty line of a description, as plain text (at most {@link DESCRIPTION_PREVIEW_CHARS} of it). */
export function descriptionPreview(description: string): string {
  const match = /\S[^\r\n]*/.exec(description);
  if (!match) return '';
  return plainTaskText(match[0].slice(0, DESCRIPTION_PREVIEW_CHARS).trim());
}
