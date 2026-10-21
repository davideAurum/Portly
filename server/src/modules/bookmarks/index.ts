/**
 * Bookmarks module (§7 Bookmarks): groups, bookmarks, atomic moves, icons, site meta and imports.
 *
 * Routes (all declared `paired()`: the paired Pages site may use them too):
 * - `GET /api/bookmarks` → `{groups}` (every group with its bookmarks, ordered)
 * - `POST /api/bookmark-groups` → 201 group · `PATCH|DELETE /api/bookmark-groups/:id`
 * - `POST /api/bookmark-groups/reorder {ids}` → `{groups}`
 * - `POST /api/bookmarks` → 201 bookmark (favicon resolved in the background) ·
 *   `PATCH|DELETE /api/bookmarks/:id`
 * - `POST /api/bookmarks/:id/move {groupId, index}` → `{groups}` (atomic, one transaction)
 * - `POST /api/bookmarks/:id/refresh-icon` → bookmark (re-resolves the host's favicon now)
 * - `POST /api/bookmarks/:id/icon` (multipart `file`, ≤ 10 MB, sniffed images only) → bookmark
 * - `GET /api/icons/:id` (gate-exempt `image` route; sandbox CSP + private cache headers are
 *   added by the security-headers middleware)
 * - `GET /api/site-meta?url=` → `{title, iconId}`
 * - `GET /api/bookmarks/import/sources` → `BookmarkImportSource[]`
 * - `POST /api/bookmarks/import/browser {sourceId, targetGroupStrategy}` → import report
 * - `POST /api/bookmarks/import/html` (multipart `file` ≤ 25 MB, optional field
 *   `targetGroupStrategy`) → import report
 *
 * Settings honoured: `bookmarks.autoFetchIcons` (no automatic favicon network traffic when off;
 * an explicit "refresh icon" still works), `bookmarks.defaultGroupId` and `bookmarks.ungroupedGroupId`
 * (each reset when its group is deleted). Job `bookmarks:icons` (hourly): resolve missing icons, refresh icons older than
 * 30 days, garbage-collect unreferenced icons.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  BookmarkCreateSchema,
  BookmarkGroupCreateSchema,
  BookmarkGroupReorderSchema,
  BookmarkGroupUpdateSchema,
  BookmarkMoveSchema,
  BookmarkUpdateSchema,
  BrowserImportSchema,
  SiteMetaQuerySchema,
  TARGET_GROUP_STRATEGIES,
  type BookmarkImportReport,
  type BookmarksResponse,
  type SiteMeta,
} from '@portly/shared';
import type { AppContext, AppEnv, RegisterModule } from '../../context.ts';
import { HttpError } from '../../lib/errors.ts';
import { errorFields } from '../../lib/logger.ts';
import { readMultipartFile } from '../../lib/multipart.ts';
import { exempt, multipart, paired, samePc } from '../../lib/routes.ts';
import { parseBody, parseQuery } from '../../lib/validate.ts';
import { createFaviconService, MAX_UPLOAD_ICON_BYTES, type FaviconService } from './favicons.ts';
import { brandFromUrl, tryFetchPage, parsePage } from './html.ts';
import { createBrowserSources, defaultLocalAppData } from './import-browser.ts';
import { parseNetscapeBookmarks } from './import-html.ts';
import { writeImport, type ImportFolder, type ImportResult } from './importer.ts';
import { createBookmarkStore, hostKey } from './store.ts';

export const prefixes = ['/api/bookmarks', '/api/bookmark-groups', '/api/icons', '/api/site-meta'] as const;

/** Name of the favicon maintenance job (core triggers it after a config import). */
export const BOOKMARK_ICONS_JOB = 'bookmarks:icons';
export const ICON_JOB_INTERVAL_MS = 60 * 60 * 1000;
export const ICON_JOB_INITIAL_DELAY_MS = 2 * 60 * 1000;
export const SITE_META_TTL_MS = 10 * 60 * 1000;
export const SITE_META_MISS_TTL_MS = 30 * 1000;
/**
 * How long site-meta waits for the favicon before answering with the title alone. The resolution
 * keeps running in the background and links the icon to the host's bookmarks when it lands, so a
 * slow icon host never holds the title (and the add dialog) hostage.
 */
export const SITE_META_ICON_BUDGET_MS = 4_000;
/** How long `refresh-icon` waits before answering (the resolution then continues in the background). */
export const REFRESH_ICON_BUDGET_MS = 12_000;
export const MAX_HTML_IMPORT_BYTES = 25 * 1024 * 1024;

export interface BookmarksModuleOptions {
  /** `%LOCALAPPDATA%` root scanned for Chrome/Edge profiles (default: the environment's). */
  localAppData?: string | null;
  /** Receives the favicon service (tests await its background queue). */
  onFavicons?: (service: FaviconService) => void;
  /** Override of {@link SITE_META_ICON_BUDGET_MS} (tests). */
  siteMetaIconBudgetMs?: number;
  /** Override of {@link REFRESH_ICON_BUDGET_MS} (tests). */
  refreshIconBudgetMs?: number;
}

