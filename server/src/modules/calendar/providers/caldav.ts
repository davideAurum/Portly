/**
 * CalDAV (Yahoo preset + generic), READ-ONLY in v1 (§8, §4.8, §4.9).
 *
 * - Requests go through tsdav's request helpers with a `fetch` transport built on safe-fetch's
 *   `user-server` policy whose `allowedOrigins` are the account's `credentialOrigins`: credentials
 *   (Basic auth) and redirects never leave those origins.
 * - XML containing `<!DOCTYPE` is rejected before tsdav parses it; bodies are capped (REPORT 10 MB,
 *   PROPFIND 1 MB). tsdav's XML parsing (xml-js) runs in a worker with a heap limit and a 5 s
 *   timeout (dav-xml.ts), never on the main thread.
 * - Every href in PROPFIND/REPORT responses is resolved against the request URL and dropped unless
 *   its origin is in `credentialOrigins`; event hrefs must also be under their collection path.
 * - Calendar data is parsed and expanded in the worker (§4.9).
 * - The account probe (`calendar` capability for yahoo/caldav) discovers the principal and the
 *   calendar home with the entered credentials; generic servers may extend `credentialOrigins`
 *   with same-site origins (same eTLD+1 via tldts) reached through `/.well-known/caldav`
 *   redirects. Yahoo's origin is fixed.
 * - A rejected password marks the account for reauth with reason `caldav_password_rejected`;
 *   other failures carry a health code in `details.reason` (for `outcomeFromError`). Outbound purposes:
 *   `caldav.propfind`, `caldav.report`, `caldav.wellknown`.
 */
import { getDomain } from 'tldts';
import { getDAVAttribute } from 'tsdav';
import {
  CaldavConnectionSchema,
  normalizeHexColor,
  type Account,
  type AccountDraft,
  type CaldavConnection,
} from '@portly/shared';
import type { AccountProbe, AppContext } from '../../../context.ts';
import { HttpError } from '../../../lib/errors.ts';
import { SIZE_CAPS, type SafeFetch } from '../../../security/safe-fetch.ts';
import { expandFailureCode, type ExpandRunner } from '../ical/run.ts';
import type { SyncWindow } from '../time.ts';
import { truncationWarning } from '../store.ts';
import type { CalendarRow, RemoteCalendar } from '../types.ts';
import { isRecord } from './http.ts';
import type { AccountProvider, EventListing } from './types.ts';
import { createDavXmlParser, davCall, DavParseError, parseDavXmlInWorker, type DavParsedResponse, type DavXmlParser } from './dav-xml.ts';

const DAV_TIMEOUT_MS = 20_000;
/** PROPFIND answers (discovery, calendar lists) are small; only REPORT may reach SIZE_CAPS.ics. */
export const PROPFIND_MAX_BYTES = 1024 * 1024;
const MAX_WELL_KNOWN_HOPS = 5;
const MAX_CALENDARS = 100;
const DOCTYPE = /<!DOCTYPE/i;

const NS = ['urn:ietf:params:xml:ns:caldav', 'http://apple.com/ns/ical/', 'http://calendarserver.org/ns/', 'DAV:'];

/** HTTP failure of a DAV request (status kept for discovery decisions; message is generic). */
export class DavHttpError extends HttpError {
  override name = 'DavHttpError';
  readonly httpStatus: number;
  constructor(httpStatus: number, message: string) {
    super(httpStatus === 401 ? 403 : 502, httpStatus === 401 ? 'forbidden' : 'provider_error', message);
    this.httpStatus = httpStatus;
  }
}

export interface DavCredentials {
  username: string;
  password: string;
}

