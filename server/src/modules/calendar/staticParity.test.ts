/**
 * The browser-only build carries ports of this module's pure code (web/src/static/lib/calendar*.ts,
 * windowsZones.ts, htmlScan.ts and providers/graphCalendar.ts). This test runs both versions on
 * the same inputs so a change to one side that is not made to the other fails here.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as webRecords from '../../../../web/src/static/lib/calendarRecords.ts';
import * as webText from '../../../../web/src/static/lib/calendarText.ts';
import * as webTime from '../../../../web/src/static/lib/calendarTime.ts';
import * as webZones from '../../../../web/src/static/lib/windowsZones.ts';
import * as webGraph from '../../../../web/src/static/providers/graphCalendar.ts';
import { graphCalendarViewPage1, graphCalendarViewPage2, graphCalendars } from './__fixtures__/providers.ts';
import * as graph from './providers/microsoft.ts';
import * as store from './store.ts';
import * as text from './text.ts';
import * as time from './time.ts';
import type { EventRecord } from './types.ts';
import * as zones from './windows-zones.ts';

const ZONES_JSON = new URL('./data/windowsZones.json', import.meta.url);
const WEB_ZONES_JSON = new URL('../../../../web/src/static/lib/windowsZones.json', import.meta.url);

const DESCRIPTIONS = [
  '<p>Agenda</p><ul><li>One</li><li>Two <i>italic</i></li></ul>',
  'Fish &amp; chips',
  'R&amp;D\nnext line',
  '<a href="https://meet.example.com/x">Join</a> <a href="javascript:alert(1)">x</a>',
  '<table><tr><td>A</td><td>B</td></tr></table><pre>keep\n  these</pre>',
  '<!DOCTYPE html><html><head><title>T</title></head><body><p>Visible</p><script>alert(1)</script></body></html>',
  `start${'<div>'.repeat(2_000)}end`,
  'a  \n\n\n\n\nb\t \n\u0000c​',
  'x'.repeat(20_000),
];

const ZONES = ['Europe/Berlin', 'America/New_York', 'Asia/Beirut', 'Australia/Lord_Howe', 'Asia/Kolkata', 'UTC', 'Pacific/Chatham'];

function graphItems(): unknown[] {
  return [...graphCalendarViewPage1.value, ...graphCalendarViewPage2.value];
}

describe('static calendar ports match the server', () => {
  it('bundles the same CLDR windowsZones table', () => {
    expect(fs.readFileSync(WEB_ZONES_JSON, 'utf8')).toBe(fs.readFileSync(ZONES_JSON, 'utf8'));
  });

  it('resolves every Windows and IANA zone of the table the same way', () => {
    const data = JSON.parse(fs.readFileSync(ZONES_JSON, 'utf8')) as { windows: Record<string, string>; ianaToWindows: Record<string, string> };
    expect(webZones.WINDOWS_ZONE_COUNT).toBe(zones.WINDOWS_ZONE_COUNT);
    for (const name of [...Object.keys(data.windows), ...Object.keys(data.ianaToWindows), 'Asia/Kolkata', 'Europe/Kyiv', 'Z', '"Tokyo Standard Time"', 'Nowhere/X']) {
      expect(webZones.resolveTimeZoneName(name), name).toBe(zones.resolveTimeZoneName(name));
      expect(webZones.ianaToWindows(name), name).toBe(zones.ianaToWindows(name));
      expect(webZones.windowsToIana(name), name).toBe(zones.windowsToIana(name));
    }
  });

  it('computes the same wall times, day starts and sync windows', () => {
    const instants = [Date.parse('2026-03-29T00:30:00Z'), Date.parse('2026-09-25T23:30:00Z'), Date.parse('2026-10-04T15:45:00Z'), Date.parse('2027-01-01T00:00:00Z')];
    for (const tz of ZONES) {
      for (const ms of instants) {
        expect(webTime.wallTimeAt(ms, tz)).toEqual(time.wallTimeAt(ms, tz));
        expect(webTime.syncWindow(ms, tz)).toEqual(time.syncWindow(ms, tz));
        const w = time.wallTimeAt(ms, tz);
        expect(webTime.wallToUtcMs(w, tz)).toBe(time.wallToUtcMs(w, tz));
      }
      expect(webTime.startOfDayMs('2026-03-29', tz)).toBe(time.startOfDayMs('2026-03-29', tz));
    }
    for (const value of ['2026-10-01T10:00:00+02:00', '2026-10-01', 'garbage', 42]) {
      expect(webTime.normalizeInstant(value)).toBe(time.normalizeInstant(value));
    }
  });

  it('cleans event text the same way', () => {
    for (const value of DESCRIPTIONS) {
      for (const format of ['auto', 'auto-tags', 'html', 'text'] as const) {
        expect(webText.descriptionText(value, 8_192, format), `${format} ${value.slice(0, 20)}`).toBe(text.descriptionText(value, 8_192, format));
      }
      expect(webText.singleLine(value, 500)).toBe(text.singleLine(value, 500));
    }
  });

  it('maps Graph calendars and events the same way', () => {
    expect(graphCalendars.value.map(webGraph.mapGraphCalendar)).toEqual(graphCalendars.value.map(graph.mapGraphCalendar));
    for (const item of graphItems()) {
      for (const writable of [true, false]) {
        expect(webGraph.mapGraphEvent(item, { writable })).toEqual(graph.mapGraphEvent(item, { writable }));
      }
    }
    expect(webGraph.GRAPH_EVENT_SELECT).toBe(graph.GRAPH_EVENT_SELECT);
    expect(webGraph.GRAPH_API).toBe(graph.GRAPH_API);
  });

  it('builds the same Graph write bodies', () => {
    const inputs: graph.GraphWriteFields[] = [
      { title: 'T', allDay: false, start: '2026-10-01T08:00:00Z', end: '2026-10-01T09:00:00Z', timezone: 'Europe/Berlin', description: 'x' },
      { allDay: true, start: '2026-10-01', end: '2026-10-02', timezone: 'Mars/Nowhere' },
      { location: null, description: null },
      { title: 'Moved', allDay: false, start: '2026-03-29T01:30:00Z', end: '2026-03-29T02:30:00Z', timezone: 'Asia/Kolkata' },
    ];
    for (const input of inputs) expect(webGraph.graphEventBody(input)).toEqual(graph.graphEventBody(input));
  });

  it('sanitizes records into the same events, ids and API shapes', async () => {
    const records: EventRecord[] = graphItems()
      .map((item) => graph.mapGraphEvent(item, { writable: true }))
      .filter((r): r is EventRecord => r !== null);
    const base = records[0]!;
    records.push(
      { ...base, title: ` ${'x'.repeat(600)} `, start: '2026-10-01T10:00:00+02:00', end: '2026-10-01T09:00:00+02:00', timezone: 'Not/AZone', htmlUrl: 'https://u:p@example.com/' },
      { ...base, allDay: true, start: '2026-10-01', end: '2026-10-01' },
      { ...base, instanceKey: '2026-10-01T10:00:00.000Z', status: 'bogus' as never },
      { ...base, remoteId: '' },
      { ...base, start: 'garbage' },
    );
    for (const record of records) {
      const server = store.sanitizeEvent('cal', record);
      expect(await webRecords.sanitizeEvent('cal', record)).toEqual(server);
    }
    expect(await webRecords.eventId('cal', 'uid-1', '2026-10-01T10:00:00.000Z')).toBe(store.eventId('cal', 'uid-1', '2026-10-01T10:00:00.000Z'));
  });
});
