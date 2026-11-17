import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '@portly/shared';
import { addDays, delayText, flightsFromEvents, mergeFlights } from './model.ts';

function event(patch: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'e1',
    calendarId: 'c1',
    title: '',
    location: null,
    description: null,
    start: '2026-12-04T02:30:00Z',
    end: '2026-12-04T05:00:00Z',
    allDay: false,
    timezone: 'America/Denver',
    status: 'confirmed',
    recurring: false,
    seriesId: null,
    htmlUrl: null,
    meetingUrl: null,
    editable: false,
    ...patch,
  };
}

describe('flightsFromEvents', () => {
  it('dates a flight by the event’s start in its own zone', () => {
    // 02:30 UTC on Dec 4 is 7:30 PM on Dec 3 in Denver.
    expect(flightsFromEvents([event({ title: 'Flight UA 123' })])).toEqual([{ ident: 'UA123', date: '2026-12-03', source: 'calendar' }]);
  });

  it('reads the location too, takes all-day dates as they are, and skips cancelled events', () => {
    expect(flightsFromEvents([event({ title: 'Trip home', location: 'DL 42 ATL' })])[0]?.ident).toBe('DL42');
    expect(flightsFromEvents([event({ title: 'BA117', allDay: true, start: '2026-12-10', end: '2026-12-11' })])[0]?.date).toBe('2026-12-10');
    expect(flightsFromEvents([event({ title: 'UA 1', status: 'cancelled' })])).toEqual([]);
  });
});

describe('mergeFlights', () => {
  it('puts typed-in flights first and drops duplicates and dismissed calendar flights', () => {
    const merged = mergeFlights(
      [{ ident: 'UA1', date: '2026-12-03' }],
      [
        { ident: 'UA1', date: '2026-12-03', source: 'calendar' },
        { ident: 'DL2', date: '2026-12-04', source: 'calendar' },
        { ident: 'AA3', date: '2026-12-05', source: 'calendar' },
      ],
      ['AA3@2026-12-05'],
    );
    expect(merged).toEqual([
      { ident: 'UA1', date: '2026-12-03', source: 'manual' },
      { ident: 'DL2', date: '2026-12-04', source: 'calendar' },
    ]);
  });
});

describe('helpers', () => {
  it('formats delays and shifts dates', () => {
    expect(delayText(25)).toBe('25m');
    expect(delayText(100)).toBe('1h 40m');
    expect(delayText(120)).toBe('2h');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
