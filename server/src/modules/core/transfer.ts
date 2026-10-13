/**
 * Config export / import (§7 Core: `GET /api/export`, `POST /api/import/preview|commit`).
 *
 * Export: `{format:'portly-export', version:1, exportedAt, data:{settings, profiles,
 * bookmarkGroups, bookmarks, uploads[base64], customIcons[base64]}}`, built by an explicit
 * per-entity allowlist serializer (each field copied by name, each entity re-validated with its
 * export schema). Never exported: accounts, secrets, oauth_*, the Todoist token, calendars/ICS
 * URLs, events, cache, fetched favicons. Only uploads referenced by settings or layouts and custom
 * icons referenced by bookmarks/search engines are embedded, within a byte budget that keeps the
 * file importable (≤ 25 MB).
 *
 * Import: the file is parsed (forbidden keys / deep nesting → 400), validated with the strict
 * versioned `ExportSchema` (→ 422; count caps included), then planned: every id is regenerated
 * (old UUIDs inside opaque widget configs are rewritten to the new ids), unknown widget types are
 * dropped, widget configs over the 64 KB cap are reset to defaults, embedded images are re-sniffed
 * (non-images dropped), dangling references are cleared, and a summary is returned. Commit backs up the database (`VACUUM INTO
 * backups/pre-import-<ts>.db`) and replaces the included tables in one transaction.
 */
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  ExportBookmarkGroupSchema,
  ExportBookmarkSchema,
  ExportSchema,
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
  type ImportSummary,
  type Profile,
  type Settings,
} from '@portly/shared';
import type { Db } from '../../db/open.ts';
import { toBool } from '../../db/helpers.ts';
import { HttpError, formatZodIssues } from '../../lib/errors.ts';
import { isUuid, newId, newToken } from '../../lib/ids.ts';
import { sniffImageType } from '../../lib/image-sniff.ts';
import type { Logger } from '../../lib/logger.ts';
import { assertSafeJson, isPlainObject, jsonByteLength } from '../../lib/safe-json.ts';
import type { SettingsService } from '../../lib/settings.ts';
import { validate } from '../../lib/validate.ts';
import { MAX_WIDGET_CONFIG_BYTES } from './profiles.ts';

/** Room kept free for everything but embedded images when budgeting an export. */
const EXPORT_BUDGET_MARGIN = 1024 * 1024;
/** Max validation issues echoed back for an invalid import file. */
const MAX_REPORTED_ISSUES = 50;

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportDeps {
  db: Db;
  log: Logger;
  settings: Settings;
  profiles: Profile[];
  now?: () => Date;
}

interface GroupRow {
  id: string;
  name: string;
  sort: number;
  color: string | null;
  collapsed: number;
}

interface BookmarkRow {
  id: string;
  group_id: string;
  title: string;
  url: string;
  sort: number;
  icon_mode: string;
  icon_id: string | null;
  letter_color: string | null;
}

interface ImageRow {
  id: string;
  content_type: string;
  bytes: Buffer;
  width?: number | null;
}

