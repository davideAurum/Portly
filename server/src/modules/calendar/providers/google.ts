/**
 * Google Calendar (§8): `calendarList.list`; `events.list(singleEvents=true, timeMin, timeMax,
 * maxResults=2500, pageToken)` over the sync window; `events.insert/patch/delete` (instance ids
 * edit single occurrences). All-day events use `start.date`/`end.date`; `meeting_url` comes from
 * `hangoutLink` or a video conference entry point; HTML descriptions become plain text.
 * Writable calendars: `accessRole` owner or writer. Outbound purposes (logs, Diagnostics):
 * `gcal.calendarList`, `gcal.events.list|insert|patch|delete`.
 */
import { EVENT_TEXT_LIMITS, type Account, type EventUpdate } from '@portly/shared';
import type { AppContext } from '../../../context.ts';
import { HttpError } from '../../../lib/errors.ts';
import { descriptionText } from '../text.ts';
import { isIsoDate, isoUtc, normalizeInstant, type SyncWindow } from '../time.ts';
import type { CalendarRow, EventRecord, EventRow, RemoteCalendar } from '../types.ts';
import { MAX_PAGES, ProviderHttpError, incompleteListing, isRecord, listItems, providerCall, str, LISTING_MAX_BYTES } from './http.ts';
import type { AccountProvider, WriteInfo, WriteProvider } from './types.ts';

export const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';
const NAME = 'Google Calendar';

export interface GoogleMapContext {
  /** The calendar allows writes (owner/writer). */
  writable: boolean;
  /** Calendar default zone (events.list `timeZone`), used when an event has none. */
  defaultTimeZone: string | null;
}

function dateOrTime(value: unknown): { date: string | null; dateTime: string | null; timeZone: string | null } {
  if (!isRecord(value)) return { date: null, dateTime: null, timeZone: null };
  return { date: str(value.date), dateTime: str(value.dateTime), timeZone: str(value.timeZone) };
}

function meetingUrlOf(raw: Record<string, unknown>): string | null {
  const hangout = str(raw.hangoutLink);
  if (hangout) return hangout;
  const conference = raw.conferenceData;
  if (!isRecord(conference) || !Array.isArray(conference.entryPoints)) return null;
  for (const entry of conference.entryPoints) {
    if (!isRecord(entry)) continue;
    const type = str(entry.entryPointType) ?? str(entry.type);
    const uri = str(entry.uri);
    if (type === 'video' && uri) return uri;
  }
  return null;
}

function statusOf(raw: Record<string, unknown>): EventRecord['status'] {
  if (raw.status === 'cancelled') return 'cancelled';
  if (Array.isArray(raw.attendees)) {
    const self = raw.attendees.find((a) => isRecord(a) && a.self === true);
    if (isRecord(self) && self.responseStatus === 'declined') return 'declined';
    if (isRecord(self) && self.responseStatus === 'tentative') return 'tentative';
  }
  return raw.status === 'tentative' ? 'tentative' : 'confirmed';
}

/** Maps one `events` resource; null for unusable items (no id/times, working-location entries). */
export function mapGoogleEvent(raw: unknown, context: GoogleMapContext): EventRecord | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  if (raw.eventType === 'workingLocation') return null;
  const start = dateOrTime(raw.start);
  const end = dateOrTime(raw.end);

  let allDay: boolean;
  let startValue: string | null;
  let endValue: string | null;
  if (start.date && isIsoDate(start.date)) {
    allDay = true;
    startValue = start.date;
    endValue = end.date && isIsoDate(end.date) ? end.date : null;
  } else {
    allDay = false;
    startValue = normalizeInstant(start.dateTime);
    endValue = normalizeInstant(end.dateTime);
  }
  if (!startValue) return null;

  const organizer = isRecord(raw.organizer) ? raw.organizer : null;
  const organizerIsSelf = organizer === null || organizer.self === true;
  const editable =
    context.writable && raw.locked !== true && raw.privateCopy !== true && (organizerIsSelf || raw.guestsCanModify === true);
  const seriesId = str(raw.recurringEventId);

  return {
    remoteId: id,
    instanceKey: null,
    etag: str(raw.etag),
    title: str(raw.summary) ?? '',
    location: str(raw.location),
    description: descriptionText(raw.description, EVENT_TEXT_LIMITS.description, 'auto'),
    start: startValue,
    end: endValue ?? startValue,
    allDay,
    timezone: start.timeZone ?? context.defaultTimeZone,
    status: statusOf(raw),
    recurring: seriesId !== null,
    seriesId,
    htmlUrl: str(raw.htmlLink),
    meetingUrl: meetingUrlOf(raw),
    editable,
  };
}

