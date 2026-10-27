/**
 * Lasting tombstones for the launch pad (docs/design/launchpad-sync.md section 6.3). Every path
 * that removes groups or bookmarks records them here in the same commit, so a merge with the
 * synced file cannot bring the rows back:
 * - deleting a group (and the bookmarks that go with it), `handlers/bookmarks.ts`;
 * - deleting a bookmark, `handlers/bookmarks.ts`;
 * - a config import or a backup restore, which replace every group and bookmark,
 *   `handlers/transfer.ts`.
 * `tombstones.test.ts` lists these paths by reading the source, so a new one cannot be added
 * without a tombstone.
 *
 * Tombstones older than {@link TOMBSTONE_TTL_MS} are dropped whenever new ones are added.
 */
import { TOMBSTONE_TTL_MS, type Tombstone, type TombstoneKind } from '../slices.ts';

export interface RemovedRows {
  groups?: readonly { id: string }[];
  bookmarks?: readonly { id: string }[];
}

/**
 * `deleted` plus tombstones for `removed` at stamp `at`: one per id (the newest wins), none older
 * than {@link TOMBSTONE_TTL_MS} before `now`. Returns a new array.
 */
export function withTombstones(deleted: readonly Tombstone[], removed: RemovedRows, at: number, now: number): Tombstone[] {
  const byKey = new Map<string, Tombstone>();
  const add = (tombstone: Tombstone): void => {
    const key = `${tombstone.kind}:${tombstone.id}`;
    const existing = byKey.get(key);
    if (!existing || existing.at < tombstone.at) byKey.set(key, tombstone);
  };
  for (const tombstone of deleted) add(tombstone);
  const record = (kind: TombstoneKind, rows: readonly { id: string }[] | undefined): void => {
    for (const row of rows ?? []) add({ kind, id: row.id, at });
  };
  record('group', removed.groups);
  record('bookmark', removed.bookmarks);
  const oldest = now - TOMBSTONE_TTL_MS;
  return [...byKey.values()].filter((t) => t.at >= oldest);
}
