/**
 * Bookmarks module of the static backend (§7 Bookmarks): the server's 16 routes over the
 * `bookmarks` and `icons` slices plus the blob store, with the server's status codes, messages,
 * ordering and caps (server/src/modules/bookmarks/index.ts + store.ts) so the unchanged UI and the
 * export format behave identically.
 *
 * Icons in the browser-only build:
 * - "auto" icons are synthetic ids `fav:<host>` (favicon.ts) that the asset resolver turns into
 *   DuckDuckGo's icon service URL; they are assigned synchronously on create/update/import when
 *   `settings.bookmarks.autoFetchIcons` is on (the server resolves favicons in the background and
 *   the client polls — nothing is ever "pending" here). Local-looking hosts never get one. An
 *   automatic bookmark stored without an icon (added while the setting was off) is listed with its
 *   host's id once the setting is on — the server's hourly maintenance job does the same.
 *   DuckDuckGo serves a generic placeholder (HTTP 404 with a PNG, which still fires `load`) for
 *   hosts it does not know, so a public host always shows an image, never the letter tile;
 *   refresh-icon cannot "find" anything either, it only points the bookmark at the icon service.
 * - "custom" icons are uploads: a `StoredBlob` of kind `icon` plus its metadata in the icons
 *   slice, registered as an object URL. The server's `IconLinker` rules are kept: a custom id that
 *   is not a stored upload falls back to auto, and a custom icon that lost its last reference is
 *   marked orphaned and kept for the undo grace period (`ready` deletes expired orphans).
 * - `GET /api/icons/:id` serves custom icon bytes for completeness; the UI never fetches it (it
 *   goes through `resolveAssetUrl`).
 * - `GET /api/site-meta` cannot fetch the page (cross-origin): it answers the site's name derived
 *   from the host and the synthetic favicon id, with no network.
 * - Browser-profile import is filesystem-only: sources answers `[]` and the import route 404s.
 *   Netscape HTML import is a full port (lib/importHtml.ts + lib/importPlan.ts + bookmarkImport.ts).
 */
import {
  BookmarkCreateSchema,
  BookmarkGroupCreateSchema,
  BookmarkGroupReorderSchema,
  BookmarkGroupUpdateSchema,
  BookmarkMoveSchema,
  BookmarkUpdateSchema,
  MAX_BOOKMARKS,
  MAX_BOOKMARK_GROUPS,
  normalizeHexColor,
  SiteMetaQuerySchema,
  TARGET_GROUP_STRATEGIES,
  type Bookmark,
  type BookmarkGroup,
  type BookmarkImportSource,
  type BookmarksResponse,
  type IconMode,
  type SiteMeta,
} from '@portly/shared';
import { z } from 'zod';
import type { StaticContext } from '../context.ts';
import { faviconIdFor, faviconServiceUrl, hostKeyOf, isFaviconId } from '../favicon.ts';
import { isUuidV4 } from '../lib/ids.ts';
import { imageSize } from '../lib/imageSize.ts';
import { sniffImageType } from '../lib/imageSniff.ts';
import { MAX_HTML_IMPORT_BYTES, parseNetscapeBookmarks } from '../lib/importHtml.ts';
import { siteName } from '../lib/siteName.ts';
import { parseJsonBody, parseQuery, readMultipartFile } from '../lib/validate.ts';
import { apiError, json, noContent, readFormData, StaticApiError } from '../respond.ts';
import type { StaticRequest, StaticRouter } from '../router.ts';
import {
  getBookmarks,
  getIcons,
  getSettings,
  ORPHAN_GRACE_MS,
  setSettings,
  SLICE,
  type BookmarksSlice,
  type StoredBookmark,
  type StoredBookmarkGroup,
} from '../slices.ts';
import { blobOf, type StoredBlob } from '../storage/types.ts';
import { compareOrder, writeImport } from './bookmarkImport.ts';

