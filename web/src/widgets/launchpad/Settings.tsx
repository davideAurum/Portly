/**
 * Launch pad widget settings (§10.8): which groups to show (and in what order), how the groups are
 * laid out (stacked, or side by side with per-group widths), tiles or list, icon size, labels,
 * columns, and what each list row shows. Groups themselves are managed in the widget's edit mode
 * or Settings → Bookmarks.
 */
import { ArrowDown, ArrowUp, Settings2 } from 'lucide-react';
import type { BookmarkGroup } from '@homebase/shared';
import { useBookmarks } from '../../api/bookmarks.ts';
import { safeHref } from '../../lib/openUrl.ts';
import { safeColor } from '../../lib/color.ts';
import { Checkbox, Field, IconButton, SegmentedControl, Select, Switch } from '../../ui/index.ts';
import type { WidgetSettingsProps } from '../types.ts';
import { MAX_GROUP_COLUMNS, type LaunchpadConfig } from './index.ts';
import { visibleGroups } from './groups.ts';
import styles from '../search/Settings.module.css';
import own from './Settings.module.css';

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

const COLUMN_OPTIONS = [
  { value: 'auto', label: 'Automatic (fit the width)' },
  ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: plural(i + 1, 'column') })),
];

const GROUP_COLUMN_OPTIONS = [
  { value: 'auto', label: 'Automatic (fit the width)' },
  ...Array.from({ length: MAX_GROUP_COLUMNS - 1 }, (_, i) => ({ value: String(i + 2), label: plural(i + 2, 'column') })),
];

function GroupName({ group }: { group: BookmarkGroup }) {
  const color = safeColor(group.color);
  return (
    <span className={styles.groupLabel}>
      {color ? <span className={styles.groupDot} style={{ background: color }} aria-hidden="true" /> : null}
      {group.name}
    </span>
  );
}

