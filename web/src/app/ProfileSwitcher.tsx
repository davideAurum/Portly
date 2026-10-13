/**
 * Header profile switcher (manual switching, §1): the active profile's name opens a menu of all
 * profiles plus "Manage profiles".
 */
import { ChevronDown, Layers, Settings2 } from 'lucide-react';
import { pickActiveProfile, sortProfiles, useActivateProfile, useProfiles } from '../api/profiles.ts';
import { useSettings } from '../api/settings.ts';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../ui/Menu.tsx';
import { navigate } from './router.ts';
import styles from './Shell.module.css';

export function ProfileSwitcher() {
  const profiles = useProfiles();
  const settings = useSettings();
  const activate = useActivateProfile();
  const list = sortProfiles(profiles.data ?? []);
  const active = pickActiveProfile(list, settings.data?.activeProfileId ?? null);
  if (!active) return null;

  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className={styles.chip} aria-label={`Profile: ${active.name}. Switch profile`}>
          <Layers aria-hidden="true" className={styles.chipIcon} />
          <span className={styles.chipText}>{active.name}</span>
          <ChevronDown aria-hidden="true" className={styles.chipChevron} />
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Profiles</MenuLabel>
        <MenuRadioGroup
          value={active.id}
          onValueChange={(id) => {
            if (id !== active.id) activate.mutate(id);
          }}
        >
          {list.map((profile) => (
            <MenuRadioItem key={profile.id} value={profile.id}>
              {profile.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem icon={<Settings2 />} onSelect={() => navigate({ name: 'settings', section: 'profiles' })}>
          Manage profiles…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