/** Builds the export file (see module docs). */
export function buildExport(deps: ExportDeps): ExportFile {
  const { db, log } = deps;
  const exportedAt = (deps.now ?? (() => new Date()))().toISOString();
  const settings = structuredClone(deps.settings);
  let skipped = 0;

  const profiles: Profile[] = [];
  for (const p of deps.profiles.slice(0, MAX_PROFILES)) {
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
    else skipped++;
  }

  const groups: ExportBookmarkGroup[] = [];
  for (const r of db.all<GroupRow>('SELECT id, name, sort, color, collapsed FROM bookmark_groups ORDER BY sort, id')) {
    if (groups.length >= MAX_BOOKMARK_GROUPS) break;
    const parsed = ExportBookmarkGroupSchema.safeParse({
      id: r.id,
      name: r.name,
      sort: Number(r.sort),
      color: normalizeHexColor(r.color),
      collapsed: toBool(r.collapsed),
    });
    if (parsed.success) groups.push(parsed.data);
    else skipped++;
  }
  const groupIds = new Set(groups.map((g) => g.id));

  const bookmarks: ExportBookmark[] = [];
  for (const r of db.all<BookmarkRow>(
    'SELECT id, group_id, title, url, sort, icon_mode, icon_id, letter_color FROM bookmarks ORDER BY group_id, sort, id',
  )) {
    if (bookmarks.length >= MAX_BOOKMARKS) break;
    if (!groupIds.has(r.group_id)) continue;
    const custom = r.icon_mode === 'custom' && typeof r.icon_id === 'string';
    const parsed = ExportBookmarkSchema.safeParse({
      id: r.id,
      groupId: r.group_id,
      title: r.title,
      url: r.url,
      sort: Number(r.sort),
      iconMode: custom ? 'custom' : r.icon_mode === 'custom' ? 'auto' : r.icon_mode,
      iconId: custom ? r.icon_id : null,
      letterColor: normalizeHexColor(r.letter_color),
    });
    if (parsed.success) bookmarks.push(parsed.data);
    else skipped++;
  }

  // Embedded images, within a budget that keeps the whole file importable.
  let budget = MAX_IMPORT_BYTES - EXPORT_BUDGET_MARGIN - jsonByteLength({ settings, profiles, groups, bookmarks });
  let skippedImages = 0;
  const embed = (row: ImageRow | undefined): { contentType: ImageContentType; data: string } | null => {
    if (!row) return null;
    const contentType = sniffImageType(row.bytes);
    const size = base64Length(row.bytes.length);
    if (!contentType || row.bytes.length > MAX_EMBEDDED_IMAGE_BYTES || size > budget) {
      skippedImages++;
      return null;
    }
    budget -= size + 128;
    return { contentType, data: row.bytes.toString('base64') };
  };

  const uploads: ExportUpload[] = [];
  const references = JSON.stringify(settings) + JSON.stringify(profiles);
  const background = settings.appearance.background.type === 'image' ? settings.appearance.background.uploadId : null;
  const uploadIds = db
    .all<{ id: string }>('SELECT id FROM uploads ORDER BY created_at DESC, id')
    .map((r) => r.id)
    .filter((id) => isUuid(id) && references.includes(id))
    .sort((a, b) => (a === background ? -1 : b === background ? 1 : 0));
  for (const id of uploadIds) {
    if (uploads.length >= MAX_EXPORT_UPLOADS) break;
    const image = embed(db.get<ImageRow>('SELECT id, content_type, bytes FROM uploads WHERE id = ?', [id]));
    if (image) uploads.push({ id, ...image });
  }

  const customIcons: ExportCustomIcon[] = [];
  const iconIds = new Set<string>();
  for (const b of bookmarks) if (b.iconMode === 'custom' && b.iconId) iconIds.add(b.iconId);
  for (const e of settings.search.engines) if (e.iconId) iconIds.add(e.iconId);
  for (const id of iconIds) {
    if (customIcons.length >= MAX_EXPORT_CUSTOM_ICONS) break;
    const row = db.get<ImageRow>("SELECT id, content_type, bytes, width FROM icons WHERE id = ? AND kind = 'upload'", [id]);
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
  if (!check.success) {
    log.error('export failed validation', { issues: check.error.issues.length });
    throw new HttpError(500, 'internal', 'Could not build the export file');
  }
  if (skipped > 0 || skippedImages > 0) log.warn('export skipped entries', { invalid: skipped, images: skippedImages });
  return file;
}

// ---------------------------------------------------------------------------
// Import: parse + plan
// ---------------------------------------------------------------------------

export interface PlannedImage {
  id: string;
  contentType: ImageContentType;
  bytes: Buffer;
}

export interface ImportPlan {
  settings: Settings;
  profiles: Profile[];
  groups: ExportBookmarkGroup[];
  bookmarks: ExportBookmark[];
  uploads: PlannedImage[];
  customIcons: (PlannedImage & { width: number | null })[];
  /**
   * Search-engine icon ids that are not embedded in the file (fetched favicons are never
   * exported). They are kept at commit only if that favicon still exists here (a same-machine
   * re-import); otherwise they become null and the engine icon is looked up again.
   */
  engineIconRefs: string[];
  summary: ImportSummary;
}

/** Parses and validates an uploaded export file (400 for unsafe/malformed JSON, 422 for schema failures). */
export function parseImportFile(bytes: Buffer): ExportFile {
  let text = bytes.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_request', 'The file is not valid JSON');
  }
  assertSafeJson(raw, 'The import file');
  if (!isPlainObject(raw) || raw.format !== EXPORT_FORMAT) {
    throw new HttpError(422, 'validation_failed', 'This is not a Portly export file');
  }
  if (raw.version !== EXPORT_VERSION) {
    throw new HttpError(422, 'validation_failed', `Unsupported export version (expected ${EXPORT_VERSION})`);
  }
  const result = ExportSchema.safeParse(raw);
  if (!result.success) {
    throw new HttpError(422, 'validation_failed', 'The import file is invalid', formatZodIssues(result.error).slice(0, MAX_REPORTED_ISSUES));
  }
  return result.data;
}

