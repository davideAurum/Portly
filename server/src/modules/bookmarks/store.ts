/**
 * Bookmark and bookmark-group persistence (§5 `bookmark_groups`, `bookmarks`; §7 Bookmarks).
 *
 * - Groups and bookmarks are ordered by `sort` (then id, for stable output). Every mutation that
 *   changes an order renumbers the affected list to 0..n-1 inside one transaction, so sorts never
 *   drift or collide.
 * - `move(id, {groupId, index})` is atomic: the bookmark is taken out of its group, inserted into
 *   the target group at the clamped index and both groups are renumbered in one transaction.
 * - PATCH handlers map fields to columns through static allowlists (never request keys).
 * - Icon ids are resolved through a join, so a bookmark never reports an icon that no longer
 *   exists (it then falls back to the letter tile on the client).
 */
import {
  MAX_BOOKMARKS,
  MAX_BOOKMARK_GROUPS,
  normalizeHexColor,
  urlHost,
  type Bookmark,
  type BookmarkCreate,
  type BookmarkGroup,
  type BookmarkGroupCreate,
  type BookmarkGroupUpdate,
  type BookmarkUpdate,
  type IconMode,
} from '@portly/shared';
import type { Db } from '../../db/open.ts';
import { toBool } from '../../db/helpers.ts';
import { HttpError } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';

export interface GroupRow {
  id: string;
  name: string;
  sort: number;
  color: string | null;
  collapsed: number;
}

export interface BookmarkRow {
  id: string;
  group_id: string;
  title: string;
  url: string;
  sort: number;
  icon_mode: string;
  icon_id: string | null;
  letter_color: string | null;
  /** icons.id when the referenced icon exists (LEFT JOIN), else null. */
  existing_icon_id: string | null;
}

const BOOKMARK_SELECT = `SELECT b.id, b.group_id, b.title, b.url, b.sort, b.icon_mode, b.icon_id, b.letter_color,
  i.id AS existing_icon_id
  FROM bookmarks b LEFT JOIN icons i ON i.id = b.icon_id`;

function iconModeOf(value: string): IconMode {
  return value === 'custom' || value === 'letter' ? value : 'auto';
}

export function toBookmark(row: BookmarkRow): Bookmark {
  const mode = iconModeOf(row.icon_mode);
  return {
    id: row.id,
    groupId: row.group_id,
    title: row.title,
    url: row.url,
    sort: Number(row.sort),
    // A custom icon that vanished degrades to the automatic icon.
    iconMode: mode === 'custom' && row.existing_icon_id === null ? 'auto' : mode,
    iconId: mode === 'letter' ? null : row.existing_icon_id,
    letterColor: normalizeHexColor(row.letter_color),
  };
}

function toGroup(row: GroupRow, bookmarks: Bookmark[]): BookmarkGroup {
  return {
    id: row.id,
    name: row.name,
    sort: Number(row.sort),
    color: normalizeHexColor(row.color),
    collapsed: toBool(row.collapsed),
    bookmarks,
  };
}

/** Lower-cased `host[:port]` of a URL (the favicon dedupe key), or null. */
export function hostKey(url: string): string | null {
  const host = urlHost(url);
  return host ? host.toLowerCase() : null;
}

export interface IconLinker {
  /** Newest stored favicon for a host (dedupe), or null. */
  hostIcon(host: string): string | null;
  /** Icon row info, or null when missing. */
  icon(id: string): { id: string; kind: 'favicon' | 'upload' } | null;
  /** Records that a custom icon lost its last reference (garbage-collected later, after an undo window). */
  orphaned(iconId: string): void;
}

export interface BookmarkStoreOptions {
  db: Db;
  icons: IconLinker;
  now?: () => number;
}

