/** Shared state of one calendar widget instance (calendars, clock, formatters, actions). */
import { createContext, useContext } from 'react';
import type { Calendar, CalendarEvent } from '@portly/shared';
import type { Formatters } from '../../lib/format.ts';

export interface CalendarWidgetContextValue {
  calendars: ReadonlyMap<string, Calendar>;
  now: Date;
  today: string;
  fmt: Formatters;
  /** A writable calendar exists (enables "+" and slot clicks). */
  canCreate: boolean;
  createEvent(day?: string, hour?: number): void;
  editEvent(event: CalendarEvent): void;
  deleteEvent(event: CalendarEvent): void;
}

export const CalendarWidgetContext = createContext<CalendarWidgetContextValue | null>(null);

export function useCalendarWidget(): CalendarWidgetContextValue {
  const value = useContext(CalendarWidgetContext);
  if (!value) throw new Error('useCalendarWidget outside CalendarWidgetContext');
  return value;
}
