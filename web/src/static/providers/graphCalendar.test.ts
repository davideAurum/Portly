/** Mirrors the "Microsoft Graph mappers" part of server/src/modules/calendar/providers/providers.test.ts. */
import { describe, expect, it } from 'vitest';
import { graphCalendarViewPage1, graphCalendarViewPage2, graphCalendars } from './__fixtures__/graph.ts';
import { graphEventBody, graphInstant, mapGraphCalendar, mapGraphEvent } from './graphCalendar.ts';

describe('Microsoft Graph mappers', () => {
  it('maps calendars: canEdit → writable, hexColor or preset color', () => {
    expect(graphCalendars.value.map(mapGraphCalendar)).toEqual([
      { remoteId: 'AQMkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgBGAAAD', name: 'Calendar', color: null, writable: true, primary: true },
      { remoteId: 'AQMkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgBGAAAE', name: 'Birthdays', color: '#5fb86b', writable: false, primary: false },
      { remoteId: 'AQMkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgBGAAAF', name: 'Shared', color: '#e3008c', writable: true, primary: false },
    ]);
  });

  it('maps a timed event in UTC with an HTML body, location, joinUrl and the Windows zone → IANA', () => {
    const e = mapGraphEvent(graphCalendarViewPage1.value[0], { writable: true });
    expect(e).toMatchObject({
      remoteId: 'AAMkAGI2TGuLAAA=',
      title: 'Quarterly review',
      start: '2026-09-30T13:00:00.000Z',
      end: '2026-09-30T14:30:00.000Z',
      allDay: false,
      location: 'Room 4.12',
      meetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
      htmlUrl: 'https://outlook.live.com/owa/?itemid=AAMkAGI2TGuLAAA%3D&exvsurl=1&path=/calendar/item',
      timezone: 'Europe/Berlin',
      editable: true,
      recurring: false,
    });
    expect(e?.description).toBe('Agenda:\n• Numbers\n• Plans\nJoin: Click here (https://teams.microsoft.com/l/meetup-join/abc)');
  });

  it('takes the date parts of all-day events verbatim', () => {
    const e = mapGraphEvent(graphCalendarViewPage1.value[1], { writable: true });
    expect(e).toMatchObject({ allDay: true, start: '2026-10-03', end: '2026-10-04', location: null, description: null });
  });

  it('maps occurrences, tentative/declined/cancelled and skips series masters', () => {
    const [occ, cancelled, master] = graphCalendarViewPage2.value.map((v) => mapGraphEvent(v, { writable: true }));
    expect(occ).toMatchObject({
      recurring: true,
      seriesId: 'AAMkAGI2master=',
      status: 'tentative',
      editable: false,
      meetingUrl: 'https://teams.microsoft.com/l/meetup-join/standup',
      timezone: 'America/Los_Angeles',
      description: 'Daily standup\nBe on time',
    });
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(master).toBeNull();
  });

  it('marks events of read-only calendars as not editable', () => {
    expect(mapGraphEvent(graphCalendarViewPage1.value[0], { writable: false })?.editable).toBe(false);
  });

  it('converts non-UTC dateTimeTimeZone values and builds write bodies with Windows zones', () => {
    expect(graphInstant({ dateTime: '2026-07-01T09:00:00.0000000', timeZone: 'Pacific Standard Time' })).toBe('2026-07-01T16:00:00.000Z');
    expect(graphInstant({ dateTime: '2026-07-01T09:00:00', timeZone: 'UTC' })).toBe('2026-07-01T09:00:00.000Z');
    expect(
      graphEventBody({ title: 'T', allDay: false, start: '2026-10-01T08:00:00Z', end: '2026-10-01T09:00:00Z', timezone: 'Europe/Berlin', description: 'x' }),
    ).toEqual({
      subject: 'T',
      body: { contentType: 'text', content: 'x' },
      isAllDay: false,
      start: { dateTime: '2026-10-01T10:00:00', timeZone: 'W. Europe Standard Time' },
      end: { dateTime: '2026-10-01T11:00:00', timeZone: 'W. Europe Standard Time' },
    });
    expect(graphEventBody({ allDay: true, start: '2026-10-01', end: '2026-10-02', timezone: 'Mars/Nowhere' })).toEqual({
      isAllDay: true,
      start: { dateTime: '2026-10-01T00:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-10-02T00:00:00', timeZone: 'UTC' },
    });
  });
});
