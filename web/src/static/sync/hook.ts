/**
 * The commit hook of launch pad sync (docs/design/launchpad-sync.md section 7, "After local
 * changes"): every commit that touches the launch pad sets the lasting "changes waiting" flag in
 * the same transaction, and a change to one of the two settings that name a group
 * (`settings.bookmarks.defaultGroupId`, `ungroupedGroupId`) gets its stamp from the launch pad
 * clock there too. After the commit, the scheduler hears about it (a sync 5 s after the last such
 * commit). Commits made by sync itself (`origin: 'sync'`) are left alone.
 */
import { SYNC_POINTERS } from '@portly/shared';
import type { StaticContext } from '../context.ts';
import { SLICE, getLaunchpadSync } from '../slices.ts';
import type { CommitHook } from '../state.ts';
import { nextStamp } from './clock.ts';

/** The origin sync's own commits pass, so they never count as local changes. */
export const SYNC_ORIGIN = 'sync';

/** The two settings as they are in memory now (read raw: the hook must not replace the settings object). */
function pointerValues(ctx: StaticContext): Record<(typeof SYNC_POINTERS)[number], string | null> | null {
  const settings = ctx.state.get<unknown>(SLICE.settings, () => undefined);
  if (typeof settings !== 'object' || settings === null) return null;
  const bookmarks = (settings as { bookmarks?: unknown }).bookmarks;
  if (typeof bookmarks !== 'object' || bookmarks === null) return null;
  const read = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const b = bookmarks as Record<string, unknown>;
  return { defaultGroupId: read(b.defaultGroupId), ungroupedGroupId: read(b.ungroupedGroupId) };
}

/**
 * Stamps a synced setting whose value differs from what this browser last applied or recorded.
 * Returns whether any changed. Also used before building this browser's launch pad, for values
 * set before sync existed.
 */
export function recordPointerChanges(ctx: StaticContext): boolean {
  const values = pointerValues(ctx);
  if (!values) return false;
  const state = getLaunchpadSync(ctx);
  let changed = false;
  for (const name of SYNC_POINTERS) {
    if (values[name] === state.applied[name]) continue;
    state.applied[name] = values[name];
    state.pointers[name] = { value: values[name], at: nextStamp(ctx) };
    changed = true;
  }
  return changed;
}

/** The hook for {@link StaticState.setCommitHook}; `onLocalChange` runs after a commit that left changes waiting. */
export function launchpadCommitHook(ctx: StaticContext, onLocalChange: () => void): CommitHook {
  return (names, origin) => {
    if (origin === SYNC_ORIGIN) return { extra: [] };
    const rows = names.includes(SLICE.bookmarks);
    const pointers = names.includes(SLICE.settings) && recordPointerChanges(ctx);
    if (!rows && !pointers) return { extra: [] };
    const state = getLaunchpadSync(ctx);
    state.waiting = true;
    state.changes += 1;
    return { extra: [SLICE.launchpadSync], committed: onLocalChange };
  };
}
