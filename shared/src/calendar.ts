/**
 * Calendar contracts (§7a calendar.ts, §7 Calendar routes, §9 sync).
 * Timed events: ISO-8601 UTC (`…Z`) in responses; all-day events: `YYYY-MM-DD` with an exclusive end.
 */
import { z } from 'zod';
import { EntityId, HexColor, IanaTimeZone, IsoDate, IsoDateTime, MAX_URL_LENGTH, SafeHttpUrl } from './core.ts';

export const CALENDAR_SOURCES = ['google', 'microsoft', 'caldav', 'ics'] as const;
export const CalendarSourceSchema = z.enum(CALENDAR_SOURCES);
export type CalendarSource = z.output<typeof CalendarSourceSchema>;

export const EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled', 'declined'] as const;
export const EventStatusSchema = z.enum(EVENT_STATUSES);
/** `declined` = the user declined the invitation (hidden unless the widget's `showDeclined`). */
export type EventStatus = z.output<typeof EventStatusSchema>;

export const EVENT_TEXT_LIMITS = {
  title: 500,
  location: 1000,
  description: 8 * 1024,
} as const;

export interface Calendar {
  id: string;
  accountId: string | null;
  source: CalendarSource;
  name: string;
  /** Resolved display color: `colorOverride ?? color ?? fallback`. */
  color: string;
  /** The user's color override, or null when the provider/fallback color is in use. */
  colorOverride?: string | null;
  /** `providerWritable && !userReadOnly`. */
  writable: boolean;
  providerWritable: boolean;
  userReadOnly: boolean;
  visible: boolean;
  isPrimary: boolean;
  sort: number;
  /** Host-only display for ICS feeds (the full URL is a vault secret). */
  displayUrl: string | null;
  lastSyncedAt: string | null;
  /**
   * Last sync problem, or null. A value starting with {@link CALENDAR_WARNING_PREFIX} is a
   * non-fatal warning (the sync succeeded, e.g. some repeating events were shortened), not an error.
   */
  lastError: string | null;
}

/** Prefix of a non-fatal `Calendar.lastError` (see {@link isCalendarWarning}). */
export const CALENDAR_WARNING_PREFIX = 'Warning: ';

