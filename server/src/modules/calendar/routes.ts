/**
 * Calendar routes (§7 Calendar). All non-exempt JSON routes, declared `paired()` (the paired Pages
 * site may use them too).
 *
 * - `GET /api/calendar/calendars` → `Calendar[]` (ICS feeds + calendars of accounts with the
 *   calendar capability enabled; color = override > provider > account > palette;
 *   writable = provider_writable && !user_read_only, Google/Microsoft only)
 * - `PATCH /api/calendar/calendars/:id {visible?, colorOverride?, userReadOnly?, sort?}` → `Calendar`
 * - `DELETE /api/calendar/calendars/:id` (ICS only) → 204
 * - `POST /api/calendar/ics {url, name, color?}` → 201 `Calendar` (the first fetch must return a calendar)
 * - `PATCH /api/calendar/ics/:id {url?, name?}` → `Calendar`
 * - `GET /api/calendar/events?from&to&tz[&calendarIds]` → `{events, window, truncated?}` (409
 *   `not_configured` without calendars): the visible calendars, or exactly `calendarIds`; at most
 *   {@link MAX_EVENTS_PER_RESPONSE} events / {@link MAX_EVENTS_RESPONSE_CHARS} chars of text
 * - `POST /api/calendar/events` → 201 `CalendarEvent` · `PATCH|DELETE /api/calendar/events/:id`
 *   (single instance; Google/Microsoft only: 409 `conflict` for read-only sources, 403 `forbidden`
 *   for read-only calendars or events the user cannot edit)
 * - `POST /api/calendar/sync` → `Calendar[]` after a full sync
 */
import type { Context, Hono } from 'hono';
import {
  CalendarUpdateSchema,
  EntityId,
  EventInputSchema,
  EventUpdateSchema,
  EventsQuerySchema,
  IcsCreateSchema,
  IcsUpdateSchema,
  type CalendarEvent,
  type EventsResponse,
} from '@portly/shared';
import type { AppContext, AppEnv } from '../../context.ts';
import { HttpError } from '../../lib/errors.ts';
import { paired } from '../../lib/routes.ts';
import { parseBody, parseQuery } from '../../lib/validate.ts';
import type { CalendarService } from './service.ts';
import { activeCalendarRows, getCalendarRow, queryEventRows, toCalendar, toCalendarEvent } from './store.ts';
import { isoUtc, startOfDayMs } from './time.ts';

/** One events response carries at most this many events… */
export const MAX_EVENTS_PER_RESPONSE = 5_000;
/** …and this much event text (title, location, description, links; chars). */
export const MAX_EVENTS_RESPONSE_CHARS = 4 * 1024 * 1024;

function eventTextChars(e: CalendarEvent): number {
  return e.title.length + (e.location?.length ?? 0) + (e.description?.length ?? 0) + (e.htmlUrl?.length ?? 0) + (e.meetingUrl?.length ?? 0);
}

function idParam(c: Context<AppEnv>, what: string): string {
  const parsed = EntityId.safeParse(c.req.param('id'));
  if (!parsed.success) throw new HttpError(404, 'not_found', `${what} not found`);
  return parsed.data;
}

/** Static allowlist: API field → column (§5 PATCH convention). */
const CALENDAR_PATCH_COLUMNS = {
  visible: 'visible',
  colorOverride: 'color_override',
  userReadOnly: 'user_read_only',
  sort: 'sort',
} as const;

export interface CalendarRouteDeps {
  ctx: AppContext;
  service: CalendarService;
  /** Runs the account and ICS sync jobs now and waits for them. */
  syncNow(): Promise<void>;
}