/** Maps one `calendarList` entry. */
export function mapGoogleCalendar(raw: unknown): RemoteCalendar | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id || raw.deleted === true) return null;
  const role = str(raw.accessRole);
  return {
    remoteId: id,
    name: str(raw.summaryOverride) ?? str(raw.summary) ?? id,
    color: str(raw.backgroundColor),
    writable: role === 'owner' || role === 'writer',
    primary: raw.primary === true,
    visible: raw.selected !== false && raw.hidden !== true,
  };
}

/** Fields of an insert or patch (§7a EventInput semantics; null clears on patch). */
export interface EventWriteFields {
  title?: string | undefined;
  location?: string | null | undefined;
  description?: string | null | undefined;
  allDay?: boolean | undefined;
  start?: string | undefined;
  end?: string | undefined;
  timezone?: string | null | undefined;
}

/** Request body for insert/patch. */
export function googleEventBody(input: EventWriteFields, forPatch: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.summary = input.title;
  if (input.location !== undefined) body.location = input.location ?? '';
  if (input.description !== undefined) body.description = input.description ?? '';
  if (input.allDay !== undefined && input.start !== undefined && input.end !== undefined) {
    if (input.allDay) {
      body.start = forPatch ? { date: input.start, dateTime: null, timeZone: null } : { date: input.start };
      body.end = forPatch ? { date: input.end, dateTime: null, timeZone: null } : { date: input.end };
    } else {
      const tz = input.timezone ?? 'UTC';
      body.start = forPatch ? { dateTime: input.start, timeZone: tz, date: null } : { dateTime: input.start, timeZone: tz };
      body.end = forPatch ? { dateTime: input.end, timeZone: tz, date: null } : { dateTime: input.end, timeZone: tz };
    }
  }
  return body;
}

/**
 * Zone a write body sends (`start.timeZone` of a timed event; all-day dates carry none). A timed
 * write without a requested zone is sent in UTC: that is a fallback.
 */
export function googleZoneSent(body: Record<string, unknown>, requested: string | null | undefined): Pick<WriteInfo, 'tzSent' | 'tzFallback'> {
  const tzSent = isRecord(body.start) ? str(body.start.timeZone) : null;
  return { tzSent, tzFallback: tzSent !== null && !requested };
}

/**
 * Listing projections (CAL-3): only the fields the mappers read, compact JSON. A page of a busy
 * work calendar (attendees, conference data, HTML descriptions) otherwise passes 5 MB.
 */
export const GOOGLE_EVENT_FIELDS =
  'nextPageToken,timeZone,items(id,etag,status,summary,description,location,start,end,recurringEventId,htmlLink,hangoutLink,' +
  'conferenceData/entryPoints(entryPointType,uri),attendees(self,responseStatus),organizer/self,locked,privateCopy,guestsCanModify,eventType)';
export const GOOGLE_CALENDAR_LIST_FIELDS = 'nextPageToken,items(id,deleted,accessRole,summaryOverride,summary,backgroundColor,primary,selected,hidden)';
/** Events per page (50 pages cover 50,000 instances). */
export const GOOGLE_EVENTS_PAGE_SIZE = 1000;

