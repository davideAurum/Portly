/**
 * Internal records of the calendar module: what providers (Google, Graph, CalDAV, ICS) produce
 * before sanitization and storage.
 */
import type { CalendarSource, EventStatus } from '@homebase/shared';

/** One event instance as produced by a provider (unsanitized: see `sanitizeEvent`). */
export interface EventRecord {
  /** Provider id: Google/Graph event (or instance) id; ICS/CalDAV UID. */
  remoteId: string;
  /** Expanded recurrence instance key (ICS/CalDAV: occurrence start, UTC), else null. */
  instanceKey: string | null;
  etag: string | null;
  title: string;
  location: string | null;
  description: string | null;
  /** Timed: ISO instant; all-day: `YYYY-MM-DD`. */
  start: string;
  /** Timed: ISO instant; all-day: `YYYY-MM-DD` (exclusive). */
  end: string;
  allDay: boolean;
  timezone: string | null;
  status: EventStatus;
  recurring: boolean;
  seriesId: string | null;
  htmlUrl: string | null;
  meetingUrl: string | null;
  editable: boolean;
}

/** A calendar as listed by an account's provider. */
export interface RemoteCalendar {
  remoteId: string;
  name: string;
  color: string | null;
  writable: boolean;
  primary: boolean;
  /** Initial visibility for newly discovered calendars. */
  visible?: boolean;
  /** CalDAV collection URL. */
  collectionUrl?: string | null;
  /** CalDAV getctag (change detection). */
  ctag?: string | null;
}

/** `calendars` row. */
export interface CalendarRow {
  id: string;
  account_id: string | null;
  source: CalendarSource;
  remote_id: string;
  name: string;
  color: string | null;
  color_override: string | null;
  provider_writable: number;
  user_read_only: number;
  visible: number;
  is_primary: number;
  sort: number;
  display_url: string | null;
  collection_url: string | null;
  sync_state: string | null;
  last_synced_at: number | null;
  last_error: string | null;
}

/** `events` row. */
export interface EventRow {
  id: string;
  calendar_id: string;
  remote_id: string;
  instance_key: string | null;
  etag: string | null;
  title: string;
  location: string | null;
  description: string | null;
  start: string;
  end: string;
  all_day: number;
  timezone: string | null;
  status: string | null;
  recurring: number;
  series_id: string | null;
  html_url: string | null;
  meeting_url: string | null;
  editable: number;
  updated_at: number;
}

