/**
 * Search widget settings (§10.8): which engines this widget offers (all, or a subset), the engine
 * switcher, autofocus on load and the placeholder. Engines themselves are managed globally in
 * Settings → Search.
 */
import { Settings2 } from 'lucide-react';
import { useSettings } from '../../api/settings.ts';
import { safeHref } from '../../lib/openUrl.ts';
import { Checkbox, Field, Input, SegmentedControl, Switch } from '../../ui/index.ts';
import { SiteIcon } from '../launchpad/SiteIcon.tsx';
import type { WidgetSettingsProps } from '../types.ts';
import type { SearchConfig } from './index.ts';
import styles from './Settings.module.css';

export default function SearchSettings({ value, onChange }: WidgetSettingsProps<SearchConfig>) {
  const settings = useSettings();
  const engines = settings.data?.search.engines ?? [];
  const update = (patch: Partial<SearchConfig>) => onChange({ ...value, ...patch });
  const selected = value.engineIds === 'all' ? new Set(engines.map((e) => e.id)) : new Set(value.engineIds);
  const manageHref = safeHref('#/settings/search');

  const toggle = (id: string, on: boolean) => {
    const next = engines.filter((e) => (e.id === id ? on : selected.has(e.id))).map((e) => e.id);
    update({ engineIds: next.length === engines.length ? 'all' : next });
  };

  return (
    <div className={styles.stack}>
      <Field label="Engines" help="Keywords and suggestions come from Settings → Search.">
        <SegmentedControl
          value={value.engineIds === 'all' ? 'all' : 'some'}
          onValueChange={(mode) => update({ engineIds: mode === 'all' ? 'all' : engines.map((e) => e.id) })}
          options={[
            { value: 'all', label: 'All engines' },
            { value: 'some', label: 'Choose…' },
          ]}
        />
      </Field>
      {value.engineIds !== 'all' ? (
        <fieldset className={styles.checklist}>
          <legend className="hb-visually-hidden">Engines in this widget</legend>
          {engines.map((engine) => (
            <div key={engine.id} className={styles.checkRow}>
              <SiteIcon label={engine.name} iconId={engine.iconId} size={18} />
              <Checkbox
                label={engine.name}
                checked={selected.has(engine.id)}
                disabled={selected.size === 1 && selected.has(engine.id)}
                onCheckedChange={(on) => toggle(engine.id, on)}
              />
            </div>
          ))}
        </fieldset>
      ) : null}
      <Switch
        label="Engine switcher"
        description="Show the engine chip with a menu of engines."
        checked={value.showEngineSwitcher}
        onCheckedChange={(showEngineSwitcher) => update({ showEngineSwitcher })}
      />
      <Switch
        label="Focus on load"
        description="Put the cursor in this search box when a new tab opens (the first such widget wins)."
        checked={value.autofocus}
        onCheckedChange={(autofocus) => update({ autofocus })}
      />
      <Field label="Placeholder">
        <Input value={value.placeholder} maxLength={100} onChange={(event) => update({ placeholder: event.currentTarget.value })} />
      </Field>
      {manageHref ? (
        <a className={styles.link} href={manageHref}>
          <Settings2 aria-hidden="true" />
          Manage search engines
        </a>
      ) : null}
    </div>
  );
}
