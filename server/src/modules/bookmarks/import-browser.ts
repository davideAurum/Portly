/**
 * Chrome / Edge bookmark import (§7 `GET /api/bookmarks/import/sources`,
 * `POST /api/bookmarks/import/browser`).
 *
 * Only `<LOCALAPPDATA>\Google\Chrome\User Data\*\Bookmarks` and
 * `<LOCALAPPDATA>\Microsoft\Edge\User Data\*\Bookmarks` are ever read (the root is injectable for
 * tests). Sources are identified by opaque ids (a hash of browser + profile directory name, never a
 * path); an import re-scans, re-resolves the path from the id, checks with `fs.realpath` that the
 * file really lies under the browser's `User Data` directory (no symlink/junction escapes), caps
 * the size at 20 MB and validates the JSON before walking it. Profile display names come from the
 * browser's `Local State` file when present.
 *
 * File-system errors never reach the client or the log raw: a file that cannot be read answers
 * 404 `not_found` ("could not be read"), and the log gets `errorFields` only (error name and code,
 * message with the user's paths masked) plus the browser — never a profile name.
 */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BookmarkImportSource, ImportBrowser } from '@portly/shared';
import { HttpError } from '../../lib/errors.ts';
import { errorFields, type Logger } from '../../lib/logger.ts';
import { MAX_FOLDER_DEPTH, type ImportFolder, type ImportLink } from './importer.ts';

export const MAX_BROWSER_FILE_BYTES = 20 * 1024 * 1024;
const MAX_LOCAL_STATE_BYTES = 10 * 1024 * 1024;
const MAX_PROFILES_PER_BROWSER = 64;

const BROWSERS: readonly { browser: ImportBrowser; label: string; segments: readonly string[] }[] = [
  { browser: 'chrome', label: 'Chrome', segments: ['Google', 'Chrome', 'User Data'] },
  { browser: 'edge', label: 'Edge', segments: ['Microsoft', 'Edge', 'User Data'] },
];

export function browserLabel(browser: ImportBrowser): string {
  return BROWSERS.find((b) => b.browser === browser)?.label ?? browser;
}

/** Default `%LOCALAPPDATA%` (null when unknown, e.g. not on Windows). */
export function defaultLocalAppData(): string | null {
  const value = process.env.LOCALAPPDATA;
  return value && path.isAbsolute(value) ? value : null;
}

export function sourceId(browser: ImportBrowser, profileDir: string): string {
  // The seed predates the rename to Portly; kept so stored import sources keep their ids.
  return createHash('sha256').update(`homebase-bookmark-source\n${browser}\n${profileDir}`).digest('base64url').slice(0, 24);
}

interface ResolvedSource extends BookmarkImportSource {
  userDataDir: string;
  profileDir: string;
  file: string;
}

// ---------------------------------------------------------------------------
// Bookmarks JSON
// ---------------------------------------------------------------------------

const RootsFileSchema = z.object({
  roots: z.record(z.string(), z.unknown()),
});

// Lenient on lengths: an over-long name or URL must not make a whole folder vanish silently
// (names are capped when groups are planned; bad URLs are skipped and counted by the importer).
const NodeSchema = z.object({
  type: z.string().max(32),
  name: z.string().optional(),
  url: z.string().optional(),
  children: z.array(z.unknown()).optional(),
});

const ROOT_LABELS: Readonly<Record<string, string>> = {
  bookmark_bar: 'Bookmarks bar',
  other: 'Other bookmarks',
  synced: 'Mobile bookmarks',
};
const ROOT_ORDER = ['bookmark_bar', 'other', 'synced'];

/**
 * Converts a parsed `Bookmarks` file into an import tree. Throws 422 when the file does not have
 * the expected shape. Entries that fail per-node validation are skipped (counted by the caller as
 * non-importable because they carry no link).
 */
export function parseBrowserBookmarks(json: unknown): ImportFolder {
  const file = RootsFileSchema.safeParse(json);
  if (!file.success) throw new HttpError(422, 'validation_failed', 'This is not a Chrome or Edge bookmarks file');
  const root: ImportFolder = { kind: 'folder', name: '', children: [] };
  const keys = [...ROOT_ORDER.filter((k) => k in file.data.roots), ...Object.keys(file.data.roots).filter((k) => !ROOT_ORDER.includes(k))];

  // Iterative conversion (hostile nesting cannot overflow the stack).
  type Work = { raw: unknown; into: ImportFolder; depth: number; fallbackName: string };
  const work: Work[] = [];
  for (const key of keys) work.push({ raw: file.data.roots[key], into: root, depth: 1, fallbackName: ROOT_LABELS[key] ?? key });
  // Preserve document order: process a queue, appending children in order.
  for (let i = 0; i < work.length; i++) {
    const item = work[i]!;
    const node = NodeSchema.safeParse(item.raw);
    if (!node.success) continue;
    if (node.data.type === 'url') {
      const link: ImportLink = { kind: 'link', title: (node.data.name ?? '').slice(0, 10_000), url: node.data.url ?? '' };
      item.into.children.push(link);
      continue;
    }
    if (node.data.type !== 'folder' || item.depth > MAX_FOLDER_DEPTH) continue;
    const name = node.data.name?.trim() ? node.data.name.slice(0, 10_000) : item.fallbackName;
    const folder: ImportFolder = { kind: 'folder', name, children: [] };
    item.into.children.push(folder);
    for (const child of node.data.children ?? []) work.push({ raw: child, into: folder, depth: item.depth + 1, fallbackName: 'Untitled folder' });
  }
  return root;
}