export default function LaunchpadSettings({ value, onChange }: WidgetSettingsProps<LaunchpadConfig>) {
  const bookmarks = useBookmarks();
  const groups = bookmarks.data?.groups ?? [];
  const update = (patch: Partial<LaunchpadConfig>) => onChange({ ...value, ...patch });
  const shown = visibleGroups(groups, value);
  const selected = new Set(shown.map((g) => g.id));
  // Chosen groups first, in this launch pad's order, then the rest in group order.
  const listed = value.groupIds === 'all' ? groups : [...shown, ...groups.filter((g) => !selected.has(g.id))];
  const manageHref = safeHref('#/settings/bookmarks');
  const list = value.style === 'list';
  const fixedGroupColumns = value.groupLayout === 'columns' && value.groupColumns !== 'auto' ? value.groupColumns : null;

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...shown.map((g) => g.id), id] : shown.map((g) => g.id).filter((g) => g !== id);
    const inGroupOrder = next.length === groups.length && groups.every((g, i) => g.id === next[i]);
    update({ groupIds: inGroupOrder ? 'all' : next });
  };
  const move = (id: string, by: -1 | 1) => {
    const ids = shown.map((g) => g.id);
    const from = ids.indexOf(id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    update({ groupIds: ids });
  };
  const setSpan = (id: string, span: number) => {
    const { [id]: _previous, ...rest } = value.groupSpans;
    update({ groupSpans: span > 1 ? { ...rest, [id]: span } : rest });
  };

  // A list row always shows something: the last visible part cannot be turned off.
  const onlyTitle = !value.listIcons && value.listDetail === 'none';
  const onlyIcon = !value.listTitle && value.listDetail === 'none';
  const onlyDetail = !value.listTitle && !value.listIcons;

  return (
    <div className={styles.stack}>
      <h3 className={own.heading}>Groups</h3>
      <Field label="Which groups">
        <SegmentedControl
          value={value.groupIds === 'all' ? 'all' : 'some'}
          onValueChange={(mode) => update({ groupIds: mode === 'all' ? 'all' : groups.map((g) => g.id) })}
          options={[
            { value: 'all', label: 'All groups' },
            { value: 'some', label: 'Choose and order…', disabled: groups.length === 0 },
          ]}
        />
      </Field>
      {value.groupIds !== 'all' ? (
        <fieldset className={styles.checklist}>
          <legend className="hb-visually-hidden">Groups in this launch pad</legend>
          {listed.map((group) => {
            const index = shown.indexOf(group);
            const on = index >= 0;
            return (
              <div key={group.id} className={styles.checkRow}>
                <div className={own.rowMain}>
                  <Checkbox
                    label={<GroupName group={group} />}
                    description={plural(group.bookmarks.length, 'bookmark')}
                    checked={on}
                    disabled={on && shown.length === 1}
                    onCheckedChange={(next) => toggle(group.id, next)}
                  />
                </div>
                {on && shown.length > 1 ? (
                  <span className={own.order}>
                    <IconButton icon={ArrowUp} size="sm" aria-label={`Move ${group.name} up`} disabled={index === 0} onClick={() => move(group.id, -1)} />
                    <IconButton icon={ArrowDown} size="sm" aria-label={`Move ${group.name} down`} disabled={index === shown.length - 1} onClick={() => move(group.id, 1)} />
                  </span>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      ) : null}
      <Field label="Group layout">
        <SegmentedControl
          value={value.groupLayout}
          onValueChange={(groupLayout) => update({ groupLayout })}
          options={[
            { value: 'stack', label: 'Stacked' },
            { value: 'columns', label: 'Side by side' },
          ]}
        />
      </Field>
      {value.groupLayout === 'columns' ? (
        <Field label="Group columns" help={fixedGroupColumns ? undefined : 'Groups get equal widths; choose a number of columns to make some groups wider.'}>
          <Select
            value={String(value.groupColumns)}
            options={GROUP_COLUMN_OPTIONS}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              update({ groupColumns: raw === 'auto' ? 'auto' : Number(raw) });
            }}
          />
        </Field>
      ) : null}
      {fixedGroupColumns && shown.length > 0 ? (
        <fieldset className={own.widths}>
          <legend className="hb-visually-hidden">Group widths</legend>
          {shown.map((group) => (
            <label key={group.id} className={own.widthRow}>
              <GroupName group={group} />
              <Select
                size="sm"
                aria-label={`Width of ${group.name}`}
                value={String(Math.min(value.groupSpans[group.id] ?? 1, fixedGroupColumns))}
                options={Array.from({ length: fixedGroupColumns }, (_, i) => ({ value: String(i + 1), label: i + 1 === fixedGroupColumns ? 'Full width' : plural(i + 1, 'column') }))}
                onChange={(event) => setSpan(group.id, Number(event.currentTarget.value))}
              />
            </label>
          ))}
          <p className={own.hint}>Groups fill the columns left to right, in the order above; a group that does not fit starts a new row.</p>
        </fieldset>
      ) : null}
      <Switch
        label="Group headers"
        description="Name, color, count and collapse toggle above each group (when there is more than one)."
        checked={value.showGroupHeaders}
        onCheckedChange={(showGroupHeaders) => update({ showGroupHeaders })}
      />

      <h3 className={own.heading}>Bookmarks</h3>
      <Field label="Style">
        <SegmentedControl
          value={value.style}
          onValueChange={(style) => update({ style })}
          options={[
            { value: 'tiles', label: 'Tiles' },
            { value: 'list', label: 'List' },
          ]}
        />
      </Field>
      <Field label="Icon size">
        <SegmentedControl
          value={value.iconSize}
          onValueChange={(iconSize) => update({ iconSize })}
          options={[
            { value: 's', label: 'Small' },
            { value: 'm', label: 'Medium' },
            { value: 'l', label: 'Large' },
          ]}
        />
      </Field>
      {list ? (
        <>
          <Switch
            label="Show page name"
            checked={value.listTitle || onlyTitle}
            disabled={onlyTitle}
            onCheckedChange={(listTitle) => update({ listTitle })}
          />
          <Field label="Show address">
            <SegmentedControl
              value={value.listDetail}
              onValueChange={(listDetail) => update({ listDetail })}
              options={[
                { value: 'none', label: 'Hidden', disabled: onlyDetail },
                { value: 'domain', label: 'Domain' },
                { value: 'url', label: 'Full URL' },
              ]}
            />
          </Field>
          <Field label="Address position">
            <SegmentedControl
              value={value.listDetailPlacement}
              onValueChange={(listDetailPlacement) => update({ listDetailPlacement })}
              disabled={value.listDetail === 'none' || !value.listTitle}
              options={[
                { value: 'inline', label: 'Beside the name' },
                { value: 'below', label: 'Under the name' },
              ]}
            />
          </Field>
          <Switch
            label="Show icons"
            checked={value.listIcons || onlyIcon}
            disabled={onlyIcon}
            onCheckedChange={(listIcons) => update({ listIcons })}
          />
          <Field label="Row spacing">
            <SegmentedControl
              value={value.listDensity}
              onValueChange={(listDensity) => update({ listDensity })}
              options={[
                { value: 'compact', label: 'Compact' },
                { value: 'normal', label: 'Normal' },
                { value: 'roomy', label: 'Roomy' },
              ]}
            />
          </Field>
        </>
      ) : (
        <Switch
          label="Show names"
          description="Names under the icons (hover shows them otherwise)."
          checked={value.showLabels}
          onCheckedChange={(showLabels) => update({ showLabels })}
        />
      )}
      <Field label={value.groupLayout === 'columns' ? 'Columns in each group' : 'Columns'}>
        <Select
          value={String(value.columns)}
          options={COLUMN_OPTIONS}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            update({ columns: raw === 'auto' ? 'auto' : Number(raw) });
          }}
        />
      </Field>
      {manageHref ? (
        <a className={styles.link} href={manageHref}>
          <Settings2 aria-hidden="true" />
          Manage groups and import bookmarks
        </a>
      ) : null}
    </div>
  );
}