export function registerCalendarRoutes(app: Hono<AppEnv>, deps: CalendarRouteDeps): void {
  const { ctx, service } = deps;
  const { db } = ctx;

  app.get('/api/calendar/calendars', paired(), (c) => c.json(service.listCalendars()));

  app.patch('/api/calendar/calendars/:id', paired(), async (c) => {
    const id = idParam(c, 'Calendar');
    const patch = await parseBody(c, CalendarUpdateSchema);
    const row = getCalendarRow(db, id);
    if (!row) throw new HttpError(404, 'not_found', 'Calendar not found');
    const values: Record<(typeof CALENDAR_PATCH_COLUMNS)[keyof typeof CALENDAR_PATCH_COLUMNS], string | number | null | undefined> = {
      visible: patch.visible === undefined ? undefined : patch.visible ? 1 : 0,
      color_override: patch.colorOverride === undefined ? undefined : (patch.colorOverride?.toLowerCase() ?? null),
      user_read_only: patch.userReadOnly === undefined ? undefined : patch.userReadOnly ? 1 : 0,
      sort: patch.sort,
    };
    db.tx(() => {
      for (const column of Object.values(CALENDAR_PATCH_COLUMNS)) {
        const value = values[column];
        if (value === undefined) continue;
        // `column` comes from the static allowlist above, never from the request.
        db.run(`UPDATE calendars SET ${column} = ? WHERE id = ?`, [value, id]);
      }
    });
    const account = row.account_id ? ctx.accounts.get(row.account_id) : null;
    return c.json(toCalendar(getCalendarRow(db, id)!, account?.color ?? null));
  });

  app.delete('/api/calendar/calendars/:id', paired(), (c) => {
    service.removeCalendar(idParam(c, 'Calendar'));
    return c.body(null, 204);
  });

  app.post('/api/calendar/ics', paired(), async (c) => {
    const input = await parseBody(c, IcsCreateSchema);
    return c.json(await service.addIcs(input), 201);
  });

  app.patch('/api/calendar/ics/:id', paired(), async (c) => {
    const id = idParam(c, 'Calendar');
    const input = await parseBody(c, IcsUpdateSchema);
    return c.json(await service.updateIcs(id, input));
  });

  app.get('/api/calendar/events', paired(), (c) => {
    const q = parseQuery(c, EventsQuerySchema);
    const active = activeCalendarRows(db, service.calendarAccounts());
    if (active.length === 0) {
      throw new HttpError(409, 'not_configured', 'No calendars yet. Connect an account or subscribe to an ICS feed.');
    }
    // Hidden calendars are only read when a widget names them explicitly.
    const wanted = q.calendarIds === undefined ? null : new Set(q.calendarIds);
    const calendars = active.filter((row) => (wanted === null ? row.visible === 1 : wanted.has(row.id)));
    // Clip to the synced window (§7): outside it the cache has nothing to say.
    const synced = service.window();
    const from = q.from > synced.fromDate ? q.from : synced.fromDate;
    let to = q.to < synced.toDate ? q.to : synced.toDate;
    if (to < from) to = from;
    const byId = new Map(calendars.map((row) => [row.id, row] as const));
    const rows =
      from < to
        ? queryEventRows(db, [...byId.keys()], {
            fromInstant: isoUtc(startOfDayMs(from, q.tz)),
            toInstant: isoUtc(startOfDayMs(to, q.tz)),
            fromDate: from,
            toDate: to,
          })
        : [];
    const events: CalendarEvent[] = [];
    let chars = 0;
    let truncated = false;
    for (const row of rows) {
      const event = toCalendarEvent(row, byId.get(row.calendar_id)!);
      chars += eventTextChars(event);
      if (events.length >= MAX_EVENTS_PER_RESPONSE || chars > MAX_EVENTS_RESPONSE_CHARS) {
        truncated = true;
        break;
      }
      events.push(event);
    }
    const body: EventsResponse = { events, window: { from, to } };
    if (truncated) body.truncated = true;
    return c.json(body);
  });

  app.post('/api/calendar/events', paired(), async (c) => {
    const input = await parseBody(c, EventInputSchema);
    return c.json(await service.createEvent(input), 201);
  });

  app.patch('/api/calendar/events/:id', paired(), async (c) => {
    const id = idParam(c, 'Event');
    const patch = await parseBody(c, EventUpdateSchema);
    return c.json(await service.updateEvent(id, patch));
  });

  app.delete('/api/calendar/events/:id', paired(), async (c) => {
    await service.deleteEvent(idParam(c, 'Event'));
    return c.body(null, 204);
  });

  app.post('/api/calendar/sync', paired(), async (c) => {
    await deps.syncNow();
    return c.json(service.listCalendars());
  });
}
