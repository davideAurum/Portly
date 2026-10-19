/**
 * First run (§10.2): when the server has no profiles, seed a "Home" profile from the default
 * layout with `POST /api/profiles {name, layout}` and make it active. If the server creates the
 * profile without the layout, the widgets are added one by one (`POST /widgets`) and placed with
 * one `PUT /positions`. Seeding runs at most once per QueryClient (i.e. per page load) and
 * re-checks the server first. Tabs opened at the same moment (e.g. a browser restoring several
 * new tabs on first run) are serialized with a Web Lock, so only the first creates "Home" and
 * the others find it when they re-check. The lock is per backend: a Pages tab on the in-browser
 * backend and one on the Portly server seed different datasets.
 *
 * First run also sets the week start and units from the browser's locale (localeDefaults.ts)
 * while they are still the schema defaults, and writes the server's answers (the new profile,
 * the resulting settings) straight into the query cache instead of refetching them.
 */
import { useEffect, useState } from 'react';
import type { QueryClient, UseQueryResult } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { newId, type Profile, type Settings, type WidgetPosition } from '@portly/shared';
import { qk } from '../api/keys.ts';
import { getCapabilities } from '../capabilities.ts';
import { activateProfile, addWidget, createProfile, fetchProfiles, savePositions } from '../api/profiles.ts';
import { fetchSettings, patchSettings } from '../api/settings.ts';
import { DEFAULT_PROFILE_NAME, createDefaultLayout } from './defaultLayout.ts';
import { firstRunGeneralPatch } from './localeDefaults.ts';

const attempted = new WeakSet<QueryClient>();

/**
 * Base of the Web Lock name shared by every tab of this origin. The static build namespaces it by
 * base path, like its database: several deployments can share one `<user>.github.io` origin.
 */
export const SEED_LOCK_NAME = __PORTLY_STATIC__ ? `portly:first-run-seed:${import.meta.env.BASE_URL}` : 'portly:first-run-seed';

/**
 * The seed lock of this page load's backend (`${SEED_LOCK_NAME}:${backend}`): a Pages tab seeding
 * its in-browser dataset never waits for one seeding the server's, and the other way round.
 */
export function seedLockName(): string {
  return `${SEED_LOCK_NAME}:${getCapabilities().backend}`;
}

/** Runs `fn` holding the cross-tab seed lock (directly where the Web Locks API is missing). */
async function withSeedLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks || typeof locks.request !== 'function') return fn();
  return locks.request(seedLockName(), fn);
}

async function freshProfiles(client: QueryClient): Promise<Profile[]> {
  return client.fetchQuery({ queryKey: qk.profiles(), queryFn: ({ signal }) => fetchProfiles(signal), staleTime: 0 });
}

/** Adds the default widgets to an (empty) profile and moves them to their default positions. */
async function addDefaultWidgets(client: QueryClient, profileId: string): Promise<void> {
  const defaults = createDefaultLayout().items;
  for (const item of defaults) await addWidget(profileId, { type: item.type, frame: item.frame });
  const profile = (await freshProfiles(client)).find((p) => p.id === profileId);
  if (!profile) return;
  // Match created instances to defaults by type, in order.
  const pool = [...profile.layout.items];
  const positions: WidgetPosition[] = [];
  for (const item of defaults) {
    const index = pool.findIndex((i) => i.type === item.type);
    if (index === -1) continue;
    const [created] = pool.splice(index, 1);
    positions.push({ id: created!.id, x: item.x, y: item.y, w: item.w, h: item.h });
  }
  if (positions.length > 0) await savePositions(profileId, positions);
}

/** Creates and activates the Home profile unless profiles already exist. Returns its id. */
export function seedHomeProfile(client: QueryClient): Promise<string | null> {
  return withSeedLock(() => seedUnlocked(client));
}

function isSettings(value: unknown): value is Settings {
  return value !== null && typeof value === 'object' && 'general' in value && 'appearance' in value;
}

/** Week start and units from the browser's locale, unless the user already chose them. */
async function applyLocaleDefaults(settings: Settings | null): Promise<Settings | null> {
  let language = '';
  try {
    language = typeof navigator === 'undefined' ? '' : navigator.language;
  } catch {
    language = '';
  }
  if (!language) return settings;
  try {
    const base = settings ?? (await fetchSettings());
    const patch = firstRunGeneralPatch(base.general, language);
    return patch ? await patchSettings({ general: patch }) : base;
  } catch {
    return settings; // not fatal: the schema defaults stay
  }
}

async function seedUnlocked(client: QueryClient): Promise<string | null> {
  if ((await freshProfiles(client)).length > 0) {
    // Another tab seeded while this one waited for the lock: show its profile.
    await client.invalidateQueries({ queryKey: qk.settings() });
    return null;
  }
  const layout = createDefaultLayout(() => newId());
  const created = await createProfile({ name: DEFAULT_PROFILE_NAME, layout });
  let profileId = created?.id ?? null;
  /** The server's profile list after seeding, when known without asking again. */
  let profiles: Profile[] | null = created && created.layout.items.length > 0 ? [created] : null;
  if (profileId === null) {
    // Response was not a profile: find what the server created.
    profiles = await freshProfiles(client);
    profileId = profiles.find((p) => p.name === DEFAULT_PROFILE_NAME)?.id ?? null;
  } else if (created && created.layout.items.length === 0) {
    await addDefaultWidgets(client, profileId);
  }
  let settings: Settings | null = null;
  if (profileId !== null) {
    try {
      const activated = await activateProfile(profileId);
      if (isSettings(activated)) settings = activated;
    } catch {
      // Not fatal: with a single profile the first one is active anyway.
    }
  }
  settings = await applyLocaleDefaults(settings);
  // Answers go straight into the cache (no refetch round trips on first run).
  if (profiles) client.setQueryData(qk.profiles(), profiles);
  if (settings) client.setQueryData(qk.settings(), settings);
  await Promise.all([
    profiles ? null : client.invalidateQueries({ queryKey: qk.profiles() }),
    settings ? null : client.invalidateQueries({ queryKey: qk.settings() }),
  ]);
  return profileId;
}

export type SeedState = 'idle' | 'seeding' | 'failed';

/**
 * Seeds the Home profile once the profile list has loaded (from the server) empty. `isFetching` is
 * read only while the list is empty: TanStack re-renders a component for each result field it
 * read, and the dashboard must not re-render on every profiles refetch.
 */
export function useFirstRunSeed(profiles: Pick<UseQueryResult<Profile[]>, 'data' | 'isSuccess' | 'isFetching'>): SeedState {
  const client = useQueryClient();
  const [state, setState] = useState<SeedState>('idle');
  const empty = profiles.isSuccess && profiles.data?.length === 0 && !profiles.isFetching;

  useEffect(() => {
    if (!empty || attempted.has(client)) return;
    attempted.add(client);
    setState('seeding');
    seedHomeProfile(client).then(
      () => setState('idle'),
      () => setState('failed'),
    );
  }, [client, empty]);

  return state;
}
