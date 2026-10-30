/**
 * Notes widget settings (§10.8 Notes): text size, font and spell checking. The note itself is
 * edited in the widget, never here. Every change goes to the dialog draft via `onChange`.
 */
import { Field } from '../../ui/Field.tsx';
import { SegmentedControl, Switch } from '../../ui/Toggles.tsx';
import type { WidgetSettingsProps } from '../types.ts';
import type { NotesConfig } from './index.ts';
import styles from './Settings.module.css';

export default function NotesSettings({ value, onChange }: WidgetSettingsProps<NotesConfig>) {
  const update = (patch: Partial<NotesConfig>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.stack}>
      <Field label="Text size">
        <SegmentedControl
          value={value.textSize}
          onValueChange={(textSize) => update({ textSize })}
          options={[
            { value: 'sm', label: 'Small' },
            { value: 'md', label: 'Medium' },
            { value: 'lg', label: 'Large' },
          ]}
        />
      </Field>
      <Field label="Font">
        <SegmentedControl
          value={value.font}
          onValueChange={(font) => update({ font })}
          options={[
            { value: 'sans', label: 'Standard' },
            { value: 'mono', label: 'Monospace' },
          ]}
        />
      </Field>
      <Switch
        label="Check spelling"
        description="Underline misspelled words while you type."
        checked={value.spellcheck}
        onCheckedChange={(spellcheck) => update({ spellcheck })}
      />
    </div>
  );
}
