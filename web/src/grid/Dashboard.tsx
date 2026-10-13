/**
 * The dashboard route: the active profile's layout, first-run seeding, and edit-mode
 * availability. Until a profile exists (first load, server unavailable) the default layout is
 * shown read-only.
 */
import { useEffect, useMemo } from 'react';
import { pickActiveProfile, useProfiles } from '../api/profiles.ts';
import { useSettings } from '../api/settings.ts';
import { useIsNarrow } from '../lib/useMediaQuery.ts';
import { createDefaultLayout } from './defaultLayout.ts';
import { useEditMode } from './editMode.tsx';
import { Grid } from './Grid.tsx';
import { useFirstRunSeed } from './seed.ts';

export function Dashboard() {
  const settings = useSettings();
  const profiles = useProfiles();
  const seed = useFirstRunSeed(profiles);
  const narrow = useIsNarrow();
  const { setAvailability } = useEditMode();
  const defaultLayout = useMemo(() => createDefaultLayout(), []);

  const active = pickActiveProfile(profiles.data ?? [], settings.data?.activeProfileId ?? null);

  let reason: string | null = null;
  if (narrow) reason = 'Editing needs a wider window';
  else if (!active) reason = seed === 'seeding' || profiles.isPending ? 'Setting up your dashboard…' : "The layout can't be saved right now";

  useEffect(() => {
    setAvailability(reason === null, reason);
  }, [reason, setAvailability]);

  // Avoid flashing the default layout before the (possibly persisted) profiles arrive.
  if (profiles.isPending && !profiles.isError) return <div aria-busy="true" />;

  return <Grid layout={active?.layout ?? defaultLayout} profileId={active?.id ?? null} />;
}
