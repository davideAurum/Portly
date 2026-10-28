/**
 * The OneDrive store of launch pad sync (docs/design/launchpad-sync.md sections 2, 4 and 6.5): the
 * file and its icons in the app's own folder (`/me/drive/special/approot`), reached with the
 * Microsoft connection's token and the `Files.ReadWrite.AppFolder` permission only.
 *
 * - Metadata comes from Graph: `GET approot:/<path>?select=id,eTag,cTag,size,@microsoft.graph.downloadUrl`
 *   (`select` without the `$`, or Graph leaves the download URL out). `404` means no file yet.
 * - Content is downloaded from `@microsoft.graph.downloadUrl` itself: a simple cross-origin `GET`
 *   with no `Authorization` header (no preflight), no credentials, no referrer, no redirects, a
 *   byte cap and a deadline, and only from a host in {@link DRIVE_DOWNLOAD_HOSTS}. The URL carries
 *   a short-lived credential: it is never logged or stored.
 * - The main file is written with a simple `PUT .../content`, with `If-Match: <eTag>` or, when
 *   there is no file yet, `@microsoft.graph.conflictBehavior=fail`; `412` or `409` is a conflict
 *   (another browser wrote first). Icons are create-only (`409`: already there, which is fine).
 * - The version of the file is its `eTag`. The text last read or written is kept in memory for the
 *   page, per account: when the metadata shows the same `eTag`, it is not downloaded again, so most
 *   checks are one small request (an `eTag`'s content never changes).
 *
 * Failures become {@link SyncStoreError}s: a second `401` → `reauth_required` (the account shows
 * Reconnect, as for the calendar), `429` or `503` with `Retry-After` → `rate_limited`, a body over
 * its cap → `too_large`, no answer → `network_error`, anything else → `unavailable`. A failed
 * request is this browser's `provider` event: status and Graph's error code, never the URL, a
 * path, an id or a token.
 */
import { SyncIconId } from '@portly/shared';
import { z } from 'zod';
import type { StaticContext } from '../context.ts';
import { getAccessToken, rejectFreshToken } from '../handlers/accounts.ts';
import { classifyFetchError, readBytesCapped, readTextCapped, UpstreamPayloadTooLargeError, withTimeout, type FetchLike } from '../lib/fetch.ts';
import { StaticApiError } from '../respond.ts';
import { SYNC_MAX_ICON_BYTES, SYNC_MAX_MAIN_BYTES, SyncStoreError, type SyncFileVersion, type SyncStore, type SyncWriteResult } from '../sync/store.ts';
import { errorName, hostOf, recordProviderFailure, statusFailureCode, stopwatch, transportFailureCode } from './diagnostics.ts';
import { GRAPH_API, isRecord } from './graphCalendar.ts';
import { GRAPH_HOST, parseRetryAfter } from './graphClient.ts';

/**
 * Hosts a download URL may point at. `my.microsoftpersonalcontent.com` is the only one the spike
 * saw for a personal account (design section 13). Microsoft's documented example,
 * `*.files.1drv.com`, is left out until a real sign-in shows it (ROADMAP 6.5): an unverified host
 * is not allowed.
 */
export const DRIVE_DOWNLOAD_HOSTS: readonly string[] = Object.freeze(['my.microsoftpersonalcontent.com']);

const APPROOT = `${GRAPH_API}/me/drive/special/approot:`;
const MAIN_PATH = '/launchpad.json';
const ICON_FOLDER = '/launchpad-icons/';
const SELECT = 'select=id,eTag,cTag,size,@microsoft.graph.downloadUrl';
const CREATE_ONLY = '@microsoft.graph.conflictBehavior=fail';

/** Deadline for a metadata request, and for moving a file's bytes. */
export const DRIVE_META_TIMEOUT_MS = 20_000;
export const DRIVE_TRANSFER_TIMEOUT_MS = 120_000;
/** Cap for a metadata answer. */
const META_MAX_BYTES = 256 * 1024;

const REASON_TOKEN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

const DriveItemSchema = z.looseObject({
  id: z.string().min(1).max(512),
  eTag: z.string().min(1).max(512),
  size: z.number().int().min(0),
  '@microsoft.graph.downloadUrl': z.string().max(8192).optional(),
});

/** The main file's text last read or written, per page (backend) and account. */
const lastMain = new WeakMap<StaticContext, Map<string, SyncFileVersion>>();

function remembered(ctx: StaticContext): Map<string, SyncFileVersion> {
  let byAccount = lastMain.get(ctx);
  if (!byAccount) {
    byAccount = new Map();
    lastMain.set(ctx, byAccount);
  }
  return byAccount;
}

export interface GraphDriveOptions {
  /** Transport (default `globalThis.fetch`, read at call time). */
  fetch?: FetchLike;
}

