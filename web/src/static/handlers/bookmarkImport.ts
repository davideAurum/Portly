/**
 * Writing an imported bookmark tree into the static backend's bookmarks slice: the in-memory port
 * of the server's `writeImport` (server/src/modules/bookmarks/importer.ts, the SQL half of the
 * importer; the pure `planGroups` lives in lib/importPlan.ts). Same rules, so an import answers the
 * same report here and on the server:
 * - existing groups are matched by trimmed, lower-cased name and reused; new groups are appended
 *   (sort = max + 1, no color, expanded);
 * - only SafeHttpUrls are imported (bookmarklets, `place:`, `chrome://`, … are skipped and
 *   counted); titles are cleaned, falling back to the host and then the URL;
 * - a URL already present in the target group is skipped, as is everything past the group cap
 *   (200: the whole group's links) and the bookmark cap (5000);
 * - new bookmarks are `auto` with the host's synthetic favicon id when automatic icons are on
 *   (the server stores the host's newest favicon or resolves one in the background).
 * The slice is replaced in one step, so a failure half-way leaves the state untouched (the
 * server's transaction).
 */
import { MAX_BOOKMARKS, MAX_BOOKMARK_GROUPS, toSafeHttpUrl, urlHost, type BookmarkImportReport } from '@homebase/shared';
import type { StaticContext } from '../context.ts';
import { faviconIdFor } from '../favicon.ts';
import { cleanTitle } from '../lib/cleanTitle.ts';
import { groupName, planGroups, type ImportCounter, type ImportFolder, type ImportStrategy } from '../lib/importPlan.ts';
import { getBookmarks, getSettings, SLICE, type BookmarksSlice, type StoredBookmark, type StoredBookmarkGroup } from '../slices.ts';

/** The server's `ORDER BY sort, id` for groups and bookmarks (ties broken by id for stable output). */
export function compareOrder(a: { sort: number; id: string }, b: { sort: number; id: string }): number {
  if (a.sort !== b.sort) return a.sort - b.sort;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface WriteImportOptions {
  strategy: ImportStrategy;
  /** Name of the group for top-level links (and of the only group with the `single` strategy). */
  fallbackName: string;
}

export async function writeImport(ctx: StaticContext, root: ImportFolder, options: WriteImportOptions): Promise<BookmarkImportReport> {
  const counter: ImportCounter = { skipped: 0, seen: 0 };
  const planned = planGroups(root, options.strategy, groupName(options.fallbackName, 'Imported bookmarks'), counter);
  const autoFetch = getSettings(ctx).bookmarks.autoFetchIcons;
  const now = ctx.now();
  const next: BookmarksSlice = structuredClone(getBookmarks(ctx));
  const report: BookmarkImportReport = { groups: 0, bookmarks: 0, skipped: 0 };

  // Later groups override earlier ones in the map, like the server's `Map(existingGroups ORDER BY sort, id)`.
  const byName = new Map<string, string>();
  for (const group of [...next.groups].sort(compareOrder)) byName.set(group.name.trim().toLowerCase(), group.id);
  let groupCount = next.groups.length;
  let bookmarkCount = next.bookmarks.length;
  let groupSort = next.groups.reduce((max, group) => Math.max(max, group.sort), -1) + 1;

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
    if (groupId === undefined) {
      if (groupCount >= MAX_BOOKMARK_GROUPS) {
        counter.skipped += valid.length;
        continue;
      }
      groupId = ctx.newId();
      const created: StoredBookmarkGroup = { id: groupId, name: group.name, sort: groupSort++, color: null, collapsed: false, createdAt: now, updatedAt: now };
      next.groups.push(created);
      byName.set(group.name.toLowerCase(), groupId);
      groupCount++;
      report.groups++;
    }

    const inGroup = next.bookmarks.filter((b) => b.groupId === groupId);
    const present = new Set(inGroup.map((b) => b.url));
    let sort = inGroup.reduce((max, b) => Math.max(max, b.sort), -1) + 1;
    for (const link of valid) {
      if (present.has(link.url) || bookmarkCount >= MAX_BOOKMARKS) {
        counter.skipped++;
        continue;
      }
      const bookmark: StoredBookmark = {
        id: ctx.newId(),
        groupId,
        title: link.title,
        url: link.url,
        sort: sort++,
        iconMode: 'auto',
        iconId: autoFetch ? faviconIdFor(link.url) : null,
        letterColor: null,
        createdAt: now,
        updatedAt: now,
      };
      next.bookmarks.push(bookmark);
      present.add(link.url);
      bookmarkCount++;
      report.bookmarks++;
    }
  }

  report.skipped = counter.skipped;
  ctx.state.set(SLICE.bookmarks, next);
  await ctx.state.commit(SLICE.bookmarks);
  return report;
}
