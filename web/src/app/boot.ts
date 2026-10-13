/**
 * Work done before the first render so a new tab paints last-known content in its first frame
 * (§10.1): restore the persisted query cache (this page load's backend snapshot), then load the
 * code of the active profile's widgets (capped, from the HTTP cache) so their lazy components
 * render without suspending.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Profile, Settings } from '@portly/shared';
import { qk } from '../api/keys.ts';
import { pickActiveProfile } from '../api/profiles.ts';
import { createDefaultLayout } from '../grid/defaultLayout.ts';
import { preloadWidgets, WIDGET_PRELOAD_CAP_MS } from '../widgets/registry.ts';
import { restorePersistedCache, type QueryPersistOptions } from './providers.tsx';

/** Widget types the dashboard will render first: the active profile's, else the default layout's. */
export function initialWidgetTypes(client: QueryClient): string[] {
  const profiles = client.getQueryData<Profile[]>(qk.profiles()) ?? [];
  const settings = client.getQueryData<Settings>(qk.settings());
  const active = pickActiveProfile(profiles, settings?.activeProfileId ?? null);
  return (active?.layout ?? createDefaultLayout()).items.map((item) => item.type);
}

/**
 * Restores `persist` (default: the client's, see `persistOptionsOf`) into `client` and preloads the
 * first widgets' code, waiting at most `capMs` for it.
 */
export async function prepareFirstRender(client: QueryClient, persist?: QueryPersistOptions, capMs: number = WIDGET_PRELOAD_CAP_MS): Promise<void> {
  await restorePersistedCache(client, persist);
  await preloadWidgets(initialWidgetTypes(client), capMs);
}