interface DriveAnswer {
  status: number;
  headers: Headers;
  text: string;
}

function graphReason(text: string): string | null {
  try {
    const data: unknown = JSON.parse(text);
    const code = isRecord(data) && isRecord(data.error) ? data.error.code : undefined;
    return typeof code === 'string' && REASON_TOKEN.test(code) ? code : null;
  } catch {
    return null;
  }
}

function rethrowAbort(err: unknown): void {
  if (classifyFetchError(err) === 'aborted') throw err;
}

/** The store error for a transport failure (the caller's abort is rethrown). */
function transportError(err: unknown, what: string): SyncStoreError {
  rethrowAbort(err);
  if (err instanceof UpstreamPayloadTooLargeError) return new SyncStoreError('too_large', `${what} is too large`);
  return new SyncStoreError('network_error', `Could not reach OneDrive (${what})`);
}

export function createGraphDriveStore(ctx: StaticContext, accountId: string, options: GraphDriveOptions = {}): SyncStore {
  const transport = (): FetchLike => options.fetch ?? globalThis.fetch;

  async function token(rejected?: string): Promise<string> {
    try {
      return await getAccessToken(ctx, accountId, rejected === undefined ? {} : { rejected });
    } catch (err) {
      rethrowAbort(err);
      if (err instanceof StaticApiError) {
        if (err.code === 'reauth_required') throw new SyncStoreError('reauth_required', 'The Microsoft account needs reconnecting');
        if (err.code === 'rate_limited') throw new SyncStoreError('rate_limited', 'Microsoft is rate limiting sign-in refreshes');
        if (err.code === 'not_found' || err.code === 'not_configured') throw new SyncStoreError('unavailable', 'The Microsoft connection is gone');
      }
      throw new SyncStoreError('network_error', 'Could not refresh the Microsoft sign-in');
    }
  }

  async function once(url: string, init: RequestInit, bearer: string, signal: AbortSignal, timeoutMs: number): Promise<DriveAnswer> {
    const elapsed = stopwatch();
    try {
      return await withTimeout({ timeoutMs, signal }, async (combined) => {
        const res = await transport()(url, {
          ...init,
          headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
          redirect: 'error',
          credentials: 'omit',
          signal: combined,
        });
        return { status: res.status, headers: res.headers, text: await readTextCapped(res, META_MAX_BYTES) };
      });
    } catch (err) {
      rethrowAbort(err);
      const code = transportFailureCode(err);
      if (code !== null) recordProviderFailure('microsoft', GRAPH_HOST, { code, errName: errorName(err), ms: elapsed() });
      throw transportError(err, 'a OneDrive request');
    }
  }

  /** One Graph request (one refresh-and-retry on 401). Statuses in `expected` are answers; others throw. */
  async function graph(url: string, init: RequestInit, signal: AbortSignal, expected: readonly number[], timeoutMs = DRIVE_META_TIMEOUT_MS): Promise<DriveAnswer> {
    const first = await token();
    let answer = await once(url, init, first, signal, timeoutMs);
    if (answer.status === 401) {
      const fresh = await token(first);
      answer = await once(url, init, fresh, signal, timeoutMs);
      if (answer.status === 401) {
        recordProviderFailure('microsoft', GRAPH_HOST, { status: 401, code: 'token_rejected' });
        await rejectFreshToken(ctx, accountId);
        throw new SyncStoreError('reauth_required', 'OneDrive refused the Microsoft sign-in');
      }
    }
    if (expected.includes(answer.status)) return answer;
    const reason = graphReason(answer.text);
    recordProviderFailure('microsoft', GRAPH_HOST, { status: answer.status, code: reason ?? statusFailureCode(answer.status) });
    const retryAfter = parseRetryAfter(answer.headers.get('retry-after'), ctx.now());
    if (answer.status === 429 || (answer.status === 503 && retryAfter !== null)) {
      throw new SyncStoreError('rate_limited', 'OneDrive is rate limiting requests', retryAfter === null ? null : retryAfter * 1000);
    }
    if (answer.status === 413) throw new SyncStoreError('too_large', 'OneDrive refused a file this large');
    throw new SyncStoreError('unavailable', `OneDrive answered ${answer.status}`);
  }

  function itemOf(answer: DriveAnswer): z.output<typeof DriveItemSchema> {
    try {
      const parsed = DriveItemSchema.safeParse(JSON.parse(answer.text));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON: refused below.
    }
    recordProviderFailure('microsoft', GRAPH_HOST, { status: answer.status, code: 'parse_error' });
    throw new SyncStoreError('unavailable', 'OneDrive returned an unexpected answer');
  }

  /** Downloads from a pre-authenticated URL Graph gave: an allowed https host, a simple request, capped. */
  async function download(link: string | undefined, maxBytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    let url: URL;
    try {
      url = new URL(link ?? '');
    } catch {
      throw new SyncStoreError('unavailable', 'OneDrive gave no download link');
    }
    if (url.protocol !== 'https:' || !DRIVE_DOWNLOAD_HOSTS.includes(url.hostname)) {
      recordProviderFailure('microsoft', 'download', { code: 'download_host_refused' });
      throw new SyncStoreError('unavailable', 'OneDrive gave a download link on a host Portly does not allow');
    }
    const host = hostOf(url);
    const elapsed = stopwatch();
    let status: number;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      ({ status, bytes } = await withTimeout({ timeoutMs: DRIVE_TRANSFER_TIMEOUT_MS, signal }, async (combined) => {
        const res = await transport()(url.href, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal: combined });
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => undefined);
          return { status: res.status, bytes: new Uint8Array(0) };
        }
        return { status: res.status, bytes: await readBytesCapped(res, maxBytes) };
      }));
    } catch (err) {
      rethrowAbort(err);
      const code = transportFailureCode(err);
      if (code !== null) recordProviderFailure('microsoft', host, { code, errName: errorName(err), ms: elapsed() });
      throw transportError(err, 'a OneDrive download');
    }
    if (status !== 200) {
      recordProviderFailure('microsoft', host, { status, code: statusFailureCode(status), ms: elapsed() });
      throw new SyncStoreError(status === 429 ? 'rate_limited' : 'unavailable', `The OneDrive download answered ${status}`);
    }
    return bytes;
  }

  function iconPath(id: string): string {
    // The only string from the synced file that goes into a path: a lower-case UUIDv4.
    if (!SyncIconId.safeParse(id).success) throw new SyncStoreError('unavailable', 'Not an icon id');
    return `${APPROOT}${ICON_FOLDER}${id}`;
  }

  return {
    kind: 'onedrive',

    async readMain(signal): Promise<SyncFileVersion | null> {
      const answer = await graph(`${APPROOT}${MAIN_PATH}?${SELECT}`, { method: 'GET' }, signal, [200, 404]);
      if (answer.status === 404) return null;
      const item = itemOf(answer);
      if (item.size > SYNC_MAX_MAIN_BYTES) throw new SyncStoreError('too_large', 'The synced launch pad is too large');
      const known = remembered(ctx).get(accountId);
      if (known?.version === item.eTag) return known;
      const bytes = await download(item['@microsoft.graph.downloadUrl'], SYNC_MAX_MAIN_BYTES, signal);
      const read = { text: new TextDecoder('utf-8').decode(bytes), version: item.eTag };
      remembered(ctx).set(accountId, read);
      return read;
    },

    async writeMain(text, ifVersion, signal): Promise<SyncWriteResult> {
      const body = new TextEncoder().encode(text);
      if (body.byteLength > SYNC_MAX_MAIN_BYTES) throw new SyncStoreError('too_large', 'The launch pad is too large to sync');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ifVersion !== null) headers['If-Match'] = ifVersion;
      const url = `${APPROOT}${MAIN_PATH}:/content${ifVersion === null ? `?${CREATE_ONLY}` : ''}`;
      const answer = await graph(url, { method: 'PUT', headers, body }, signal, [200, 201, 409, 412], DRIVE_TRANSFER_TIMEOUT_MS);
      if (answer.status === 409 || answer.status === 412) return { ok: false, reason: 'conflict' };
      const version = itemOf(answer).eTag;
      remembered(ctx).set(accountId, { text, version });
      return { ok: true, version };
    },

    async readIcon(id, signal): Promise<Blob | null> {
      const answer = await graph(`${iconPath(id)}?${SELECT}`, { method: 'GET' }, signal, [200, 404]);
      if (answer.status === 404) return null;
      const item = itemOf(answer);
      if (item.size > SYNC_MAX_ICON_BYTES) throw new SyncStoreError('too_large', 'A synced icon is too large');
      const bytes = await download(item['@microsoft.graph.downloadUrl'], SYNC_MAX_ICON_BYTES, signal);
      return new Blob([bytes]);
    },

    async writeIcon(id, data, signal): Promise<void> {
      if (data.size > SYNC_MAX_ICON_BYTES) throw new SyncStoreError('too_large', 'An icon is too large to sync');
      const url = `${iconPath(id)}:/content?${CREATE_ONLY}`;
      // 409: the icon is already there. Icons never change, so that is done.
      await graph(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data }, signal, [200, 201, 409], DRIVE_TRANSFER_TIMEOUT_MS);
    },

    async deleteIcon(id, signal): Promise<void> {
      await graph(iconPath(id), { method: 'DELETE' }, signal, [204, 404]);
    },
  };
}
