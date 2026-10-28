/**
 * Launch pad sync: the synced file's format and the merge (docs/design/launchpad-sync.md sections
 * 6 and 8). Pure: no storage, no network, no clock (callers pass `now`), so any backend can use it
 * (the browser-only site today, the Portly server perhaps later) and any sync store can carry it.
 *
 * The file holds the whole launch pad. Every row has two last-writer-wins parts, each with its own
 * stamp from the launch pad clock: the content (`updatedAt`) and the placement (`placedAt`). A
 * tombstone (`deleted`) removes a row whose two stamps are both at or before it. A removed row's
 * last content stays in the file next to its tombstone until the tombstone expires
 * ({@link pruneLaunchpad}), so the merge is a join: commutative, associative and idempotent, and
 * every browser gets the same result whatever order they sync in.
 *
 * Equal stamps are settled by comparing the two versions' canonical JSON (the larger wins), so no
 * device id is needed. The merge never renumbers `sort`, never creates rows and never repairs
 * references: a bookmark whose group is gone, or a custom icon that is not listed, is placed or
 * shown by the browser that applies the file ({@link liveLaunchpad} only says what is alive).
 */
import { z } from 'zod';
import { EntityId, ImageContentType } from './core.ts';
import { MAX_BOOKMARKS, MAX_BOOKMARK_GROUPS } from './bookmarks.ts';
import { ExportBookmarkGroupSchema, ExportBookmarkSchema } from './export.ts';

export const SYNC_FILE_FORMAT = 'portly-sync';
export const SYNC_FILE_VERSION = 1;

/** How long a tombstone (and the removed row's content) is kept in the file. */
export const SYNC_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** No stamp is older than this (2020-01-01): an older one is not from Portly's clock. */
export const SYNC_STAMP_MIN = Date.UTC(2020, 0, 1);
/** A stamp further ahead of this PC's clock than this fails validation. */
export const SYNC_STAMP_MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
/** Rows in the file, removed ones included (a whole launch pad replaced twice within 90 days fits). */
export const MAX_SYNC_GROUPS = MAX_BOOKMARK_GROUPS * 4;
export const MAX_SYNC_BOOKMARKS = MAX_BOOKMARKS * 4;
export const MAX_SYNC_TOMBSTONES = MAX_SYNC_BOOKMARKS + MAX_SYNC_GROUPS;
export const MAX_SYNC_ICONS = MAX_BOOKMARKS;

/** A launch pad clock stamp (epoch ms). Its upper bound depends on the reader's clock ({@link syncStampProblem}). */
export const SyncStamp = z.number().int().min(SYNC_STAMP_MIN).max(Number.MAX_SAFE_INTEGER);
/** A stamp, or 0 for "never" (a pointer nobody set, a file that never dropped a tombstone). */
const StampOrZero = z.union([z.literal(0), SyncStamp]);

/** A file generation: rewritten when a browser replaces the synced launch pad with its own. */
export const SyncEpochSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A custom icon id: a lower-case UUIDv4, the only string from the file that goes into a storage path. */
export const SyncIconId = z.string().regex(UUID_V4);

export const SyncGroupSchema = ExportBookmarkGroupSchema.extend({ updatedAt: SyncStamp, placedAt: SyncStamp }).strict();
export type SyncGroup = z.output<typeof SyncGroupSchema>;

/** A bookmark. `iconId` is set only for a `custom` icon (one of the file's `icons`); automatic icons are never synced. */
export const SyncBookmarkSchema = ExportBookmarkSchema.extend({ updatedAt: SyncStamp, placedAt: SyncStamp })
  .strict()
  .refine((b) => b.iconMode === 'custom' || b.iconId === null, { message: 'Only a custom icon has an id', path: ['iconId'] });
export type SyncBookmark = z.output<typeof SyncBookmarkSchema>;

export const SYNC_TOMBSTONE_KINDS = ['group', 'bookmark'] as const;
export const SyncTombstoneSchema = z.object({ kind: z.enum(SYNC_TOMBSTONE_KINDS), id: EntityId, at: SyncStamp }).strict();
export type SyncTombstone = z.output<typeof SyncTombstoneSchema>;

/** A custom icon: its bytes are a separate file named after `id`, checked against `sha256` (lower-case hex). */
export const SyncIconSchema = z
  .object({
    id: SyncIconId,
    contentType: ImageContentType,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    width: z.number().int().min(1).max(4096).nullable(),
  })
  .strict();
export type SyncIcon = z.output<typeof SyncIconSchema>;

/** A synced setting that names a group: its value and the stamp of its last change. */
export const SyncPointerSchema = z.object({ value: EntityId.nullable(), at: StampOrZero }).strict();
export type SyncPointer = z.output<typeof SyncPointerSchema>;

