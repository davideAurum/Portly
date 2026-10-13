/**
 * Microsoft Graph calendars (personal accounts, §8): `/me/calendars`;
 * `/me/calendars/{id}/calendarView?startDateTime&endDateTime&$top=500` paged via
 * `@odata.nextLink` with `Prefer: outlook.timezone="UTC"`; create `POST /me/calendars/{id}/events`;
 * `PATCH/DELETE /me/events/{id}` (occurrence ids edit single instances). When `isAllDay`, the date
 * parts of start/end are taken verbatim (end exclusive). `meeting_url` from
 * `onlineMeeting.joinUrl`; `canEdit` → writable. Outbound purposes (logs, Diagnostics):
 * `graph.calendars`, `graph.calendarView`, `graph.events.create|update|delete`.
 */
import { EVENT_TEXT_LIMITS, type Account, type EventInput, type EventUpdate } from '@portly/shared';
import type { AppContext } from '../../../context.ts';
import { HttpError } from '../../../lib/errors.ts';
import { descriptionText } from '../text.ts';
import { formatDate, isIsoDate, isoUtc, pad2, wallTimeAt, wallToUtcMs, type SyncWindow } from '../time.ts';
import type { CalendarRow, EventRecord, EventRow, RemoteCalendar } from '../types.ts';
import { ianaToWindows, resolveTimeZoneName } from '../windows-zones.ts';
import { MAX_PAGES, incompleteListing, isRecord, listItems, providerCall, str } from './http.ts';
import type { AccountProvider, WriteInfo, WriteProvider } from './types.ts';

export const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const NAME = 'Outlook.com';
const PREFER = 'outlook.timezone="UTC", outlook.body-content-type="text"';

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

/**
 * Zone a write body sends (`start.timeZone`: a Windows zone, or UTC when the requested IANA zone
 * is missing or has no Windows equivalent — a fallback).
 */
export function graphZoneSent(body: Record<string, unknown>, requested: string | null | undefined): Pick<WriteInfo, 'tzSent' | 'tzFallback'> {
  const tzSent = isRecord(body.start) ? str(body.start.timeZone) : null;
  return { tzSent, tzFallback: tzSent !== null && (!requested || ianaToWindows(requested) === null) };
}

export function createMicrosoftProvider(ctx: Pick<AppContext, 'fetch' | 'accounts'>): AccountProvider & WriteProvider {
  const call = (account: Account, url: string, init: { method?: string; body?: unknown; allowStatuses?: number[]; purpose: string }) => {
    if (!url.startsWith(`${GRAPH_ORIGIN}/`)) {
      throw new HttpError(502, 'provider_error', { message: `${NAME} returned an unexpected link`, accountId: account.id });
    }
    return ctx.accounts.withToken(account.id, (token) =>
      providerCall(ctx.fetch, url, { ...init, token, provider: NAME, accountId: account.id, headers: { Prefer: PREFER } }),
    );
  };

  const mapResponse = (data: unknown, calendar: CalendarRow): EventRecord => {
    const mapped = mapGraphEvent(data, { writable: calendar.provider_writable === 1 });
    if (!mapped) throw new HttpError(502, 'provider_error', `${NAME} returned an unexpected response`);
    return mapped;
  };

  const eventUrl = (event: EventRow) => `${GRAPH_API}/me/events/${encodeURIComponent(event.remote_id)}`;

  return {
    source: 'microsoft',

    async listCalendars(account) {
      const out: RemoteCalendar[] = [];
      let url: string | null = `${GRAPH_API}/me/calendars?$top=100&$select=id,name,color,hexColor,canEdit,isDefaultCalendar`;
      for (let page = 0; page < MAX_PAGES && url; page++) {
        const { data } = await call(account, url, { purpose: 'graph.calendars' });
        for (const item of listItems(data, 'value', account)) {
          const cal = mapGraphCalendar(item);
          if (cal) out.push(cal);
        }
        url = str((data as Record<string, unknown>)['@odata.nextLink']);
      }
      if (url) throw incompleteListing(account);
      return out;
    },

    async listEvents(account, calendar, window: SyncWindow) {
      const out: EventRecord[] = [];
      const params = new URLSearchParams({
        startDateTime: isoUtc(window.fromMs),
        endDateTime: isoUtc(window.toMs),
        $top: '500',
        $select: GRAPH_EVENT_SELECT,
      });
      let url: string | null = `${GRAPH_API}/me/calendars/${encodeURIComponent(calendar.remote_id)}/calendarView?${params}`;
      const writable = calendar.provider_writable === 1;
      for (let page = 0; page < MAX_PAGES && url; page++) {
        const { data } = await call(account, url, { purpose: 'graph.calendarView' });
        for (const item of listItems(data, 'value', account)) {
          const mapped = mapGraphEvent(item, { writable });
          if (mapped) out.push(mapped);
        }
        url = str((data as Record<string, unknown>)['@odata.nextLink']);
      }
      // A partial listing would delete the events on the pages never fetched.
      if (url) throw incompleteListing(account);
      return out;
    },

    async createEvent(account, calendar, input: EventInput) {
      const url = `${GRAPH_API}/me/calendars/${encodeURIComponent(calendar.remote_id)}/events`;
      const body = graphEventBody(input);
      const { status, data } = await call(account, url, { method: 'POST', body, purpose: 'graph.events.create' });
      return { record: mapResponse(data, calendar), status, ...graphZoneSent(body, input.timezone) };
    },

    async updateEvent(account, calendar, event: EventRow, patch: EventUpdate) {
      const timezone = patch.timezone ?? event.timezone;
      const body = graphEventBody({ ...patch, timezone });
      const { status, data } = await call(account, eventUrl(event), { method: 'PATCH', body, purpose: 'graph.events.update' });
      return { record: mapResponse(data, calendar), status, ...graphZoneSent(body, timezone) };
    },

    async deleteEvent(account, _calendar, event: EventRow) {
      const { status } = await call(account, eventUrl(event), { method: 'DELETE', allowStatuses: [404], purpose: 'graph.events.delete' });
      return { status, tzSent: null, tzFallback: false };
    },
  };
}
