/**
 * Launch pad sync through a private GitHub repository: a {@link SyncStore} over the contents API of
 * `api.github.com`, with a fine-grained personal access token limited to that one repository
 * (docs/design/launchpad-sync-github.md). Not wired to a sync engine yet.
 *
 * Layout, on the repository's default branch: {@link MAIN_PATH} in the root, and one binary file
 * per icon, `launchpad-icons/<uuid>` ({@link iconPath}). The user creates the repository; Portly
 * never creates, renames or deletes repositories. Every write is a commit, so the repository's
 * history keeps old launch pads until the repository is deleted.
 *
 * **Versions.** A file's version is its blob `sha` (a hash of its content). `PUT …/contents/{path}`
 * with `sha` writes only while the file still has that sha; GitHub answers 409 when it moved and
 * 422 when a sha is missing (file exists) or wrong. A 409 also comes back when another write to
 * the same branch is in flight, so icon writes try again, and a 422 is confirmed by reading the
 * file's sha before it is called a conflict.
 *
 * **Reads.** The contents API inlines files up to 1 MB as base64; bigger ones come from
 * `GET …/git/blobs/{sha}` (base64 JSON, up to 100 MB), so everything stays on `api.github.com` and
 * no download URL carrying a token is used. The contents `ETag` is the blob sha, so the main file is
 * read with `If-None-Match`: an unchanged file costs a `304` (not counted against the rate limit)
 * and the text kept from the last read or write.
 *
 * **Hostile input.** Every answer is parsed with zod, its byte size is capped before and after
 * download, a blob must carry the sha asked for and decode to the size listed. The repository must
 * be private (checked once per store). The main text is returned as is: the engine validates it like
 * an import file. Errors never carry the token, the repository name or URLs.
 */
import { z } from 'zod';
import { decodeBase64, encodeBase64 } from '../lib/base64.ts';
import { classifyFetchError, fetchTextCapped, UpstreamPayloadTooLargeError, type FetchedText, type FetchLike } from '../lib/fetch.ts';
import { SYNC_MAX_ICON_BYTES, SYNC_MAX_MAIN_BYTES, SyncStoreError, type SyncFileVersion, type SyncStore, type SyncWriteResult } from '../sync/store.ts';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';

export const MAIN_PATH = 'launchpad.json';
export const ICONS_DIR = 'launchpad-icons';
export const MAIN_COMMIT_MESSAGE = 'Portly: update the launch pad';
export const ICON_ADD_MESSAGE = 'Portly: add a launch pad icon';
export const ICON_REMOVE_MESSAGE = 'Portly: remove a launch pad icon';

/** What the contents API inlines; bigger files come from the blob API. */
export const INLINE_MAX_BYTES = 1024 * 1024;
/** Attempts of an icon write or delete that GitHub refused because the branch moved meanwhile. */
export const ICON_WRITE_ATTEMPTS = 3;
/** Pause before the next attempt, times the attempt number: the other write has to finish first. */
export const ICON_RETRY_DELAY_MS = 750;

/** A contents answer inlines at most 1 MB (base64 with a newline every 60 characters). */
const CONTENTS_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const WRITE_RESPONSE_MAX_BYTES = 256 * 1024;
const REPO_RESPONSE_MAX_BYTES = 256 * 1024;

export const REQUEST_TIMEOUT_MS = 30_000;
/** A 25 MB upload or download needs longer than a small call. */
const LARGE_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_RETRY_AFTER_MS = 60_000;
export const MAX_RETRY_AFTER_MS = 60 * 60_000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BLOB_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** GitHub logins: letters, digits and single inner hyphens, at most 39. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** Repository names: letters, digits, `.`, `_`, `-`, at most 100 (not `.` or `..`). */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function iconPath(id: string): string {
  return `${ICONS_DIR}/${id}`;
}

export interface Repository {
  owner: string;
  name: string;
}

/** `owner/name`, or null unless both parts are valid GitHub names. */
export function parseRepository(text: string): Repository | null {
  const parts = text.split('/');
  if (parts.length !== 2) return null;
  const [owner = '', name = ''] = parts;
  if (!OWNER.test(owner) || !REPO_NAME.test(name) || name === '.' || name === '..' || name.toLowerCase().endsWith('.git')) return null;
  return { owner, name };
}

/** Bytes of a base64 JSON answer for `maxBytes` of content (GitHub breaks lines every 60 characters). */
function base64ResponseMax(maxBytes: number): number {
  const chars = Math.ceil(maxBytes / 3) * 4;
  return chars + Math.ceil(chars / 60) + 64 * 1024;
}