export interface BookmarkStore {
  list(): BookmarkGroup[];
  getGroup(id: string): BookmarkGroup | null;
  createGroup(input: BookmarkGroupCreate): BookmarkGroup;
  updateGroup(id: string, input: BookmarkGroupUpdate): BookmarkGroup;
  deleteGroup(id: string): void;
  reorderGroups(ids: readonly string[]): BookmarkGroup[];
  get(id: string): Bookmark | null;
  create(input: BookmarkCreate): Bookmark;
  update(id: string, input: BookmarkUpdate): Bookmark;
  delete(id: string): void;
  move(id: string, target: { groupId: string; index: number }): BookmarkGroup[];
  /** Sets a bookmark to a custom (uploaded) icon. */
  setCustomIcon(id: string, iconId: string): Bookmark;
  /** Sets a bookmark to automatic mode with the given favicon (or none). */
  setAutoIcon(id: string, iconId: string | null): Bookmark;
  groupCount(): number;
  bookmarkCount(): number;
}

export function createBookmarkStore(options: BookmarkStoreOptions): BookmarkStore {
  const { db, icons } = options;
  const now = options.now ?? Date.now;

  const groupRow = (id: string): GroupRow | undefined =>
    db.get<GroupRow>('SELECT id, name, sort, color, collapsed FROM bookmark_groups WHERE id = ?', [id]);
  const bookmarkRow = (id: string): BookmarkRow | undefined => db.get<BookmarkRow>(`${BOOKMARK_SELECT} WHERE b.id = ?`, [id]);

  const requireGroup = (id: string): GroupRow => {
    const row = groupRow(id);
    if (!row) throw new HttpError(404, 'not_found', 'Bookmark group not found');
    return row;
  };
  const requireBookmark = (id: string): BookmarkRow => {
    const row = bookmarkRow(id);
    if (!row) throw new HttpError(404, 'not_found', 'Bookmark not found');
    return row;
  };

  const groupBookmarks = (groupId: string): Bookmark[] =>
    db.all<BookmarkRow>(`${BOOKMARK_SELECT} WHERE b.group_id = ? ORDER BY b.sort, b.id`, [groupId]).map(toBookmark);

  const orderedBookmarkIds = (groupId: string): string[] =>
    db.all<{ id: string }>('SELECT id FROM bookmarks WHERE group_id = ? ORDER BY sort, id', [groupId]).map((r) => r.id);

  /** Writes sort = position for every id whose sort differs. */
  const renumberBookmarks = (ids: readonly string[], ts: number): void => {
    ids.forEach((id, index) => {
      db.run('UPDATE bookmarks SET sort = ?, updated_at = ? WHERE id = ? AND sort <> ?', [index, ts, id, index]);
    });
  };

  const list = (): BookmarkGroup[] => {
    const groups = db.all<GroupRow>('SELECT id, name, sort, color, collapsed FROM bookmark_groups ORDER BY sort, id');
    const byGroup = new Map<string, Bookmark[]>();
    for (const row of db.all<BookmarkRow>(`${BOOKMARK_SELECT} ORDER BY b.group_id, b.sort, b.id`)) {
      const listForGroup = byGroup.get(row.group_id) ?? [];
      listForGroup.push(toBookmark(row));
      byGroup.set(row.group_id, listForGroup);
    }
    return groups.map((g) => toGroup(g, byGroup.get(g.id) ?? []));
  };

  const getGroup = (id: string): BookmarkGroup | null => {
    const row = groupRow(id);
    return row ? toGroup(row, groupBookmarks(id)) : null;
  };

  /** Resolves the icon columns for a create/update (see module docs). */
  const iconColumns = (
    mode: IconMode,
    requestedIconId: string | null | undefined,
    url: string,
  ): { mode: IconMode; iconId: string | null } => {
    if (mode === 'letter') return { mode, iconId: null };
    if (mode === 'custom') {
      const icon = requestedIconId ? icons.icon(requestedIconId) : null;
      if (icon && icon.kind === 'upload') return { mode, iconId: icon.id };
      // No usable upload: fall through to the automatic icon.
    }
    const requested = requestedIconId ? icons.icon(requestedIconId) : null;
    if (requested && requested.kind === 'favicon') return { mode: 'auto', iconId: requested.id };
    const host = hostKey(url);
    return { mode: 'auto', iconId: host ? icons.hostIcon(host) : null };
  };

  const store: BookmarkStore = {
    list,
    getGroup,

    createGroup(input) {
      return db.tx(() => {
        if (store.groupCount() >= MAX_BOOKMARK_GROUPS) {
          throw new HttpError(409, 'conflict', `You can have at most ${MAX_BOOKMARK_GROUPS} bookmark groups`);
        }
        const id = newId();
        const ts = now();
        const max = db.get<{ m: number | null }>('SELECT MAX(sort) AS m FROM bookmark_groups')?.m ?? -1;
        db.run('INSERT INTO bookmark_groups (id, name, sort, color, collapsed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          id,
          input.name,
          Number(max) + 1,
          normalizeHexColor(input.color ?? null),
          input.collapsed ? 1 : 0,
          ts,
          ts,
        ]);
        return getGroup(id)!;
      });
    },

    updateGroup(id, input) {
      return db.tx(() => {
        requireGroup(id);
        const ts = now();
        // Static column allowlist.
        if (input.name !== undefined) db.run('UPDATE bookmark_groups SET name = ?, updated_at = ? WHERE id = ?', [input.name, ts, id]);
        if (input.color !== undefined) {
          db.run('UPDATE bookmark_groups SET color = ?, updated_at = ? WHERE id = ?', [normalizeHexColor(input.color), ts, id]);
        }
        if (input.collapsed !== undefined) {
          db.run('UPDATE bookmark_groups SET collapsed = ?, updated_at = ? WHERE id = ?', [input.collapsed ? 1 : 0, ts, id]);
        }
        return getGroup(id)!;
      });
    },

    deleteGroup(id) {
      db.tx(() => {
        requireGroup(id);
        const customIcons = db.all<{ icon_id: string }>(
          "SELECT icon_id FROM bookmarks WHERE group_id = ? AND icon_mode = 'custom' AND icon_id IS NOT NULL",
          [id],
        );
        db.run('DELETE FROM bookmark_groups WHERE id = ?', [id]); // bookmarks cascade
        const remaining = db.all<{ id: string }>('SELECT id FROM bookmark_groups ORDER BY sort, id').map((r) => r.id);
        remaining.forEach((groupId, index) => {
          db.run('UPDATE bookmark_groups SET sort = ? WHERE id = ? AND sort <> ?', [index, groupId, index]);
        });
        for (const row of customIcons) icons.orphaned(row.icon_id);
      });
    },

    reorderGroups(ids) {
      return db.tx(() => {
        const current = db.all<{ id: string }>('SELECT id FROM bookmark_groups ORDER BY sort, id').map((r) => r.id);
        const known = new Set(current);
        const seen = new Set<string>();
        const order: string[] = [];
        for (const id of ids) {
          if (known.has(id) && !seen.has(id)) {
            order.push(id);
            seen.add(id);
          }
        }
        // Groups the client did not mention (e.g. created elsewhere meanwhile) keep their relative order at the end.
        for (const id of current) if (!seen.has(id)) order.push(id);
        const ts = now();
        order.forEach((id, index) => {
          db.run('UPDATE bookmark_groups SET sort = ?, updated_at = ? WHERE id = ? AND sort <> ?', [index, ts, id, index]);
        });
        return list();
      });
    },

    get(id) {
      const row = bookmarkRow(id);
      return row ? toBookmark(row) : null;
    },

    create(input) {
      return db.tx(() => {
        if (!groupRow(input.groupId)) throw new HttpError(422, 'validation_failed', 'The bookmark group does not exist');
        if (store.bookmarkCount() >= MAX_BOOKMARKS) {
          throw new HttpError(409, 'conflict', `You can have at most ${MAX_BOOKMARKS} bookmarks`);
        }
        const id = newId();
        const ts = now();
        const max = db.get<{ m: number | null }>('SELECT MAX(sort) AS m FROM bookmarks WHERE group_id = ?', [input.groupId])?.m ?? -1;
        const icon = iconColumns(input.iconMode ?? 'auto', input.iconId, input.url);
        db.run(
          `INSERT INTO bookmarks (id, group_id, title, url, sort, icon_mode, icon_id, letter_color, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, input.groupId, input.title, input.url, Number(max) + 1, icon.mode, icon.iconId, normalizeHexColor(input.letterColor ?? null), ts, ts],
        );
        return store.get(id)!;
      });
    },

    update(id, input) {
      return db.tx(() => {
        const row = requireBookmark(id);
        const ts = now();
        const url = input.url ?? row.url;
        // Static column allowlist.
        if (input.title !== undefined) db.run('UPDATE bookmarks SET title = ?, updated_at = ? WHERE id = ?', [input.title, ts, id]);
        if (input.url !== undefined) db.run('UPDATE bookmarks SET url = ?, updated_at = ? WHERE id = ?', [input.url, ts, id]);
        if (input.letterColor !== undefined) {
          db.run('UPDATE bookmarks SET letter_color = ?, updated_at = ? WHERE id = ?', [normalizeHexColor(input.letterColor), ts, id]);
        }

        const currentMode = iconModeOf(row.icon_mode);
        const hostChanged = input.url !== undefined && hostKey(input.url) !== hostKey(row.url);
        const modeChanged = input.iconMode !== undefined && input.iconMode !== currentMode;
        if (modeChanged || input.iconId !== undefined || (hostChanged && currentMode === 'auto')) {
          const mode = input.iconMode ?? currentMode;
          const requested = input.iconId !== undefined ? input.iconId : mode === currentMode && !hostChanged ? row.icon_id : null;
          const icon = iconColumns(mode, requested, url);
          db.run('UPDATE bookmarks SET icon_mode = ?, icon_id = ?, updated_at = ? WHERE id = ?', [icon.mode, icon.iconId, ts, id]);
          if (currentMode === 'custom' && row.icon_id && row.icon_id !== icon.iconId) icons.orphaned(row.icon_id);
        }
        return store.get(id)!;
      });
    },

    delete(id) {
      db.tx(() => {
        const row = requireBookmark(id);
        db.run('DELETE FROM bookmarks WHERE id = ?', [id]);
        renumberBookmarks(orderedBookmarkIds(row.group_id), now());
        if (iconModeOf(row.icon_mode) === 'custom' && row.icon_id) icons.orphaned(row.icon_id);
      });
    },

    move(id, target) {
      return db.tx(() => {
        const row = requireBookmark(id);
        if (!groupRow(target.groupId)) throw new HttpError(422, 'validation_failed', 'The target group does not exist');
        const ts = now();
        const targetIds = orderedBookmarkIds(target.groupId).filter((b) => b !== id);
        const index = Math.max(0, Math.min(target.index, targetIds.length));
        targetIds.splice(index, 0, id);
        if (row.group_id !== target.groupId) {
          db.run('UPDATE bookmarks SET group_id = ?, updated_at = ? WHERE id = ?', [target.groupId, ts, id]);
          renumberBookmarks(orderedBookmarkIds(row.group_id), ts);
        }
        renumberBookmarks(targetIds, ts);
        return list();
      });
    },

    setCustomIcon(id, iconId) {
      return db.tx(() => {
        const row = requireBookmark(id);
        db.run("UPDATE bookmarks SET icon_mode = 'custom', icon_id = ?, updated_at = ? WHERE id = ?", [iconId, now(), id]);
        if (iconModeOf(row.icon_mode) === 'custom' && row.icon_id && row.icon_id !== iconId) icons.orphaned(row.icon_id);
        return store.get(id)!;
      });
    },

    setAutoIcon(id, iconId) {
      return db.tx(() => {
        const row = requireBookmark(id);
        db.run("UPDATE bookmarks SET icon_mode = 'auto', icon_id = ?, updated_at = ? WHERE id = ?", [iconId, now(), id]);
        if (iconModeOf(row.icon_mode) === 'custom' && row.icon_id && row.icon_id !== iconId) icons.orphaned(row.icon_id);
        return store.get(id)!;
      });
    },

    groupCount() {
      return Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bookmark_groups')?.n ?? 0);
    },

    bookmarkCount() {
      return Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bookmarks')?.n ?? 0);
    },
  };
  return store;
}
