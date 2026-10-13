/**
 * Calendar API (§7 Calendar): calendars, events (window queries), ICS subscriptions, sync and
 * single-instance event writes. Event writes are optimistic across every cached events query
 * and roll back on failure (§10.7 #8); the widget adds the toasts (with Undo where reversible).
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  CALENDAR_WARNING_PREFIX,
  isCalendarWarning,
  type Calendar,
  type CalendarEvent,
  type CalendarUpdate,
  type EventInput,
  type EventsResponse,
  type EventUpdate,
  type IcsCreate,
  type IcsUpdate,
} from '@homebase/shared';
import { apiDelete, apiGet, apiPatch, apiPath, apiPost, isApiError } from './client.ts';
import { qk } from './keys.ts';

/** §10.7: calendar data is fresh for 60 s. */
export const CALENDAR_STALE_MS = 60_000;
/** A page left open all day still follows the server's sync. */
export const CALENDAR_REFETCH_MS = 5 * 60_000;
/** While a calendar waits for its first sync, poll the list briefly… */
export const FIRST_SYNC_POLL_MS = 5_000;
/** …for at most this long (then the normal interval): a server that never answers must not be polled every 5 s forever. */
export const FIRST_SYNC_POLL_WINDOW_MS = 2 * 60_000;

/** When the current burst of fast polling started, and for which accounts (a new account restarts it). */
let fastPoll: { key: string; since: number } | null = null;

/** Test hook: forget the fast-poll window. */
export function resetFirstSyncPoll(): void {
  fastPoll = null;
}

export function firstSyncInterval(wantFast: boolean, key: string, now: number = Date.now()): number {
  if (!wantFast) {
    fastPoll = null;
    return CALENDAR_REFETCH_MS;
  }
  if (fastPoll === null || fastPoll.key !== key) fastPoll = { key, since: now };
  return now - fastPoll.since < FIRST_SYNC_POLL_WINDOW_MS ? FIRST_SYNC_POLL_MS : CALENDAR_REFETCH_MS;
}

export interface CalendarSyncIssue {
  /** `error`: the last sync failed (cached events are shown); `warning`: it worked, with a caveat. */
  level: 'error' | 'warning';
  message: string;
}

/**
 * A calendar's last sync problem, or null. `lastError` values prefixed `Warning: ` are non-fatal
 * (e.g. "Some repeating events were shortened") and never mark the calendar as failing.
 */
export function calendarSyncIssue(calendar: Pick<Calendar, 'lastError'>): CalendarSyncIssue | null {
  const text = calendar.lastError;
  if (!text) return null;
  if (isCalendarWarning(text)) return { level: 'warning', message: text.slice(CALENDAR_WARNING_PREFIX.length) };
  return { level: 'error', message: text };
}

/** True when the calendar's last sync failed (warnings do not count). */
export function calendarSyncFailed(calendar: Pick<Calendar, 'lastError'>): boolean {
  return calendarSyncIssue(calendar)?.level === 'error';
}

function awaitingFirstSync(calendars: readonly Calendar[] | undefined): boolean {
  return calendars?.some((c) => c.lastSyncedAt === null && c.lastError === null) ?? false;
}

export function fetchCalendars(signal?: AbortSignal): Promise<Calendar[]> {
  return apiGet<Calendar[]>('/api/calendar/calendars', { signal });
}

export interface UseCalendarsOptions {
  enabled?: boolean;
  /** Poll quickly while the list is empty (a connected account's first sync is still running). */
  pollWhileEmpty?: boolean;
  /** Identifies the accounts being waited for: a change restarts the (bounded) fast polling. */
  pollKey?: string;
}

export function useCalendars(options: UseCalendarsOptions = {}) {
  const pollWhileEmpty = options.pollWhileEmpty ?? false;
  return useQuery({
    queryKey: qk.calendar.calendars(),
    queryFn: ({ signal }) => fetchCalendars(signal),
    staleTime: CALENDAR_STALE_MS,
    refetchInterval: (query) => {
      const data = query.state.data;
      return firstSyncInterval(awaitingFirstSync(data) || (pollWhileEmpty && data?.length === 0), options.pollKey ?? '');
    },
    refetchIntervalInBackground: false,
    enabled: options.enabled ?? true,
  });
}

export interface EventRange {
  /** `YYYY-MM-DD` (inclusive). */
  from: string;
  /** `YYYY-MM-DD` (exclusive). */
  to: string;
  /** IANA zone the dates are in. */
  tz: string;
}