/** Number of http(s) links in a tree. */
export function countImportableLinks(root: ImportFolder): number {
  let n = 0;
  const stack: ImportFolder[] = [root];
  while (stack.length > 0) {
    const folder = stack.pop()!;
    for (const child of folder.children) {
      if (child.kind === 'folder') stack.push(child);
      else if (/^https?:\/\//i.test(child.url.trim())) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// File system
// ---------------------------------------------------------------------------

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Reads a file of at most `max` bytes (the size is checked before and while reading). */
async function readCapped(file: string, max: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new HttpError(422, 'validation_failed', 'The bookmarks file is not a regular file');
    if (stat.size > max) throw new HttpError(413, 'payload_too_large', `The bookmarks file is larger than ${Math.round(max / 1024 / 1024)} MB`);
    const buffer = Buffer.alloc(Math.min(stat.size, max) + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > max) throw new HttpError(413, 'payload_too_large', 'The bookmarks file is too large');
      if (total === buffer.length) break;
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

/** `path` lies inside `root` (both already real paths). */
function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const LocalStateSchema = z.object({
  profile: z.object({ info_cache: z.record(z.string(), z.object({ name: z.string().max(200).optional() }).loose()) }).loose(),
});

async function profileNames(browser: ImportBrowser, userDataDir: string, log: Logger): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const raw = await readCapped(path.join(userDataDir, 'Local State'), MAX_LOCAL_STATE_BYTES);
    const parsed = LocalStateSchema.safeParse(JSON.parse(raw.toString('utf8')));
    if (parsed.success) {
      for (const [dir, info] of Object.entries(parsed.data.profile.info_cache)) {
        const name = info.name?.trim();
        if (name) names.set(dir, name.slice(0, 100));
      }
    }
  } catch (err) {
    // errorFields: a JSON.parse snippet (which could hold profile names) is masked, paths too.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.debug('could not read browser Local State', { browser, ...errorFields(err) });
  }
  return names;
}

/**
 * Reads and parses a `Bookmarks` file. Our own refusals (too large, not a regular file, not JSON)
 * pass through; a file-system error becomes 404 "could not be read", logged at `level` with its
 * error fields (debug while listing sources, warn for an import the user asked for).
 */
async function readBookmarksJson(file: string, browser: ImportBrowser, log: Logger, level: 'debug' | 'warn'): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readCapped(file, MAX_BROWSER_FILE_BYTES);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    log[level]('browser bookmarks file could not be read', { browser, ...errorFields(err) });
    throw new HttpError(404, 'not_found', { message: 'The bookmarks file could not be read', cause: err });
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new HttpError(422, 'validation_failed', 'The bookmarks file is not valid JSON');
  }
}

export interface BrowserSources {
  list(): Promise<BookmarkImportSource[]>;
  /** Re-resolves a source id, verifies the path and returns the parsed tree + a display label. */
  load(id: string): Promise<{ tree: ImportFolder; label: string }>;
}

export function createBrowserSources(options: { localAppData: string | null; log: Logger }): BrowserSources {
  const { log } = options;

  const scan = async (withCounts: boolean): Promise<ResolvedSource[]> => {
    const root = options.localAppData;
    if (!root) return [];
    const out: ResolvedSource[] = [];
    for (const { browser, segments } of BROWSERS) {
      const userDataDir = path.join(root, ...segments);
      if (!(await isDirectory(userDataDir))) continue;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(userDataDir, { withFileTypes: true });
      } catch (err) {
        log.debug('browser profile directory could not be listed', { browser, ...errorFields(err) });
        continue;
      }
      const names = await profileNames(browser, userDataDir, log);
      let found = 0;
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || found >= MAX_PROFILES_PER_BROWSER) continue;
        const file = path.join(userDataDir, entry.name, 'Bookmarks');
        try {
          const stat = await fs.stat(file);
          if (!stat.isFile()) continue;
        } catch {
          continue;
        }
        found++;
        let bookmarkCount = 0;
        if (withCounts) {
          try {
            bookmarkCount = countImportableLinks(parseBrowserBookmarks(await readBookmarksJson(file, browser, log, 'debug')));
          } catch (err) {
            // Unreadable (already logged) or not a bookmarks file: not offered.
            if (!(err instanceof HttpError && err.status === 404)) log.debug('browser bookmarks file skipped', { browser, ...errorFields(err) });
            continue;
          }
        }
        out.push({
          id: sourceId(browser, entry.name),
          browser,
          profileName: names.get(entry.name) ?? entry.name,
          bookmarkCount,
          userDataDir,
          profileDir: entry.name,
          file,
        });
      }
    }
    return out;
  };

  return {
    async list() {
      const sources = await scan(true);
      return sources.map(({ id, browser, profileName, bookmarkCount }) => ({ id, browser, profileName, bookmarkCount }));
    },
    async load(id) {
      const source = (await scan(false)).find((s) => s.id === id);
      if (!source) throw new HttpError(404, 'not_found', 'That browser profile was not found; refresh the list and try again');
      let realRoot: string;
      let realFile: string;
      try {
        realRoot = await fs.realpath(source.userDataDir);
        realFile = await fs.realpath(source.file);
      } catch (err) {
        log.debug('browser bookmarks file could not be resolved', { browser: source.browser, ...errorFields(err) });
        throw new HttpError(404, 'not_found', { message: 'The bookmarks file could not be read', cause: err });
      }
      if (!isInside(realRoot, realFile) || path.basename(realFile) !== 'Bookmarks') {
        log.warn('browser bookmarks file resolves outside the browser profile directory; refused', { browser: source.browser });
        throw new HttpError(403, 'forbidden', 'The bookmarks file is not inside the browser profile directory');
      }
      const tree = parseBrowserBookmarks(await readBookmarksJson(realFile, source.browser, log, 'warn'));
      return { tree, label: `${browserLabel(source.browser)} — ${source.profileName}` };
    },
  };
}