export const SyncPointersSchema = z.object({ defaultGroupId: SyncPointerSchema, ungroupedGroupId: SyncPointerSchema }).strict();
export type SyncPointers = z.output<typeof SyncPointersSchema>;
export const SYNC_POINTERS = ['defaultGroupId', 'ungroupedGroupId'] as const;

export const SyncFileSchema = z
  .object({
    format: z.literal(SYNC_FILE_FORMAT),
    version: z.literal(SYNC_FILE_VERSION),
    epoch: SyncEpochSchema,
    /** The newest tombstone dropped so far (0: none): a browser that last synced before it cannot rely on tombstones. */
    horizon: StampOrZero,
    groups: z.array(SyncGroupSchema).max(MAX_SYNC_GROUPS),
    bookmarks: z.array(SyncBookmarkSchema).max(MAX_SYNC_BOOKMARKS),
    deleted: z.array(SyncTombstoneSchema).max(MAX_SYNC_TOMBSTONES),
    icons: z.array(SyncIconSchema).max(MAX_SYNC_ICONS),
    pointers: SyncPointersSchema,
  })
  .strict();
export type SyncFile = z.output<typeof SyncFileSchema>;

/** The launch pad as the merge sees it: the file without its format header. */
export type SyncLaunchpad = Omit<SyncFile, 'format' | 'version'>;

/** Why a stamp in `doc` is unacceptable to a reader whose clock says `now`, or null. */
export function syncStampProblem(doc: SyncLaunchpad, now: number): 'stamp_ahead' | null {
  const limit = now + SYNC_STAMP_MAX_AHEAD_MS;
  const ahead = (stamp: number): boolean => stamp > limit;
  if (ahead(doc.horizon)) return 'stamp_ahead';
  for (const row of [...doc.groups, ...doc.bookmarks]) if (ahead(row.updatedAt) || ahead(row.placedAt)) return 'stamp_ahead';
  for (const tombstone of doc.deleted) if (ahead(tombstone.at)) return 'stamp_ahead';
  for (const name of SYNC_POINTERS) if (ahead(doc.pointers[name].at)) return 'stamp_ahead';
  return null;
}