/** Resolves with `promise`'s value, or with `undefined` once `ms` have passed. */
function withinBudget<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

const IdParam = z.string().min(1).max(512);

function param(value: string | undefined): string {
  const parsed = IdParam.safeParse(value);
  if (!parsed.success) throw new HttpError(404, 'not_found', 'Not found');
  return parsed.data;
}

export function createBookmarksModule(options: BookmarksModuleOptions = {}): RegisterModule {
  return (app: Hono<AppEnv>, ctx: AppContext): void => {
    const log = ctx.log.child({ module: 'bookmarks' });
    const iconBudgetMs = options.siteMetaIconBudgetMs ?? SITE_META_ICON_BUDGET_MS;
    const refreshBudgetMs = options.refreshIconBudgetMs ?? REFRESH_ICON_BUDGET_MS;
    const autoFetch = (): boolean => ctx.settings.get('bookmarks').autoFetchIcons;
    const favicons = createFaviconService({
      db: ctx.db,
      fetch: ctx.fetch,
      log,
      autoFetch,
      externalReferences: () => ctx.settings.get('search').engines.flatMap((e) => (e.iconId ? [e.iconId] : [])),
    });
    options.onFavicons?.(favicons);
    const store = createBookmarkStore({ db: ctx.db, icons: favicons });
    const sources = createBrowserSources({
      localAppData: options.localAppData === undefined ? defaultLocalAppData() : options.localAppData,
      log,
    });

    const afterImport = (result: ImportResult): BookmarkImportReport => {
      if (autoFetch()) for (const url of result.createdUrls) favicons.enqueue(url);
      log.info('bookmarks imported', { groups: result.groups, bookmarks: result.bookmarks, skipped: result.skipped });
      return { groups: result.groups, bookmarks: result.bookmarks, skipped: result.skipped };
    };

    const runImport = (tree: ImportFolder, strategy: (typeof TARGET_GROUP_STRATEGIES)[number], label: string): BookmarkImportReport =>
      afterImport(writeImport(ctx.db, tree, { strategy, fallbackName: label, now: Date.now() }));

    // ---- icons ----------------------------------------------------------------

    app.get('/api/icons/:id', exempt('image'), paired(), (c) => {
      const icon = favicons.read(c.req.param('id'));
      if (!icon) throw new HttpError(404, 'not_found', 'Icon not found');
      return c.body(new Uint8Array(icon.bytes), 200, { 'Content-Type': icon.contentType });
    });

    // ---- site meta ------------------------------------------------------------

    app.get('/api/site-meta', paired(), async (c) => {
      const { url } = parseQuery(c, SiteMetaQuerySchema);
      const key = `bookmarks:site-meta:${url}`;
      let meta = ctx.memo.get<SiteMeta>(key);
      if (!meta) {
        const page = await tryFetchPage(ctx.fetch, url, log, { purpose: 'site-meta' });
        // Unreadable page: name the bookmark after its site ("Netflix") rather than leave it blank.
        const title = (page?.html ? parsePage(page.html, page.url).title : null) ?? brandFromUrl(url);
        let iconId: string | null = null;
        if (autoFetch()) {
          const resolving = favicons.ensure(url, { page }).catch((err: unknown) => {
            log.warn('site-meta icon failed', errorFields(err));
            return null;
          });
          iconId = (await withinBudget(resolving, iconBudgetMs)) ?? null;
        }
        meta = { title, iconId };
        // Failures are remembered only briefly (the site may be back in a moment).
        ctx.memo.set(key, meta, !page?.html && iconId === null ? SITE_META_MISS_TTL_MS : SITE_META_TTL_MS);
      }
      // The host's icon may have landed since (background resolution after the budget ran out);
      // an icon garbage-collected since the answer was cached must not be reported.
      const host = hostKey(url);
      const known = meta.iconId && favicons.icon(meta.iconId) ? meta.iconId : null;
      const iconId = known ?? (host ? favicons.hostIcon(host) : null);
      return c.json({ title: meta.title, iconId } satisfies SiteMeta);
    });

    // ---- imports (registered before /api/bookmarks/:id routes) -----------------

    app.get('/api/bookmarks/import/sources', samePc(), async (c) => c.json(await sources.list()));

    app.post('/api/bookmarks/import/browser', samePc(), async (c) => {
      const input = await parseBody(c, BrowserImportSchema);
      const { tree, label } = await sources.load(input.sourceId);
      return c.json(runImport(tree, input.targetGroupStrategy, label));
    });

    app.post('/api/bookmarks/import/html', multipart('import'), paired(), async (c) => {
      const file = await readMultipartFile(c, { maxBytes: MAX_HTML_IMPORT_BYTES });
      const form = await c.req.formData();
      const rawStrategy = form.get('targetGroupStrategy');
      const strategy = z.enum(TARGET_GROUP_STRATEGIES).safeParse(typeof rawStrategy === 'string' ? rawStrategy : 'folders');
      if (!strategy.success) throw new HttpError(422, 'validation_failed', 'targetGroupStrategy must be "folders" or "single"');
      const tree = parseNetscapeBookmarks(new TextDecoder('utf-8', { fatal: false }).decode(file.bytes));
      return c.json(runImport(tree, strategy.data, 'Imported bookmarks'));
    });

    // ---- groups ---------------------------------------------------------------

    app.get('/api/bookmarks', paired(), (c) => c.json({ groups: store.list() } satisfies BookmarksResponse));

    app.post('/api/bookmark-groups/reorder', paired(), async (c) => {
      const { ids } = await parseBody(c, BookmarkGroupReorderSchema);
      return c.json({ groups: store.reorderGroups(ids) } satisfies BookmarksResponse);
    });

    app.post('/api/bookmark-groups', paired(), async (c) => {
      const input = await parseBody(c, BookmarkGroupCreateSchema);
      return c.json(store.createGroup(input), 201);
    });

    app.patch('/api/bookmark-groups/:id', paired(), async (c) => {
      const input = await parseBody(c, BookmarkGroupUpdateSchema);
      return c.json(store.updateGroup(param(c.req.param('id')), input));
    });

    app.delete('/api/bookmark-groups/:id', paired(), (c) => {
      const id = param(c.req.param('id'));
      store.deleteGroup(id);
      const settings = ctx.settings.get('bookmarks');
      if (settings.defaultGroupId === id || settings.ungroupedGroupId === id) {
        try {
          ctx.settings.set('bookmarks', {
            ...settings,
            defaultGroupId: settings.defaultGroupId === id ? null : settings.defaultGroupId,
            ungroupedGroupId: settings.ungroupedGroupId === id ? null : settings.ungroupedGroupId,
          });
        } catch (err) {
          log.warn('could not reset the default bookmark group', errorFields(err));
        }
      }
      return c.body(null, 204);
    });

    // ---- bookmarks ------------------------------------------------------------

    app.post('/api/bookmarks', paired(), async (c) => {
      const input = await parseBody(c, BookmarkCreateSchema);
      const bookmark = store.create(input);
      if (bookmark.iconMode === 'auto' && bookmark.iconId === null && autoFetch()) favicons.enqueue(bookmark.url);
      return c.json(bookmark, 201);
    });

    app.patch('/api/bookmarks/:id', paired(), async (c) => {
      const input = await parseBody(c, BookmarkUpdateSchema);
      const bookmark = store.update(param(c.req.param('id')), input);
      if (bookmark.iconMode === 'auto' && bookmark.iconId === null && autoFetch()) favicons.enqueue(bookmark.url);
      return c.json(bookmark);
    });

    app.delete('/api/bookmarks/:id', paired(), (c) => {
      store.delete(param(c.req.param('id')));
      return c.body(null, 204);
    });

    app.post('/api/bookmarks/:id/move', paired(), async (c) => {
      const input = await parseBody(c, BookmarkMoveSchema);
      return c.json({ groups: store.move(param(c.req.param('id')), input) } satisfies BookmarksResponse);
    });

    app.post('/api/bookmarks/:id/refresh-icon', paired(), async (c) => {
      const id = param(c.req.param('id'));
      const bookmark = store.get(id);
      if (!bookmark) throw new HttpError(404, 'not_found', 'Bookmark not found');
      // Explicit user action: resolves now even when automatic fetching is off. On failure the
      // host's previous favicon (if any) is kept. A slow chain finishes in the background (it
      // links the new icon to the host's automatic bookmarks when it lands).
      const resolving = favicons.ensure(bookmark.url, { force: true }).catch((err: unknown) => {
        log.warn('icon refresh failed', errorFields(err));
        return null;
      });
      const resolved = await withinBudget(resolving, refreshBudgetMs);
      const host = hostKey(bookmark.url);
      return c.json(store.setAutoIcon(id, resolved ?? (host ? favicons.hostIcon(host) : null)));
    });

    app.post('/api/bookmarks/:id/icon', multipart('upload'), paired(), async (c) => {
      const id = param(c.req.param('id'));
      if (!store.get(id)) throw new HttpError(404, 'not_found', 'Bookmark not found');
      const file = await readMultipartFile(c, { maxBytes: MAX_UPLOAD_ICON_BYTES });
      const iconId = favicons.storeUpload(file.bytes);
      return c.json(store.setCustomIcon(id, iconId));
    });

    // ---- jobs -----------------------------------------------------------------

    ctx.scheduler.every(BOOKMARK_ICONS_JOB, ICON_JOB_INTERVAL_MS, () => favicons.maintenance(), {
      initialDelayMs: ICON_JOB_INITIAL_DELAY_MS,
    });
  };
}

export const register: RegisterModule = createBookmarksModule();
