/**
 * This browser's launch pad as a sync document, and a merged document applied back to it
 * (docs/design/launchpad-sync.md sections 6.8 and 8).
 *
 * Building: groups and bookmarks from the bookmarks slice with their stamps, the slice's
 * tombstones, the two synced settings with their stamps (sync state), and an entry with a SHA-256
 * for every custom icon a bookmark uses. Automatic icons are not synced. A row that fails the
 * file's schema (an old row with a title too long, say) stays in this browser unsynced and
 * untouched. A bookmark this browser moved under "No group" only because its group is gone goes
 * back up with its synced group, unless it was placed again here since.
 *
 * Applying, for this browser only and without stamps, so a repair never goes back up:
 * - a bookmark whose group is gone shows under the "No group" group; when there is none, one is
 *   created like the app does it, which is a real local change (stamped, synced);
 * - a custom icon whose bytes are missing or failed their checks keeps its id, and the bookmark
 *   shows the automatic icon (the bookmarks handler's projection does that already);
 * - a synced setting naming a group that is gone reads as none.
 */
import {
  SYNC_POINTERS,
  SyncBookmarkSchema,
  SyncGroupSchema,
  SyncIconId,
  SyncTombstoneSchema,
  canonicalJson,
  liveLaunchpad,
  mergeLaunchpads,
  emptyLaunchpad,
  type ImageContentType,
  type SyncBookmark,
  type SyncGroup,
  type SyncIcon,
  type SyncLaunchpad,
} from '@portly/shared';
import type { StaticContext } from '../context.ts';
import { faviconIdFor } from '../favicon.ts';
import {
  SLICE,
  getBookmarks,
  getIcons,
  getLaunchpadSync,
  getSettings,
  setSettings,
  type BookmarksSlice,
  type RehomedBookmark,
  type StoredBookmark,
  type StoredBookmarkGroup,
  type StoredIconMeta,
} from '../slices.ts';
import type { StoredBlob } from '../storage/types.ts';
import { nextStamp } from './clock.ts';
import { sha256Hex } from './format.ts';
import { recordPointerChanges } from './hook.ts';

/** The name the app gives the "No group" group (widgets/launchpad/ungrouped.ts). */
export const UNGROUPED_NAME = 'No group';

/** An epoch placeholder for a browser that never synced (replaced by the file's or a new one). */
const NO_EPOCH = 'unsynced';

export interface LocalLaunchpad {
  doc: SyncLaunchpad;
  /** Bytes of the custom icons only this browser has, by id (uploaded before the file names them). */
  iconBytes: ReadonlyMap<string, Uint8Array>;
  /** Live rows in this browser that are not in `doc` (they fail the file's schema). */
  unsyncable: { groups: ReadonlySet<string>; bookmarks: ReadonlySet<string> };
  /** The change counter when this was built: a change after it means the apply must wait. */
  changes: number;
}

function toSyncGroup(row: StoredBookmarkGroup): SyncGroup | null {
  const parsed = SyncGroupSchema.safeParse({
    id: row.id,
    name: row.name,
    sort: row.sort,
    color: row.color,
    collapsed: row.collapsed,
    updatedAt: row.updatedAt,
    placedAt: row.placedAt,
  });
  return parsed.success ? parsed.data : null;
}

function toSyncBookmark(row: StoredBookmark, groupId: string): SyncBookmark | null {
  const custom = row.iconMode === 'custom' && SyncIconId.safeParse(row.iconId).success;
  const parsed = SyncBookmarkSchema.safeParse({
    id: row.id,
    groupId,
    title: row.title,
    url: row.url,
    sort: row.sort,
    iconMode: custom ? 'custom' : row.iconMode === 'letter' ? 'letter' : 'auto',
    iconId: custom ? row.iconId : null,
    letterColor: row.letterColor,
    updatedAt: row.updatedAt,
    placedAt: row.placedAt,
  });
  return parsed.success ? parsed.data : null;
}

