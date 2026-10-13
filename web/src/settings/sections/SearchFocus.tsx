/**
 * Settings → Search → "Focus the search box on a new tab": a shortcut to the search widgets'
 * "Focus on load" option (widget config `autofocus`) in the active profile, which is otherwise only
 * reachable from the widget's own settings — and the search box usually has its header hidden.
 */
import { useQueryClient } from '@tanstack/react-query';
import { pickActiveProfile, saveWidget, useProfiles } from '../../api/profiles.ts';
import { useSettings } from '../../api/settings.ts';
import { Switch } from '../../ui/index.ts';
import { getWidgetDefinition, parseWidgetConfig } from '../../widgets/registry.ts';
import type { SearchConfig } from '../../widgets/search/index.ts';

export function SearchFocusSwitch() {
  const client = useQueryClient();
  const settings = useSettings();
  const profiles = useProfiles();
  const definition = getWidgetDefinition('search');
  const profile = profiles.data ? pickActiveProfile(profiles.data, settings.data?.activeProfileId ?? null) : null;
  const widgets = definition && profile ? profile.layout.items.filter((item) => item.type === 'search') : [];
  const configs = widgets.map((item) => ({ item, config: parseWidgetConfig(definition!, item.config) as SearchConfig }));
  const checked = configs.some(({ config }) => config.autofocus);

  const toggle = (autofocus: boolean) => {
    if (!profile) return;
    for (const { item, config } of configs) {
      if (config.autofocus !== autofocus) void saveWidget(client, profile.id, item.id, { config: { ...config, autofocus } }).catch(() => {});
    }
  };

  return (
    <Switch
      label="Focus the search box on a new tab"
      description={
        widgets.length > 0
          ? `Puts the cursor in the search box when Portly opens, so you can type straight away (the “${profile!.name}” profile).`
          : `The “${profile?.name ?? 'current'}” profile has no search box.`
      }
      checked={checked}
      disabled={widgets.length === 0}
      onCheckedChange={toggle}
    />
  );
}
