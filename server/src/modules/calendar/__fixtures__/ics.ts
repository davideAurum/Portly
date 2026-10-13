/** iCalendar fixtures (RFC 5545). CRLF line endings like real feeds. */

export function ics(lines: string[]): string {
  return `${lines.join('\r\n')}\r\n`;
}

export const WINDOW = {
  fromDate: '2026-08-26',
  toDate: '2027-09-25',
  fromMs: Date.parse('2026-08-26T00:00:00Z'),
  toMs: Date.parse('2027-09-25T00:00:00Z'),
};

const VTIMEZONE_NEW_YORK = [
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'TZNAME:EST',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/** Weekly series with an EXDATE, a moved (RECURRENCE-ID) and a cancelled occurrence, VTIMEZONE. */
export const RECURRING_FEED = ics([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Homebase tests//EN',
  'X-WR-CALNAME:Team',
  'X-APPLE-CALENDAR-COLOR:#FF2968',
  ...VTIMEZONE_NEW_YORK,
  'BEGIN:VEVENT',
  'UID:weekly-1@example.com',
  'DTSTAMP:20260901T000000Z',
  'DTSTART;TZID=America/New_York:20261026T090000',
  'DTEND;TZID=America/New_York:20261026T100000',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'EXDATE;TZID=America/New_York:20261102T090000',
  'SUMMARY:Planning',
  'LOCATION:Room 1',
  'DESCRIPTION:Agenda at https://example.com/agenda\\nSecond line',
  'URL:https://example.com/planning',
  'X-GOOGLE-CONFERENCE:https://meet.google.com/xyz-abcd-efg',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:weekly-1@example.com',
  'DTSTAMP:20260901T000000Z',
  'RECURRENCE-ID;TZID=America/New_York:20261109T090000',
  'DTSTART;TZID=America/New_York:20261109T140000',
  'DTEND;TZID=America/New_York:20261109T150000',
  'SUMMARY:Planning (moved)',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:weekly-1@example.com',
  'DTSTAMP:20260901T000000Z',
  'RECURRENCE-ID;TZID=America/New_York:20261116T090000',
  'DTSTART;TZID=America/New_York:20261116T090000',
  'DTEND;TZID=America/New_York:20261116T100000',
  'STATUS:CANCELLED',
  'SUMMARY:Planning',
  'END:VEVENT',
  'END:VCALENDAR',
]);

/** Windows TZID without VTIMEZONE (Outlook style), a floating event and an all-day event. */
export const MIXED_FEED = ics([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN',
  'BEGIN:VEVENT',
  'UID:win-1',
  'DTSTART;TZID=W. Europe Standard Time:20261201T090000',
  'DTEND;TZID=W. Europe Standard Time:20261201T103000',
  'SUMMARY:Windows zone',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:floating-1',
  'DTSTART:20261202T080000',
  'DTEND:20261202T090000',
  'SUMMARY:Floating',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:allday-1',
  'DTSTART;VALUE=DATE:20261224',
  'DTEND;VALUE=DATE:20261227',
  'SUMMARY:Christmas',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:allday-2',
  'DTSTART;VALUE=DATE:20261231',
  'SUMMARY:New Year’s Eve (no DTEND)',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:unknown-zone',
  'DTSTART;TZID=Mars/Olympus_Mons:20261203T080000',
  'DURATION:PT30M',
  'SUMMARY:Unknown zone is floating',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:old-1',
  'DTSTART:20200101T100000Z',
  'DTEND:20200101T110000Z',
  'SUMMARY:Outside the window',
  'END:VEVENT',
  'END:VCALENDAR',
]);

export const SECONDLY_FEED = ics([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//x//y//EN',
  'BEGIN:VEVENT',
  'UID:secondly',
  'DTSTART:20261001T100000Z',
  'DTEND:20261001T100001Z',
  'RRULE:FREQ=SECONDLY',
  'SUMMARY:Every second',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:minutely',
  'DTSTART:20261001T100000Z',
  'RRULE:FREQ=MINUTELY;INTERVAL=1',
  'SUMMARY:Every minute',
  'END:VEVENT',
  'END:VCALENDAR',
]);

export function manyVevents(count: number): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//y//EN'];
  for (let i = 0; i < count; i++) {
    lines.push('BEGIN:VEVENT', `UID:e${i}`, 'DTSTART:20261001T100000Z', 'SUMMARY:x', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return ics(lines);
}

/** A daily event that produces more instances in the window than the per-event cap. */
export const HOURLY_FEED = ics([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//x//y//EN',
  'BEGIN:VEVENT',
  'UID:hourly',
  'DTSTART:20261001T000000Z',
  'DTEND:20261001T001500Z',
  'RRULE:FREQ=HOURLY',
  'SUMMARY:Ping',
  'END:VEVENT',
  'END:VCALENDAR',
]);

export const SIMPLE_FEED = ics([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//x//y//EN',
  'X-WR-CALNAME:Holidays',
  'BEGIN:VEVENT',
  'UID:h1',
  'DTSTART;VALUE=DATE:20261003',
  'DTEND;VALUE=DATE:20261004',
  'SUMMARY:Unity Day',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:h2',
  'DTSTART:20261010T100000Z',
  'DTEND:20261010T110000Z',
  'SUMMARY:Parade',
  'END:VEVENT',
  'END:VCALENDAR',
]);
