/**
 * Bookmarks (launch pad), groups, imports and the `bookmarks` settings namespace (§7a bookmarks.ts).
 */
import { z } from 'zod';
import { EntityId, HexColor, SafeHttpUrl } from './core.ts';

export const MAX_BOOKMARK_GROUPS = 200;
export const MAX_BOOKMARKS = 5000;

export const ICON_MODES = ['auto', 'custom', 'letter'] as const;
export const IconModeSchema = z.enum(ICON_MODES);
/** `auto` = fetched favicon, `custom` = user upload, `letter` = letter tile. */
export type IconMode = z.output<typeof IconModeSchema>;

export const BookmarkTitleSchema = z.string().trim().min(1).max(300);
export const BookmarkGroupNameSchema = z.string().trim().min(1).max(100);

export const BookmarkSchema = z
  .object({
    id: EntityId,
    groupId: EntityId,
    title: BookmarkTitleSchema,
    url: SafeHttpUrl,
    sort: z.number().int(),
    iconMode: IconModeSchema,
    iconId: EntityId.nullable(),
    letterColor: HexColor.nullable(),
  })
  .strict();
export type Bookmark = z.output<typeof BookmarkSchema>;

export const BookmarkGroupSchema = z
  .object({
    id: EntityId,
    name: BookmarkGroupNameSchema,
    sort: z.number().int(),
    color: HexColor.nullable(),
    collapsed: z.boolean(),
    bookmarks: z.array(BookmarkSchema),
  })
  .strict();
export type BookmarkGroup = z.output<typeof BookmarkGroupSchema>;

/** `GET /api/bookmarks` */
export interface BookmarksResponse {
  groups: BookmarkGroup[];
}

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

/** `POST /api/bookmark-groups` */
export const BookmarkGroupCreateSchema = z
  .object({
    name: BookmarkGroupNameSchema,
    color: HexColor.nullable().optional(),
    collapsed: z.boolean().optional(),
  })
  .strict();
export type BookmarkGroupCreate = z.output<typeof BookmarkGroupCreateSchema>;

/** `PATCH /api/bookmark-groups/:id` */
export const BookmarkGroupUpdateSchema = z
  .object({
    name: BookmarkGroupNameSchema.optional(),
    color: HexColor.nullable().optional(),
    collapsed: z.boolean().optional(),
  })
  .strict();
export type BookmarkGroupUpdate = z.output<typeof BookmarkGroupUpdateSchema>;

/** `POST /api/bookmark-groups/reorder {ids}` — the complete new order of group ids. */
export const BookmarkGroupReorderSchema = z
  .object({
    ids: z.array(EntityId).max(MAX_BOOKMARK_GROUPS),
  })
  .strict()
  .refine((v) => new Set(v.ids).size === v.ids.length, { message: 'Group ids must be unique', path: ['ids'] });
export type BookmarkGroupReorder = z.output<typeof BookmarkGroupReorderSchema>;

/** `POST /api/bookmarks` — appended to the end of the group. */
export const BookmarkCreateSchema = z
  .object({
    groupId: EntityId,
    title: BookmarkTitleSchema,
    url: SafeHttpUrl,
    iconMode: IconModeSchema.optional(),
    iconId: EntityId.nullable().optional(),
    letterColor: HexColor.nullable().optional(),
  })
  .strict();
export type BookmarkCreate = z.output<typeof BookmarkCreateSchema>;

/** `PATCH /api/bookmarks/:id` */
export const BookmarkUpdateSchema = z
  .object({
    title: BookmarkTitleSchema.optional(),
    url: SafeHttpUrl.optional(),
    iconMode: IconModeSchema.optional(),
    iconId: EntityId.nullable().optional(),
    letterColor: HexColor.nullable().optional(),
  })
  .strict();
export type BookmarkUpdate = z.output<typeof BookmarkUpdateSchema>;

/** `POST /api/bookmarks/:id/move {groupId, index}` (atomic; index within the target group). */
export const BookmarkMoveSchema = z
  .object({
    groupId: EntityId,
    index: z.number().int().min(0).max(MAX_BOOKMARKS),
  })
  .strict();
export type BookmarkMove = z.output<typeof BookmarkMoveSchema>;

/** `GET /api/site-meta?url=` */
export const SiteMetaQuerySchema = z.object({ url: SafeHttpUrl });
export type SiteMetaQuery = z.output<typeof SiteMetaQuerySchema>;

/** `GET /api/site-meta` response. */
export interface SiteMeta {
  title: string | null;
  iconId: string | null;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export const IMPORT_BROWSERS = ['chrome', 'edge'] as const;
export type ImportBrowser = (typeof IMPORT_BROWSERS)[number];

/** `GET /api/bookmarks/import/sources` item; `id` is opaque (never a path). */
export interface BookmarkImportSource {
  id: string;
  browser: ImportBrowser;
  profileName: string;
  bookmarkCount: number;
}

export const TARGET_GROUP_STRATEGIES = ['folders', 'single'] as const;

/** `POST /api/bookmarks/import/browser` */
export const BrowserImportSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    targetGroupStrategy: z.enum(TARGET_GROUP_STRATEGIES),
  })
  .strict();
export type BrowserImport = z.output<typeof BrowserImportSchema>;

/** Import report returned by browser and HTML bookmark imports. */
export interface BookmarkImportReport {
  /** Groups created. */
  groups: number;
  /** Bookmarks created. */
  bookmarks: number;
  /** Entries skipped (non-http(s) URLs, invalid entries, over the caps). */
  skipped: number;
}

// ---------------------------------------------------------------------------
// Settings namespace
// ---------------------------------------------------------------------------

/** `settings.bookmarks` */
export const BookmarksSettingsSchema = z
  .object({
    /** Group that quick-added bookmarks go to (null = first group). */
    defaultGroupId: EntityId.nullable().default(null),
    /** The group holding bookmarks filed under "No group" (shown without a header; null = none yet). */
    ungroupedGroupId: EntityId.nullable().default(null),
    /** Fetch favicons automatically for `auto` icon mode. */
    autoFetchIcons: z.boolean().default(true),
  })
  .strict();
export type BookmarksSettings = z.output<typeof BookmarksSettingsSchema>;
