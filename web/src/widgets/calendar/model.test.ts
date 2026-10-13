import { describe, expect, it } from 'vitest';
import type { Calendar, CalendarEvent } from '@homebase/shared';
import {
  addDaysKey,
  dateKey,
  defaultCalendarId,
  defaultFormValues,
  filterEvents,
  formTimes,
  formValuesFromEvent,
  groupAgenda,
  isoWithOffset,
  layoutDay,
  layoutSpans,
  linkify,
  nowMarkerIndex,
  sameEventTimes,
  shiftAnchor,
  validateEventForm,
  viewRange,
  type EventFormValues,
} from './model.ts';

/** A local wall time as an ISO instant (tests are independent of the machine's zone). */
function at(y: number, m: number, d: number, h = 0, min = 0): string {
  return new Date(y, m - 1, d, h, min).toISOString();
}

function ev(id: string, patch: Partial<CalendarEvent>): CalendarEvent {
  return {
    id,
    calendarId: 'c1',
    title: id,
    location: null,
    description: null,
    start: at(2026, 9, 25, 10),
    end: at(2026, 9, 25, 11),
    allDay: false,
    timezone: null,
    status: 'confirmed',
    recurring: false,
    seriesId: null,
    htmlUrl: null,
    meetingUrl: null,
    editable: false,
    ...patch,
  };
}

function cal(id: string, patch: Partial<Calendar> = {}): Calendar {
  return {
    id,
    accountId: 'a1',
    source: 'google',
    name: id,
    color: '#3b82f6',
    writable: true,
    providerWritable: true,
    userReadOnly: false,
    visible: true,
    isPrimary: false,
    sort: 0,
    displayUrl: null,
    lastSyncedAt: null,
    lastError: null,
    ...patch,
  };
}