export function createGoogleProvider(ctx: Pick<AppContext, 'fetch' | 'accounts'>): AccountProvider & WriteProvider {
  const call = (
    account: Account,
    url: string,
    init: { method?: string; body?: unknown; allowStatuses?: number[]; maxBytes?: number; purpose: string },
  ) =>
    ctx.accounts.withToken(account.id, (token) =>
      providerCall(ctx.fetch, url, { ...init, token, provider: NAME, accountId: account.id }),
    );

  const calendarUrl = (calendar: CalendarRow) => `${GOOGLE_API}/calendars/${encodeURIComponent(calendar.remote_id)}/events`;

  const mapResponse = (data: unknown, calendar: CalendarRow): EventRecord => {
    const mapped = mapGoogleEvent(data, { writable: calendar.provider_writable === 1, defaultTimeZone: null });
    if (!mapped) throw new HttpError(502, 'provider_error', `${NAME} returned an unexpected response`);
    return mapped;
  };

  return {
    source: 'google',

    async listCalendars(account) {
      const out: RemoteCalendar[] = [];
      let pageToken: string | null = null;
      let page = 0;
      try {
        for (; page < MAX_PAGES; page++) {
          const params = new URLSearchParams({ maxResults: '250', prettyPrint: 'false', fields: GOOGLE_CALENDAR_LIST_FIELDS });
          if (pageToken) params.set('pageToken', pageToken);
          const { data } = await call(account, `${GOOGLE_API}/users/me/calendarList?${params}`, {
            maxBytes: LISTING_MAX_BYTES,
            purpose: 'gcal.calendarList',
          });
          for (const item of listItems(data, 'items', account)) {
            const cal = mapGoogleCalendar(item);
            if (cal) out.push(cal);
          }
          pageToken = str((data as Record<string, unknown>).nextPageToken);
          if (!pageToken) break;
        }
      } catch (err) {
        // Without the calendarlist scope, fall back to the primary calendar (calendar.events
        // suffices) — only when the list is refused outright for that reason: a refusal on a
        // later page must not turn into "every other calendar disappeared" (sync would delete
        // them), and any other 403 (Calendar API disabled for the OAuth client's project, …)
        // refuses events.list just the same, so a stand-in calendar would only fail every sync.
        if (page === 0 && err instanceof ProviderHttpError && err.denial === 'insufficient_scope') {
          return [{ remoteId: 'primary', name: account.email ?? account.label, color: null, writable: true, primary: true }];
        }
        throw err;
      }
      if (pageToken) throw incompleteListing(account);
      return out;
    },

    async listEvents(account, calendar, window: SyncWindow) {
      const out: EventRecord[] = [];
      let pageToken: string | null = null;
      const writable = calendar.provider_writable === 1;
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({
          singleEvents: 'true',
          timeMin: isoUtc(window.fromMs),
          timeMax: isoUtc(window.toMs),
          maxResults: String(GOOGLE_EVENTS_PAGE_SIZE),
          prettyPrint: 'false',
          fields: GOOGLE_EVENT_FIELDS,
        });
        if (pageToken) params.set('pageToken', pageToken);
        const { data } = await call(account, `${calendarUrl(calendar)}?${params}`, { maxBytes: LISTING_MAX_BYTES, purpose: 'gcal.events.list' });
        const items = listItems(data, 'items', account);
        const record = data as Record<string, unknown>;
        const defaultTimeZone = str(record.timeZone);
        for (const item of items) {
          const mapped = mapGoogleEvent(item, { writable, defaultTimeZone });
          if (mapped && mapped.status !== 'cancelled') out.push(mapped);
        }
        pageToken = str(record.nextPageToken);
        if (!pageToken) break;
      }
      // A partial listing would delete the events on the pages never fetched.
      if (pageToken) throw incompleteListing(account);
      return out;
    },

    async createEvent(account, calendar, input) {
      const body = googleEventBody(input, false);
      const { status, data } = await call(account, calendarUrl(calendar), { method: 'POST', body, purpose: 'gcal.events.insert' });
      return { record: mapResponse(data, calendar), status, ...googleZoneSent(body, input.timezone) };
    },

    async updateEvent(account, calendar, event: EventRow, patch: EventUpdate) {
      const url = `${calendarUrl(calendar)}/${encodeURIComponent(event.remote_id)}`;
      const timezone = patch.timezone ?? event.timezone ?? undefined;
      const body = googleEventBody({ ...patch, timezone }, true);
      const { status, data } = await call(account, url, { method: 'PATCH', body, purpose: 'gcal.events.patch' });
      return { record: mapResponse(data, calendar), status, ...googleZoneSent(body, timezone) };
    },

    async deleteEvent(account, calendar, event: EventRow) {
      const url = `${calendarUrl(calendar)}/${encodeURIComponent(event.remote_id)}`;
      // Already gone upstream (404/410) counts as deleted.
      const { status } = await call(account, url, { method: 'DELETE', allowStatuses: [404, 410], purpose: 'gcal.events.delete' });
      return { status, tzSent: null, tzFallback: false };
    },
  };
}