/** Largest custom icon accepted (the server's MAX_UPLOAD_ICON_BYTES / multipart('upload') limit). */
export const MAX_UPLOAD_ICON_BYTES = 10 * 1024 * 1024;
/** Route params longer than this are "not found" (the server's IdParam). */
const MAX_ID_PARAM = 512;
const UNSUPPORTED_IMAGE = 'Unsupported image type (png, gif, jpeg, webp, avif, ico, bmp or svg)';
const StrategySchema = z.enum(TARGET_GROUP_STRATEGIES);

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function idParam(request: StaticRequest, name = 'id'): string {
  const value = request.params[name];
  if (value === undefined || value.length === 0 || value.length > MAX_ID_PARAM) throw new StaticApiError('not_found', 'Not found');
  return value;
}

function requireGroup(slice: BookmarksSlice, id: string): StoredBookmarkGroup {
  const group = slice.groups.find((g) => g.id === id);
  if (!group) throw new StaticApiError('not_found', 'Bookmark group not found');
  return group;
}

function requireBookmark(slice: BookmarksSlice, id: string): StoredBookmark {
  const bookmark = slice.bookmarks.find((b) => b.id === id);
  if (!bookmark) throw new StaticApiError('not_found', 'Bookmark not found');
  return bookmark;
}

function orderedGroups(slice: BookmarksSlice): StoredBookmarkGroup[] {
  return [...slice.groups].sort(compareOrder);
}

function groupBookmarks(slice: BookmarksSlice, groupId: string): StoredBookmark[] {
  return slice.bookmarks.filter((b) => b.groupId === groupId).sort(compareOrder);
}

/** Writes sort = position for every row whose sort differs (the server's renumbering). */
function renumber(rows: readonly (StoredBookmark | StoredBookmarkGroup)[], ts: number): void {
  rows.forEach((row, index) => {
    if (row.sort !== index) {
      row.sort = index;
      row.updatedAt = ts;
    }
  });
}

// ---------------------------------------------------------------------------
// Icon registry (the server's IconLinker over synthetic favicon ids + stored uploads)
// ---------------------------------------------------------------------------

type IconKind = 'favicon' | 'upload';
type IconKindOf = (id: string) => IconKind | null;

/** Resolves an icon id to its kind: a usable synthetic favicon id, a stored custom icon, or null. */
function iconKindResolver(ctx: StaticContext): IconKindOf {
  const uploads = new Set(getIcons(ctx).map((icon) => icon.id));
  return (id) => {
    if (isFaviconId(id)) return faviconServiceUrl(id) !== null ? 'favicon' : null;
    return uploads.has(id) ? 'upload' : null;
  };
}

/**
 * The icon columns for a create/update (store.ts `iconColumns`): letter → none; custom only with a
 * stored upload (else falls through to auto); auto accepts a requested favicon id, else the host's
 * synthetic id when automatic icons are on, else none.
 */
function iconColumns(ctx: StaticContext, mode: IconMode, requested: string | null | undefined, url: string): { mode: IconMode; iconId: string | null } {
  if (mode === 'letter') return { mode, iconId: null };
  if (requested) {
    const kind = iconKindResolver(ctx)(requested);
    if (mode === 'custom' && kind === 'upload') return { mode: 'custom', iconId: requested };
    if (kind === 'favicon') return { mode: 'auto', iconId: requested };
  }
  return { mode: 'auto', iconId: getSettings(ctx).bookmarks.autoFetchIcons ? faviconIdFor(url) : null };
}

/** Marks a custom icon as unreferenced (kept for the undo window, then deleted by `ready`). Returns whether the icons slice changed. */
function markOrphaned(ctx: StaticContext, iconId: string): boolean {
  const icon = getIcons(ctx).find((i) => i.id === iconId);
  if (!icon || icon.orphanedAt !== null) return false;
  icon.orphanedAt = ctx.now();
  return true;
}

/** Clears the orphan marker when a custom icon is referenced again (Undo re-creates with the old id). */
function markReferenced(ctx: StaticContext, iconId: string): boolean {
  const icon = getIcons(ctx).find((i) => i.id === iconId);
  if (!icon || icon.orphanedAt === null) return false;
  icon.orphanedAt = null;
  return true;
}

// ---------------------------------------------------------------------------
// Projection (store.ts toBookmark / toGroup)
// ---------------------------------------------------------------------------

function iconModeOf(value: string): IconMode {
  return value === 'custom' || value === 'letter' ? value : 'auto';
}

