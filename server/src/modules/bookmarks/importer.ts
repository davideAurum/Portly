/**
 * Writes an imported bookmark tree into the database (§7 Bookmarks imports).
 *
 * Both importers (Chrome/Edge `Bookmarks` JSON and Netscape HTML) produce an {@link ImportFolder}
 * tree. Strategies:
 * - `folders`: every folder that directly holds links becomes a group. The top-level folders
 *   ("Bookmarks bar", "Other bookmarks", …) name the groups of their own links; deeper folders
 *   are named by their path below that level ("Dev / Tools"). Links at the very top go to the
 *   fallback group.
 * - `single`: every link goes to one group named after the source.
 * A group with the same name (case-insensitive) is reused, and URLs already in it are skipped.
 * Only SafeHttpUrls are imported; `javascript:` bookmarklets, `chrome://`, `file:` and invalid
 * entries are skipped and counted, as is everything past the group/bookmark caps. One transaction.
 */
import {
  BookmarkGroupNameSchema,
  MAX_BOOKMARKS,
  MAX_BOOKMARK_GROUPS,
  toSafeHttpUrl,
  urlHost,
  type BookmarkImportReport,
  type BrowserImport,
} from '@homebase/shared';
import type { Db } from '../../db/open.ts';
import { newId } from '../../lib/ids.ts';
import { cleanTitle } from './html.ts';
import { hostKey } from './store.ts';

export interface ImportLink {
  kind: 'link';
  title: string;
  url: string;
}

export interface ImportFolder {
  kind: 'folder';
  name: string;
  children: (ImportFolder | ImportLink)[];
}

export type ImportStrategy = BrowserImport['targetGroupStrategy'];

/** Deepest folder nesting walked (deeper entries are skipped). */
export const MAX_FOLDER_DEPTH = 64;
/** Hard cap on entries examined per import (defends against pathological files). */
export const MAX_IMPORT_ENTRIES = 100_000;

const MAX_GROUP_NAME = 100;

function groupName(raw: string, fallback: string): string {
  const cleaned = cleanTitle(raw, MAX_GROUP_NAME) ?? fallback;
  return BookmarkGroupNameSchema.safeParse(cleaned).success ? cleaned : fallback;
}

interface PlannedGroup {
  name: string;
  links: ImportLink[];
}

interface Counter {
  skipped: number;
  seen: number;
}

/** Flattens the tree into named groups (in document order). */
export function planGroups(root: ImportFolder, strategy: ImportStrategy, fallbackName: string, counter: Counter): PlannedGroup[] {
  const groups = new Map<string, PlannedGroup>();
  const add = (name: string, link: ImportLink) => {
    const key = name.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { name, links: [] };
      groups.set(key, group);
    }
    group.links.push(link);
  };

  // Document order: a folder's own links first, then its subfolders (recursion depth ≤ MAX_FOLDER_DEPTH).
  const visit = (folder: ImportFolder, path: string[], depth: number): void => {
    const deferred: { folder: ImportFolder; path: string[]; depth: number }[] = [];
    for (const child of folder.children) {
      counter.seen++;
      if (counter.seen > MAX_IMPORT_ENTRIES) {
        counter.skipped++;
        continue;
      }
      if (child.kind === 'link') {
        const name =
          strategy === 'single'
            ? fallbackName
            : path.length === 0
              ? fallbackName
              : path.length === 1
                ? path[0]!
                : path.slice(1).join(' / ');
        add(groupName(name, fallbackName), child);
      } else if (depth + 1 > MAX_FOLDER_DEPTH) {
        counter.skipped += countLinks(child);
      } else {
        const label = cleanTitle(child.name, MAX_GROUP_NAME) ?? 'Untitled folder';
        deferred.push({ folder: child, path: [...path, label], depth: depth + 1 });
      }
    }
    for (const next of deferred) visit(next.folder, next.path, next.depth);
  };
  visit(root, [], 0);
  return [...groups.values()];
}

function countLinks(folder: ImportFolder): number {
  let n = 0;
  const stack: ImportFolder[] = [folder];
  while (stack.length > 0) {
    const f = stack.pop()!;
    for (const child of f.children) {
      if (child.kind === 'link') n++;
      else stack.push(child);
    }
  }
  return n;
}

export interface ImportResult extends BookmarkImportReport {
  /** URLs of the bookmarks created (for background favicon resolution). */
  createdUrls: string[];
}

export function writeImport(
  db: Db,
  root: ImportFolder,
  options: { strategy: ImportStrategy; fallbackName: string; now: number },
): ImportResult {
  const counter: Counter = { skipped: 0, seen: 0 };
  const planned = planGroups(root, options.strategy, groupName(options.fallbackName, 'Imported bookmarks'), counter);
  const result: ImportResult = { groups: 0, bookmarks: 0, skipped: 0, createdUrls: [] };

  db.tx(() => {
    const existingGroups = db.all<{ id: string; name: string }>('SELECT id, name FROM bookmark_groups ORDER BY sort, id');
    const byName = new Map(existingGroups.map((g) => [g.name.trim().toLowerCase(), g.id]));
    let groupCount = existingGroups.length;
    let bookmarkCount = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bookmarks')?.n ?? 0);
    let groupSort = Number(db.get<{ m: number | null }>('SELECT MAX(sort) AS m FROM bookmark_groups')?.m ?? -1) + 1;
    const hostIcons = new Map<string, string>();
    for (const row of db.all<{ source_host: string; id: string }>(
      "SELECT source_host, id FROM icons WHERE kind = 'favicon' AND source_host IS NOT NULL ORDER BY fetched_at ASC",
    )) {
      hostIcons.set(row.source_host, row.id); // ascending → the newest wins
    }

    for (const group of planned) {
      const valid: { title: string; url: string }[] = [];
      for (const link of group.links) {
        const url = toSafeHttpUrl(link.url);
        if (!url) {
          counter.skipped++;
          continue;
        }
        valid.push({ url, title: cleanTitle(link.title) ?? urlHost(url) ?? url });
      }
      if (valid.length === 0) continue;

      let groupId = byName.get(group.name.toLowerCase());
      if (!groupId) {
        if (groupCount >= MAX_BOOKMARK_GROUPS) {
          counter.skipped += valid.length;
          continue;
        }
        groupId = newId();
        db.run('INSERT INTO bookmark_groups (id, name, sort, color, collapsed, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, ?, ?)', [
          groupId,
          group.name,
          groupSort++,
          options.now,
          options.now,
        ]);
        byName.set(group.name.toLowerCase(), groupId);
        groupCount++;
        result.groups++;
      }

      const present = new Set(db.all<{ url: string }>('SELECT url FROM bookmarks WHERE group_id = ?', [groupId]).map((r) => r.url));
      let sort = Number(db.get<{ m: number | null }>('SELECT MAX(sort) AS m FROM bookmarks WHERE group_id = ?', [groupId])?.m ?? -1) + 1;
      for (const link of valid) {
        if (present.has(link.url) || bookmarkCount >= MAX_BOOKMARKS) {
          counter.skipped++;
          continue;
        }
        const host = hostKey(link.url);
        db.run(
          `INSERT INTO bookmarks (id, group_id, title, url, sort, icon_mode, icon_id, letter_color, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'auto', ?, NULL, ?, ?)`,
          [newId(), groupId, link.title, link.url, sort++, host ? (hostIcons.get(host) ?? null) : null, options.now, options.now],
        );
        present.add(link.url);
        bookmarkCount++;
        result.bookmarks++;
        result.createdUrls.push(link.url);
      }
    }
  });
  result.skipped = counter.skipped;
  return result;
}
