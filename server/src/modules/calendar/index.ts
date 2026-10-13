/**
 * Calendar module (§7 Calendar, §8, §9): Google and Microsoft (two-way, single instances),
 * CalDAV (Yahoo preset + generic, read-only) and ICS subscriptions (read-only), synced into the
 * `calendars`/`events` cache and served from it.
 *
 * - Scheduler: `calendar:sync` (accounts) every `settings.calendar.syncIntervalMin` minutes
 *   (rescheduled on change) and `calendar:ics` every 30 min; both first run 5 s after start.
 * - Account changes: created/updated accounts with the calendar capability sync right away
 *   (skipping any failure backoff, like `POST /api/calendar/sync`); deleted accounts' calendars
 *   are gone by FK cascade (a dangling default calendar is reset). The health of a deleted
 *   account's calendars, or of calendars switched off, is forgotten.
 * - Registers the CalDAV probe for the `calendar` capability on `yahoo` and `caldav` accounts.
 * - Parse workers log their failures as this module (`calendar worker failed`).
 */
import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../../context.ts';
import { errorFields } from '../../lib/logger.ts';
import { createExpandRunner, type ExpandRunner } from './ical/run.ts';
import { createCaldavProbe, createCaldavProvider } from './providers/caldav.ts';
import { createGoogleProvider } from './providers/google.ts';
import { createMicrosoftProvider } from './providers/microsoft.ts';
import { registerCalendarRoutes } from './routes.ts';
import { createCalendarService, ICS_SYNC_INTERVAL_MS, type CalendarProviders, type CalendarService } from './service.ts';
import { getCalendarRow } from './store.ts';

export const prefixes = ['/api/calendar'] as const;

export const ACCOUNT_SYNC_JOB = 'calendar:sync';
export const ICS_SYNC_JOB = 'calendar:ics';
export const INITIAL_SYNC_DELAY_MS = 5_000;
export { ICS_SYNC_INTERVAL_MS };

export interface CalendarModuleOptions {
  /** Provider overrides (tests). */
  providers?: Partial<CalendarProviders>;
  runExpand?: ExpandRunner;
  now?: () => number;
  timeZone?: () => string;
}

export interface CalendarModule {
  service: CalendarService;
}

/** Builds and wires the module (exported for tests that need the service). */
export function setupCalendar(app: Hono<AppEnv>, ctx: AppContext, options: CalendarModuleOptions = {}): CalendarModule {
  const log = ctx.log.child({ module: 'calendar' });
  const runExpand = options.runExpand ?? createExpandRunner({ log });
  const providers: CalendarProviders = {
    google: options.providers?.google ?? createGoogleProvider(ctx),
    microsoft: options.providers?.microsoft ?? createMicrosoftProvider(ctx),
    caldav: options.providers?.caldav ?? createCaldavProvider(ctx, runExpand),
  };
  const service = createCalendarService({ ctx, providers, runExpand, now: options.now, timeZone: options.timeZone });

  const minutes = () => ctx.settings.get('calendar').syncIntervalMin * 60 * 1000;
  const accountsJob = ctx.scheduler.every(ACCOUNT_SYNC_JOB, minutes(), () => service.syncAccounts(), {
    initialDelayMs: INITIAL_SYNC_DELAY_MS,
  });
  const icsJob = ctx.scheduler.every(ICS_SYNC_JOB, ICS_SYNC_INTERVAL_MS, () => service.syncIcsAll(), {
    initialDelayMs: INITIAL_SYNC_DELAY_MS,
  });

  ctx.settings.onChange('calendar', (next, previous) => {
    if (next.syncIntervalMin !== previous.syncIntervalMin) accountsJob.reschedule(next.syncIntervalMin * 60 * 1000);
  });

  ctx.accounts.onChange((event) => {
    // A reconnect or settings change may have fixed what kept failing: try again right away.
    service.clearSyncBackoff(event.accountId);
    if (event.type === 'deleted') {
      service.forgetAccount(event.accountId);
      const defaultId = ctx.settings.get('calendar').defaultCalendarId;
      if (defaultId && !getCalendarRow(ctx.db, defaultId)) {
        try {
          ctx.settings.patch({ calendar: { defaultCalendarId: null } });
        } catch (err) {
          log.warn('could not reset the default calendar', errorFields(err));
        }
      }
      return;
    }
    const account = ctx.accounts.get(event.accountId);
    if (!account || !account.enabledCapabilities.includes('calendar')) {
      // Calendars that are not synced have no health to show (their rows stay for the settings).
      service.forgetAccount(event.accountId);
      return;
    }
    service.syncAccount(account.id).catch((err: unknown) => log.error('calendar sync after account change failed', errorFields(err)));
  });

  ctx.accounts.registerProbe('calendar', ['yahoo', 'caldav'], createCaldavProbe(ctx));

  registerCalendarRoutes(app, {
    ctx,
    service,
    syncNow: async () => {
      service.clearSyncBackoff(); // "Sync now" also retries calendars that are backing off
      await Promise.all([accountsJob.runNow(), icsJob.runNow()]);
    },
  });

  return { service };
}

export function register(app: Hono<AppEnv>, ctx: AppContext): void {
  setupCalendar(app, ctx);
}
