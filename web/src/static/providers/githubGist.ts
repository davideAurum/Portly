/**
 * Launch pad sync through GitHub gists: a {@link SyncStore} over `api.github.com` with a personal
 * access token (docs/design/launchpad-sync-gist.md). Not wired to a sync engine yet.
 *
 * Layout: two **secret** gists in the token's account, found again by a fixed file name and
 * remembered by id in this browser (`onIdsChange`):
 * - the main gist holds one file, {@link MAIN_FILE}; its version is the gist's newest revision
 *   (`history[0].version`, a commit SHA), so nothing but launch pad writes moves it;
 * - the icons gist holds {@link ICONS_MARKER_FILE} and one base64 text file per icon,
 *   `icon-<uuid>.b64`. Icons live apart so that icon uploads do not move the main version and a
 *   check of the main file never downloads them.
 *
 * Secret gists are unlisted, not private: anyone with the address can read them.
 *
 * **Conflicts.** GitHub has no conditional write for gists (its ETags are weak, and `If-Match` is
 * not documented on `PATCH /gists/{id}`). {@link GistStore.writeMain} therefore reads the newest
 * revision right before it writes and refuses when it moved. A write by another browser that lands
 * between that read and this `PATCH` (one round trip) is seen afterwards: the new revision's parent
 * (`history[1]`) is then not the revision checked. The store puts the other browser's text back
 * (`GET /gists/{id}/{sha}`, then a second `PATCH`) and answers `conflict`, so the engine reads,
 * merges and writes again, as after a refused write. Writes of three browsers within the same
 * second can still lose one of them until that browser's next check, which merges its own copy in
 * again (the merge is state-based: every browser keeps the whole launch pad).
 *
 * **Sizes.** The API returns at most 1 MB of each file (`truncated`, then `raw_url` on
 * `gist.githubusercontent.com`, which answers any origin) and at most 300 files per gist. `raw_url`
 * serves files up to 10 MB, so the main file is capped at {@link GIST_MAIN_MAX_BYTES} and an icon
 * at {@link GIST_ICON_MAX_BYTES} (its base64 text then stays under 10 MB). Every body is read with a
 * byte cap.
 *
 * **Hostile input.** Every answer is parsed with zod; ids and SHAs must match their patterns before
 * they go into a path; a `raw_url` must be `https://gist.githubusercontent.com/<owner>/<gist id>/raw/…`
 * and is fetched with no credentials, no referrer and no custom header. The main text is returned
 * as is: the engine validates it like an import file. Errors never carry the token, ids or URLs.
 */
import { z } from 'zod';
import { decodeBase64, encodeBase64 } from '../lib/base64.ts';
import { classifyFetchError, fetchTextCapped, UpstreamPayloadTooLargeError, type FetchedText, type FetchLike } from '../lib/fetch.ts';
import { SYNC_MAX_ICON_BYTES, SYNC_MAX_MAIN_BYTES, SyncStoreError, type SyncFileVersion, type SyncStore, type SyncWriteResult } from '../sync/store.ts';

export const GITHUB_API = 'https://api.github.com';
export const GIST_RAW_HOST = 'gist.githubusercontent.com';
export const GITHUB_API_VERSION = '2022-11-28';

export const MAIN_FILE = 'portly-launchpad.json';
export const ICONS_MARKER_FILE = 'portly-launchpad-icons.txt';
export const MAIN_DESCRIPTION = 'Portly launch pad sync (kept by Portly: do not rename its file)';
export const ICONS_DESCRIPTION = 'Portly launch pad icons (kept by Portly: do not rename its files)';
const ICONS_MARKER_TEXT =
  'Custom icons of the Portly launch pad, one base64 file per icon. Portly adds and removes them. ' +
  'This gist is secret, not private: anyone with its address can read it.\n';

/** Largest file `raw_url` serves; bigger ones need a git clone. */
export const GIST_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** The API lists at most this many files of a gist. */
export const GIST_MAX_FILES = 300;
export const GIST_MAIN_MAX_BYTES = Math.min(SYNC_MAX_MAIN_BYTES, GIST_MAX_FILE_BYTES);
/** An icon whose base64 text fits in one gist file. */
export const GIST_ICON_MAX_BYTES = Math.min(SYNC_MAX_ICON_BYTES, Math.floor(GIST_MAX_FILE_BYTES / 4) * 3);
/** All icon files together, so one `GET` of the icons gist stays bounded. */
export const GIST_ICONS_TOTAL_MAX_BYTES = 48 * 1024 * 1024;

