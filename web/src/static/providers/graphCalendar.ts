/**
 * Microsoft Graph calendar mapping for the static backend (port of the pure parts of
 * server/src/modules/calendar/providers/microsoft.ts): Graph `calendar` / `event` objects →
 * records, and event write bodies. Listings use
 * `/me/calendars/{id}/calendarView?startDateTime&endDateTime&$top=500` with
 * `Prefer: outlook.timezone="UTC"`, so instants arrive in UTC; other zones are converted. When
 * `isAllDay`, the date parts of start/end are taken verbatim (end exclusive). `meeting_url` from
 * `onlineMeeting.joinUrl`; `canEdit` → writable.
 */
import { EVENT_TEXT_LIMITS } from '@portly/shared';
import type { EventRecord, RemoteCalendar } from '../lib/calendarRecords.ts';
import { descriptionText } from '../lib/calendarText.ts';
import { formatDate, isIsoDate, isoUtc, pad2, wallTimeAt, wallToUtcMs } from '../lib/calendarTime.ts';
import { ianaToWindows, resolveTimeZoneName } from '../lib/windowsZones.ts';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export const GRAPH_API = 'https://graph.microsoft.com/v1.0';
export const GRAPH_ORIGIN = 'https://graph.microsoft.com';
export const GRAPH_PROVIDER_NAME = 'Outlook.com';
export const GRAPH_PREFER = 'outlook.timezone="UTC", outlook.body-content-type="text"';

export const GRAPH_EVENT_SELECT = [
  'id',
  'subject',
  'body',
  'start',
  'end',
  'isAllDay',
  'location',
  'webLink',
  'onlineMeeting',
  'onlineMeetingUrl',
  'type',
  'seriesMasterId',
  'isCancelled',
  'responseStatus',
  'isOrganizer',
  'originalStartTimeZone',
].join(',');

/** Outlook preset calendar colors (`color`) when `hexColor` is empty. */
const PRESET_COLORS: Record<string, string> = {
  lightBlue: '#4f9ee8',
  lightGreen: '#5fb86b',
  lightOrange: '#f2994a',
  lightGray: '#9aa3ad',
  lightYellow: '#e0b93a',
  lightTeal: '#3fb8aa',
  lightPink: '#e56fa6',
  lightBrown: '#b08968',
  lightRed: '#e5534b',
};

const GRAPH_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** Graph `dateTimeTimeZone` → ISO UTC (the zone is UTC under our Prefer header; others are converted). */
export function graphInstant(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const dateTime = str(value.dateTime);
  if (!dateTime) return null;
  const m = GRAPH_DATETIME.exec(dateTime);
  if (!m) return null;
  if (m[7]) {
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${m[7]}`);
    return Number.isFinite(ms) ? isoUtc(ms) : null;
  }
  const tzName = str(value.timeZone);
  const zone = !tzName || /^(utc|etc\/utc|gmt)$/i.test(tzName) ? 'UTC' : (resolveTimeZoneName(tzName) ?? 'UTC');
  const ms = wallToUtcMs(
    { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0) },
    zone,
  );
  return Number.isFinite(ms) ? isoUtc(ms) : null;
}

function graphDate(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const date = str(value.dateTime)?.slice(0, 10) ?? null;
  return date && isIsoDate(date) ? date : null;
}

function statusOf(raw: Record<string, unknown>): EventRecord['status'] {
  if (raw.isCancelled === true) return 'cancelled';
  const response = isRecord(raw.responseStatus) ? str(raw.responseStatus.response) : null;
  if (response === 'declined') return 'declined';
  if (response === 'tentativelyAccepted') return 'tentative';
  return 'confirmed';
}

/** Maps one Graph `event`; null for unusable items (series masters, missing times). */
export function mapGraphEvent(raw: unknown, context: { writable: boolean }): EventRecord | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id || raw.type === 'seriesMaster') return null;
  const allDay = raw.isAllDay === true;
  const start = allDay ? graphDate(raw.start) : graphInstant(raw.start);
  const end = allDay ? graphDate(raw.end) : graphInstant(raw.end);
  if (!start) return null;

  const body = isRecord(raw.body) ? raw.body : null;
  const bodyType = body && str(body.contentType)?.toLowerCase() === 'html' ? 'html' : 'text';
  const description = body ? descriptionText(body.content, EVENT_TEXT_LIMITS.description, bodyType) : null;
  const location = isRecord(raw.location) ? str(raw.location.displayName) : null;
  const meeting = isRecord(raw.onlineMeeting) ? str(raw.onlineMeeting.joinUrl) : null;
  const seriesId = str(raw.seriesMasterId);
  const originalZone = str(raw.originalStartTimeZone);

  return {
    remoteId: id,
    instanceKey: null,
    etag: str(raw['@odata.etag']),
    title: str(raw.subject) ?? '',
    location,
    description,
    start,
    end: end ?? start,
    allDay,
    timezone: originalZone ? resolveTimeZoneName(originalZone) : null,
    status: statusOf(raw),
    recurring: raw.type === 'occurrence' || raw.type === 'exception' || seriesId !== null,
    seriesId,
    htmlUrl: str(raw.webLink),
    meetingUrl: meeting ?? str(raw.onlineMeetingUrl),
    editable: context.writable && raw.isOrganizer !== false,
  };
}

/** Maps one Graph `calendar`. */
export function mapGraphCalendar(raw: unknown): RemoteCalendar | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const hex = str(raw.hexColor);
  const preset = str(raw.color);
  return {
    remoteId: id,
    name: str(raw.name) ?? 'Calendar',
    color: hex ?? (preset ? (PRESET_COLORS[preset] ?? null) : null),
    writable: raw.canEdit === true,
    primary: raw.isDefaultCalendar === true,
  };
}

/** Graph `dateTimeTimeZone` for writes: local wall time in the user's zone (Windows id), else UTC. */
export function graphTimeFor(instant: string, tz: string | null | undefined): { dateTime: string; timeZone: string } {
  const ms = Date.parse(instant);
  const windows = tz ? ianaToWindows(tz) : null;
  if (tz && windows) {
    const w = wallTimeAt(ms, tz);
    return { dateTime: `${formatDate(w.year, w.month, w.day)}T${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}`, timeZone: windows };
  }
  return { dateTime: isoUtc(ms).slice(0, 19), timeZone: 'UTC' };
}

export function graphDateFor(date: string, tz: string | null | undefined): { dateTime: string; timeZone: string } {
  return { dateTime: `${date}T00:00:00`, timeZone: (tz ? ianaToWindows(tz) : null) ?? 'UTC' };
}

export interface GraphWriteFields {
  title?: string | undefined;
  location?: string | null | undefined;
  description?: string | null | undefined;
  allDay?: boolean | undefined;
  start?: string | undefined;
  end?: string | undefined;
  timezone?: string | null | undefined;
}

export function graphEventBody(input: GraphWriteFields): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.subject = input.title;
  if (input.location !== undefined) body.location = { displayName: input.location ?? '' };
  if (input.description !== undefined) body.body = { contentType: 'text', content: input.description ?? '' };
  if (input.allDay !== undefined && input.start !== undefined && input.end !== undefined) {
    body.isAllDay = input.allDay;
    if (input.allDay) {
      body.start = graphDateFor(input.start, input.timezone);
      body.end = graphDateFor(input.end, input.timezone);
    } else {
      body.start = graphTimeFor(input.start, input.timezone);
      body.end = graphTimeFor(input.end, input.timezone);
    }
  }
  return body;
}
