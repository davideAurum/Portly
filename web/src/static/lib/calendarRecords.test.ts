/**
 * Mirrors the "ids, sanitization and text" part of
 * server/src/modules/calendar/providers/providers.test.ts for the static port, plus the API
 * mapping of stored rows.
 */
import { describe, expect, it } from 'vitest';
import { eventId, fallbackColor, sanitizeEvent, toCalendar, toCalendarEvent, toEventRow, type CalendarRow, type EventRecord } from './calendarRecords.ts';

const record: EventRecord = {
  remoteId: 'r',
  instanceKey: null,
  etag: null,
  title: `  ${'x'.repeat(600)}  `,
  location: '\u0000Somewhere\n   else',
  description: 'a\r\n\r\n\r\n\r\nb',
  start: '2026-10-01T10:00:00+02:00',
  end: '2026-10-01T09:00:00+02:00',
  allDay: false,
  timezone: 'Not/AZone',
  status: 'bogus' as never,
  recurring: false,
  seriesId: null,
  htmlUrl: 'https://user:pw@example.com/',
  meetingUrl: 'https://example.com/meet',
  editable: true,
};

function calendarRow(overrides: Partial<CalendarRow> = {}): CalendarRow {
  return {
    id: 'cal',
    account_id: 'acc',
    source: 'microsoft',
    remote_id: 'remote',
    name: 'Calendar',
    color: null,
    color_override: null,
    provider_writable: 1,
    user_read_only: 0,
    visible: 1,
    is_primary: 1,
    sort: 0,
    display_url: null,
    collection_url: null,
    sync_state: null,
    last_synced_at: null,
    last_error: null,
    ...overrides,
  };
}

describe('event ids', () => {
  it('match the server: `${calendarId}:${sha1(remoteId|instanceKey)}`', async () => {
    expect(await eventId('cal', 'uid-1', null)).toBe('cal:2ff2cfd576779f94dbc303644ce0cd6d295b079f');
    expect(await eventId('cal', 'uid-1', '2026-10-01T10:00:00.000Z')).toBe('cal:2fa259518afe783e7b280e7d7fc1420b005de555');
    expect(await eventId('other', 'uid-1', null)).toBe('other:2ff2cfd576779f94dbc303644ce0cd6d295b079f');
  });
});

describe('sanitizeEvent', () => {
  it('caps text, applies defaults, normalizes times and drops invalid zones and URLs', async () => {
    const clean = (await sanitizeEvent('cal', record))!;
    expect(clean.title).toHaveLength(500);
    expect(clean.location).toBe('Somewhere else');
    expect(clean.description).toBe('a\n\nb');
    expect(clean.start).toBe('2026-10-01T08:00:00.000Z');
    expect(clean.end).toBe(clean.start);
    expect(clean.timezone).toBeNull();
    expect(clean.status).toBe('confirmed');
    expect(clean.htmlUrl).toBeNull();
    expect(clean.meetingUrl).toBe('https://example.com/meet');
    expect(await sanitizeEvent('cal', { ...clean, allDay: true, start: '2026-10-01', end: '2026-10-01' })).toMatchObject({ end: '2026-10-02' });
    expect((await sanitizeEvent('cal', { ...clean, title: '   ' }))?.title).toBe('(No title)');
    expect(await sanitizeEvent('cal', { ...clean, start: 'garbage' })).toBeNull();
    expect(await sanitizeEvent('cal', { ...clean, remoteId: '' })).toBeNull();
  });
});

describe('API mapping', () => {
  it('resolves calendar color override > provider > account > palette, and writability', () => {
    expect(toCalendar(calendarRow({ color: '#112233', color_override: '#AABBCC' }), '#445566')).toMatchObject({ color: '#aabbcc', colorOverride: '#aabbcc' });
    expect(toCalendar(calendarRow({ color: '#112233' }), '#445566').color).toBe('#112233');
    expect(toCalendar(calendarRow(), '#445566').color).toBe('#445566');
    expect(toCalendar(calendarRow()).color).toBe(fallbackColor('cal'));
    expect(toCalendar(calendarRow()).writable).toBe(true);
    expect(toCalendar(calendarRow({ user_read_only: 1 })).writable).toBe(false);
    expect(toCalendar(calendarRow({ last_synced_at: Date.parse('2026-10-01T08:00:00Z') })).lastSyncedAt).toBe('2026-10-01T08:00:00.000Z');
  });

  it('round-trips a sanitized event through its stored row; editable needs a writable calendar', async () => {
    const clean = (await sanitizeEvent('cal', { ...record, title: 'Lunch', htmlUrl: null }))!;
    const row = toEventRow('cal', clean, 1);
    expect(toCalendarEvent(row, calendarRow())).toEqual({
      id: clean.id,
      calendarId: 'cal',
      title: 'Lunch',
      location: 'Somewhere else',
      description: 'a\n\nb',
      start: '2026-10-01T08:00:00.000Z',
      end: '2026-10-01T08:00:00.000Z',
      allDay: false,
      timezone: null,
      status: 'confirmed',
      recurring: false,
      seriesId: null,
      htmlUrl: null,
      meetingUrl: 'https://example.com/meet',
      editable: true,
    });
    expect(toCalendarEvent(row, calendarRow({ user_read_only: 1 })).editable).toBe(false);
  });
});