/** What a projection needs besides the row: the icon registry and `settings.bookmarks.autoFetchIcons`. */
interface IconView {
  kindOf: IconKindOf;
  autoIcons: boolean;
}

function iconView(ctx: StaticContext): IconView {
  return { kindOf: iconKindResolver(ctx), autoIcons: getSettings(ctx).bookmarks.autoFetchIcons };
}

function toBookmark(row: StoredBookmark, view: IconView): Bookmark {
  const mode = iconModeOf(row.iconMode);
  const exists = row.iconId !== null && view.kindOf(row.iconId) !== null;
  let iconId = mode === 'letter' || !exists ? null : row.iconId;
  // The server's maintenance job gives automatic bookmarks without a usable icon their host's icon
  // once automatic icons are on (e.g. bookmarks added or imported while the setting was off); the
  // synthetic id needs no fetch, so it is derived here instead.
  if (mode === 'auto' && iconId === null && view.autoIcons) iconId = faviconIdFor(row.url);
  return {
    id: row.id,
    groupId: row.groupId,
    title: row.title,
    url: row.url,
    sort: row.sort,
    // A custom icon that vanished degrades to the automatic icon.
    iconMode: mode === 'custom' && !exists ? 'auto' : mode,
    iconId,
    letterColor: normalizeHexColor(row.letterColor),
  };
}

function toGroup(row: StoredBookmarkGroup, rows: readonly StoredBookmark[], view: IconView): BookmarkGroup {
  return {
    id: row.id,
    name: row.name,
    sort: row.sort,
    color: normalizeHexColor(row.color),
    collapsed: Boolean(row.collapsed),
    bookmarks: rows.map((b) => toBookmark(b, view)),
  };
}

function projectBookmark(ctx: StaticContext, row: StoredBookmark): Bookmark {
  return toBookmark(row, iconView(ctx));
}

function projectGroup(ctx: StaticContext, slice: BookmarksSlice, row: StoredBookmarkGroup): BookmarkGroup {
  return toGroup(row, groupBookmarks(slice, row.id), iconView(ctx));
}

/** Every group with its bookmarks, ordered by (sort, id). */
export function listGroups(ctx: StaticContext): BookmarkGroup[] {
  const slice = getBookmarks(ctx);
  const view = iconView(ctx);
  const byGroup = new Map<string, StoredBookmark[]>();
  for (const bookmark of slice.bookmarks) {
    const bucket = byGroup.get(bookmark.groupId);
    if (bucket) bucket.push(bookmark);
    else byGroup.set(bookmark.groupId, [bookmark]);
  }
  return orderedGroups(slice).map((group) => toGroup(group, (byGroup.get(group.id) ?? []).sort(compareOrder), view));
}