// ---------------------------------------------------------------------------
// GitHub's answers
// ---------------------------------------------------------------------------

const RepoSchema = z.object({ private: z.boolean() });

const FileSchema = z.object({
  type: z.literal('file'),
  sha: z.string().regex(BLOB_SHA),
  size: z.number().int().nonnegative(),
  content: z.string().optional(),
  encoding: z.string().max(32).optional(),
});

const BlobSchema = z.object({
  sha: z.string().regex(BLOB_SHA),
  size: z.number().int().nonnegative(),
  encoding: z.literal('base64'),
  content: z.string(),
});

const WriteSchema = z.object({ content: z.object({ sha: z.string().regex(BLOB_SHA) }) });

type RepoFile = z.output<typeof FileSchema>;

export interface GitHubRepoStoreOptions {
  token: string;
  repository: Repository;
  /** Transport (default `globalThis.fetch`, read at call time). */
  fetch?: FetchLike;
  /** Clock (epoch ms), for `X-RateLimit-Reset`. */
  now?(): number;
  /** Waits before an icon write is tried again (default: a timer the signal cancels). */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

interface ApiResponse {
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
    return new SyncStoreError(
      'reauth_required',
      'The saved GitHub token may not change the sync repository. Give it Contents: Read and write on that repository, or save a new one in Settings → Accounts.',
    );
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

function tooLarge(): SyncStoreError {
  return new SyncStoreError('too_large', 'A synced file is larger than Portly accepts.');
}

function repositoryMissing(): SyncStoreError {
  return new SyncStoreError(
    'reauth_required',
    "GitHub can't find the sync repository with the saved token. Check that it still exists and that the token may use it, in Settings → Accounts.",
  );
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function checkIconId(id: string): void {
  if (!UUID_V4.test(id)) throw new RangeError('Icon ids must be UUIDv4');
}

/** GitHub's base64 (line breaks every 60 characters) as bytes, or null when it is not base64. */
function decodeGitHubBase64(text: string): Uint8Array | null {
  try {
    return decodeBase64(text.replace(/[\r\n]/g, ''));
  } catch {
    return null;
  }
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The headers of every REST call: JSON, the token, a pinned API version. */
export function githubHeaders(token: string): Record<string, string> {
  return { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': GITHUB_API_VERSION };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class GitHubRepoStore implements SyncStore {
  readonly kind = 'github' as const;
  private readonly token: string;
  private readonly repoPath: string;
  private readonly transport: FetchLike | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The check that the repository exists and is private, shared by concurrent calls; dropped when it fails. */
  private repoCheck: Promise<void> | null = null;
  /** The main file as last read or written, for the cheap "nothing changed" read. */
  private lastMain: { etag: string | null; version: string; text: string } | null = null;

  constructor(options: GitHubRepoStoreOptions) {
    const { owner, name } = options.repository;
    // Checked again here: these go into every path.
    if (parseRepository(`${owner}/${name}`) === null) throw new RangeError('Invalid repository');
    this.token = options.token;
    this.repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    this.transport = options.fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? abortableSleep;
  }

  // ---- main file ------------------------------------------------------------

  async readMain(signal: AbortSignal): Promise<SyncFileVersion | null> {
    await this.ensureRepo(signal);
    const cached = this.lastMain;
    const res = await this.api('GET', this.contentsPath(MAIN_PATH), { maxBytes: CONTENTS_RESPONSE_MAX_BYTES, signal, ifNoneMatch: cached?.etag ?? undefined });
    if (res.status === 304 && cached !== null) return { text: cached.text, version: cached.version };
    if (res.status === 404) {
      this.lastMain = null;
      return null;
    }
    const file = this.parseFile(res);
    if (file === null) throw invalidAnswer();
    const header = res.headers.get('etag');
    const etag = header !== null && header.length <= 200 ? header : null;
    if (cached !== null && cached.version === file.sha) {
      this.lastMain = { ...cached, etag };
      return { text: cached.text, version: cached.version };
    }
    const bytes = await this.fileBytes(file, SYNC_MAX_MAIN_BYTES, signal);
    if (bytes === null) throw invalidAnswer();
    let text: string;
    try {
      text = utf8Decoder.decode(bytes);
    } catch {
      throw invalidAnswer();
    }
    this.lastMain = { etag, version: file.sha, text };
    return { text, version: file.sha };
  }

  async writeMain(text: string, ifVersion: string | null, signal: AbortSignal): Promise<SyncWriteResult> {
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > SYNC_MAX_MAIN_BYTES) throw new SyncStoreError('too_large', 'The launch pad is too large to sync.');
    // A version that is not a sha was never ours: the file moved on.
    if (ifVersion !== null && !BLOB_SHA.test(ifVersion)) return { ok: false, reason: 'conflict' };
    await this.ensureRepo(signal);
    const body = { message: MAIN_COMMIT_MESSAGE, content: encodeBase64(bytes), ...(ifVersion === null ? {} : { sha: ifVersion }) };
    const res = await this.api('PUT', this.contentsPath(MAIN_PATH), { body, maxBytes: WRITE_RESPONSE_MAX_BYTES, signal, large: true });
    if (res.status === 200 || res.status === 201) {
      const version = this.parseWrite(res);
      this.lastMain = { etag: null, version, text };
      return { ok: true, version };
    }
    if (res.status === 409) return { ok: false, reason: 'conflict' };
    if (res.status === 422 || res.status === 404) {
      // A missing or stale sha, or something else: only a moved file is a conflict.
      if ((await this.currentSha(MAIN_PATH, signal)) !== ifVersion) return { ok: false, reason: 'conflict' };
      if (res.status === 404) throw repositoryMissing();
    }
    throw statusError(res.status, res.headers, res.body, this.now());
  }

  // ---- icons ----------------------------------------------------------------

  async readIcon(id: string, signal: AbortSignal): Promise<Blob | null> {
    checkIconId(id);
    await this.ensureRepo(signal);
    const res = await this.api('GET', this.contentsPath(iconPath(id)), { maxBytes: CONTENTS_RESPONSE_MAX_BYTES, signal });
    if (res.status === 404) return null;
    // Not a file (a folder put there by hand): unreadable, treated like a missing icon.
    const file = this.parseFile(res);
    if (file === null) return null;
    const bytes = await this.fileBytes(file, SYNC_MAX_ICON_BYTES, signal);
    if (bytes === null) return null;
    // The type comes from sniffing the bytes (the engine's job), never from GitHub.
    return new Blob([bytes as Uint8Array<ArrayBuffer>]);
  }

  async writeIcon(id: string, data: Blob, signal: AbortSignal): Promise<void> {
    checkIconId(id);
    if (data.size > SYNC_MAX_ICON_BYTES) throw new SyncStoreError('too_large', 'This icon is too large to sync.');
    await this.ensureRepo(signal);
    const body = { message: ICON_ADD_MESSAGE, content: encodeBase64(new Uint8Array(await data.arrayBuffer())) };
    for (let attempt = 0; attempt < ICON_WRITE_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.sleep(ICON_RETRY_DELAY_MS * attempt, signal);
      const res = await this.api('PUT', this.contentsPath(iconPath(id)), { body, maxBytes: WRITE_RESPONSE_MAX_BYTES, signal, large: true });
      if (res.status === 200 || res.status === 201) return;
      // Another write to the branch was in flight: try again.
      if (res.status === 409) continue;
      // No sha given for a file that exists: an icon id is never written twice, so it is there.
      if (res.status === 422 && (await this.currentSha(iconPath(id), signal)) !== null) return;
      if (res.status === 404) throw repositoryMissing();
      throw statusError(res.status, res.headers, res.body, this.now());
    }
    throw new SyncStoreError('unavailable', 'GitHub kept refusing the icon while other changes were saved. Sync tries again later.');
  }

  async deleteIcon(id: string, signal: AbortSignal): Promise<void> {
    checkIconId(id);
    await this.ensureRepo(signal);
    const path = iconPath(id);
    for (let attempt = 0; attempt < ICON_WRITE_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.sleep(ICON_RETRY_DELAY_MS * attempt, signal);
      const sha = await this.currentSha(path, signal);
      if (sha === null) return;
      const res = await this.api('DELETE', this.contentsPath(path), { body: { message: ICON_REMOVE_MESSAGE, sha }, maxBytes: WRITE_RESPONSE_MAX_BYTES, signal });
      if (res.status === 200) return;
      // Removed meanwhile, unless the repository itself is gone (checked again).
      if (res.status === 404) {
        this.repoCheck = null;
        return this.ensureRepo(signal);
      }
      // The branch or the file moved meanwhile: read the sha again.
      if (res.status === 409 || res.status === 422) continue;
      throw statusError(res.status, res.headers, res.body, this.now());
    }
    throw new SyncStoreError('unavailable', 'GitHub kept refusing to remove the icon while other changes were saved. Sync tries again later.');
  }

  // ---- requests ---------------------------------------------------------------

  private contentsPath(path: string): string {
    return `${this.repoPath}/contents/${path}`;
  }

  /** Once per store: the repository exists for this token and is private. */
  private ensureRepo(signal: AbortSignal): Promise<void> {
    if (this.repoCheck === null) {
      const check = this.checkRepo(signal);
      this.repoCheck = check;
      check.catch(() => {
        if (this.repoCheck === check) this.repoCheck = null;
      });
    }
    return this.repoCheck;
  }

  private async checkRepo(signal: AbortSignal): Promise<void> {
    const res = await this.api('GET', this.repoPath, { maxBytes: REPO_RESPONSE_MAX_BYTES, signal });
    if (res.status === 404) throw repositoryMissing();
    if (res.status !== 200) throw statusError(res.status, res.headers, res.body, this.now());
    const parsed = RepoSchema.safeParse(res.body);
    if (!parsed.success) throw invalidAnswer();
    if (!parsed.data.private) {
      throw new SyncStoreError('reauth_required', 'The sync repository is public on GitHub. Portly syncs only to a private repository: make it private again in its settings.');
    }
  }

  /** The file's blob sha, or null when it does not exist. */
  private async currentSha(path: string, signal: AbortSignal): Promise<string | null> {
    const res = await this.api('GET', this.contentsPath(path), { maxBytes: CONTENTS_RESPONSE_MAX_BYTES, signal });
    if (res.status === 404) return null;
    const file = this.parseFile(res);
    if (file === null) throw invalidAnswer();
    return file.sha;
  }

  /** A file entry from a 200 answer; null when it is not a file (a folder, a link). */
  private parseFile(res: ApiResponse): RepoFile | null {
    if (res.status !== 200) throw statusError(res.status, res.headers, res.body, this.now());
    const parsed = FileSchema.safeParse(res.body);
    return parsed.success ? parsed.data : null;
  }

  private parseWrite(res: ApiResponse): string {
    const parsed = WriteSchema.safeParse(res.body);
    if (!parsed.success) throw invalidAnswer();
    return parsed.data.content.sha;
  }

  /** A file's bytes: inline up to 1 MB, else from the blob API. Null when they are not base64 or not the size listed. */
  private async fileBytes(file: RepoFile, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
    if (file.size > maxBytes) throw tooLarge();
    let content: string;
    if (file.encoding === 'base64' && file.content !== undefined && (file.content !== '' || file.size === 0)) {
      content = file.content;
    } else {
      const res = await this.api('GET', `${this.repoPath}/git/blobs/${file.sha}`, { maxBytes: base64ResponseMax(maxBytes), signal, large: true });
      if (res.status === 404) return null;
      if (res.status !== 200) throw statusError(res.status, res.headers, res.body, this.now());
      const blob = BlobSchema.safeParse(res.body);
      if (!blob.success || blob.data.sha !== file.sha) throw invalidAnswer();
      if (blob.data.size > maxBytes) throw tooLarge();
      content = blob.data.content;
    }
    const bytes = decodeGitHubBase64(content);
    return bytes !== null && bytes.byteLength === file.size ? bytes : null;
  }

  /**
   * One call to the REST API: token, JSON, no browser cache (GitHub sends `max-age=60`; a caller's
   * `If-None-Match` makes the browser pass a 304 through), byte cap.
   */
  private async api(
    method: string,
    path: string,
    options: { body?: unknown; maxBytes: number; signal: AbortSignal; ifNoneMatch?: string; large?: boolean },
  ): Promise<ApiResponse> {
    const headers = githubHeaders(this.token);
    const init: RequestInit = { method, headers, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' };
    if (options.ifNoneMatch !== undefined) headers['if-none-match'] = options.ifNoneMatch;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    let res: FetchedText;
    try {
      res = await fetchTextCapped(`${GITHUB_API}${path}`, init, {
        timeoutMs: options.large === true ? LARGE_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
        signal: options.signal,
        maxBytes: options.maxBytes,
        fetch: this.transport,
      });
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
}

export function createGitHubRepoStore(options: GitHubRepoStoreOptions): GitHubRepoStore {
  return new GitHubRepoStore(options);
}
