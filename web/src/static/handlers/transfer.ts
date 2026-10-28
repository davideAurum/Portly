/**
 * Config export / import of the static backend (§7 Core: `GET /api/export`,
 * `POST /api/import/preview|commit`), a port of server/src/modules/core/transfer.ts over the
 * slices and the blob store.
 *
 * Export: `{format:'portly-export', version:1, exportedAt, data:{settings, profiles,
 * bookmarkGroups, bookmarks, uploads[base64], customIcons[base64]}}`, built by an explicit
 * per-entity allowlist serializer (each entity re-validated with its export schema). Only uploads
 * whose UUID occurs in the settings/profiles JSON and custom icons referenced by custom bookmarks
 * or search engines are embedded, newest first (the background image first), within a byte budget
 * that keeps the file importable (≤ 25 MB). Never exported: the Todoist token, the pre-import
 * backups. Synthetic favicon ids (`fav:<host>`) are plain strings and travel as-is in settings;
 * bookmarks with a non-embedded custom icon are exported as `auto`.
 *
 * Import: the file is parsed (forbidden keys / deep nesting → 400), validated with the strict
 * versioned `ExportSchema` (→ 422), then planned: every id is regenerated (old UUIDs inside opaque
 * widget configs are rewritten), unknown widget types are dropped, configs over 64 KB are reset,
 * embedded images are re-sniffed, dangling references are cleared, and a summary with the
 * server's exact note strings is returned (plans live 10 minutes, at most 3). Commit snapshots the
 * current export JSON as a pre-import backup (its document under a `backup:<id>` key outside the
 * slices, a small entry in the `backups` index slice; the newest kept, see `keepBackups`), then
 * REPLACES profiles, bookmark groups, bookmarks, uploads, custom icons and every settings
 * namespace — all of it, old images deleted and new ones written included, in ONE storage
 * transaction, so a failure changes nothing. There is no favicon store: automatic bookmarks get
 * the synthetic favicon id of their host when `settings.bookmarks.autoFetchIcons` is on (never a
 * pending icon), and non-embedded search-engine icon UUIDs become null.
 *
 * Backups (static build only): `GET /api/backups` lists `{id, at, bytes}` newest first and
 * `GET /api/backups/:id` downloads that export document, which imports like any export file.
 */
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  isExportFormat,
  ExportBookmarkGroupSchema,
  ExportBookmarkSchema,
  ExportSchema,
  ImportCommitSchema,
  LayoutSchema,
  MAX_BOOKMARKS,
  MAX_BOOKMARK_GROUPS,
  MAX_EMBEDDED_IMAGE_BYTES,
  MAX_EXPORT_CUSTOM_ICONS,
  MAX_EXPORT_UPLOADS,
  MAX_IMPORT_BYTES,
  MAX_PROFILES,
  ProfileSchema,
  SettingsSchema,
  defaultThemeBackground,
  isKnownWidgetType,
  normalizeHexColor,
  urlHost,
  type ExportBookmark,
  type ExportBookmarkGroup,
  type ExportCustomIcon,
  type ExportFile,
  type ExportUpload,
  type ImageContentType,
  type ImportPreviewResponse,
  type ImportSummary,
  type Profile,
  type Settings,
} from '@portly/shared';
import type { StaticContext } from '../context.ts';
import { faviconIdFor, isFaviconId } from '../favicon.ts';
import { decodeBase64, encodeBase64 } from '../lib/base64.ts';
import { isUuid, newToken } from '../lib/ids.ts';
import { sniffImageType } from '../lib/imageSniff.ts';
import { assertSafeJson, isPlainObject, jsonByteLength } from '../lib/safeJson.ts';
import { parseJsonBody, readMultipartFile, validate } from '../lib/validate.ts';
import { json, readFormData, StaticApiError, validationIssues } from '../respond.ts';
import type { StaticRouter } from '../router.ts';
import {
  BACKUP_KEY_PREFIX,
  keepBackups,
  SLICE,
  backupKey,
  getBackups,
  getBookmarks,
  getSettings,
  getUploads,
  setSettings,
  type BackupEntry,
  type BackupReason,
  type BookmarksSlice,
  type StoredIconMeta,
  type StoredProfile,
  type StoredUploadMeta,
} from '../slices.ts';
import { blobOf, type StoredBlob } from '../storage/types.ts';
import { LAUNCHPAD_SLICES, nextStamp } from '../sync/clock.ts';
import { withTombstones } from '../sync/tombstones.ts';
import { MAX_WIDGET_CONFIG_BYTES, listProfiles } from './profiles.ts';