/**
 * Which calendars an events query reads: 'visible' (the server's default: calendars shown in
 * Settings → Calendars) or a widget's own list (hidden calendars included).
 */
export type EventsSelection = 'visible' | readonly string[];

/** Stable form of a selection for query keys and the `calendarIds` parameter. */
export function selectionKey(selection: EventsSelection): string {
  return selection === 'visible' ? 'visible' : [...new Set(selection)].sort().join(',');
}

export function eventsPath(range: EventRange, selection: EventsSelection = 'visible'): string {
  const params = new URLSearchParams({ from: range.from, to: range.to, tz: range.tz });
  if (selection !== 'visible') params.set('calendarIds', selectionKey(selection));
  return `/api/calendar/events?${params.toString()}`;
}

export function useCalendarEvents(range: EventRange, options: { enabled?: boolean; calendars?: EventsSelection } = {}) {
  const selection = options.calendars ?? 'visible';
  return useQuery({
    queryKey: qk.calendar.events(range.from, range.to, range.tz, selectionKey(selection)),
    queryFn: ({ signal }) => apiGet<EventsResponse>(eventsPath(range, selection), { signal }),
    staleTime: CALENDAR_STALE_MS,
    refetchInterval: CALENDAR_REFETCH_MS,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

// ---------------------------------------------------------------------------
// Calendars & ICS
// ---------------------------------------------------------------------------

export function useUpdateCalendar() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: CalendarUpdate & { id: string }) => apiPatch<Calendar>(apiPath`/api/calendar/calendars/${id}`, patch),
    onMutate: async ({ id, ...patch }) => {
      await client.cancelQueries({ queryKey: qk.calendar.calendars() });
      const previous = client.getQueryData<Calendar[]>(qk.calendar.calendars());
      if (previous) {
        client.setQueryData<Calendar[]>(
          qk.calendar.calendars(),
          previous.map((c) => {
            if (c.id !== id) return c;
            const next: Calendar = { ...c };
            if (patch.visible !== undefined) next.visible = patch.visible;
            if (patch.sort !== undefined) next.sort = patch.sort;
            if (patch.colorOverride) next.color = patch.colorOverride.toLowerCase();
            // Clearing: the provider color arrives with the server's response.
            if (patch.colorOverride !== undefined) next.colorOverride = patch.colorOverride?.toLowerCase() ?? null;
            if (patch.userReadOnly !== undefined) {
              next.userReadOnly = patch.userReadOnly;
              next.writable = c.providerWritable && !patch.userReadOnly && (c.source === 'google' || c.source === 'microsoft');
            }
            return next;
          }),
        );
      }
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(qk.calendar.calendars(), context.previous);
    },
    onSuccess: (calendar) => {
      client.setQueryData<Calendar[]>(qk.calendar.calendars(), (list) => list?.map((c) => (c.id === calendar.id ? calendar : c)));
    },
    // The server returns only visible calendars' events by default: showing or hiding one
    // changes what the events queries hold.
    onSettled: (_calendar, _error, vars) =>
      vars.visible === undefined ? undefined : client.invalidateQueries({ queryKey: EVENTS_PREFIX }),
  });
}

export function useAddIcs() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: IcsCreate) => apiPost<Calendar>('/api/calendar/ics', body),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.calendar.all() }),
  });
}

export function useUpdateIcs() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: IcsUpdate & { id: string }) => apiPatch<Calendar>(apiPath`/api/calendar/ics/${id}`, body),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.calendar.all() }),
  });
}

export function useDeleteCalendar() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(apiPath`/api/calendar/calendars/${id}`),
    onSettled: () => Promise.all([client.invalidateQueries({ queryKey: qk.calendar.all() }), client.invalidateQueries({ queryKey: qk.settings() })]),
  });
}

/** `POST /api/calendar/sync` (waits for the sync) → fresh calendar list; events refetch. */
export function useSyncCalendars() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<Calendar[]>('/api/calendar/sync'),
    onSuccess: (calendars) => {
      client.setQueryData(qk.calendar.calendars(), calendars);
      // A sync can flag an account for reconnection.
      return Promise.all([client.invalidateQueries({ queryKey: ['calendar', 'events'] }), client.invalidateQueries({ queryKey: qk.accounts() })]);
    },
  });
}

// ---------------------------------------------------------------------------
// Events (optimistic)
// ---------------------------------------------------------------------------

type EventsSnapshot = [readonly unknown[], EventsResponse | undefined][];

const EVENTS_PREFIX = ['calendar', 'events'] as const;

