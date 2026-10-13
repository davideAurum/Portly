import { describe, expect, it } from 'vitest';
import { startOfDayMs, wallTimeAt, wallToUtcMs, zoneOffsetMs, type WallTime } from './time.ts';

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

describe('wallToUtcMs in DST gaps (TZ-1)', () => {
  it.each([
    ['Europe/Berlin', '2026-03-29 02:30', '2026-03-29 03:30'],
    ['Australia/Sydney', '2026-10-04 02:30', '2026-10-04 03:30'],
    ['Africa/Cairo', '2026-04-24 00:00', '2026-04-24 01:00'],
    ['America/New_York', '2026-03-08 02:30', '2026-03-08 03:30'],
    ['Australia/Lord_Howe', '2026-10-04 02:15', '2026-10-04 02:45'],
  ])('%s %s moves forward by the gap to %s', (tz, input, expected) => {
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

  it('every valid local time around the 2026 transitions round-trips in zones east and west of UTC', () => {
    const spans = [
      [Date.UTC(2026, 2, 5), Date.UTC(2026, 3, 30)],
      [Date.UTC(2026, 8, 25), Date.UTC(2026, 10, 5)],
    ] as const;
    for (const tz of ['Europe/Berlin', 'America/New_York', 'Africa/Cairo', 'Asia/Beirut', 'Australia/Sydney', 'America/Santiago']) {
      for (const [from, to] of spans) {
        for (let ms = from; ms < to; ms += 60 * 60_000) {
          expect(localText(wallToUtcMs(wallTimeAt(ms, tz), tz), tz), tz).toBe(localText(ms, tz));
        }
      }
    }
  }, 30_000);
});
