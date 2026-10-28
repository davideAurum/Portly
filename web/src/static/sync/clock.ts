/**
 * The launch pad clock (docs/design/launchpad-sync.md section 6.1): a hybrid logical clock that
 * stamps every change to the launch pad's groups and bookmarks. A stamp is
 * `max(Date.now(), last + 1)`, and `last` is raised to the highest stamp of the synced file after
 * every merge, so a change made after seeing another PC's change always wins over it, however
 * wrong either PC's clock is. Wall-clock time only decides between edits made without seeing each
 * other.
 *
 * The clock lives in the `launchpad-sync` slice: a handler that stamps commits that slice with the
 * bookmarks (see {@link LAUNCHPAD_SLICES}).
 */
import type { StaticContext } from '../context.ts';
import { SLICE, getBookmarks, getLaunchpadSync } from '../slices.ts';

/** The slices a launch pad change commits together: the rows and the clock that stamped them. */
export const LAUNCHPAD_SLICES = Object.freeze([SLICE.bookmarks, SLICE.launchpadSync]);

/** The highest stamp in the stored launch pad: where a lost or new clock starts from. */
function highestStoredStamp(ctx: StaticContext): number {
  const slice = getBookmarks(ctx);
  let highest = 0;
  for (const row of [...slice.groups, ...slice.bookmarks]) highest = Math.max(highest, row.updatedAt, row.placedAt);
  for (const tombstone of slice.deleted) highest = Math.max(highest, tombstone.at);
  return highest;
}

/** The next stamp, always above every stamp this browser gave out or saw. Commit {@link LAUNCHPAD_SLICES}. */
export function nextStamp(ctx: StaticContext): number {
  const state = getLaunchpadSync(ctx);
  const last = state.clock > 0 ? state.clock : highestStoredStamp(ctx);
  const stamp = Math.max(Math.floor(ctx.now()), last + 1);
  state.clock = stamp;
  return stamp;
}

/** Raises the clock to `stamp` (a merged file's highest), so later local stamps come after it. */
export function observeStamp(ctx: StaticContext, stamp: number): void {
  const state = getLaunchpadSync(ctx);
  if (Number.isFinite(stamp) && stamp > state.clock) state.clock = Math.floor(stamp);
}