/** Response caps: the main gist inlines at most 1 MB of text (JSON escaping can grow it). */
const MAIN_GIST_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const ICONS_GIST_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const LIST_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const ERROR_RESPONSE_MAX_BYTES = 64 * 1024;
/** `GET /gists` pages of 100 looked through when searching for the sync gists. */
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 10;
/** A missing icon reads the icons gist again only when the copy at hand is older than this. */
export const ICONS_REFRESH_MS = 30_000;

export const REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRY_AFTER_MS = 60_000;
export const MAX_RETRY_AFTER_MS = 60 * 60_000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GIST_ID = /^[A-Za-z0-9]{1,64}$/;
const REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function iconFileName(id: string): string {
  return `icon-${id}.b64`;
}

// ---------------------------------------------------------------------------
// GitHub's answers
// ---------------------------------------------------------------------------

const GistFileSchema = z.object({
  size: z.number().int().nonnegative(),
  raw_url: z.string().max(2048),
  truncated: z.boolean().optional(),
  content: z.string().optional(),
});

const GistSchema = z.object({
  id: z.string().regex(GIST_ID),
  public: z.boolean(),
  created_at: z.string().max(64),
  // A deleted file shows as null in some answers.
  files: z.record(z.string().max(1024), GistFileSchema.nullable()),
  truncated: z.boolean().optional(),
  history: z.array(z.object({ version: z.string().regex(REVISION) })).optional(),
});

/** A listed gist: files without content, no history. */
const ListedGistSchema = z.object({
  id: z.string().regex(GIST_ID),
  public: z.boolean(),
  created_at: z.string().max(64),
  files: z.record(z.string().max(1024), z.unknown()),
});

type GistFile = z.output<typeof GistFileSchema>;
type Gist = z.output<typeof GistSchema>;
type ListedGist = z.output<typeof ListedGistSchema>;

export type GistKind = 'main' | 'icons';

/** The ids of this browser's sync gists, remembered between page loads. */
export interface GistIds {
  main: string | null;
  icons: string | null;
}

export interface GistStoreOptions {
  token: string;
  ids?: GistIds;
  /** Called whenever an id is found, created or forgotten; the caller persists it. */
  onIdsChange?(ids: GistIds): void | Promise<void>;
  /** Transport (default `globalThis.fetch`, read at call time). */
  fetch?: FetchLike;
  /** Clock (epoch ms), for `X-RateLimit-Reset`. */
  now?(): number;
}

interface GistResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function retryAfterMs(headers: Headers, now: number): number {
  const retry = headers.get('retry-after')?.trim();
  let ms: number | null = null;
  if (retry !== undefined && /^\d+$/.test(retry)) ms = Number(retry) * 1000;
  const reset = headers.get('x-ratelimit-reset')?.trim();
  if (ms === null && headers.get('x-ratelimit-remaining')?.trim() === '0' && reset !== undefined && /^\d+$/.test(reset)) {
    ms = Number(reset) * 1000 - now;
  }
  if (ms === null || !Number.isFinite(ms)) ms = DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, ms));
}

function messageOf(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' ? message.slice(0, 500) : '';
}

/**
 * The store error for a refused request. 403 is a rate limit when GitHub says so (no requests
 * left, `Retry-After`, or "rate limit" in its message), otherwise a token that may not do this.
 * GitHub's text is only matched, never passed on.
 */
export function statusError(status: number, headers: Headers, body: unknown, now: number): SyncStoreError {
  const limited =
    status === 429 ||
    (status === 403 && (headers.get('x-ratelimit-remaining')?.trim() === '0' || headers.has('retry-after') || /rate limit/i.test(messageOf(body))));
  if (limited) return new SyncStoreError('rate_limited', 'GitHub is limiting requests. Sync tries again later.', retryAfterMs(headers, now));
  if (status === 401) return new SyncStoreError('reauth_required', 'GitHub refused the saved token. Paste a new one in Settings → Accounts.');
  if (status === 403) {
    return new SyncStoreError('reauth_required', 'The saved GitHub token may not change gists. Create one with the gist permission in Settings → Accounts.');
  }
  if (status === 413) return new SyncStoreError('too_large', 'GitHub refused a file this large.');
  if (status >= 500) return new SyncStoreError('unavailable', `GitHub is having problems (HTTP ${status}). Sync tries again later.`);
  return new SyncStoreError('unavailable', `GitHub returned an unexpected answer (HTTP ${status}).`);
}