/** Room kept free for everything but embedded images when budgeting an export. */
const EXPORT_BUDGET_MARGIN = 1024 * 1024;
/** Max validation issues echoed back for an invalid import file. */
const MAX_REPORTED_ISSUES = 50;

const UTF8 = new TextDecoder('utf-8', { fatal: false });

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `YYYY-MM-DD` in local time (the export file name). */
export function localDateStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Builds the export file (see module docs); 500 when the result fails `ExportSchema`. */
export async function buildExport(ctx: StaticContext): Promise<ExportFile> {
  const exportedAt = new Date(ctx.now()).toISOString();
  const settings = structuredClone(getSettings(ctx));

  const profiles: Profile[] = [];
  for (const p of listProfiles(ctx).slice(0, MAX_PROFILES)) {
    const candidate = {
      id: p.id,
      name: p.name,
      sort: p.sort,
      layout: {
        version: 1 as const,
        items: p.layout.items.map((i) => ({ id: i.id, type: i.type, x: i.x, y: i.y, w: i.w, h: i.h, config: i.config, frame: i.frame })),
      },
    };
    const parsed = ProfileSchema.safeParse(candidate);
    if (parsed.success) profiles.push(parsed.data);
  }

  const store = getBookmarks(ctx);
  const groups: ExportBookmarkGroup[] = [];
  for (const g of [...store.groups].sort((a, b) => a.sort - b.sort || compareStrings(a.id, b.id))) {
    if (groups.length >= MAX_BOOKMARK_GROUPS) break;
    const parsed = ExportBookmarkGroupSchema.safeParse({
      id: g.id,
      name: g.name,
      sort: Number(g.sort),
      color: normalizeHexColor(g.color),
      collapsed: Boolean(g.collapsed),
    });
    if (parsed.success) groups.push(parsed.data);
  }
  const groupIds = new Set(groups.map((g) => g.id));

  const bookmarks: ExportBookmark[] = [];
  const orderedBookmarks = [...store.bookmarks].sort(
    (a, b) => compareStrings(a.groupId, b.groupId) || a.sort - b.sort || compareStrings(a.id, b.id),
  );
  for (const b of orderedBookmarks) {
    if (bookmarks.length >= MAX_BOOKMARKS) break;
    if (!groupIds.has(b.groupId)) continue;
    const custom = b.iconMode === 'custom' && typeof b.iconId === 'string';
    const parsed = ExportBookmarkSchema.safeParse({
      id: b.id,
      groupId: b.groupId,
      title: b.title,
      url: b.url,
      sort: Number(b.sort),
      iconMode: custom ? 'custom' : b.iconMode === 'custom' ? 'auto' : b.iconMode,
      iconId: custom ? b.iconId : null,
      letterColor: normalizeHexColor(b.letterColor),
    });
    if (parsed.success) bookmarks.push(parsed.data);
  }

  // Embedded images, within a budget that keeps the whole file importable.
  let budget = MAX_IMPORT_BYTES - EXPORT_BUDGET_MARGIN - jsonByteLength({ settings, profiles, groups, bookmarks });
  const embed = (blob: StoredBlob | undefined): { contentType: ImageContentType; data: string } | null => {
    if (!blob) return null;
    const contentType = sniffImageType(blob.bytes);
    const size = base64Length(blob.bytes.length);
    if (!contentType || blob.bytes.length > MAX_EMBEDDED_IMAGE_BYTES || size > budget) return null;
    budget -= size + 128;
    return { contentType, data: encodeBase64(blob.bytes) };
  };

  const uploads: ExportUpload[] = [];
  const references = JSON.stringify(settings) + JSON.stringify(profiles);
  const background = settings.appearance.background.type === 'image' ? settings.appearance.background.uploadId : null;
  const uploadIds = [...getUploads(ctx)]
    .sort((a, b) => b.createdAt - a.createdAt || compareStrings(a.id, b.id))
    .map((u) => u.id)
    .filter((id) => isUuid(id) && references.includes(id))
    .sort((a, b) => (a === background ? -1 : b === background ? 1 : 0));
  for (const id of uploadIds) {
    if (uploads.length >= MAX_EXPORT_UPLOADS) break;
    const blob = await ctx.state.getBlob(id);
    const image = embed(blob?.kind === 'upload' ? blob : undefined);
    if (image) uploads.push({ id, ...image });
  }

  const customIcons: ExportCustomIcon[] = [];
  const iconIds = new Set<string>();
  for (const b of bookmarks) if (b.iconMode === 'custom' && b.iconId) iconIds.add(b.iconId);
  for (const e of settings.search.engines) if (e.iconId) iconIds.add(e.iconId);
  for (const id of iconIds) {
    if (customIcons.length >= MAX_EXPORT_CUSTOM_ICONS) break;
    const blob = await ctx.state.getBlob(id);
    const row = blob?.kind === 'icon' ? blob : undefined;
    const image = embed(row);
    if (!image) continue;
    const width = typeof row?.width === 'number' && Number.isInteger(row.width) && row.width >= 1 && row.width <= 4096 ? row.width : null;
    customIcons.push({ id, ...image, width });
  }
  const exportedIcons = new Set(customIcons.map((i) => i.id));
  for (const b of bookmarks) {
    if (b.iconMode === 'custom' && (!b.iconId || !exportedIcons.has(b.iconId))) {
      b.iconMode = 'auto';
      b.iconId = null;
    }
  }

  const file: ExportFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt,
    data: { settings, profiles, bookmarkGroups: groups, bookmarks, uploads, customIcons },
  };
  const check = ExportSchema.safeParse(file);
  if (!check.success) throw new StaticApiError('internal', 'Could not build the export file');
  return file;
}

