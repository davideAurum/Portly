/**
 * Applies the last-known theme from the persisted query cache before React mounts, so a new tab
 * paints with the user's background and colors instead of flashing the defaults. The value goes
 * through applyTheme (ThemeSchema validation, fixed variable list) like any other theme.
 *
 * The Pages build keeps one snapshot per backend (`app/providers.tsx`), so the caller names the
 * snapshot of this page load's backend ({@link firstPaintSnapshot}). The snapshot's age does not
 * matter here: a theme from last week still beats flashing the defaults, and settings re-apply.
 */
import { qk } from '../api/keys.ts';
import type { Backend } from '../capabilities.ts';
import { applyTheme } from './applyTheme.ts';

interface PersistedClient {
  buster?: unknown;
  clientState?: { queries?: { queryKey?: unknown; state?: { data?: unknown } }[] };
}

/** Which persisted snapshot to read: its localStorage key and, optionally, the buster it must carry. */
export interface PersistedSnapshotRef {
  key: string;
  /** Snapshots written under another buster are ignored. */
  buster?: string;
}

/**
 * The snapshot a page load paints its first theme from: its backend's key (`persist`, the page
 * load's persist options) and, only for the Portly server on this PC in the Pages build, the
 * buster too, so another server instance's theme is never shown. Never the restore's maxAge, and
 * no buster elsewhere: an old or previous-version theme is still the user's, not the defaults.
 */
export function firstPaintSnapshot(
  persist: { key: string; buster: string },
  backend: Backend,
  options: { pagesBuild?: boolean } = {},
): PersistedSnapshotRef {
  const pagesBuild = options.pagesBuild ?? __PORTLY_STATIC__;
  return pagesBuild && backend === 'server' ? { key: persist.key, buster: persist.buster } : { key: persist.key };
}

export function applyPersistedTheme(snapshot: string | PersistedSnapshotRef, storage: Pick<Storage, 'getItem'> | undefined = safeLocalStorage()): boolean {
  const ref: PersistedSnapshotRef = typeof snapshot === 'string' ? { key: snapshot } : snapshot;
  try {
    const raw = storage?.getItem(ref.key);
    if (!raw) return false;
    const persisted = JSON.parse(raw) as PersistedClient;
    if (ref.buster !== undefined && persisted.buster !== ref.buster) return false;
    const key = JSON.stringify(qk.settings());
    const query = persisted.clientState?.queries?.find((q) => JSON.stringify(q.queryKey) === key);
    const data = query?.state?.data;
    if (typeof data !== 'object' || data === null || !('appearance' in data)) return false;
    return applyTheme((data as { appearance: unknown }).appearance);
  } catch {
    return false;
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
