/**
 * Todoist widget settings (§10.8): filter (free text + presets), list title, sort, and whether
 * project and due chips are shown. Every change previews live; the widget waits for the filter
 * to settle before fetching.
 */
import { DEFAULT_TODOIST_FILTER } from '@portly/shared';
import { useSettings } from '../../api/settings.ts';
import { Button } from '../../ui/Button.tsx';
import { Field } from '../../ui/Field.tsx';
import { Input } from '../../ui/Input.tsx';
import { SegmentedControl, Switch } from '../../ui/Toggles.tsx';
import type { WidgetSettingsProps } from '../types.ts';
import type { TodoistConfig } from './index.ts';
import { FILTER_PRESETS, presetFor, type TaskSort } from './model.ts';
import styles from './Todoist.module.css';

const SORT_OPTIONS: readonly { value: TaskSort; label: string }[] = [
  { value: 'todoist', label: 'Todoist' },
  { value: 'due', label: 'Due date' },
  { value: 'priority', label: 'Priority' },
];

export default function TodoistSettings({ value, onChange }: WidgetSettingsProps<TodoistConfig>) {
  const settings = useSettings();
  const defaultFilter = settings.data?.todoist.defaultFilter ?? DEFAULT_TODOIST_FILTER;
  const active = presetFor(value.filter.trim() || defaultFilter);
  const filterTooLong = value.filter.length > 1024;

  return (
    <>
      <Field
        label="Filter"
        error={filterTooLong ? 'Keep the filter under 1024 characters.' : undefined}
        help={
          <>
            Any Todoist filter, e.g. <code className={styles.code}>#Work &amp; p1</code> or <code className={styles.code}>%errands</code>.
            Leave empty to use your default filter (<code className={styles.code}>{defaultFilter}</code>).
          </>
        }
      >
        <Input
          value={value.filter}
          placeholder={defaultFilter}
          maxLength={1100}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onChange({ ...value, filter: event.currentTarget.value })}
        />
      </Field>
      <div className={styles.presets} role="group" aria-label="Filter presets">
        {FILTER_PRESETS.map((preset) => {
          const selected = active?.query === preset.query;
          return (
            <Button
              key={preset.query}
              size="sm"
              variant={selected ? 'primary' : 'secondary'}
              aria-pressed={selected}
              title={preset.query}
              onClick={() => onChange({ ...value, filter: preset.query })}
            >
              {preset.label}
            </Button>
          );
        })}
      </div>
      <Field label="List title" help="Shown above the tasks. Leave empty to use the filter's name.">
        <Input
          value={value.title ?? ''}
          placeholder={active?.label ?? (value.filter.trim() || defaultFilter)}
          maxLength={80}
          onChange={(event) => {
            const title = event.currentTarget.value;
            onChange({ ...value, title: title.trim() === '' ? undefined : title });
          }}
        />
      </Field>
      <Field label="Sort tasks by">
        <SegmentedControl<TaskSort> value={value.sort} onValueChange={(sort) => onChange({ ...value, sort })} options={SORT_OPTIONS} block />
      </Field>
      <Switch label="Show project" description="Project name and color under each task." checked={value.showProject} onCheckedChange={(showProject) => onChange({ ...value, showProject })} />
      <Switch label="Show due date" description="Overdue dates are highlighted." checked={value.showDue} onCheckedChange={(showDue) => onChange({ ...value, showDue })} />
    </>
  );
}
