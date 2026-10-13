import type { BookmarkGroup } from '@homebase/shared';
import type { LaunchpadConfig } from './index.ts';

/**
 * Groups a launch pad shows: all of them in group order, or `groupIds` in the order listed there
 * (each launch pad can order its groups); unknown ids are ignored (none left → all).
 */
export function visibleGroups(groups: readonly BookmarkGroup[], config: Pick<LaunchpadConfig, 'groupIds'>): BookmarkGroup[] {
  if (config.groupIds === 'all') return [...groups];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const selected = [...new Set(config.groupIds)].flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  return selected.length > 0 || groups.length === 0 ? selected : [...groups];
}

/** How many group columns a group spans (1 unless the layout has a fixed number of columns). */
export function groupSpan(config: Pick<LaunchpadConfig, 'groupLayout' | 'groupColumns' | 'groupSpans'>, groupId: string): number {
  if (config.groupLayout !== 'columns' || config.groupColumns === 'auto') return 1;
  return Math.min(config.groupSpans[groupId] ?? 1, config.groupColumns);
}
