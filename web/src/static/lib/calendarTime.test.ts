/**
 * Mirrors server/src/modules/calendar/time.test.ts and the "time and zones" part of
 * providers.test.ts for the static port.
 */
import { describe, expect, it } from 'vitest';
import { addDays, startOfDayMs, syncWindow, wallTimeAt, wallToUtcMs, zoneOffsetMs, type WallTime } from './calendarTime.ts';

function wall(text: string): WallTime {
  const [date, time] = text.split(' ') as [string, string];
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return { year, month, day, hour, minute, second: 0 };
}

const two = (n: number) => String(n).padStart(2, '0');

function localText(ms: number, tz: string): string {
  const w = wallTimeAt(ms, tz);
  return `${w.year}-${two(w.month)}-${two(w.day)} ${two(w.hour)}:${two(w.minute)}`;
}

describe('wallToUtcMs', () => {
  it('converts wall times across DST', () => {
    expect(new Date(wallToUtcMs({ year: 2026, month: 3, day: 29, hour: 12, minute: 0, second: 0 }, 'Europe/Berlin')).toISOString()).toBe('2026-03-29T10:00:00.000Z');
    expect(new Date(wallToUtcMs({ year: 2026, month: 3, day: 28, hour: 12, minute: 0, second: 0 }, 'Europe/Berlin')).toISOString()).toBe('2026-03-28T11:00:00.000Z');
    expect(new Date(startOfDayMs('2026-10-01', 'Asia/Tokyo')).toISOString()).toBe('2026-09-30T15:00:00.000Z');
  });

  it.each([
    ['Europe/Berlin', '2026-03-29 02:30', '2026-03-29 03:30'],
    ['Australia/Sydney', '2026-10-04 02:30', '2026-10-04 03:30'],
    ['Africa/Cairo', '2026-04-24 00:00', '2026-04-24 01:00'],
    ['America/New_York', '2026-03-08 02:30', '2026-03-08 03:30'],
    ['Australia/Lord_Howe', '2026-10-04 02:15', '2026-10-04 02:45'],
  ])('%s %s in a DST gap moves forward by the gap to %s', (tz, input, expected) => {
    expect(localText(wallToUtcMs(wall(input), tz), tz)).toBe(expected);
  });

  it('keeps ordinary and ambiguous times valid', () => {
    expect(localText(wallToUtcMs(wall('2026-07-01 12:00'), 'Europe/Berlin'), 'Europe/Berlin')).toBe('2026-07-01 12:00');
    expect(localText(wallToUtcMs(wall('2026-10-25 02:30'), 'Europe/Berlin'), 'Europe/Berlin')).toBe('2026-10-25 02:30');
  });

  it('a day whose DST starts at midnight begins at 01:00 that day, not 23:00 the day before', () => {
    const start = startOfDayMs('2026-03-29', 'Asia/Beirut');
    expect(localText(start, 'Asia/Beirut')).toBe('2026-03-29 01:00');
    expect(zoneOffsetMs(start, 'Asia/Beirut')).toBe(3 * 3_600_000);
  });
});

describe('syncWindow', () => {
  it('covers [today-30d, today+365d) in the given zone', () => {
    const w = syncWindow(Date.parse('2026-09-25T23:30:00Z'), 'Europe/Berlin'); // already Sep 26 in Berlin
    expect(w.fromDate).toBe('2026-08-27');
    expect(w.toDate).toBe('2027-09-26');
    expect(new Date(w.fromMs).toISOString()).toBe('2026-08-26T22:00:00.000Z');
    expect(w.tz).toBe('Europe/Berlin');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