// ---------------------------------------------------------------------------
// Import: parse + plan
// ---------------------------------------------------------------------------

export interface PlannedImage {
  id: string;
  contentType: ImageContentType;
  bytes: Uint8Array;
}

export interface ImportPlan {
  settings: Settings;
  profiles: Profile[];
  groups: ExportBookmarkGroup[];
  bookmarks: ExportBookmark[];
  uploads: PlannedImage[];
  customIcons: (PlannedImage & { width: number | null })[];
  /**
   * Search-engine icon UUIDs that are not embedded in the file (the server's fetched favicons).
   * The browser-only build has no favicon store, so they become null at commit.
   */
  engineIconRefs: string[];
  summary: ImportSummary;
}

/** Parses and validates an uploaded export file (400 for unsafe/malformed JSON, 422 for schema failures). */
export function parseImportFile(bytes: Uint8Array): ExportFile {
  let text = UTF8.decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new StaticApiError('bad_request', 'The file is not valid JSON');
  }
  assertSafeJson(raw, 'The import file');
  if (!isPlainObject(raw) || !isExportFormat(raw.format)) {
    throw new StaticApiError('validation_failed', 'This is not a Portly export file');
  }
  if (raw.version !== EXPORT_VERSION) {
    throw new StaticApiError('validation_failed', `Unsupported export version (expected ${EXPORT_VERSION})`);
  }
  // A file exported before the rename (`homebase-export`) has the same content.
  const result = ExportSchema.safeParse({ ...raw, format: EXPORT_FORMAT });
  if (!result.success) {
    throw new StaticApiError('validation_failed', 'The import file is invalid', validationIssues(result.error).slice(0, MAX_REPORTED_ISSUES));
  }
  return result.data;
}