function commitNames(iconsChanged: boolean, ...more: string[]): string[] {
  return iconsChanged ? [SLICE.bookmarks, SLICE.icons, ...more] : [SLICE.bookmarks, ...more];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function register(router: StaticRouter): void {
  // ---- icons ----------------------------------------------------------------

  router.get('/api/icons/:id', async (ctx, request) => {
    const id = (request.params.id ?? '').toLowerCase();
    const notFound = (): Response => apiError('not_found', 'Icon not found');
    // Only uploads have bytes; synthetic favicon ids resolve to the icon service in the UI.
    if (!isUuidV4(id) || !getIcons(ctx).some((icon) => icon.id === id)) return notFound();
    const entry = await ctx.state.getBlob(id);
    if (!entry || entry.kind !== 'icon' || sniffImageType(entry.bytes) !== entry.type) return notFound();
    return new Response(blobOf(entry), {
      status: 200,
      headers: { 'content-type': entry.type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' },
    });
  });

  // ---- site meta ------------------------------------------------------------

  router.get('/api/site-meta', (ctx, request) => {
    const { url } = parseQuery(request.url, SiteMetaQuerySchema);
    const iconId = getSettings(ctx).bookmarks.autoFetchIcons ? faviconIdFor(url) : null;
    return json({ title: siteName(url), iconId } satisfies SiteMeta);
  });

  // ---- imports (registered before /api/bookmarks/:id routes, like the server) -

  router.get('/api/bookmarks/import/sources', () => json([] satisfies BookmarkImportSource[]));

  router.post('/api/bookmarks/import/browser', () => apiError('not_found', 'Browser profile import is not available in this build'));

  router.post('/api/bookmarks/import/html', async (ctx, request) => {
    const form = await readFormData(request.req);
    const file = await readMultipartFile(form, undefined, MAX_HTML_IMPORT_BYTES);
    const rawStrategy = form.get('targetGroupStrategy');
    const strategy = StrategySchema.safeParse(typeof rawStrategy === 'string' ? rawStrategy : 'folders');
    if (!strategy.success) throw new StaticApiError('validation_failed', 'targetGroupStrategy must be "folders" or "single"');
    const tree = parseNetscapeBookmarks(new TextDecoder('utf-8', { fatal: false }).decode(file.bytes));
    return json(await writeImport(ctx, tree, { strategy: strategy.data, fallbackName: 'Imported bookmarks' }));
  });

  // ---- groups ---------------------------------------------------------------

  router.get('/api/bookmarks', (ctx) => json({ groups: listGroups(ctx) } satisfies BookmarksResponse));

  router.post('/api/bookmark-groups/reorder', async (ctx, request) => {
    const { ids } = await parseJsonBody(request.req, BookmarkGroupReorderSchema);
    const slice = getBookmarks(ctx);
    const current = orderedGroups(slice);
    const known = new Map(current.map((g) => [g.id, g]));
    const seen = new Set<string>();
    const order: StoredBookmarkGroup[] = [];
    for (const id of ids) {
      const group = known.get(id);
      if (group && !seen.has(id)) {
        order.push(group);
        seen.add(id);
      }
    }
    // Groups the client did not mention (e.g. created elsewhere meanwhile) keep their relative order at the end.
    for (const group of current) if (!seen.has(group.id)) order.push(group);
    renumber(order, ctx.now());
    await ctx.state.commit(SLICE.bookmarks);
    return json({ groups: listGroups(ctx) } satisfies BookmarksResponse);
  });

  router.post('/api/bookmark-groups', async (ctx, request) => {
    const input = await parseJsonBody(request.req, BookmarkGroupCreateSchema);
    const slice = getBookmarks(ctx);
    if (slice.groups.length >= MAX_BOOKMARK_GROUPS) {
      throw new StaticApiError('conflict', `You can have at most ${MAX_BOOKMARK_GROUPS} bookmark groups`);
    }
    const ts = ctx.now();
    const group: StoredBookmarkGroup = {
      id: ctx.newId(),
      name: input.name,
      sort: slice.groups.reduce((max, g) => Math.max(max, g.sort), -1) + 1,
      color: normalizeHexColor(input.color ?? null),
      collapsed: input.collapsed === true,
      createdAt: ts,
      updatedAt: ts,
    };
    slice.groups.push(group);
    await ctx.state.commit(SLICE.bookmarks);
    return json(projectGroup(ctx, slice, group), 201);
  });

  router.patch('/api/bookmark-groups/:id', async (ctx, request) => {
    const input = await parseJsonBody(request.req, BookmarkGroupUpdateSchema);
    const id = idParam(request);
    const slice = getBookmarks(ctx);
    const group = requireGroup(slice, id);
    const ts = ctx.now();
    // Static field allowlist; sort never changes here.
    if (input.name !== undefined) group.name = input.name;
    if (input.color !== undefined) group.color = normalizeHexColor(input.color);
    if (input.collapsed !== undefined) group.collapsed = input.collapsed;
    if (input.name !== undefined || input.color !== undefined || input.collapsed !== undefined) group.updatedAt = ts;
    await ctx.state.commit(SLICE.bookmarks);
    return json(projectGroup(ctx, slice, group));
  });

  router.delete('/api/bookmark-groups/:id', async (ctx, request) => {
    const id = idParam(request);
    const slice = getBookmarks(ctx);
    requireGroup(slice, id);
    const ts = ctx.now();
    const removed = slice.bookmarks.filter((b) => b.groupId === id);
    slice.bookmarks = slice.bookmarks.filter((b) => b.groupId !== id); // cascade
    slice.groups = slice.groups.filter((g) => g.id !== id);
    renumber(orderedGroups(slice), ts);
    let iconsChanged = false;
    for (const bookmark of removed) {
      if (iconModeOf(bookmark.iconMode) === 'custom' && bookmark.iconId) iconsChanged = markOrphaned(ctx, bookmark.iconId) || iconsChanged;
    }
    const names = commitNames(iconsChanged);
    // The server resets settings.bookmarks.defaultGroupId when that group goes (the web re-reads settings).
    const settings = getSettings(ctx);
    const { defaultGroupId, ungroupedGroupId } = settings.bookmarks;
    if (defaultGroupId === id || ungroupedGroupId === id) {
      setSettings(ctx, {
        ...settings,
        bookmarks: {
          ...settings.bookmarks,
          defaultGroupId: defaultGroupId === id ? null : defaultGroupId,
          ungroupedGroupId: ungroupedGroupId === id ? null : ungroupedGroupId,
        },
      });
      names.push(SLICE.settings);
    }
    await ctx.state.commit(...names);
    return noContent();
  });

  // ---- bookmarks ------------------------------------------------------------

  router.post('/api/bookmarks', async (ctx, request) => {
    const input = await parseJsonBody(request.req, BookmarkCreateSchema);
    const slice = getBookmarks(ctx);
    if (!slice.groups.some((g) => g.id === input.groupId)) throw new StaticApiError('validation_failed', 'The bookmark group does not exist');
    if (slice.bookmarks.length >= MAX_BOOKMARKS) throw new StaticApiError('conflict', `You can have at most ${MAX_BOOKMARKS} bookmarks`);
    const ts = ctx.now();
    const icon = iconColumns(ctx, input.iconMode ?? 'auto', input.iconId, input.url);
    const bookmark: StoredBookmark = {
      id: ctx.newId(),
      groupId: input.groupId,
      title: input.title,
      url: input.url,
      sort: slice.bookmarks.reduce((max, b) => (b.groupId === input.groupId ? Math.max(max, b.sort) : max), -1) + 1,
      iconMode: icon.mode,
      iconId: icon.iconId,
      letterColor: normalizeHexColor(input.letterColor ?? null),
      createdAt: ts,
      updatedAt: ts,
    };
    slice.bookmarks.push(bookmark);
    const iconsChanged = icon.mode === 'custom' && icon.iconId !== null && markReferenced(ctx, icon.iconId);
    await ctx.state.commit(...commitNames(iconsChanged));
    return json(projectBookmark(ctx, bookmark), 201);
  });

  router.patch('/api/bookmarks/:id', async (ctx, request) => {
    const input = await parseJsonBody(request.req, BookmarkUpdateSchema);
    const id = idParam(request);
    const slice = getBookmarks(ctx);
    const bookmark = requireBookmark(slice, id);
    const ts = ctx.now();
    const previousUrl = bookmark.url;
    const url = input.url ?? previousUrl;
    // Static field allowlist.
    if (input.title !== undefined) bookmark.title = input.title;
    if (input.url !== undefined) bookmark.url = input.url;
    if (input.letterColor !== undefined) bookmark.letterColor = normalizeHexColor(input.letterColor);
    if (input.title !== undefined || input.url !== undefined || input.letterColor !== undefined) bookmark.updatedAt = ts;

    let iconsChanged = false;
    const currentMode = iconModeOf(bookmark.iconMode);
    const currentIconId = bookmark.iconId;
    const hostChanged = input.url !== undefined && hostKeyOf(input.url) !== hostKeyOf(previousUrl);
    const modeChanged = input.iconMode !== undefined && input.iconMode !== currentMode;
    if (modeChanged || input.iconId !== undefined || (hostChanged && currentMode === 'auto')) {
      const mode = input.iconMode ?? currentMode;
      const requested = input.iconId !== undefined ? input.iconId : mode === currentMode && !hostChanged ? currentIconId : null;
      const icon = iconColumns(ctx, mode, requested, url);
      bookmark.iconMode = icon.mode;
      bookmark.iconId = icon.iconId;
      bookmark.updatedAt = ts;
      if (currentMode === 'custom' && currentIconId && currentIconId !== icon.iconId) iconsChanged = markOrphaned(ctx, currentIconId) || iconsChanged;
      if (icon.mode === 'custom' && icon.iconId) iconsChanged = markReferenced(ctx, icon.iconId) || iconsChanged;
    }
    await ctx.state.commit(...commitNames(iconsChanged));
    return json(projectBookmark(ctx, bookmark));
  });

  router.delete('/api/bookmarks/:id', async (ctx, request) => {
    const id = idParam(request);
    const slice = getBookmarks(ctx);
    const bookmark = requireBookmark(slice, id);
    slice.bookmarks = slice.bookmarks.filter((b) => b.id !== id);
    renumber(groupBookmarks(slice, bookmark.groupId), ctx.now());
    const iconsChanged = iconModeOf(bookmark.iconMode) === 'custom' && bookmark.iconId !== null && markOrphaned(ctx, bookmark.iconId);
    await ctx.state.commit(...commitNames(iconsChanged));
    return noContent();
  });

  router.post('/api/bookmarks/:id/move', async (ctx, request) => {
    const input = await parseJsonBody(request.req, BookmarkMoveSchema);
    const id = idParam(request);
    const slice = getBookmarks(ctx);
    const bookmark = requireBookmark(slice, id);
    if (!slice.groups.some((g) => g.id === input.groupId)) throw new StaticApiError('validation_failed', 'The target group does not exist');
    const ts = ctx.now();
    const target = groupBookmarks(slice, input.groupId).filter((b) => b.id !== id);
    const index = Math.max(0, Math.min(input.index, target.length));
    target.splice(index, 0, bookmark);
    if (bookmark.groupId !== input.groupId) {
      const sourceId = bookmark.groupId;
      bookmark.groupId = input.groupId;
      bookmark.updatedAt = ts;
      renumber(groupBookmarks(slice, sourceId), ts);
    }
    renumber(target, ts);
    await ctx.state.commit(SLICE.bookmarks);
    return json({ groups: listGroups(ctx) } satisfies BookmarksResponse);
  });

  router.post('/api/bookmarks/:id/refresh-icon', async (ctx, request) => {
    const id = idParam(request);
    const slice = getBookmarks(ctx);
    const bookmark = requireBookmark(slice, id);
    // Explicit user action: assigns the host's icon even when automatic fetching is off (the
    // server runs its resolution chain here; the browser can only point at the icon service).
    const iconsChanged = setIcon(ctx, bookmark, 'auto', faviconIdFor(bookmark.url));
    await ctx.state.commit(...commitNames(iconsChanged));
    return json(projectBookmark(ctx, bookmark));
  });

  router.post('/api/bookmarks/:id/icon', async (ctx, request) => {
    const id = idParam(request);
    requireBookmark(getBookmarks(ctx), id); // 404 before the body is read, like the server
    const { bytes } = await readMultipartFile(await readFormData(request.req), undefined, MAX_UPLOAD_ICON_BYTES);
    const type = sniffImageType(bytes);
    if (!type) throw new StaticApiError('validation_failed', UNSUPPORTED_IMAGE);
    // Re-resolve after the awaits: another tab may have reloaded the slice meanwhile.
    requireBookmark(getBookmarks(ctx), id);
    const ts = ctx.now();
    const entry: StoredBlob = { id: ctx.newId(), kind: 'icon', type, bytes, width: imageSize(bytes, type), createdAt: ts };
    await ctx.state.putBlob(entry);
    // 1. The icon's metadata, persisted on its own: if that fails, nothing refers to the bytes yet,
    //    so they are deleted again and memory, storage and the blob store keep agreeing.
    try {
      getIcons(ctx).push({ id: entry.id, type, width: entry.width, createdAt: ts, orphanedAt: null });
      await ctx.state.commit(SLICE.icons);
    } catch (error) {
      removeIconMeta(ctx, entry.id);
      await ctx.state.deleteBlob(entry.id).catch(() => undefined);
      throw error;
    }
    ctx.assets.registerBlob('icons', entry.id, blobOf(entry));
    // 2. The bookmark. If that commit fails, the in-memory rows are put back; the new icon stays
    //    stored but unreferenced, so `ready` garbage-collects it after the grace period.
    const bookmark = requireBookmark(getBookmarks(ctx), id);
    const previous = { iconMode: bookmark.iconMode, iconId: bookmark.iconId, updatedAt: bookmark.updatedAt };
    const previousOrphanedAt = previous.iconId === null ? undefined : getIcons(ctx).find((icon) => icon.id === previous.iconId)?.orphanedAt;
    const iconsChanged = setIcon(ctx, bookmark, 'custom', entry.id);
    try {
      await ctx.state.commit(...commitNames(iconsChanged));
    } catch (error) {
      Object.assign(bookmark, previous);
      const replaced = previous.iconId === null ? undefined : getIcons(ctx).find((icon) => icon.id === previous.iconId);
      if (replaced && previousOrphanedAt !== undefined) replaced.orphanedAt = previousOrphanedAt;
      throw error;
    }
    return json(projectBookmark(ctx, bookmark));
  });
}

/** Drops an icon's metadata from the in-memory icons slice (no-op when absent). */
function removeIconMeta(ctx: StaticContext, iconId: string): void {
  const icons = getIcons(ctx);
  const index = icons.findIndex((icon) => icon.id === iconId);
  if (index !== -1) icons.splice(index, 1);
}

/** store.ts setCustomIcon / setAutoIcon: sets the icon columns and orphans a replaced custom icon. */
function setIcon(ctx: StaticContext, bookmark: StoredBookmark, mode: 'auto' | 'custom', iconId: string | null): boolean {
  const previousMode = iconModeOf(bookmark.iconMode);
  const previousIconId = bookmark.iconId;
  bookmark.iconMode = mode;
  bookmark.iconId = iconId;
  bookmark.updatedAt = ctx.now();
  let iconsChanged = false;
  if (previousMode === 'custom' && previousIconId && previousIconId !== iconId) iconsChanged = markOrphaned(ctx, previousIconId) || iconsChanged;
  if (mode === 'custom' && iconId) iconsChanged = markReferenced(ctx, iconId) || iconsChanged;
  return iconsChanged;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * Registers every stored custom icon as an object URL and runs the server's icon garbage
 * collection: an upload nobody references any more is deleted once its orphan marker (or, when it
 * never got one, its creation) is older than the undo grace period. Metadata whose bytes are gone
 * is dropped (the bookmark then reports the automatic icon, as with the server's LEFT JOIN), and
 * icon bytes without metadata (the tab closed between writing the bytes and committing their
 * metadata) are deleted once older than the grace period — a younger one may be an upload another
 * tab is finishing. Idempotent: safe to call again after an import replaced the slices.
 */
export async function ready(ctx: StaticContext): Promise<void> {
  const now = ctx.now();
  const blobs = new Map<string, StoredBlob>();
  for (const blob of await ctx.state.listBlobs()) if (blob.kind === 'icon') blobs.set(blob.id, blob);
  const icons = getIcons(ctx);
  const known = new Set(icons.map((icon) => icon.id));
  for (const blob of blobs.values()) {
    // Best effort: a failed cleanup must not stop the backend from starting (the next start retries).
    if (!known.has(blob.id) && blob.createdAt + ORPHAN_GRACE_MS <= now) await ctx.state.deleteBlob(blob.id).catch(() => undefined);
  }
  if (icons.length === 0) return;
  const referenced = new Set<string>();
  for (const bookmark of getBookmarks(ctx).bookmarks) {
    if (iconModeOf(bookmark.iconMode) === 'custom' && bookmark.iconId) referenced.add(bookmark.iconId);
  }
  for (const engine of getSettings(ctx).search.engines) if (engine.iconId) referenced.add(engine.iconId);

  let changed = false;
  for (const icon of [...icons]) {
    const entry = blobs.get(icon.id);
    const inUse = referenced.has(icon.id);
    const expired = !inUse && (icon.orphanedAt ?? icon.createdAt) + ORPHAN_GRACE_MS <= now;
    if (!entry || expired) {
      icons.splice(icons.indexOf(icon), 1);
      if (entry) await ctx.state.deleteBlob(icon.id);
      ctx.assets.revoke('icons', icon.id);
      changed = true;
      continue;
    }
    if (inUse && icon.orphanedAt !== null) {
      icon.orphanedAt = null;
      changed = true;
    }
    ctx.assets.registerBlob('icons', icon.id, blobOf(entry));
  }
  if (changed) await ctx.state.commit(SLICE.icons);
}