/** True when `lastError` is a non-fatal warning rather than a sync failure. */
export function isCalendarWarning(lastError: string | null | undefined): boolean {
  return typeof lastError === 'string' && lastError.startsWith(CALENDAR_WARNING_PREFIX);
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  location: string | null;
  description: string | null;
  /** Timed: ISO UTC `…Z`; all-day: `YYYY-MM-DD`. */
  start: string;
  /** Timed: ISO UTC `…Z`; all-day: `YYYY-MM-DD` (exclusive). */
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

/** `GET /api/calendar/events` response. */
export interface EventsResponse {
  events: CalendarEvent[];
  /** The window actually covered (clipped to the synced window); `to` exclusive. */
  window: { from: string; to: string };
  /**
   * True when the range held more events (or event text) than one response carries; the
   * earliest events are returned. Absent otherwise.
   */
  truncated?: boolean;
}

/** Most calendars one events request may name (`calendarIds`). */
export const MAX_EVENTS_QUERY_CALENDARS = 200;

/**
 * `GET /api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=<IANA>[&calendarIds=a,b]` (to
 * exclusive). With `calendarIds` (comma-separated): exactly those calendars, hidden ones
 * included; without it: the visible calendars.
 */
export const EventsQuerySchema = z
  .object({
    from: IsoDate,
    to: IsoDate,
    tz: IanaTimeZone,
    calendarIds: z
      .string()
      .max(MAX_EVENTS_QUERY_CALENDARS * 64)
      .transform((value) => value.split(',').filter((id) => id !== ''))
      .pipe(z.array(EntityId).max(MAX_EVENTS_QUERY_CALENDARS))
      .optional(),
  })
  .refine((q) => q.from < q.to, { message: '`to` must be after `from`', path: ['to'] });
export type EventsQuery = z.output<typeof EventsQuerySchema>;

const EventTitle = z.string().trim().min(1).max(EVENT_TEXT_LIMITS.title);
const EventLocation = z.string().trim().max(EVENT_TEXT_LIMITS.location);
const EventDescription = z.string().max(EVENT_TEXT_LIMITS.description);
/** Timed input: ISO with offset (or Z). */
const TimedInstant = IsoDateTime;

function checkEventTimes(
  v: { allDay?: boolean | undefined; start?: string | undefined; end?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (v.allDay === undefined || v.start === undefined || v.end === undefined) return;
  const schema = v.allDay ? IsoDate : TimedInstant;
  const expected = v.allDay ? 'YYYY-MM-DD' : 'an ISO date-time with offset';
  if (!schema.safeParse(v.start).success) {
    ctx.addIssue({ code: 'custom', message: `start must be ${expected}`, path: ['start'] });
    return;
  }
  if (!schema.safeParse(v.end).success) {
    ctx.addIssue({ code: 'custom', message: `end must be ${expected}`, path: ['end'] });
    return;
  }
  const startMs = Date.parse(v.start);
  const endMs = Date.parse(v.end);
  if (!(endMs > startMs)) {
    ctx.addIssue({ code: 'custom', message: 'end must be after start', path: ['end'] });
  }
}

/**
 * `POST /api/calendar/events`. Timed = ISO with offset; all-day = `YYYY-MM-DD`, end exclusive.
 */
export const EventInputSchema = z
  .object({
    calendarId: EntityId,
    title: EventTitle,
    allDay: z.boolean(),
    start: z.string().max(40),
    end: z.string().max(40),
    timezone: IanaTimeZone,
    location: EventLocation.optional(),
    description: EventDescription.optional(),
  })
  .strict()
  .superRefine(checkEventTimes);
export type EventInput = z.output<typeof EventInputSchema>;

/**
 * `PATCH /api/calendar/events/:id` (single instance). When any of allDay/start/end is present,
 * all three must be present so the times can be validated together.
 */
export const EventUpdateSchema = z
  .object({
    title: EventTitle.optional(),
    allDay: z.boolean().optional(),
    start: z.string().max(40).optional(),
    end: z.string().max(40).optional(),
    timezone: IanaTimeZone.optional(),
    location: EventLocation.nullable().optional(),
    description: EventDescription.nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const present = [v.allDay, v.start, v.end].filter((x) => x !== undefined).length;
    if (present !== 0 && present !== 3) {
      ctx.addIssue({ code: 'custom', message: 'allDay, start and end must be sent together', path: ['start'] });
      return;
    }
    checkEventTimes(v, ctx);
  });
export type EventUpdate = z.output<typeof EventUpdateSchema>;

/** `PATCH /api/calendar/calendars/:id` */
export const CalendarUpdateSchema = z
  .object({
    visible: z.boolean().optional(),
    colorOverride: HexColor.nullable().optional(),
    userReadOnly: z.boolean().optional(),
    sort: z.number().int().optional(),
  })
  .strict();
export type CalendarUpdate = z.output<typeof CalendarUpdateSchema>;

/**
 * ICS feed URL: `webcal://` is rewritten to `https://`, then it must be a SafeHttpUrl.
 */
export const IcsFeedUrlSchema = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH)
  .transform((s) => (/^webcals?:\/\//i.test(s) ? s.replace(/^webcals?:\/\//i, 'https://') : s))
  .pipe(SafeHttpUrl);

/** `POST /api/calendar/ics {url, name, color?}` */
export const IcsCreateSchema = z
  .object({
    url: IcsFeedUrlSchema,
    name: z.string().trim().min(1).max(200),
    color: HexColor.nullable().optional(),
  })
  .strict();
export type IcsCreate = z.output<typeof IcsCreateSchema>;

/** `PATCH /api/calendar/ics/:id {url?, name?}` */
export const IcsUpdateSchema = z
  .object({
    url: IcsFeedUrlSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type IcsUpdate = z.output<typeof IcsUpdateSchema>;

export const MIN_SYNC_INTERVAL_MIN = 5;
export const MAX_SYNC_INTERVAL_MIN = 60;

/** `settings.calendar` */
export const CalendarSettingsSchema = z
  .object({
    syncIntervalMin: z.number().int().min(MIN_SYNC_INTERVAL_MIN).max(MAX_SYNC_INTERVAL_MIN).default(5),
    defaultCalendarId: EntityId.nullable().default(null),
  })
  .strict();
export type CalendarSettings = z.output<typeof CalendarSettingsSchema>;