/** This browser's launch pad as a sync document (see the module docs). */
export async function buildLocalLaunchpad(ctx: StaticContext): Promise<LocalLaunchpad> {
  recordPointerChanges(ctx);
  const state = getLaunchpadSync(ctx);
  const slice = getBookmarks(ctx);
  const known = new Map(state.icons.map((icon) => [icon.id, icon]));
  const localIcons = new Map(getIcons(ctx).map((icon) => [icon.id, icon]));

  const groups: SyncGroup[] = [];
  const unsyncableGroups = new Set<string>();
  for (const row of slice.groups) {
    const group = toSyncGroup(row);
    if (group) groups.push(group);
    else unsyncableGroups.add(row.id);
  }

  const bookmarks: SyncBookmark[] = [];
  const unsyncableBookmarks = new Set<string>();
  for (const row of slice.bookmarks) {
    // Under "No group" only because its group is gone, and not placed again here since: its synced group.
    const original = state.rehomed[row.id];
    const groupId = original !== undefined && row.placedAt === original.placedAt ? original.groupId : row.groupId;
    const bookmark = toSyncBookmark(row, groupId);
    if (bookmark) bookmarks.push(bookmark);
    else unsyncableBookmarks.add(row.id);
  }

  const icons: SyncIcon[] = [];
  const iconBytes = new Map<string, Uint8Array>();
  for (const id of new Set(bookmarks.flatMap((b) => (b.iconMode === 'custom' && b.iconId ? [b.iconId] : [])))) {
    const entry = known.get(id);
    if (entry) {
      icons.push(entry);
      continue;
    }
    const meta = localIcons.get(id);
    const blob = meta ? await ctx.state.getBlob(id) : undefined;
    if (!meta || !blob || blob.kind !== 'icon') continue;
    icons.push({ id, contentType: blob.type as ImageContentType, sha256: await sha256Hex(blob.bytes), width: meta.width });
    iconBytes.set(id, blob.bytes);
  }

  const deleted = slice.deleted.flatMap((t) => SyncTombstoneSchema.safeParse(t).data ?? []);
  return {
    doc: { ...emptyLaunchpad(state.epoch ?? NO_EPOCH), groups, bookmarks, deleted, icons, pointers: structuredClone(state.pointers) },
    iconBytes,
    unsyncable: { groups: unsyncableGroups, bookmarks: unsyncableBookmarks },
    changes: state.changes,
  };
}

/** A custom icon downloaded from the store and checked, ready to keep. */
export interface ReceivedIcon {
  id: string;
  type: ImageContentType;
  bytes: Uint8Array;
  width: number | null;
}

export interface ApplyPlan {
  /** The merged document plus any real local change the apply made (a new "No group" group). */
  doc: SyncLaunchpad;
  /** Whether this browser's launch pad changes. */
  changed: boolean;
  /** Live rows here before and after, and how many of the old ones go. */
  before: number;
  removed: number;
  /** The slices and blobs to commit. */
  names: string[];
  putBlobs: StoredBlob[];
  /** Applies the plan to the in-memory slices (call right before the commit, with no await between). */
  write(): void;
}

function sameRows(a: BookmarksSlice, b: Pick<BookmarksSlice, 'groups' | 'bookmarks'>): boolean {
  const key = (rows: readonly { id: string }[]) => canonicalJson([...rows].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)));
  return key(a.groups) === key(b.groups) && key(a.bookmarks) === key(b.bookmarks);
}

/**
 * What applying `merged` to this browser does (see the module docs). Reads the slices as they are
 * now; nothing changes until {@link ApplyPlan.write}.
 */
