/**
 * Config export/import file (§7 Core: `GET /api/export`, `POST /api/import/preview|commit`).
 * The file is built by an explicit per-entity allowlist serializer; accounts, secrets, OAuth
 * data, the Todoist token, calendars/ICS URLs, events, cache and fetched favicons are excluded.
 * Import validates with this strict, versioned schema, regenerates every id, drops unknown
 * widget types and reports a summary before anything is written.
 */
import { z } from 'zod';
import { EntityId, HexColor, ImageContentType, IsoDateTime, SafeHttpUrl, Uuid } from './core.ts';
import { BookmarkGroupNameSchema, BookmarkTitleSchema, IconModeSchema, MAX_BOOKMARKS, MAX_BOOKMARK_GROUPS } from './bookmarks.ts';
import { MAX_PROFILES, ProfileSchema } from './profiles.ts';
import { SettingsSchema } from './settings.ts';

export const EXPORT_FORMAT = 'portly-export';
export const EXPORT_VERSION = 1;
/** The format of files exported before the rename to Portly: imported like {@link EXPORT_FORMAT}. */
export const LEGACY_EXPORT_FORMAT = 'homebase-export';

/** True for the `format` of an export file Portly imports (its own, or Homebase's). */
export function isExportFormat(value: unknown): boolean {
  return value === EXPORT_FORMAT || value === LEGACY_EXPORT_FORMAT;
}

/** Max import file size (multipart upload), bytes. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
/** Max size of one embedded upload / custom icon, bytes (decoded). */
export const MAX_EMBEDDED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_EXPORT_UPLOADS = 100;
export const MAX_EXPORT_CUSTOM_ICONS = MAX_BOOKMARKS;

/** base64 length that decodes to at most `bytes` bytes. */
function base64LengthFor(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

const EmbeddedImage = z
  .object({
    id: EntityId,
    contentType: ImageContentType,
    data: z.base64().max(base64LengthFor(MAX_EMBEDDED_IMAGE_BYTES)),
  })
  .strict();

export const ExportUploadSchema = EmbeddedImage.extend({ id: Uuid });
export type ExportUpload = z.output<typeof ExportUploadSchema>;

export const ExportCustomIconSchema = EmbeddedImage.extend({
  width: z.number().int().min(1).max(4096).nullable().default(null),
});
export type ExportCustomIcon = z.output<typeof ExportCustomIconSchema>;

export const ExportBookmarkGroupSchema = z
  .object({
    id: EntityId,
    name: BookmarkGroupNameSchema,
    sort: z.number().int(),
    color: HexColor.nullable(),
    collapsed: z.boolean(),
  })
  .strict();
export type ExportBookmarkGroup = z.output<typeof ExportBookmarkGroupSchema>;

export const ExportBookmarkSchema = z
  .object({
    id: EntityId,
    groupId: EntityId,
    title: BookmarkTitleSchema,
    url: SafeHttpUrl,
    sort: z.number().int(),
    iconMode: IconModeSchema,
    /** For `custom` icons: id of an entry in `customIcons`; otherwise null. */
    iconId: EntityId.nullable(),
    letterColor: HexColor.nullable(),
  })
  .strict();
export type ExportBookmark = z.output<typeof ExportBookmarkSchema>;

export const ExportDataSchema = z
  .object({
    settings: SettingsSchema,
    profiles: z.array(ProfileSchema).max(MAX_PROFILES),
    bookmarkGroups: z.array(ExportBookmarkGroupSchema).max(MAX_BOOKMARK_GROUPS),
    bookmarks: z.array(ExportBookmarkSchema).max(MAX_BOOKMARKS),
    uploads: z.array(ExportUploadSchema).max(MAX_EXPORT_UPLOADS),
    customIcons: z.array(ExportCustomIconSchema).max(MAX_EXPORT_CUSTOM_ICONS),
  })
  .strict();

export const ExportSchema = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    version: z.literal(EXPORT_VERSION),
    exportedAt: IsoDateTime,
    data: ExportDataSchema,
  })
  .strict();
export type ExportFile = z.output<typeof ExportSchema>;
export type ExportFileInput = z.input<typeof ExportSchema>;

/** `POST /api/import/preview` summary shown before committing. */
export interface ImportSummary {
  exportedAt: string;
  counts: {
    profiles: number;
    widgets: number;
    bookmarkGroups: number;
    bookmarks: number;
    uploads: number;
    customIcons: number;
  };
  /** Search engines that will be installed (name + template host) so the user can review them. */
  searchEngines: { name: string; host: string }[];
  /** Items that will not be imported. */
  dropped: {
    /** Widgets whose type this build does not know. */
    unknownWidgets: number;
    /** Human-readable notes (e.g. "2 widgets of unknown type 'stocks'"). */
    notes: string[];
  };
}

export interface ImportPreviewResponse {
  previewId: string;
  summary: ImportSummary;
}

/** `POST /api/import/commit {previewId}` */
export const ImportCommitSchema = z
  .object({
    previewId: z.string().min(1).max(200),
  })
  .strict();
export type ImportCommit = z.output<typeof ImportCommitSchema>;