/** The highest stamp in `doc`: a reader raises its launch pad clock to it after a merge. */
export function highestSyncStamp(doc: SyncLaunchpad): number {
  let highest = doc.horizon;
  for (const row of [...doc.groups, ...doc.bookmarks]) highest = Math.max(highest, row.updatedAt, row.placedAt);
  for (const tombstone of doc.deleted) highest = Math.max(highest, tombstone.at);
  for (const name of SYNC_POINTERS) highest = Math.max(highest, doc.pointers[name].at);
  return highest;
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/** JSON with object keys sorted, so equal values always give equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const GROUP_CONTENT = ['name', 'color', 'collapsed'] as const;
const GROUP_PLACEMENT = ['sort'] as const;
const BOOKMARK_CONTENT = ['title', 'url', 'iconMode', 'iconId', 'letterColor'] as const;
const BOOKMARK_PLACEMENT = ['sort', 'groupId'] as const;

function pick<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = row[key];
  return out;
}

/** The later of two versions of one part: higher stamp, then the larger canonical JSON. */
function later<T>(a: T, b: T, stampA: number, stampB: number, part: (v: T) => unknown): T {
  if (stampA !== stampB) return stampA > stampB ? a : b;
  return compareText(canonicalJson(part(a)), canonicalJson(part(b))) >= 0 ? a : b;
}

function joinRow<T extends { id: string; updatedAt: number; placedAt: number }>(
  a: T,
  b: T,
  content: readonly (keyof T)[],
  placement: readonly (keyof T)[],
): T {
  const c = later(a, b, a.updatedAt, b.updatedAt, (v) => pick(v, content));
  const p = later(a, b, a.placedAt, b.placedAt, (v) => pick(v, placement));
  return { ...c, ...pick(p, placement), placedAt: p.placedAt, updatedAt: c.updatedAt };
}

function joinRows<T extends { id: string; updatedAt: number; placedAt: number }>(
  lists: readonly (readonly T[])[],
  content: readonly (keyof T)[],
  placement: readonly (keyof T)[],
): T[] {
  const byId = new Map<string, T>();
  for (const list of lists) {
    for (const row of list) {
      const existing = byId.get(row.id);
      byId.set(row.id, existing ? joinRow(existing, row, content, placement) : row);
    }
  }
  return [...byId.values()].sort((x, y) => compareText(x.id, y.id));
}

function joinTombstones(lists: readonly (readonly SyncTombstone[])[]): SyncTombstone[] {
  const byKey = new Map<string, SyncTombstone>();
  for (const list of lists) {
    for (const tombstone of list) {
      const key = `${tombstone.kind}\u0000${tombstone.id}`;
      const existing = byKey.get(key);
      if (!existing || tombstone.at > existing.at) byKey.set(key, { kind: tombstone.kind, id: tombstone.id, at: tombstone.at });
    }
  }
  return [...byKey.values()].sort((x, y) => compareText(x.kind, y.kind) || compareText(x.id, y.id));
}

function joinIcons(lists: readonly (readonly SyncIcon[])[]): SyncIcon[] {
  const byId = new Map<string, SyncIcon>();
  for (const list of lists) {
    for (const icon of list) {
      const existing = byId.get(icon.id);
      // Icons never change, so two entries for one id only come from a damaged file: keep one, the same everywhere.
      byId.set(icon.id, existing ? later(existing, icon, 0, 0, (v) => v) : icon);
    }
  }
  return [...byId.values()].sort((x, y) => compareText(x.id, y.id));
}

function joinPointer(a: SyncPointer, b: SyncPointer): SyncPointer {
  const winner = later(a, b, a.at, b.at, (v) => v.value);
  return { value: winner.value, at: winner.at };
}

/** An empty launch pad of `epoch`: what a missing file merges as. */
export function emptyLaunchpad(epoch: string): SyncLaunchpad {
  return {
    epoch,
    horizon: 0,
    groups: [],
    bookmarks: [],
    deleted: [],
    icons: [],
    pointers: { defaultGroupId: { value: null, at: 0 }, ungroupedGroupId: { value: null, at: 0 } },
  };
}

/**
 * The merge of two launch pads: per row the later content and the later placement, the newest
 * tombstone per row, every icon, the later value of each pointer, the higher horizon. Rows,
 * tombstones and icons come out sorted by id, so equal launch pads serialize to equal text.
 *
 * Both should have the same `epoch`: a browser that sees a new epoch first forgets what the new
 * file replaced ({@link forgetUnsynced}); the result keeps the larger epoch either way.
 */
export function mergeLaunchpads(a: SyncLaunchpad, b: SyncLaunchpad): SyncLaunchpad {
  return {
    epoch: compareText(a.epoch, b.epoch) >= 0 ? a.epoch : b.epoch,
    horizon: Math.max(a.horizon, b.horizon),
    groups: joinRows([a.groups, b.groups], GROUP_CONTENT, GROUP_PLACEMENT),
    bookmarks: joinRows([a.bookmarks, b.bookmarks], BOOKMARK_CONTENT, BOOKMARK_PLACEMENT),
    deleted: joinTombstones([a.deleted, b.deleted]),
    icons: joinIcons([a.icons, b.icons]),
    pointers: {
      defaultGroupId: joinPointer(a.pointers.defaultGroupId, b.pointers.defaultGroupId),
      ungroupedGroupId: joinPointer(a.pointers.ungroupedGroupId, b.pointers.ungroupedGroupId),
    },
  };
}

/** `doc` in merged form (duplicate ids joined, everything sorted): what the merge of `doc` with itself gives. */
export function normalizeLaunchpad(doc: SyncLaunchpad): SyncLaunchpad {
  return mergeLaunchpads(doc, doc);
}

/** True when a tombstone at `at` removes a row with these stamps: both at or before it. */
export function isRemovedBy(row: { updatedAt: number; placedAt: number }, at: number | undefined): boolean {
  return at !== undefined && row.updatedAt <= at && row.placedAt <= at;
}

function tombstoneIndex(doc: SyncLaunchpad): Map<string, number> {
  return new Map(doc.deleted.map((t) => [`${t.kind}\u0000${t.id}`, t.at]));
}

/** The rows of `doc` that are alive (not removed by a tombstone). References are not repaired. */
export function liveLaunchpad(doc: SyncLaunchpad): { groups: SyncGroup[]; bookmarks: SyncBookmark[] } {
  const tombstones = tombstoneIndex(doc);
  return {
    groups: doc.groups.filter((g) => !isRemovedBy(g, tombstones.get(`group\u0000${g.id}`))),
    bookmarks: doc.bookmarks.filter((b) => !isRemovedBy(b, tombstones.get(`bookmark\u0000${b.id}`))),
  };
}

// ---------------------------------------------------------------------------
// Expiry and the horizon
// ---------------------------------------------------------------------------

/**
 * `doc` with tombstones older than {@link SYNC_TOMBSTONE_TTL_MS} dropped, together with the rows
 * they removed, and the icons no row names any more; the horizon becomes the newest dropped
 * tombstone. When the file would still hold more tombstones or rows than its caps, the oldest
 * removed rows and tombstones go first, the same way. Run by the writer before it uploads.
 */
export function pruneLaunchpad(doc: SyncLaunchpad, now: number): SyncLaunchpad {
  const tombstones = [...doc.deleted].sort((x, y) => x.at - y.at || compareText(x.kind, y.kind) || compareText(x.id, y.id));
  const cutoff = now - SYNC_TOMBSTONE_TTL_MS;
  const groupsDead = (keep: ReadonlyMap<string, number>) => doc.groups.filter((g) => isRemovedBy(g, keep.get(`group\u0000${g.id}`))).length;
  const bookmarksDead = (keep: ReadonlyMap<string, number>) => doc.bookmarks.filter((b) => isRemovedBy(b, keep.get(`bookmark\u0000${b.id}`))).length;
  const live = liveLaunchpad(doc);

  let drop = 0;
  while (drop < tombstones.length && tombstones[drop]!.at < cutoff) drop++;
  // Over a cap: drop more of the oldest until the file fits (each dropped tombstone takes its removed row along).
  const fits = (n: number): boolean => {
    const kept = new Map(tombstones.slice(n).map((t) => [`${t.kind}\u0000${t.id}`, t.at]));
    return (
      tombstones.length - n <= MAX_SYNC_TOMBSTONES &&
      live.groups.length + groupsDead(kept) <= MAX_SYNC_GROUPS &&
      live.bookmarks.length + bookmarksDead(kept) <= MAX_SYNC_BOOKMARKS
    );
  };
  if (!fits(drop)) {
    let low = drop;
    let high = tombstones.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (fits(mid)) high = mid;
      else low = mid + 1;
    }
    drop = low;
  }
  if (drop === 0) return pruneIcons(doc);

  const dropped = tombstones.slice(0, drop);
  const kept = tombstones.slice(drop);
  const droppedAt = new Map(dropped.map((t) => [`${t.kind}\u0000${t.id}`, t.at]));
  const keptKeys = new Set(kept.map((t) => `${t.kind}\u0000${t.id}`));
  const survives = (kind: string, row: SyncGroup | SyncBookmark): boolean => {
    const key = `${kind}\u0000${row.id}`;
    return keptKeys.has(key) || !isRemovedBy(row, droppedAt.get(key));
  };
  return pruneIcons({
    ...doc,
    horizon: Math.max(doc.horizon, dropped.at(-1)!.at),
    groups: doc.groups.filter((g) => survives('group', g)),
    bookmarks: doc.bookmarks.filter((b) => survives('bookmark', b)),
    deleted: [...kept].sort((x, y) => compareText(x.kind, y.kind) || compareText(x.id, y.id)),
  });
}