function decodeImage(data: string): { contentType: ImageContentType; bytes: Uint8Array } | null {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(data);
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_EMBEDDED_IMAGE_BYTES) return null;
  const contentType = sniffImageType(bytes);
  return contentType ? { contentType, bytes } : null;
}

/** Deep copy of `value` with every string equal to an old id replaced by its new id. */
function remapStrings(value: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => remapStrings(v, map));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = remapStrings(value[key], map);
    return out;
  }
  return value;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Turns a validated export file into an import plan with fresh ids (from `newId`) and a summary. */
export function planImport(file: ExportFile, newId: () => string): ImportPlan {
  const data = file.data;
  const notes: string[] = [];
  // Old UUIDs → new ids, used to rewrite references inside opaque widget configs. Only UUIDs are
  // rewritten, so short ids in a hand-made file cannot clobber unrelated config strings.
  const uuidMap = new Map<string, string>();
  const remember = (oldId: string, id: string): void => {
    if (isUuid(oldId)) uuidMap.set(oldId, id);
  };

  let droppedImages = 0;
  const uploads: PlannedImage[] = [];
  const uploadMap = new Map<string, string>();
  for (const u of data.uploads) {
    const decoded = uploadMap.has(u.id) ? null : decodeImage(u.data);
    if (!decoded) {
      droppedImages++;
      continue;
    }
    const id = newId();
    uploadMap.set(u.id, id);
    remember(u.id, id);
    uploads.push({ id, ...decoded });
  }

  const customIcons: ImportPlan['customIcons'] = [];
  const iconMap = new Map<string, string>();
  for (const icon of data.customIcons) {
    const decoded = iconMap.has(icon.id) ? null : decodeImage(icon.data);
    if (!decoded) {
      droppedImages++;
      continue;
    }
    const id = newId();
    iconMap.set(icon.id, id);
    remember(icon.id, id);
    customIcons.push({ id, ...decoded, width: icon.width });
  }
  if (droppedImages > 0) notes.push(`${plural(droppedImages, 'image')} skipped (not a supported image, too large or duplicated)`);

  const groups: ExportBookmarkGroup[] = [];
  const groupMap = new Map<string, string>();
  let duplicateGroups = 0;
  for (const g of data.bookmarkGroups) {
    if (groupMap.has(g.id)) {
      duplicateGroups++;
      continue;
    }
    const id = newId();
    groupMap.set(g.id, id);
    remember(g.id, id);
    groups.push({ ...g, id });
  }
  if (duplicateGroups > 0) notes.push(`${plural(duplicateGroups, 'bookmark group')} with a duplicate id skipped`);

  const bookmarks: ExportBookmark[] = [];
  let orphans = 0;
  let lostIcons = 0;
  for (const b of data.bookmarks) {
    const groupId = groupMap.get(b.groupId);
    if (!groupId) {
      orphans++;
      continue;
    }
    let iconMode = b.iconMode;
    let iconId: string | null = null;
    if (iconMode === 'custom') {
      iconId = b.iconId ? (iconMap.get(b.iconId) ?? null) : null;
      if (!iconId) {
        iconMode = 'auto';
        lostIcons++;
      }
    }
    const id = newId();
    remember(b.id, id);
    bookmarks.push({ ...b, id, groupId, iconMode, iconId });
  }
  if (orphans > 0) notes.push(`${plural(orphans, 'bookmark')} without a group skipped`);
  if (lostIcons > 0) notes.push(`${plural(lostIcons, 'custom bookmark icon')} missing; fetched icons will be used`);

  // Profiles: assign ids first so configs can reference any of them.
  const profileMap = new Map<string, string>();
  const sourceProfiles = data.profiles.filter((p) => {
    if (profileMap.has(p.id)) return false;
    const id = newId();
    profileMap.set(p.id, id);
    remember(p.id, id);
    return true;
  });
  if (sourceProfiles.length < data.profiles.length) {
    notes.push(`${plural(data.profiles.length - sourceProfiles.length, 'profile')} with a duplicate id skipped`);
  }
  const unknownTypes = new Map<string, number>();
  let oversizeConfigs = 0;
  const importConfig = (config: unknown): unknown => {
    const remapped = remapStrings(config, uuidMap);
    // Same cap as the widget routes: an imported layout must not smuggle in megabytes of opaque
    // JSON that every `GET /api/profiles` would then serve. The widget falls back to its defaults.
    if (jsonByteLength(remapped) <= MAX_WIDGET_CONFIG_BYTES) return remapped;
    oversizeConfigs++;
    return {};
  };
  const profiles: Profile[] = sourceProfiles.map((p) => {
    const items = p.layout.items.filter((item) => {
      if (isKnownWidgetType(item.type)) return true;
      unknownTypes.set(item.type, (unknownTypes.get(item.type) ?? 0) + 1);
      return false;
    });
    const layout = validate(
      LayoutSchema,
      { version: 1, items: items.map((item) => ({ ...item, id: newId(), config: importConfig(item.config) })) },
      'imported layout',
    );
    return { id: profileMap.get(p.id) ?? newId(), name: p.name, sort: p.sort, layout };
  });
  if (oversizeConfigs > 0) {
    notes.push(`${plural(oversizeConfigs, 'widget')} with oversized settings will use default settings`);
  }
  let unknownWidgets = 0;
  for (const [type, count] of [...unknownTypes.entries()].sort()) {
    unknownWidgets += count;
    notes.push(`${plural(count, 'widget')} of unknown type "${type}" skipped`);
  }

  // Settings: explicit reference fix-ups.
  const next = structuredClone(data.settings);
  const firstProfile = [...profiles].sort((a, b) => a.sort - b.sort)[0]?.id ?? null;
  next.activeProfileId = (next.activeProfileId ? profileMap.get(next.activeProfileId) : undefined) ?? firstProfile;
  next.bookmarks.defaultGroupId = next.bookmarks.defaultGroupId ? (groupMap.get(next.bookmarks.defaultGroupId) ?? null) : null;
  next.bookmarks.ungroupedGroupId = next.bookmarks.ungroupedGroupId ? (groupMap.get(next.bookmarks.ungroupedGroupId) ?? null) : null;
  if (next.appearance.background.type === 'image') {
    const uploadId = uploadMap.get(next.appearance.background.uploadId);
    if (uploadId) next.appearance.background = { ...next.appearance.background, uploadId };
    else {
      next.appearance.background = defaultThemeBackground();
      notes.push('The background image was not included; the default background will be used');
    }
  }
  const engineIconRefs: string[] = [];
  next.search.engines = next.search.engines.map((e) => {
    if (!e.iconId) return { ...e, iconId: null };
    const embedded = iconMap.get(e.iconId);
    if (embedded) return { ...e, iconId: embedded };
    // Synthetic favicon ids need no stored image: they resolve to the icon service anywhere.
    if (isFaviconId(e.iconId)) return e;
    if (!isUuid(e.iconId)) return { ...e, iconId: null };
    engineIconRefs.push(e.iconId);
    return e;
  });
  const settings = validate(SettingsSchema, next, 'imported settings');

  const summary: ImportSummary = {
    exportedAt: file.exportedAt,
    counts: {
      profiles: profiles.length,
      widgets: profiles.reduce((n, p) => n + p.layout.items.length, 0),
      bookmarkGroups: groups.length,
      bookmarks: bookmarks.length,
      uploads: uploads.length,
      customIcons: customIcons.length,
    },
    searchEngines: settings.search.engines.map((e) => ({ name: e.name, host: urlHost(e.urlTemplate.split('%s').join('x')) ?? '' })),
    dropped: { unknownWidgets, notes },
  };
  return { settings, profiles, groups, bookmarks, uploads, customIcons, engineIconRefs, summary };
}