export function planApply(ctx: StaticContext, merged: SyncLaunchpad, local: LocalLaunchpad, received: readonly ReceivedIcon[]): ApplyPlan {
  const now = ctx.now();
  const slice = getBookmarks(ctx);
  const settings = getSettings(ctx);
  let doc = merged;
  let live = liveLaunchpad(doc);

  // A bookmark whose group is gone needs a "No group" group; when there is none, make one (a real change).
  // Groups this browser keeps unsynced are not gone.
  const kept = [...local.unsyncable.groups].filter((id) => slice.groups.some((g) => g.id === id));
  const liveGroups = new Set([...live.groups.map((g) => g.id), ...kept]);
  const homeless = live.bookmarks.filter((b) => !liveGroups.has(b.groupId));
  let home = doc.pointers.ungroupedGroupId.value;
  if (homeless.length > 0 && (home === null || !liveGroups.has(home))) {
    const at = nextStamp(ctx);
    const created: SyncGroup = {
      id: ctx.newId(),
      name: UNGROUPED_NAME,
      sort: live.groups.reduce((max, g) => Math.max(max, g.sort), -1) + 1,
      color: null,
      collapsed: false,
      updatedAt: at,
      placedAt: at,
    };
    home = created.id;
    doc = mergeLaunchpads(doc, { ...emptyLaunchpad(doc.epoch), groups: [created], pointers: { ...doc.pointers, ungroupedGroupId: { value: created.id, at: nextStamp(ctx) } } });
    live = liveLaunchpad(doc);
  }

  const previous = {
    groups: new Map(slice.groups.map((g) => [g.id, g])),
    bookmarks: new Map(slice.bookmarks.map((b) => [b.id, b])),
  };
  const autoIcons = settings.bookmarks.autoFetchIcons;
  const groups: StoredBookmarkGroup[] = live.groups.map((g) => ({
    id: g.id,
    name: g.name,
    sort: g.sort,
    color: g.color,
    collapsed: g.collapsed,
    createdAt: previous.groups.get(g.id)?.createdAt ?? now,
    updatedAt: g.updatedAt,
    placedAt: g.placedAt,
  }));
  // Rows this browser cannot sync stay as they are.
  for (const id of local.unsyncable.groups) {
    const row = previous.groups.get(id);
    if (row && !groups.some((g) => g.id === id)) groups.push(row);
  }
  const groupIds = new Set(groups.map((g) => g.id));
  const rehomed: Record<string, RehomedBookmark> = {};
  const bookmarks: StoredBookmark[] = live.bookmarks.map((b) => {
    let groupId = b.groupId;
    if (!groupIds.has(groupId) && home !== null) {
      rehomed[b.id] = { groupId: b.groupId, placedAt: b.placedAt };
      groupId = home;
    }
    const old = previous.bookmarks.get(b.id);
    const iconId = b.iconMode === 'custom' ? b.iconId : b.iconMode === 'auto' ? (old?.iconMode === 'auto' && old.url === b.url ? old.iconId : autoIcons ? faviconIdFor(b.url) : null) : null;
    return {
      id: b.id,
      groupId,
      title: b.title,
      url: b.url,
      sort: b.sort,
      iconMode: b.iconMode,
      iconId,
      letterColor: b.letterColor,
      createdAt: old?.createdAt ?? now,
      updatedAt: b.updatedAt,
      placedAt: b.placedAt,
    };
  });
  for (const id of local.unsyncable.bookmarks) {
    const row = previous.bookmarks.get(id);
    if (row && !bookmarks.some((b) => b.id === id)) bookmarks.push(row);
  }

  const next = { groups, bookmarks };
  const rowsChanged = !sameRows(slice, next);
  const nextIds = new Set([...groups.map((g) => g.id), ...bookmarks.map((b) => b.id)]);
  const before = slice.groups.length + slice.bookmarks.length;
  const removed = [...previous.groups.keys(), ...previous.bookmarks.keys()].filter((id) => !nextIds.has(id)).length;

  // The synced settings: the merged value when it names a live group, else none.
  const resolved = Object.fromEntries(SYNC_POINTERS.map((name) => [name, ((v) => (v !== null && groupIds.has(v) ? v : null))(doc.pointers[name].value)])) as Record<
    (typeof SYNC_POINTERS)[number],
    string | null
  >;
  const settingsChanged = SYNC_POINTERS.some((name) => settings.bookmarks[name] !== resolved[name]);

  const icons = getIcons(ctx);
  const have = new Set(icons.map((i) => i.id));
  const newIcons: StoredIconMeta[] = received.filter((r) => !have.has(r.id)).map((r) => ({ id: r.id, type: r.type, width: r.width, createdAt: now, orphanedAt: null }));
  const putBlobs: StoredBlob[] = received
    .filter((r) => !have.has(r.id))
    .map((r) => ({ id: r.id, kind: 'icon', type: r.type, bytes: r.bytes, width: r.width, createdAt: now }));

  const names: string[] = [SLICE.launchpadSync];
  if (rowsChanged || canonicalJson(slice.deleted) !== canonicalJson(doc.deleted)) names.push(SLICE.bookmarks);
  if (newIcons.length > 0) names.push(SLICE.icons);
  if (settingsChanged) names.push(SLICE.settings);

  return {
    doc,
    changed: rowsChanged || settingsChanged || newIcons.length > 0,
    before,
    removed,
    names,
    putBlobs,
    write() {
      const fresh = getBookmarks(ctx);
      fresh.groups = groups;
      fresh.bookmarks = bookmarks;
      fresh.deleted = doc.deleted.map((t) => ({ ...t }));
      if (newIcons.length > 0) getIcons(ctx).push(...newIcons);
      if (settingsChanged) {
        const current = getSettings(ctx);
        setSettings(ctx, { ...current, bookmarks: { ...current.bookmarks, ...resolved } });
      }
      const sync = getLaunchpadSync(ctx);
      sync.pointers = structuredClone(doc.pointers);
      sync.applied = { ...resolved };
      sync.rehomed = rehomed;
    },
  };
}