function pruneIcons(doc: SyncLaunchpad): SyncLaunchpad {
  const named = new Set(doc.bookmarks.filter((b) => b.iconMode === 'custom' && b.iconId !== null).map((b) => b.iconId));
  const icons = doc.icons.filter((icon) => named.has(icon.id));
  return icons.length === doc.icons.length ? doc : { ...doc, icons };
}

/**
 * This browser's launch pad without the rows it can no longer trust: used when the file's horizon
 * is past this browser's last sync (tombstones it never saw have expired) or the file has a new
 * epoch (another browser replaced the launch pad). A row the file does not know (neither a row nor
 * a tombstone) is kept only when it changed after `lastSynced` (the stamp of this browser's last
 * merge): made offline. Anything older was removed elsewhere.
 */
export function forgetUnsynced(local: SyncLaunchpad, file: SyncLaunchpad, lastSynced: number): SyncLaunchpad {
  const known = (kind: string, ids: Iterable<string>): Set<string> => new Set([...ids].map((id) => `${kind}\u0000${id}`));
  const fileKeys = new Set([
    ...known('group', file.groups.map((g) => g.id)),
    ...known('bookmark', file.bookmarks.map((b) => b.id)),
    ...file.deleted.map((t) => `${t.kind}\u0000${t.id}`),
  ]);
  const keep = (kind: string, row: SyncGroup | SyncBookmark): boolean =>
    fileKeys.has(`${kind}\u0000${row.id}`) || Math.max(row.updatedAt, row.placedAt) > lastSynced;
  return {
    ...local,
    groups: local.groups.filter((g) => keep('group', g)),
    bookmarks: local.bookmarks.filter((b) => keep('bookmark', b)),
    deleted: local.deleted.filter((t) => t.at > lastSynced || fileKeys.has(`${t.kind}\u0000${t.id}`)),
  };
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/** The file's text: canonical JSON of the normalized launch pad, so equal launch pads give equal text. */
export function serializeSyncFile(doc: SyncLaunchpad): string {
  const normal = normalizeLaunchpad(doc);
  const file: SyncFile = { format: SYNC_FILE_FORMAT, version: SYNC_FILE_VERSION, ...normal };
  return canonicalJson(file);
}
