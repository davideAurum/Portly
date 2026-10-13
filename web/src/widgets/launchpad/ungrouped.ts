/**
 * "No group": bookmarks filed without a group live in an ordinary bookmark group whose id is kept in
 * `settings.bookmarks.ungroupedGroupId`. The launch pad shows it first and without a header; the
 * group is created the first time a bookmark is filed under "No group".
 */
import type { QueryClient } from '@tanstack/react-query';
import type { BookmarkGroup } from '@homebase/shared';
import { createGroup } from '../../api/bookmarks.ts';
import { qk } from '../../api/keys.ts';
import { patchSettings, useSettings } from '../../api/settings.ts';

export const UNGROUPED_NAME = 'No group';

/** The "No group" group's id, if it exists among `groups`. */
export function useUngroupedId(groups?: readonly BookmarkGroup[]): string | null {
  const id = useSettings().data?.bookmarks.ungroupedGroupId ?? null;
  return id && (!groups || groups.some((g) => g.id === id)) ? id : null;
}

/** Ungrouped bookmarks first, then the groups in their order. */
export function ungroupedFirst<G extends { id: string }>(groups: readonly G[], ungroupedId: string | null): G[] {
  const ungrouped = ungroupedId ? groups.find((g) => g.id === ungroupedId) : undefined;
  return ungrouped ? [ungrouped, ...groups.filter((g) => g !== ungrouped)] : [...groups];
}

/** The "No group" group's id, creating the group (and recording it in settings) when needed. */
export async function ensureUngroupedGroup(client: QueryClient, ungroupedId: string | null): Promise<string> {
  if (ungroupedId) return ungroupedId;
  const created = await createGroup({ name: UNGROUPED_NAME });
  client.setQueryData(qk.settings(), await patchSettings({ bookmarks: { ungroupedGroupId: created.id } }));
  await client.invalidateQueries({ queryKey: qk.bookmarks.all(), exact: true });
  return created.id;
}