function decodeImage(data: string): { contentType: ImageContentType; bytes: Buffer } | null {
  const bytes = Buffer.from(data, 'base64');
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

/** Turns a validated export file into an import plan with fresh ids and a summary. */
export function planImport(file: ExportFile): ImportPlan {
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

export interface CommitDeps {
  db: Db;
  settings: SettingsService;
  now?: () => number;
}

export interface CommitResult {
  /** Automatic-icon bookmarks with no stored favicon for their host yet (the icon job fetches them). */
  missingIcons: number;
}

/**
 * Replaces settings, profiles, bookmark groups/bookmarks, uploads and custom icons in one
 * transaction. Fetched favicons are not part of an export, but the ones already stored here stay:
 * automatic-icon bookmarks are linked to their host's newest favicon right away (instead of
 * showing letter tiles until the hourly icon job), and search-engine icons that still exist are kept.
 */
export function commitImport(deps: CommitDeps, plan: ImportPlan): CommitResult {
  const { db, settings } = deps;
  const ts = (deps.now ?? Date.now)();
  let missingIcons = 0;
  try {
    db.tx(() => {
      db.run('DELETE FROM bookmarks');
      db.run('DELETE FROM bookmark_groups');
      db.run("DELETE FROM icons WHERE kind = 'upload'");
      db.run('DELETE FROM uploads');
      db.run('DELETE FROM profiles');

      for (const u of plan.uploads) {
        db.run('INSERT INTO uploads (id, content_type, bytes, created_at) VALUES (?, ?, ?, ?)', [u.id, u.contentType, u.bytes, ts]);
      }
      for (const i of plan.customIcons) {
        db.run(
          "INSERT INTO icons (id, kind, source_host, content_type, bytes, width, fetched_at) VALUES (?, 'upload', NULL, ?, ?, ?, ?)",
          [i.id, i.contentType, i.bytes, i.width, ts],
        );
      }
      for (const g of plan.groups) {
        db.run('INSERT INTO bookmark_groups (id, name, sort, color, collapsed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          g.id,
          g.name,
          g.sort,
          g.color,
          g.collapsed ? 1 : 0,
          ts,
          ts,
        ]);
      }
      const hostIcons = new Map<string, string | null>();
      const faviconFor = (url: string): string | null => {
        const host = urlHost(url)?.toLowerCase();
        if (!host) return null;
        if (!hostIcons.has(host)) {
          const row = db.get<{ id: string }>(
            "SELECT id FROM icons WHERE kind = 'favicon' AND source_host = ? ORDER BY fetched_at DESC, id LIMIT 1",
            [host],
          );
          hostIcons.set(host, row?.id ?? null);
        }
        return hostIcons.get(host) ?? null;
      };
      for (const b of plan.bookmarks) {
        let iconId = b.iconId;
        if (b.iconMode === 'auto') {
          iconId = faviconFor(b.url);
          if (iconId === null) missingIcons++;
        }
        db.run(
          `INSERT INTO bookmarks (id, group_id, title, url, sort, icon_mode, icon_id, letter_color, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [b.id, b.groupId, b.title, b.url, b.sort, b.iconMode, iconId, b.letterColor, ts, ts],
        );
      }
      for (const p of plan.profiles) {
        db.run('INSERT INTO profiles (id, name, sort, layout, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
          p.id,
          p.name,
          p.sort,
          JSON.stringify(p.layout),
          ts,
          ts,
        ]);
      }
      // Engine icons that are not embedded: keep them only while that favicon exists here.
      const refs = new Set(plan.engineIconRefs);
      const engines = plan.settings.search.engines.map((e) =>
        e.iconId && refs.has(e.iconId) && !db.get("SELECT 1 AS ok FROM icons WHERE id = ? AND kind = 'favicon'", [e.iconId]) ? { ...e, iconId: null } : e,
      );
      // Last, so a failure above never leaves the settings cache ahead of the database.
      settings.replace({ ...plan.settings, search: { ...plan.settings.search, engines } });
    });
  } catch (err) {
    settings.reload();
    throw err;
  }
  return { missingIcons };
}