/** A transport failure as a store error; the caller's own abort is rethrown as is. */
function transportError(err: unknown): SyncStoreError {
  if (err instanceof SyncStoreError) return err;
  if (err instanceof UpstreamPayloadTooLargeError) return new SyncStoreError('too_large', 'An answer from GitHub was larger than Portly accepts.');
  switch (classifyFetchError(err)) {
    case 'aborted':
      throw err;
    case 'timeout':
      return new SyncStoreError('network_error', 'GitHub did not answer in time.');
    case 'network':
      return new SyncStoreError('network_error', 'GitHub could not be reached.');
  }
}

function invalidAnswer(): SyncStoreError {
  return new SyncStoreError('unavailable', 'GitHub returned an answer Portly could not read.');
}

function publicGist(): SyncStoreError {
  return new SyncStoreError('unavailable', 'The sync gist was made public on GitHub. Portly no longer uses it: delete it, and sync starts a new secret one.');
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function checkIconId(id: string): void {
  if (!UUID_V4.test(id)) throw new RangeError('Icon ids must be UUIDv4');
}

/** The oldest gist first, so every browser that finds two picks the same one. */
function compareAge(a: ListedGist, b: ListedGist): number {
  // Code-point order, not localeCompare: the choice must not depend on the browser's locale.
  const byTime = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  return byTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The headers of every REST call: JSON, the token, a pinned API version. */
export function githubHeaders(token: string): Record<string, string> {
  return { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': GITHUB_API_VERSION };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class GistStore implements SyncStore {
  readonly kind = 'gist' as const;
  private readonly token: string;
  private readonly transport: FetchLike | undefined;
  private readonly now: () => number;
  private readonly onIdsChange: GistStoreOptions['onIdsChange'];
  private ids: GistIds;
  /** The icons gist as last read: icons never change, so reads reuse it until a miss. */
  private iconsCache: Gist | null = null;
  private iconsReadAt = Number.NEGATIVE_INFINITY;

  constructor(options: GistStoreOptions) {
    this.token = options.token;
    this.transport = options.fetch;
    this.now = options.now ?? (() => Date.now());
    this.onIdsChange = options.onIdsChange;
    const ids = options.ids ?? { main: null, icons: null };
    this.ids = {
      main: ids.main !== null && GIST_ID.test(ids.main) ? ids.main : null,
      icons: ids.icons !== null && GIST_ID.test(ids.icons) ? ids.icons : null,
    };
  }

  // ---- main file ------------------------------------------------------------

  async readMain(signal: AbortSignal): Promise<SyncFileVersion | null> {
    const gist = await this.findGist('main', signal);
    if (gist === null) return null;
    const file = gist.files[MAIN_FILE];
    if (file === undefined || file === null) return null;
    const version = gist.history?.[0]?.version;
    if (version === undefined) throw invalidAnswer();
    const text = await this.fileText(gist, MAIN_FILE, file, GIST_MAIN_MAX_BYTES, signal);
    return { text, version };
  }

  async writeMain(text: string, ifVersion: string | null, signal: AbortSignal): Promise<SyncWriteResult> {
    if (utf8Bytes(text) > GIST_MAIN_MAX_BYTES) throw new SyncStoreError('too_large', 'The launch pad is too large to sync through a gist.');
    const gist = await this.findGist('main', signal);
    if (gist === null) {
      // The file was there when the engine read it, and is gone now: let it read again.
      if (ifVersion !== null) return { ok: false, reason: 'conflict' };
      const created = await this.createGist('main', { [MAIN_FILE]: { content: text } }, signal);
      // Another browser created the gist at the same time, and its gist wins.
      if (created === null) return { ok: false, reason: 'conflict' };
      const version = created.history?.[0]?.version;
      if (version === undefined) throw invalidAnswer();
      return { ok: true, version };
    }
    const head = gist.history?.[0]?.version;
    if (head === undefined) throw invalidAnswer();
    const hasFile = gist.files[MAIN_FILE] != null;
    if (ifVersion === null ? hasFile : !hasFile || head !== ifVersion) return { ok: false, reason: 'conflict' };

    const patched = await this.patchGist('main', gist.id, { [MAIN_FILE]: { content: text } }, MAIN_GIST_RESPONSE_MAX_BYTES, signal);
    if (patched === null) return { ok: false, reason: 'conflict' };
    const ours = patched.history?.[0]?.version;
    if (ours === undefined) throw invalidAnswer();
    // Same text as before: GitHub makes no new revision.
    if (ours === head) return { ok: true, version: ours };
    const parent = patched.history?.[1]?.version;
    // No parent listed: nothing to compare, so trust the write (a lost one heals at the next check).
    if (parent === undefined || parent === head) return { ok: true, version: ours };
    await this.restoreRevision(gist.id, parent, signal);
    return { ok: false, reason: 'conflict' };
  }

  /**
   * Another browser's write landed between our check and our write, and ours replaced it: put its
   * text back, so the engine's next read merges it instead of losing it.
   */
  private async restoreRevision(id: string, revision: string, signal: AbortSignal): Promise<void> {
    const res = await this.api('GET', `/gists/${encodeURIComponent(id)}/${revision}`, { maxBytes: MAIN_GIST_RESPONSE_MAX_BYTES, signal });
    if (res.status === 404) return;
    const old = this.parseGist(res);
    const file = old.files[MAIN_FILE];
    // That write removed the file (by hand, on GitHub): keep ours.
    if (file === undefined || file === null) return;
    const text = await this.fileText(old, MAIN_FILE, file, GIST_MAIN_MAX_BYTES, signal);
    await this.patchGist('main', id, { [MAIN_FILE]: { content: text } }, MAIN_GIST_RESPONSE_MAX_BYTES, signal);
  }

  // ---- icons ----------------------------------------------------------------

  async readIcon(id: string, signal: AbortSignal): Promise<Blob | null> {
    checkIconId(id);
    const name = iconFileName(id);
    let gist = this.iconsCache;
    let file = gist?.files[name];
    // Several missing icons in one round cost one read of the icons gist, not one each.
    if (gist === null || (file == null && this.now() - this.iconsReadAt >= ICONS_REFRESH_MS)) {
      gist = await this.loadIcons(signal);
      file = gist?.files[name];
    }
    if (gist === null || file === undefined || file === null) return null;
    if (file.size > GIST_MAX_FILE_BYTES) throw new SyncStoreError('too_large', 'A synced icon is too large.');
    const text = await this.fileText(gist, name, file, GIST_MAX_FILE_BYTES, signal);
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(text.trim());
    } catch {
      // Not base64: unreadable, so treated like a missing icon (shown as automatic here).
      return null;
    }
    if (bytes.byteLength > GIST_ICON_MAX_BYTES) throw new SyncStoreError('too_large', 'A synced icon is too large.');
    // The type comes from sniffing the bytes (the engine's job), never from GitHub.
    return new Blob([bytes as Uint8Array<ArrayBuffer>]);
  }

  async writeIcon(id: string, data: Blob, signal: AbortSignal): Promise<void> {
    checkIconId(id);
    if (data.size > GIST_ICON_MAX_BYTES) throw new SyncStoreError('too_large', 'This icon is too large to sync through a gist.');
    const name = iconFileName(id);
    const content = encodeBase64(new Uint8Array(await data.arrayBuffer()));
    // Twice at most: the icons gist may be deleted, or another browser may create it at the same time.
    for (let attempt = 0; attempt < 2; attempt++) {
      const gist = await this.loadIcons(signal);
      if (gist === null) {
        const created = await this.createGist('icons', { [ICONS_MARKER_FILE]: { content: ICONS_MARKER_TEXT }, [name]: { content } }, signal);
        if (created !== null) return;
        continue;
      }
      if (gist.files[name] != null) return;
      const files = Object.values(gist.files).filter((f): f is GistFile => f !== null);
      const total = files.reduce((sum, f) => sum + f.size, 0);
      if (gist.truncated === true || files.length >= GIST_MAX_FILES || total + content.length > GIST_ICONS_TOTAL_MAX_BYTES) {
        throw new SyncStoreError('too_large', 'The icons gist is full: remove some custom icons.');
      }
      const patched = await this.patchGist('icons', gist.id, { [name]: { content } }, ICONS_GIST_RESPONSE_MAX_BYTES, signal);
      if (patched !== null) {
        this.cacheIcons(patched);
        return;
      }
    }
    throw new SyncStoreError('unavailable', 'The icons gist could not be written.');
  }

  async deleteIcon(id: string, signal: AbortSignal): Promise<void> {
    checkIconId(id);
    const name = iconFileName(id);
    const gist = await this.loadIcons(signal);
    if (gist === null || gist.files[name] == null) return;
    const patched = await this.patchGist('icons', gist.id, { [name]: null }, ICONS_GIST_RESPONSE_MAX_BYTES, signal);
    if (patched !== null) this.cacheIcons(patched);
  }

  private async loadIcons(signal: AbortSignal): Promise<Gist | null> {
    const gist = await this.findGist('icons', signal);
    this.cacheIcons(gist);
    return gist;
  }

  private cacheIcons(gist: Gist | null): void {
    this.iconsCache = gist;
    this.iconsReadAt = this.now();
  }

  // ---- finding and creating the gists ----------------------------------------

  private async setId(kind: GistKind, id: string | null): Promise<void> {
    if (this.ids[kind] === id) return;
    this.ids = { ...this.ids, [kind]: id };
    if (kind === 'icons' && id === null) this.iconsCache = null;
    await this.onIdsChange?.({ ...this.ids });
  }

  /** The remembered gist, else the oldest secret gist of the account with the kind's file. */
  private async findGist(kind: GistKind, signal: AbortSignal): Promise<Gist | null> {
    const maxBytes = kind === 'main' ? MAIN_GIST_RESPONSE_MAX_BYTES : ICONS_GIST_RESPONSE_MAX_BYTES;
    const remembered = this.ids[kind];
    if (remembered !== null) {
      const gist = await this.getGist(remembered, maxBytes, signal);
      if (gist !== null) {
        if (gist.public) throw publicGist();
        return gist;
      }
      // Deleted on GitHub (or not this account's): look for another one.
      await this.setId(kind, null);
    }
    const found = (await this.listSyncGists(kind, signal))[0];
    if (found === undefined) return null;
    const gist = await this.getGist(found.id, maxBytes, signal);
    if (gist === null || gist.public) return null;
    await this.setId(kind, gist.id);
    return gist;
  }

  /** The account's secret gists holding the kind's file, oldest first. */
  private async listSyncGists(kind: GistKind, signal: AbortSignal): Promise<ListedGist[]> {
    const marker = kind === 'main' ? MAIN_FILE : ICONS_MARKER_FILE;
    const found: ListedGist[] = [];
    for (let page = 1; page <= LIST_MAX_PAGES; page++) {
      const res = await this.api('GET', `/gists?per_page=${LIST_PAGE_SIZE}&page=${page}`, { maxBytes: LIST_RESPONSE_MAX_BYTES, signal });
      if (res.status !== 200) throw statusError(res.status, res.headers, res.body, this.now());
      if (!Array.isArray(res.body)) throw invalidAnswer();
      for (const entry of res.body) {
        const parsed = ListedGistSchema.safeParse(entry);
        if (parsed.success && !parsed.data.public && Object.hasOwn(parsed.data.files, marker)) found.push(parsed.data);
      }
      if (res.body.length < LIST_PAGE_SIZE) break;
    }
    return found.sort(compareAge);
  }

  /**
   * Creates a secret gist. When another browser created one at the same time, the oldest wins in
   * every browser: ours is deleted again and null is returned (its content is still local).
   */
  private async createGist(kind: GistKind, files: Record<string, { content: string }>, signal: AbortSignal): Promise<Gist | null> {
    const description = kind === 'main' ? MAIN_DESCRIPTION : ICONS_DESCRIPTION;
    const maxBytes = kind === 'main' ? MAIN_GIST_RESPONSE_MAX_BYTES : ICONS_GIST_RESPONSE_MAX_BYTES;
    const res = await this.api('POST', '/gists', { body: { description, public: false, files }, maxBytes, signal });
    if (res.status !== 201 && res.status !== 200) throw statusError(res.status, res.headers, res.body, this.now());
    const created = this.parseGist(res);
    const oldest = (await this.listSyncGists(kind, signal)).find((g) => compareAge(g, created) < 0);
    if (oldest !== undefined) {
      await this.api('DELETE', `/gists/${encodeURIComponent(created.id)}`, { maxBytes: ERROR_RESPONSE_MAX_BYTES, signal }).catch(() => undefined);
      await this.setId(kind, oldest.id);
      return null;
    }
    await this.setId(kind, created.id);
    if (kind === 'icons') this.cacheIcons(created);
    return created;
  }

  // ---- requests ---------------------------------------------------------------

  private async getGist(id: string, maxBytes: number, signal: AbortSignal): Promise<Gist | null> {
    const res = await this.api('GET', `/gists/${encodeURIComponent(id)}`, { maxBytes, signal });
    if (res.status === 404) return null;
    return this.parseGist(res);
  }

  /** `PATCH /gists/{id}`; null when the gist is gone (forgotten) or GitHub reports a write conflict. */
  private async patchGist(
    kind: GistKind,
    id: string,
    files: Record<string, { content: string } | null>,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Gist | null> {
    const res = await this.api('PATCH', `/gists/${encodeURIComponent(id)}`, { body: { files }, maxBytes, signal });
    if (res.status === 404) {
      await this.setId(kind, null);
      return null;
    }
    if (res.status === 409) return null;
    return this.parseGist(res);
  }

  private parseGist(res: GistResponse): Gist {
    if (res.status !== 200 && res.status !== 201) throw statusError(res.status, res.headers, res.body, this.now());
    const parsed = GistSchema.safeParse(res.body);
    if (!parsed.success) throw invalidAnswer();
    return parsed.data;
  }

  /** One call to the REST API: token, JSON, no cache (GitHub sends `max-age=60`), byte cap. */
  private async api(method: string, path: string, options: { body?: unknown; maxBytes: number; signal: AbortSignal }): Promise<GistResponse> {
    const headers = githubHeaders(this.token);
    const init: RequestInit = { method, headers, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    let res: FetchedText;
    try {
      res = await fetchTextCapped(`${GITHUB_API}${path}`, init, { timeoutMs: REQUEST_TIMEOUT_MS, signal: options.signal, maxBytes: options.maxBytes, fetch: this.transport });
    } catch (err) {
      throw transportError(err);
    }
    let body: unknown = null;
    if (res.text.trim() !== '') {
      try {
        body = JSON.parse(res.text) as unknown;
      } catch {
        if (res.status >= 200 && res.status < 300) throw invalidAnswer();
      }
    }
    if (res.status === 401 || res.status === 403 || res.status === 413 || res.status === 429 || res.status >= 500) {
      throw statusError(res.status, res.headers, body, this.now());
    }
    return { status: res.status, headers: res.headers, body };
  }

  /** A file's text: inline when GitHub sent all of it, else from its `raw_url`. */
  private async fileText(gist: Gist, name: string, file: GistFile, maxBytes: number, signal: AbortSignal): Promise<string> {
    if (file.size > maxBytes) throw new SyncStoreError('too_large', 'A synced file is larger than Portly accepts.');
    if (file.truncated !== true && file.content !== undefined) {
      if (utf8Bytes(file.content) > maxBytes) throw new SyncStoreError('too_large', 'A synced file is larger than Portly accepts.');
      return file.content;
    }
    const url = rawUrl(file.raw_url, gist.id, name);
    if (url === null) throw invalidAnswer();
    let res: FetchedText;
    try {
      // A simple request: no credentials, no custom header, so no preflight. The URL names the
      // file's content hash, so a cached copy is the right one.
      res = await fetchTextCapped(url, { method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        signal,
        maxBytes,
        fetch: this.transport,
      });
    } catch (err) {
      throw transportError(err);
    }
    if (res.status !== 200) throw statusError(res.status, res.headers, null, this.now());
    return res.text;
  }
}

/**
 * The `raw_url` of a gist file, or null unless it is
 * `https://gist.githubusercontent.com/<owner>/<this gist>/raw/<sha>/<this file>`.
 */
export function rawUrl(raw: string, gistId: string, fileName: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== GIST_RAW_HOST || url.port !== '' || url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  const parts = url.pathname.split('/');
  // ['', owner, gist id, 'raw', sha, file name]
  if (parts.length !== 6 || parts[0] !== '' || !/^[A-Za-z0-9-]{1,39}$/.test(parts[1] ?? '') || parts[2] !== gistId || parts[3] !== 'raw') return null;
  if (!REVISION.test(parts[4] ?? '')) return null;
  let name: string;
  try {
    name = decodeURIComponent(parts[5] ?? '');
  } catch {
    return null;
  }
  return name === fileName ? url.href : null;
}

export function createGistStore(options: GistStoreOptions): GistStore {
  return new GistStore(options);
}