function basicAuth(credentials: DavCredentials): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}`;
}

function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * A `fetch` for tsdav over safe-fetch (`user-server`, `allowedOrigins`, purpose `caldav.<method>`):
 * adds Basic auth, rejects non-2xx statuses (401 → auth error) and any XML with a DOCTYPE, caps
 * the body.
 */
export function createDavFetch(fetch: SafeFetch, allowedOrigins: readonly string[], credentials: DavCredentials): typeof globalThis.fetch {
  const authorization = basicAuth(credentials);
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = { ...headerRecord(init?.headers), Authorization: authorization };
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const method = (init?.method ?? 'GET').toUpperCase();
    const res = await fetch(url, {
      method,
      headers,
      body,
      policy: 'user-server',
      allowedOrigins,
      as: 'text',
      maxBytes: method === 'REPORT' ? SIZE_CAPS.ics : PROPFIND_MAX_BYTES,
      timeoutMs: DAV_TIMEOUT_MS,
      purpose: `caldav.${/^[A-Z]{1,16}$/.test(method) ? method.toLowerCase() : 'request'}`,
    });
    if (res.status === 401) throw new DavHttpError(401, 'The server rejected the username or password');
    if (res.status < 200 || res.status >= 300) throw new DavHttpError(res.status, `The CalDAV server answered ${res.status}`);
    if (DOCTYPE.test(res.data)) throw new DavHttpError(502, 'The CalDAV server sent XML with a DOCTYPE, which is not accepted');
    const response = new Response(res.status === 204 ? null : res.data, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/xml' },
    });
    Object.defineProperty(response, 'url', { value: res.url });
    return response;
  }) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// href handling
// ---------------------------------------------------------------------------

/** Resolves `href` against `base`; null unless the result's origin is in `origins`. */
export function resolveHref(href: unknown, base: string, origins: readonly string[]): URL | null {
  if (typeof href !== 'string' && typeof href !== 'number') return null;
  const text = String(href).trim();
  if (text === '' || text.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (!origins.includes(url.origin)) return null;
  url.hash = '';
  return url;
}

function withSlash(pathname: string): string {
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

/** True when `url` is a resource strictly inside the `collection` (same origin, under its path). */
export function isUnderCollection(url: URL, collection: URL): boolean {
  if (url.origin !== collection.origin) return false;
  let base: string;
  let path: string;
  try {
    base = withSlash(decodeURIComponent(collection.pathname));
    path = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) return false;
  return path.startsWith(base) && path.length > base.length;
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isRecord(value)) {
    if (typeof value._cdata === 'string') return value._cdata;
    if (typeof value._text === 'string') return value._text;
  }
  return null;
}

function hrefOf(value: unknown): unknown {
  if (isRecord(value)) {
    const href = value.href;
    return Array.isArray(href) ? href[0] : href;
  }
  return undefined;
}

function componentNames(comp: unknown): string[] {
  const list = Array.isArray(comp) ? comp : comp === undefined || comp === null ? [] : [comp];
  return list
    .map((c) => (isRecord(c) && isRecord(c._attributes) && typeof c._attributes.name === 'string' ? c._attributes.name.toUpperCase() : null))
    .filter((n): n is string => n !== null);
}

// ---------------------------------------------------------------------------
// DAV operations
// ---------------------------------------------------------------------------

export interface DavSession {
  fetch: typeof globalThis.fetch;
  origins: readonly string[];
  /** Parses DAV XML answers (default: in a worker). */
  parse?: DavXmlParser | undefined;
}

async function propfind(session: DavSession, url: string, props: Record<string, unknown>, depth: '0' | '1'): Promise<DavParsedResponse[]> {
  return davCall(
    {
      url,
      init: {
        method: 'PROPFIND',
        headers: { depth },
        namespace: 'd',
        body: { propfind: { _attributes: getDAVAttribute(NS as never[]), prop: props } },
      },
      fetch: session.fetch,
    },
    session.parse ?? parseDavXmlInWorker,
  );
}

/** `current-user-principal` of the resource at `url`, resolved and origin-checked. */
export async function findPrincipal(session: DavSession, url: string): Promise<string | null> {
  const responses = await propfind(session, url, { 'd:current-user-principal': {} }, '0');
  for (const r of responses) {
    const resolved = resolveHref(hrefOf(r.props?.currentUserPrincipal), url, session.origins);
    if (resolved) return resolved.href;
  }
  return null;
}

/** `calendar-home-set` of the principal, resolved and origin-checked. */
export async function findCalendarHome(session: DavSession, principalUrl: string): Promise<string | null> {
  const responses = await propfind(session, principalUrl, { 'c:calendar-home-set': {} }, '0');
  for (const r of responses) {
    const resolved = resolveHref(hrefOf(r.props?.calendarHomeSet), principalUrl, session.origins);
    if (resolved) return resolved.href;
  }
  return null;
}

export interface DavCalendarInfo {
  url: string;
  name: string;
  color: string | null;
  ctag: string | null;
}

/** Calendar collections (VEVENT-capable) in the home, hrefs resolved and origin-checked. */
export async function listDavCalendars(session: DavSession, homeUrl: string): Promise<DavCalendarInfo[]> {
  const responses = await propfind(
    session,
    homeUrl,
    {
      'd:displayname': {},
      'ca:calendar-color': {},
      'd:resourcetype': {},
      'c:supported-calendar-component-set': {},
      'cs:getctag': {},
    },
    '1',
  );
  const home = new URL(homeUrl);
  const out: DavCalendarInfo[] = [];
  const seen = new Set<string>();
  for (const r of responses) {
    if (!r.ok) continue;
    const url = resolveHref(r.href, homeUrl, session.origins);
    if (!url) continue;
    if (withSlash(url.pathname) === withSlash(home.pathname) && url.origin === home.origin) continue;
    const props = r.props ?? {};
    const types = isRecord(props.resourcetype) ? Object.keys(props.resourcetype) : [];
    if (!types.includes('calendar')) continue;
    const components = componentNames(isRecord(props.supportedCalendarComponentSet) ? props.supportedCalendarComponentSet.comp : undefined);
    if (components.length > 0 && !components.includes('VEVENT')) continue;
    const href = url.href;
    if (seen.has(href)) continue;
    seen.add(href);
    const name = textOf(props.displayname)?.trim();
    out.push({
      url: href,
      name: name && name !== '' ? name : decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? 'Calendar'),
      color: normalizeHexColor(textOf(props.calendarColor)?.trim()),
      ctag: textOf(props.getctag),
    });
    if (out.length >= MAX_CALENDARS) break;
  }
  return out;
}

function davTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

export interface DavObject {
  href: string;
  etag: string | null;
  data: string;
}

/** REPORT calendar-query (time-range) → calendar objects whose hrefs are inside the collection. */
export async function queryDavEvents(session: DavSession, collectionUrl: string, window: { fromMs: number; toMs: number }): Promise<DavObject[]> {
  const responses = await davCall(
    {
      url: collectionUrl,
      init: {
        method: 'REPORT',
        headers: { depth: '1' },
        namespace: 'c',
        body: {
          'calendar-query': {
            _attributes: getDAVAttribute(NS as never[]),
            'd:prop': { 'd:getetag': {}, 'c:calendar-data': {} },
            filter: {
              'comp-filter': {
                _attributes: { name: 'VCALENDAR' },
                'comp-filter': {
                  _attributes: { name: 'VEVENT' },
                  'time-range': { _attributes: { start: davTime(window.fromMs), end: davTime(window.toMs) } },
                },
              },
            },
          },
        },
      },
      fetch: session.fetch,
    },
    session.parse ?? parseDavXmlInWorker,
  );
  const collection = new URL(collectionUrl);
  const out: DavObject[] = [];
  for (const r of responses) {
    if (!r.ok) continue;
    const url = resolveHref(r.href, collectionUrl, session.origins);
    if (!url || !isUnderCollection(url, collection)) continue;
    const data = textOf(r.props?.calendarData);
    if (!data || !/BEGIN:VCALENDAR/i.test(data)) continue;
    out.push({ href: url.href, etag: textOf(r.props?.getetag), data });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discovery (probe) and provider
// ---------------------------------------------------------------------------

/** eTLD+1 of a URL's host (null for IP literals / unknown). */
function siteOf(url: URL): string | null {
  try {
    return getDomain(url.hostname, { allowPrivateDomains: false });
  } catch {
    return null;
  }
}

export function isSameSite(a: URL, b: URL): boolean {
  if (a.protocol !== b.protocol && !(a.protocol === 'http:' && b.protocol === 'https:')) return false;
  if (a.hostname === b.hostname) return true;
  const sa = siteOf(a);
  return sa !== null && sa === siteOf(b);
}

export interface DiscoveryResult {
  credentialOrigins: string[];
  principalUrl: string;
  calendarHomeUrl: string;
  calendars: DavCalendarInfo[];
}

/**
 * Finds principal + calendar home: PROPFIND on the server URL first; if that yields no principal,
 * follows `/.well-known/caldav` redirects by hand, extending the credential origins with
 * same-site origins when `allowSameSite` (generic servers; Yahoo stays fixed).
 */
export async function discoverCaldav(
  fetch: SafeFetch,
  connection: CaldavConnection,
  credentials: DavCredentials,
  options: { allowSameSite: boolean; parse?: DavXmlParser },
): Promise<DiscoveryResult> {
  const serverUrl = new URL(connection.serverUrl);
  const origins = new Set<string>(connection.credentialOrigins.length > 0 ? connection.credentialOrigins : [serverUrl.origin]);
  const session = (): DavSession => ({ fetch: createDavFetch(fetch, [...origins], credentials), origins: [...origins], parse: options.parse });

  let principal: string | null = null;
  let firstError: unknown = null;
  try {
    principal = await findPrincipal(session(), serverUrl.href);
  } catch (err) {
    if (err instanceof DavHttpError && err.httpStatus === 401) throw err;
    firstError = err;
  }

  if (!principal) {
    // RFC 6764: /.well-known/caldav, redirects followed manually and re-validated.
    let current = new URL('/.well-known/caldav', serverUrl);
    for (let hop = 0; hop <= MAX_WELL_KNOWN_HOPS; hop++) {
      let res;
      try {
        res = await fetch(current.href, {
          method: 'PROPFIND',
          headers: { Authorization: basicAuth(credentials), Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
          body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>',
          policy: 'user-server',
          allowedOrigins: [...origins],
          as: 'text',
          maxBytes: 1024 * 1024,
          redirect: 'manual',
          timeoutMs: DAV_TIMEOUT_MS,
          purpose: 'caldav.wellknown',
        });
      } catch {
        break;
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          break;
        }
        if (!origins.has(next.origin)) {
          if (!options.allowSameSite || !isSameSite(serverUrl, next) || next.protocol !== 'https:') {
            throw new HttpError(502, 'provider_error', 'The CalDAV server redirected to a different site; enter the final server URL instead');
          }
          origins.add(next.origin);
        }
        current = next;
        continue;
      }
      if (res.status === 401) throw new DavHttpError(401, 'The server rejected the username or password');
      if (res.status >= 200 && res.status < 300) {
        try {
          principal = await findPrincipal(session(), current.href);
        } catch (err) {
          if (err instanceof DavHttpError && err.httpStatus === 401) throw err;
        }
      }
      break;
    }
  }

  if (!principal) {
    const status = firstError instanceof DavHttpError ? ` (the server answered ${firstError.httpStatus})` : '';
    throw new HttpError(502, 'provider_error', `No CalDAV account was found at this address${status}`);
  }
  const home = await findCalendarHome(session(), principal);
  if (!home) throw new HttpError(502, 'provider_error', 'The CalDAV server did not report a calendar home');
  const calendars = await listDavCalendars(session(), home);
  return { credentialOrigins: [...origins], principalUrl: principal, calendarHomeUrl: home, calendars };
}

function connectionOf(config: Record<string, unknown>): CaldavConnection | null {
  const parsed = CaldavConnectionSchema.safeParse(config.caldav);
  return parsed.success ? parsed.data : null;
}

function usernameOf(config: Record<string, unknown>): string {
  return typeof config.username === 'string' ? config.username : '';
}

/** Health code (for `outcomeFromError`) of an answer the XML worker could not read. */
function davParseCode(err: DavParseError): 'too_large' | 'timeout' | 'parse_error' {
  return err.reason === 'limit' ? 'too_large' : err.reason === 'timeout' ? 'timeout' : 'parse_error';
}

/**
 * Maps any non-HttpError failure to a generic message (tsdav errors may embed raw server text);
 * the original stays as `cause` (logged as a name/code chain only).
 */
function sanitizeDavError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  throw new HttpError(502, 'provider_error', {
    message: 'The CalDAV server sent an unexpected response',
    cause: err,
    ...(err instanceof DavParseError ? { details: { reason: davParseCode(err) } } : {}),
  });
}

/** XML parser of the module's CalDAV requests: in a worker, failures logged as the calendar module's. */
function moduleDavParser(ctx: Pick<AppContext, 'log'>): DavXmlParser {
  return createDavXmlParser({ log: ctx.log.child({ module: 'calendar' }) });
}

/** Account probe for the `calendar` capability (yahoo, caldav). */
export function createCaldavProbe(ctx: Pick<AppContext, 'fetch' | 'log'>): AccountProbe {
  const parse = moduleDavParser(ctx);
  return async (draft: AccountDraft) => {
    const connection = connectionOf(draft.config);
    if (!connection) throw new HttpError(422, 'validation_failed', 'CalDAV settings are missing');
    try {
      const result = await discoverCaldav(
        ctx.fetch,
        connection,
        { username: usernameOf(draft.config), password: draft.secret.password },
        { allowSameSite: draft.kind === 'caldav', parse },
      );
      return {
        configPatch: {
          caldav: {
            credentialOrigins: result.credentialOrigins,
            principalUrl: result.principalUrl,
            calendarHomeUrl: result.calendarHomeUrl,
          },
        },
      };
    } catch (err) {
      sanitizeDavError(err);
    }
  };
}

export function createCaldavProvider(
  ctx: Pick<AppContext, 'fetch' | 'accounts' | 'log'>,
  runExpand: ExpandRunner,
): AccountProvider {
  const parse = moduleDavParser(ctx);
  const sessionFor = async (account: Account): Promise<{ session: DavSession; connection: CaldavConnection }> => {
    const config = ctx.accounts.getConfig(account.id) as unknown as Record<string, unknown>;
    const connection = connectionOf(config);
    if (!connection) throw new HttpError(409, 'not_configured', { message: 'This account has no CalDAV settings', accountId: account.id });
    const { password } = await ctx.accounts.getSecret(account.id);
    const origins = connection.credentialOrigins.length > 0 ? connection.credentialOrigins : [new URL(connection.serverUrl).origin];
    return { session: { fetch: createDavFetch(ctx.fetch, origins, { username: usernameOf(config), password }), origins, parse }, connection };
  };

  const onAuthFailure = (account: Account, err: unknown): never => {
    if (err instanceof DavHttpError && err.httpStatus === 401) {
      ctx.accounts.setStatus(account.id, 'reauth', 'The CalDAV server rejected the password', {
        reason: 'caldav_password_rejected',
        source: 'calendar',
      });
      throw new HttpError(409, 'reauth_required', { message: 'The CalDAV server rejected the password', accountId: account.id, cause: err });
    }
    return sanitizeDavError(err);
  };

  return {
    source: 'caldav',

    async listCalendars(account) {
      const { session, connection } = await sessionFor(account);
      try {
        let home = connection.calendarHomeUrl ?? null;
        if (!home) {
          const principal = connection.principalUrl ?? (await findPrincipal(session, connection.serverUrl));
          home = principal ? await findCalendarHome(session, principal) : null;
        }
        if (!home || !resolveHref(home, home, session.origins)) {
          throw new HttpError(502, 'provider_error', { message: 'The CalDAV calendar home could not be found', accountId: account.id });
        }
        const calendars = await listDavCalendars(session, home);
        return calendars.map(
          (c, index): RemoteCalendar => ({
            remoteId: c.url,
            name: c.name,
            color: c.color,
            writable: false,
            primary: index === 0,
            collectionUrl: c.url,
            ctag: c.ctag,
          }),
        );
      } catch (err) {
        return onAuthFailure(account, err);
      }
    },

    async listEvents(account, calendar: CalendarRow, window: SyncWindow): Promise<EventListing> {
      const { session } = await sessionFor(account);
      const collectionUrl = calendar.collection_url ?? calendar.remote_id;
      if (!resolveHref(collectionUrl, collectionUrl, session.origins)) {
        throw new HttpError(502, 'provider_error', { message: 'The calendar address is outside this account’s server', accountId: account.id });
      }
      let objects: DavObject[];
      try {
        objects = await queryDavEvents(session, collectionUrl, window);
      } catch (err) {
        return onAuthFailure(account, err);
      }
      const result = await runExpand({
        sources: objects.map((o) => ({ data: o.data, etag: o.etag })),
        window: { fromDate: window.fromDate, toDate: window.toDate, fromMs: window.fromMs, toMs: window.toMs },
        localTz: window.tz,
      });
      if (!result.ok) {
        throw new HttpError(502, 'provider_error', { message: result.message, accountId: account.id, details: { reason: expandFailureCode(result.reason) } });
      }
      return { events: result.events, warning: truncationWarning(result.truncated, result.descriptionsDropped) };
    },
  };
}