describe('ranges and navigation', () => {
  it('computes agenda, week (per weekStartsOn) and 6-week month ranges', () => {
    expect(viewRange('agenda', '2026-09-25', 7, 1)).toEqual({ from: '2026-09-25', to: '2026-10-02' });
    expect(viewRange('agenda', '2026-09-25', 40, 1)).toEqual({ from: '2026-09-25', to: '2026-10-09' });
    // Friday Sep 25, 2026: Monday-start week begins Sep 21, Sunday-start Sep 20, Saturday-start Sep 19.
    expect(viewRange('week', '2026-09-25', 7, 1)).toEqual({ from: '2026-09-21', to: '2026-09-28' });
    expect(viewRange('week', '2026-09-25', 7, 0)).toEqual({ from: '2026-09-20', to: '2026-09-27' });
    expect(viewRange('week', '2026-09-25', 7, 6)).toEqual({ from: '2026-09-19', to: '2026-09-26' });
    expect(viewRange('month', '2026-09-25', 7, 1)).toEqual({ from: '2026-08-31', to: '2026-10-12' });
  });

  it('moves by a page', () => {
    expect(shiftAnchor('agenda', '2026-09-25', 1, 3)).toBe('2026-09-28');
    expect(shiftAnchor('week', '2026-09-25', -1, 7)).toBe('2026-09-18');
    expect(shiftAnchor('month', '2026-01-31', 1, 7)).toBe('2026-02-01');
    expect(shiftAnchor('month', '2026-01-15', -1, 7)).toBe('2025-12-01');
    expect(addDaysKey('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('agenda grouping', () => {
  const range = { from: '2026-09-25', to: '2026-09-29' };

  it('groups by day with all-day first, multi-day spans on every day and today always present', () => {
    const events = [
      ev('late', { start: at(2026, 9, 26, 22), end: at(2026, 9, 27, 1) }),
      ev('trip', { allDay: true, start: '2026-09-26', end: '2026-09-28' }),
      ev('morning', { start: at(2026, 9, 26, 8), end: at(2026, 9, 26, 9) }),
      ev('long', { start: at(2026, 9, 27, 9), end: at(2026, 9, 29, 12) }),
    ];
    const days = groupAgenda(events, range, '2026-09-25');
    expect(days.map((d) => [d.day, d.allDay.map((i) => i.event.id), d.timed.map((i) => i.event.id)])).toEqual([
      ['2026-09-25', [], []],
      ['2026-09-26', ['trip'], ['morning', 'late']],
      ['2026-09-27', ['trip'], ['late', 'long']],
      ['2026-09-28', ['long'], []], // covers the whole day → all-day row
    ]);
    const trip = days[1]!.allDay[0]!;
    expect(trip).toMatchObject({ continued: false, continues: true, dayOf: { day: 1, days: 2 } });
    const lateNextDay = days[2]!.timed[0]!;
    expect(lateNextDay).toMatchObject({ continued: true, continues: false });
  });

  it('does not put an event ending at midnight on the next day', () => {
    const days = groupAgenda([ev('eve', { start: at(2026, 9, 26, 20), end: at(2026, 9, 27, 0) })], range, '2026-09-25');
    expect(days.map((d) => d.day)).toEqual(['2026-09-25', '2026-09-26']);
  });

  it('places the now marker before the first event that starts later', () => {
    const [today] = groupAgenda(
      [ev('a', { start: at(2026, 9, 25, 9), end: at(2026, 9, 25, 10) }), ev('b', { start: at(2026, 9, 25, 15), end: at(2026, 9, 25, 16) })],
      range,
      '2026-09-25',
    );
    expect(nowMarkerIndex(today!.timed, new Date(2026, 8, 25, 12))).toBe(1);
    expect(nowMarkerIndex(today!.timed, new Date(2026, 8, 25, 20))).toBe(2);
  });

  it('filters by calendar selection and declined status', () => {
    const calendars = new Map([
      ['c1', cal('c1')],
      ['c2', cal('c2', { visible: false })],
    ]);
    const events = [ev('a', {}), ev('b', { calendarId: 'c2' }), ev('d', { status: 'declined' }), ev('x', { calendarId: 'gone' })];
    expect(filterEvents(events, calendars, { calendarIds: 'visible', showDeclined: false }).map((e) => e.id)).toEqual(['a']);
    expect(filterEvents(events, calendars, { calendarIds: ['c2'], showDeclined: true }).map((e) => e.id)).toEqual(['b']);
    expect(filterEvents(events, calendars, { calendarIds: 'visible', showDeclined: true }).map((e) => e.id)).toEqual(['a', 'd']);
  });
});

describe('week layout', () => {
  it('puts overlapping events side by side and clips to the day', () => {
    const blocks = layoutDay(
      [
        ev('a', { start: at(2026, 9, 25, 9), end: at(2026, 9, 25, 11) }),
        ev('b', { start: at(2026, 9, 25, 10), end: at(2026, 9, 25, 12) }),
        ev('c', { start: at(2026, 9, 25, 11), end: at(2026, 9, 25, 12) }),
        ev('d', { start: at(2026, 9, 25, 14), end: at(2026, 9, 25, 14) }),
        ev('night', { start: at(2026, 9, 24, 23), end: at(2026, 9, 25, 1) }),
      ],
      '2026-09-25',
    );
    const byId = Object.fromEntries(blocks.map((b) => [b.event.id, b]));
    expect(byId.night).toMatchObject({ startMin: 0, endMin: 60, columns: 1 });
    expect(byId.a).toMatchObject({ startMin: 540, column: 0, columns: 2 });
    expect(byId.b).toMatchObject({ column: 1, columns: 2 });
    expect(byId.c).toMatchObject({ column: 0, columns: 2 });
    expect(byId.d).toMatchObject({ startMin: 840, endMin: 860, columns: 1 }); // minimum height
  });

  it('stacks all-day spans in lanes across the week', () => {
    const days = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'];
    const bars = layoutSpans(
      [
        ev('span', { allDay: true, start: '2026-09-19', end: '2026-09-23' }),
        ev('one', { allDay: true, start: '2026-09-22', end: '2026-09-23' }),
        ev('later', { allDay: true, start: '2026-09-24', end: '2026-10-02' }),
      ],
      days,
    );
    expect(bars.map((b) => [b.event.id, b.start, b.span, b.lane, b.continued, b.continues])).toEqual([
      ['span', 0, 2, 0, true, false],
      ['one', 1, 1, 1, false, false],
      ['later', 3, 4, 0, false, true],
    ]);
  });
});

describe('linkify', () => {
  it('links only http(s) URLs as parts, trimming trailing punctuation', () => {
    expect(linkify('See https://example.com/a?b=1, then (https://en.wikipedia.org/wiki/Foo_(bar)). javascript:alert(1)')).toEqual([
      { type: 'text', value: 'See ' },
      { type: 'link', value: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { type: 'text', value: ', then (' },
      { type: 'link', value: 'https://en.wikipedia.org/wiki/Foo_(bar)', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
      { type: 'text', value: '). javascript:alert(1)' },
    ]);
    expect(linkify('https://user:pw@evil.example/')).toEqual([{ type: 'text', value: 'https://user:pw@evil.example/' }]);
    expect(linkify('<script>alert(1)</script>')).toEqual([{ type: 'text', value: '<script>alert(1)</script>' }]);
  });
});

describe('event form', () => {
  const base: EventFormValues = {
    title: 'Lunch',
    calendarId: 'c1',
    allDay: false,
    startDate: '2026-09-25',
    startTime: '12:00',
    endDate: '2026-09-25',
    endTime: '13:00',
    location: '',
    description: '',
  };
  const writable = new Set(['c1']);

  it('validates title, calendar and end after start', () => {
    expect(validateEventForm(base, writable)).toEqual({});
    expect(validateEventForm({ ...base, title: '  ' }, writable)).toHaveProperty('title');
    expect(validateEventForm({ ...base, calendarId: 'ro' }, writable)).toHaveProperty('calendarId');
    expect(validateEventForm({ ...base, endTime: '12:00' }, writable)).toEqual({ endTime: 'The event must end after it starts.' });
    expect(validateEventForm({ ...base, endDate: '2026-09-24', endTime: '18:00' }, writable)).toHaveProperty('endTime');
    expect(validateEventForm({ ...base, allDay: true, endDate: '2026-09-25' }, writable)).toEqual({});
    expect(validateEventForm({ ...base, allDay: true, endDate: '2026-09-24' }, writable)).toHaveProperty('endDate');
    expect(validateEventForm({ ...base, startDate: '' }, writable)).toHaveProperty('startDate');
  });

  it('converts to API times: ISO with the local offset, all-day end exclusive', () => {
    const timed = formTimes(base, 'Europe/Berlin');
    expect(timed.allDay).toBe(false);
    expect(Date.parse(timed.start)).toBe(new Date(2026, 8, 25, 12).getTime());
    expect(timed.start).toMatch(/^2026-09-25T12:00:00[+-]\d{2}:\d{2}$/);
    expect(formTimes({ ...base, allDay: true, endDate: '2026-09-27' }, 'UTC')).toEqual({ allDay: true, start: '2026-09-25', end: '2026-09-28', timezone: 'UTC' });
    expect(isoWithOffset(new Date(2026, 0, 1, 9, 5))).toMatch(/^2026-01-01T09:05:00[+-]\d{2}:\d{2}$/);
  });

  it('defaults to the next full hour, one hour long; edits show the all-day end inclusively', () => {
    const values = defaultFormValues(new Date(2026, 8, 25, 10, 20), 'c1');
    expect(values).toMatchObject({ startDate: '2026-09-25', startTime: '11:00', endDate: '2026-09-25', endTime: '12:00', allDay: false });
    expect(defaultFormValues(new Date(2026, 8, 25, 23, 30), 'c1')).toMatchObject({ startDate: '2026-09-26', startTime: '00:00' });
    expect(defaultFormValues(new Date(2026, 8, 25, 10), 'c1', '2026-09-28', 14)).toMatchObject({ startDate: '2026-09-28', startTime: '14:00', endTime: '15:00' });
    expect(formValuesFromEvent(ev('x', { allDay: true, start: '2026-10-01', end: '2026-10-04' }))).toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-03' });
    expect(dateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('detects unchanged times so an edit does not re-send them', () => {
    const timed = ev('t', { start: at(2026, 9, 25, 12), end: at(2026, 9, 25, 13) });
    expect(sameEventTimes(timed, formTimes(formValuesFromEvent(timed), 'Europe/Berlin'))).toBe(true);
    expect(sameEventTimes(timed, formTimes({ ...formValuesFromEvent(timed), endTime: '13:30' }, 'Europe/Berlin'))).toBe(false);
    expect(sameEventTimes(timed, formTimes({ ...formValuesFromEvent(timed), allDay: true }, 'Europe/Berlin'))).toBe(false);
    const allDay = ev('a', { allDay: true, start: '2026-10-01', end: '2026-10-04' });
    expect(sameEventTimes(allDay, formTimes(formValuesFromEvent(allDay), 'UTC'))).toBe(true);
    expect(sameEventTimes(allDay, formTimes({ ...formValuesFromEvent(allDay), endDate: '2026-10-04' }, 'UTC'))).toBe(false);
  });

  it('picks the default calendar: configured if writable, else primary, else first', () => {
    const list = [cal('a'), cal('b', { isPrimary: true })];
    expect(defaultCalendarId(list, 'a')).toBe('a');
    expect(defaultCalendarId(list, 'missing')).toBe('b');
    expect(defaultCalendarId([cal('z')], null)).toBe('z');
    expect(defaultCalendarId([], null)).toBe('');
  });
});