function snapshot(client: QueryClient): EventsSnapshot {
  return client.getQueriesData<EventsResponse>({ queryKey: EVENTS_PREFIX });
}

function restore(client: QueryClient, saved: EventsSnapshot): void {
  for (const [key, data] of saved) client.setQueryData(key, data);
}

function mapEvents(client: QueryClient, fn: (events: CalendarEvent[]) => CalendarEvent[]): void {
  client.setQueriesData<EventsResponse>({ queryKey: EVENTS_PREFIX }, (data) => (data ? { ...data, events: fn(data.events) } : data));
}

/** A write refused with `reauth_required` also flagged the account: refresh it (Reconnect UI). */
function afterWriteError(client: QueryClient, error: unknown): void {
  if (isApiError(error, 'reauth_required')) void client.invalidateQueries({ queryKey: qk.accounts() });
}

function byStart(a: CalendarEvent, b: CalendarEvent): number {
  return a.start < b.start ? -1 : a.start > b.start ? 1 : Number(b.allDay) - Number(a.allDay);
}

/** Temporary id for an optimistic event until the server's id arrives. */
export const PENDING_ID_PREFIX = 'pending:';

export function eventFromInput(input: EventInput, id: string): CalendarEvent {
  return {
    id,
    calendarId: input.calendarId,
    title: input.title,
    location: input.location || null,
    description: input.description || null,
    start: input.allDay ? input.start : new Date(input.start).toISOString(),
    end: input.allDay ? input.end : new Date(input.end).toISOString(),
    allDay: input.allDay,
    timezone: input.timezone,
    status: 'confirmed',
    recurring: false,
    seriesId: null,
    htmlUrl: null,
    meetingUrl: null,
    // Not editable until the server's copy (and id) replaces it.
    editable: false,
  };
}

export function applyUpdate(event: CalendarEvent, patch: EventUpdate): CalendarEvent {
  const next: CalendarEvent = { ...event };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.location !== undefined) next.location = patch.location || null;
  if (patch.description !== undefined) next.description = patch.description || null;
  if (patch.allDay !== undefined && patch.start !== undefined && patch.end !== undefined) {
    next.allDay = patch.allDay;
    next.start = patch.allDay ? patch.start : new Date(patch.start).toISOString();
    next.end = patch.allDay ? patch.end : new Date(patch.end).toISOString();
  }
  if (patch.timezone !== undefined) next.timezone = patch.timezone;
  return next;
}

export function useCreateEvent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: EventInput) => apiPost<CalendarEvent>('/api/calendar/events', input),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: EVENTS_PREFIX });
      const saved = snapshot(client);
      const tempId = `${PENDING_ID_PREFIX}${crypto.randomUUID()}`;
      mapEvents(client, (events) => [...events, eventFromInput(input, tempId)].sort(byStart));
      return { saved, tempId };
    },
    onError: (error, _input, context) => {
      if (context) restore(client, context.saved);
      afterWriteError(client, error);
    },
    onSuccess: (created, _input, context) => {
      mapEvents(client, (events) => events.map((e) => (e.id === context?.tempId ? created : e)).sort(byStart));
    },
    onSettled: () => client.invalidateQueries({ queryKey: EVENTS_PREFIX }),
  });
}

export function useUpdateEvent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: EventUpdate }) => apiPatch<CalendarEvent>(apiPath`/api/calendar/events/${id}`, patch),
    onMutate: async ({ id, patch }) => {
      await client.cancelQueries({ queryKey: EVENTS_PREFIX });
      const saved = snapshot(client);
      mapEvents(client, (events) => events.map((e) => (e.id === id ? applyUpdate(e, patch) : e)).sort(byStart));
      return { saved };
    },
    onError: (error, _vars, context) => {
      if (context) restore(client, context.saved);
      afterWriteError(client, error);
    },
    onSuccess: (updated, { id }) => {
      mapEvents(client, (events) => events.map((e) => (e.id === id ? updated : e)).sort(byStart));
    },
    onSettled: () => client.invalidateQueries({ queryKey: EVENTS_PREFIX }),
  });
}

export function useDeleteEvent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(apiPath`/api/calendar/events/${id}`),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: EVENTS_PREFIX });
      const saved = snapshot(client);
      mapEvents(client, (events) => events.filter((e) => e.id !== id));
      return { saved };
    },
    onError: (error, _id, context) => {
      if (context) restore(client, context.saved);
      afterWriteError(client, error);
    },
    onSettled: () => client.invalidateQueries({ queryKey: EVENTS_PREFIX }),
  });
}
