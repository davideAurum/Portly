/**
 * Server-only routes in the static build. App-password accounts (Yahoo, CalDAV, IMAP), the
 * credential vault, calendars, mail and the server's diagnostics need the Homebase server
 * (secrets, provider APIs, sync, its logs), and their UI is hidden behind `src/capabilities.ts`
 * (Settings → Diagnostics shows this browser's events and the hybrid state instead). (Outlook.com accounts and their sign-in
 * are handled in the browser by handlers/accounts.ts.) Every route the web app's API modules know is still
 * registered here so a stray call — a stale persisted layout, a hand-typed hash route, a cached
 * query — answers the server's own "not set up" error, `409 not_configured`, which the query
 * client never retries and ErrorState renders as "Not set up yet", instead of a `404` that would
 * read like a broken client. Nothing here touches state.
 *
 * Keep {@link UNAVAILABLE_ROUTES} in step with the paths and methods used in
 * web/src/api/accounts.ts, calendar.ts, mail.ts, feeds.ts, vault.ts and diagnostics.ts that
 * handlers/accounts.ts does not answer (the test pins the table). The OAuth callback is the site's own address on the
 * in-browser backend, never an API call, so it is not listed.
 */
import { unavailable } from '../respond.ts';
import type { StaticRouter } from '../router.ts';

/** The feature name in the error message: "<feature> is not available in the browser-only build." */
export type UnavailableFeature = 'Accounts' | 'The credential vault' | 'Calendars' | 'Mail' | 'Feeds' | 'Diagnostics';

export interface UnavailableRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pattern: string;
  feature: UnavailableFeature;
}

function route(method: UnavailableRoute['method'], pattern: string, feature: UnavailableFeature): UnavailableRoute {
  return Object.freeze({ method, pattern, feature });
}

/** Every server-only route the web app can call, in the server's route order. */
export const UNAVAILABLE_ROUTES: readonly UnavailableRoute[] = Object.freeze([
  // web/src/api/accounts.ts — app-password accounts (§7 Accounts); :kind is yahoo | caldav | imap
  route('POST', '/api/accounts/:kind', 'Accounts'),
  // web/src/api/vault.ts (§4.6)
  route('POST', '/api/vault/reset', 'The credential vault'),
  // web/src/api/calendar.ts (§7 Calendar)
  route('GET', '/api/calendar/calendars', 'Calendars'),
  route('PATCH', '/api/calendar/calendars/:id', 'Calendars'),
  route('DELETE', '/api/calendar/calendars/:id', 'Calendars'),
  route('POST', '/api/calendar/ics', 'Calendars'),
  route('PATCH', '/api/calendar/ics/:id', 'Calendars'),
  route('GET', '/api/calendar/events', 'Calendars'),
  route('POST', '/api/calendar/events', 'Calendars'),
  route('PATCH', '/api/calendar/events/:id', 'Calendars'),
  route('DELETE', '/api/calendar/events/:id', 'Calendars'),
  route('POST', '/api/calendar/sync', 'Calendars'),
  // web/src/api/mail.ts (§7 Mail)
  route('GET', '/api/mail/summary', 'Mail'),
  route('POST', '/api/mail/:accountId/messages/:id/read', 'Mail'),
  route('POST', '/api/mail/:accountId/messages/:id/archive', 'Mail'),
  route('POST', '/api/mail/:accountId/messages/:id/trash', 'Mail'),
  // web/src/api/feeds.ts (feeds are cross-origin documents: only the server can fetch them)
  route('GET', '/api/feeds', 'Feeds'),
  // web/src/api/diagnostics.ts (§17): the server's health, logs, log level, jobs and report, and
  // the upload of this browser's events (only sent while the backend is the server)
  route('GET', '/api/diagnostics/summary', 'Diagnostics'),
  route('GET', '/api/diagnostics/logs', 'Diagnostics'),
  route('GET', '/api/diagnostics/health/:key/history', 'Diagnostics'),
  route('PUT', '/api/diagnostics/level', 'Diagnostics'),
  route('POST', '/api/diagnostics/jobs/:name/run', 'Diagnostics'),
  route('GET', '/api/diagnostics/report', 'Diagnostics'),
  route('POST', '/api/diagnostics/client-events', 'Diagnostics'),
]);

export function register(router: StaticRouter): void {
  for (const { method, pattern, feature } of UNAVAILABLE_ROUTES) {
    router.add(method, pattern, () => unavailable(feature));
  }
}
