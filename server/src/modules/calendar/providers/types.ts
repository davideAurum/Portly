/**
 * Provider interfaces: every account kind lists calendars and events; Google and Microsoft can
 * also write single events (CalDAV and ICS are read-only in v1) and report what they sent.
 */
import type { Account, CalendarSource, EventInput, EventUpdate } from '@portly/shared';
import type { SyncWindow } from '../time.ts';
import type { CalendarRow, EventRecord, EventRow, RemoteCalendar } from '../types.ts';

export interface AccountProvider {
  readonly source: CalendarSource;
  listCalendars(account: Account): Promise<RemoteCalendar[]>;
  /**
   * Every event instance of `calendar` in the window. Returns `null` when the calendar is known
   * to be unchanged since the last sync (the cached rows stay as they are).
   */
  listEvents(account: Account, calendar: CalendarRow, window: SyncWindow): Promise<EventRecord[] | EventListing | null>;
}

/** Events plus a new `sync_state` for the calendar and an optional non-fatal warning. */
export interface EventListing {
  events: EventRecord[];
  /** New `sync_state`; undefined keeps the stored one. */
  syncState?: string | null;
  /** Non-fatal warning (e.g. shortened repeating events), recorded without failing the sync. */
  warning?: string | null;
}

/** What a write sent and what the provider answered (the `calendar event written` log line). */
export interface WriteInfo {
  /** The provider's HTTP status (a delete of an event already gone upstream reports 404/410). */
  status: number;
  /** Zone sent with the event's times (IANA for Google, a Windows zone for Graph); null when none was sent. */
  tzSent: string | null;
  /** Times were sent in UTC because the requested zone was missing or has no provider equivalent. */
  tzFallback: boolean;
}

export interface WrittenEvent extends WriteInfo {
  record: EventRecord;
}

export interface WriteProvider {
  createEvent(account: Account, calendar: CalendarRow, input: EventInput): Promise<WrittenEvent>;
  updateEvent(account: Account, calendar: CalendarRow, event: EventRow, patch: EventUpdate): Promise<WrittenEvent>;
  deleteEvent(account: Account, calendar: CalendarRow, event: EventRow): Promise<WriteInfo>;
}

export function isEventListing(value: unknown): value is EventListing {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as EventListing).events);
}