// ---------------------------------------------------------------------------
// Import: previews and commit
// ---------------------------------------------------------------------------

export const PREVIEW_TTL_MS = 10 * 60 * 1000;
/** Plans are held in memory; at most this many at once (oldest evicted). */
export const MAX_PREVIEWS = 3;

export interface PreviewStore {
  add(plan: ImportPlan): string;
  get(id: string): ImportPlan | null;
  delete(id: string): void;
  readonly size: number;
}

export function createPreviewStore(options: { now?: () => number; ttlMs?: number; max?: number } = {}): PreviewStore {
  const now = options.now ?? (() => Date.now());
  const ttl = options.ttlMs ?? PREVIEW_TTL_MS;
  const max = options.max ?? MAX_PREVIEWS;
  const entries = new Map<string, { plan: ImportPlan; expiresAt: number }>();
  const purge = (): void => {
    const t = now();
    for (const [id, e] of entries) if (e.expiresAt <= t) entries.delete(id);
  };
  return {
    add(plan) {
      purge();
      while (entries.size >= max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      const id = newToken(24);
      entries.set(id, { plan, expiresAt: now() + ttl });
      return id;
    },
    get(id) {
      purge();
      return entries.get(id)?.plan ?? null;
    },
    delete(id) {
      entries.delete(id);
    },
    get size() {
      purge();
      return entries.size;
    },
  };
}

/** One preview store per backend instance (its clock is the context's). */
const previewStores = new WeakMap<StaticContext, PreviewStore>();

export function previewsFor(ctx: StaticContext): PreviewStore {
  let store = previewStores.get(ctx);
  if (!store) {
    store = createPreviewStore({ now: () => ctx.now() });
    previewStores.set(ctx, store);
  }
  return store;
}

/**
 * Backs up the current export JSON, then replaces settings, profiles, bookmark groups/bookmarks,
 * uploads and custom icons (see module docs). The backup document, the six slices, the deletion
 * of every old image and the new images are ONE storage transaction: when it fails, storage is
 * untouched and `commitWith` has put the slices back in memory, so nothing changed. Object URLs
 * are swapped only after it succeeded.
 */
/** A backup to commit: the backups index after it, and the documents to write (the new one) and delete (evicted ones). */
export interface PreparedBackup {
  entries: BackupEntry[];
  documents: Map<string, unknown>;
}

/**
 * Takes the current export JSON as a backup before an import (`reason: 'import'`) or a sync
 * (`'sync'`) replaces data, and works out which older backups go (`keepBackups`: three import
 * backups and one sync backup). Nothing is written: commit `SLICE.backups` with `entries` set and
 * `documents` as extra JSON, in the same transaction as the change. Throws when the export fails.
 */
export async function prepareBackup(ctx: StaticContext, reason: BackupReason): Promise<PreparedBackup> {
  const snapshot = JSON.stringify(await buildExport(ctx));
  const backup: BackupEntry = { id: newToken(16), at: ctx.now(), bytes: snapshot.length, reason };
  const { kept: entries, evicted } = keepBackups([backup, ...getBackups(ctx).entries]);
  const documents = new Map<string, unknown>([[backupKey(backup.id), snapshot], ...evicted.map((e): [string, undefined] => [backupKey(e.id), undefined])]);
  return { entries, documents };
}

export async function commitImport(ctx: StaticContext, plan: ImportPlan): Promise<void> {
  const ts = ctx.now();

  let backup: PreparedBackup;
  try {
    backup = await prepareBackup(ctx, 'import');
  } catch {
    throw new StaticApiError('internal', 'Could not back up the current data; nothing was imported');
  }
  // The launch pad's rows are stamped by its clock; every old row gets a tombstone, so with sync on
  // the import replaces the launch pad in every synced browser (design section 6.7).
  const stamp = nextStamp(ctx);
  const old = getBookmarks(ctx);

  // Everything new is computed before anything is touched.
  const refs = new Set(plan.engineIconRefs);
  const engines = plan.settings.search.engines.map((e) => (e.iconId && refs.has(e.iconId) ? { ...e, iconId: null } : e));
  const settings = validate(SettingsSchema, { ...plan.settings, search: { ...plan.settings.search, engines } }, 'settings');
  const autoIcons = settings.bookmarks.autoFetchIcons;
  const profiles: StoredProfile[] = plan.profiles.map((p) => ({ id: p.id, name: p.name, sort: p.sort, layout: p.layout, createdAt: ts, updatedAt: ts }));
  const bookmarks: BookmarksSlice = {
    groups: plan.groups.map((g) => ({
      id: g.id,
      name: g.name,
      sort: g.sort,
      color: g.color,
      collapsed: g.collapsed,
      createdAt: ts,
      updatedAt: stamp,
      placedAt: stamp,
    })),
    bookmarks: plan.bookmarks.map((b) => ({
      id: b.id,
      groupId: b.groupId,
      title: b.title,
      url: b.url,
      sort: b.sort,
      iconMode: b.iconMode,
      iconId: b.iconMode === 'auto' ? (autoIcons ? faviconIdFor(b.url) : null) : b.iconId,
      letterColor: b.letterColor,
      createdAt: ts,
      updatedAt: stamp,
      placedAt: stamp,
    })),
    deleted: withTombstones(old.deleted, { groups: old.groups, bookmarks: old.bookmarks }, stamp, ts),
  };
  const uploads: StoredUploadMeta[] = plan.uploads.map((u) => ({ id: u.id, type: u.contentType, createdAt: ts }));
  const icons: StoredIconMeta[] = plan.customIcons.map((i) => ({ id: i.id, type: i.contentType, width: i.width, createdAt: ts, orphanedAt: null }));

  // Images: every old upload and custom icon goes, the planned ones (fresh ids) come in.
  const fresh = new Set([...plan.uploads, ...plan.customIcons].map((i) => i.id));
  const previous = (await ctx.state.listBlobIds()).filter((id) => !fresh.has(id));
  const putBlobs: StoredBlob[] = [
    ...plan.uploads.map((u): StoredBlob => ({ id: u.id, kind: 'upload', type: u.contentType, bytes: u.bytes, width: null, createdAt: ts })),
    ...plan.customIcons.map((i): StoredBlob => ({ id: i.id, kind: 'icon', type: i.contentType, bytes: i.bytes, width: i.width, createdAt: ts })),
  ];

  // No await between replacing the slices in memory and the commit, which snapshots them.
  // The backup: its document outside the slices (never loaded at startup), an entry in the index.
  ctx.state.set(SLICE.backups, { entries: backup.entries });
  ctx.state.set(SLICE.profiles, profiles);
  ctx.state.set(SLICE.bookmarks, bookmarks);
  ctx.state.set(SLICE.uploads, uploads);
  ctx.state.set(SLICE.icons, icons);
  setSettings(ctx, settings);
  await ctx.state.commitWith([SLICE.backups, SLICE.profiles, ...LAUNCHPAD_SLICES, SLICE.uploads, SLICE.icons, SLICE.settings], {
    json: backup.documents,
    deleteBlobs: previous,
    putBlobs,
  });

  for (const id of previous) {
    ctx.assets.revoke('uploads', id);
    ctx.assets.revoke('icons', id);
  }
  for (const u of plan.uploads) ctx.assets.registerBlob('uploads', u.id, blobOf({ bytes: u.bytes, type: u.contentType }));
  for (const i of plan.customIcons) ctx.assets.registerBlob('icons', i.id, blobOf({ bytes: i.bytes, type: i.contentType }));
}

// ---------------------------------------------------------------------------
// Pre-import backups
// ---------------------------------------------------------------------------

/** What `GET /api/backups` lists (newest first). */
export interface BackupInfo {
  id: string;
  /** ISO timestamp of the import or sync that replaced the data. */
  at: string;
  /** Size of the export document (characters). */
  bytes: number;
  /** What it was taken before: an import, or a launch pad sync that replaced or removed a lot. */
  reason: 'import' | 'sync';
}

/** The stored export document of a backup, or null. */
export async function readBackup(ctx: StaticContext, id: string): Promise<{ entry: BackupEntry; json: string } | null> {
  const entry = getBackups(ctx).entries.find((e) => e.id === id);
  if (!entry) return null;
  const json = await ctx.state.storage.getJson(backupKey(entry.id));
  return typeof json === 'string' ? { entry, json } : null;
}

/**
 * Startup: keeps the backup index and the stored documents in step — index entries whose
 * document is missing and documents no entry names (e.g. left by an interrupted write) are
 * dropped, and an index of an older shape is rewritten.
 */
export async function ready(ctx: StaticContext): Promise<void> {
  const keys = new Set(await ctx.state.storage.listJsonKeys());
  const stored = ctx.state.has(SLICE.backups) ? ctx.state.get<unknown>(SLICE.backups, () => undefined) : undefined;
  const index = getBackups(ctx);
  const entries = keepBackups(index.entries.filter((e) => keys.has(backupKey(e.id)))).kept;
  const live = new Set(entries.map((e) => backupKey(e.id)));
  const stray = [...keys].filter((key) => key.startsWith(BACKUP_KEY_PREFIX) && !live.has(key));
  const rewrite = stored !== undefined && (stored !== index || entries.length !== index.entries.length);
  if (!rewrite && stray.length === 0) return;
  if (rewrite) ctx.state.set(SLICE.backups, { entries });
  await ctx.state.commitWith(rewrite ? [SLICE.backups] : [], { json: new Map(stray.map((key): [string, undefined] => [key, undefined])) });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function register(router: StaticRouter): void {
  router.get('/api/export', async (ctx) => {
    const file = await buildExport(ctx);
    const res = json(file);
    res.headers.set('content-disposition', `attachment; filename="portly-export-${localDateStamp(new Date(ctx.now()))}.json"`);
    return res;
  });

  router.post('/api/import/preview', async (ctx, { req }) => {
    const { bytes } = await readMultipartFile(await readFormData(req), undefined, MAX_IMPORT_BYTES);
    const plan = planImport(parseImportFile(bytes), ctx.newId);
    const body: ImportPreviewResponse = { previewId: previewsFor(ctx).add(plan), summary: plan.summary };
    return json(body);
  });

  router.post('/api/import/commit', async (ctx, { req }) => {
    const { previewId } = await parseJsonBody(req, ImportCommitSchema);
    const previews = previewsFor(ctx);
    const plan = previews.get(previewId);
    if (!plan) throw new StaticApiError('not_found', 'Import preview not found or expired; upload the file again');
    await commitImport(ctx, plan);
    previews.delete(previewId);
    return json({ ok: true, summary: plan.summary });
  });

  router.get('/api/backups', (ctx) => {
    const list: BackupInfo[] = getBackups(ctx).entries.map((e) => ({ id: e.id, at: new Date(e.at).toISOString(), bytes: e.bytes, reason: e.reason ?? 'import' }));
    return json(list);
  });

  router.get('/api/backups/:id', async (ctx, { params }) => {
    const backup = await readBackup(ctx, params.id ?? '');
    if (!backup) throw new StaticApiError('not_found', 'Backup not found');
    return new Response(backup.json, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="portly-backup-${localDateStamp(new Date(backup.entry.at))}.json"`,
      },
    });
  });
}
