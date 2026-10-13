/**
 * The pure half of the server's bookmark importer (server/src/modules/bookmarks/importer.ts):
 * the {@link ImportFolder} tree both parsers produce and {@link planGroups}, which flattens it
 * into named groups (§7 Bookmarks imports). Writing the plan into the static bookmark state is the
 * bookmarks handler's job (the server's SQL `writeImport`).
 *
 * Strategies:
 * - `folders`: every folder that directly holds links becomes a group. The top-level folders
 *   ("Bookmarks bar", "Other bookmarks", …) name the groups of their own links; deeper folders
 *   are named by their path below that level ("Dev / Tools"). Links at the very top go to the
 *   fallback group.
 * - `single`: every link goes to one group named after the source.
 * Group names are cleaned to ≤ 100 characters and must satisfy BookmarkGroupNameSchema (else the
 * fallback name). Nothing here filters URLs: `toSafeHttpUrl` and the de-duplication happen when
 * the plan is written, where skipped links are counted.
 */
import { BookmarkGroupNameSchema, type BrowserImport } from '@portly/shared';
import { cleanTitle } from './cleanTitle.ts';

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

export const MAX_GROUP_NAME = 100;

/** A valid group name from `raw` (cleaned, ≤ 100 chars), or `fallback`. */
export function groupName(raw: string, fallback: string): string {
  const cleaned = cleanTitle(raw, MAX_GROUP_NAME) ?? fallback;
  return BookmarkGroupNameSchema.safeParse(cleaned).success ? cleaned : fallback;
}

export interface PlannedGroup {
  name: string;
  links: ImportLink[];
}

export interface ImportCounter {
  skipped: number;
  seen: number;
}

/** Flattens the tree into named groups (in document order); groups are keyed case-insensitively. */
export function planGroups(root: ImportFolder, strategy: ImportStrategy, fallbackName: string, counter: ImportCounter): PlannedGroup[] {
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

/** Number of links anywhere below `folder` (iterative; safe for hostile nesting). */
export function countLinks(folder: ImportFolder): number {
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
