/**
 * GitHub widget settings (§10.8 GitHub): the order of the board, and whether archived repositories
 * and forks are on it. The token is in Settings → Accounts, under GitHub repositories.
 */
import { Field } from '../../ui/Field.tsx';
import { SegmentedControl, Switch } from '../../ui/Toggles.tsx';
import type { WidgetSettingsProps } from '../types.ts';
import type { GitHubConfig } from './index.ts';
import type { RepoSort } from './model.ts';

const SORT_OPTIONS: readonly { value: RepoSort; label: string }[] = [
  { value: 'attention', label: 'Attention' },
  { value: 'pushed', label: 'Last push' },
  { value: 'name', label: 'Name' },
];

export default function GitHubSettings({ value, onChange }: WidgetSettingsProps<GitHubConfig>) {
  return (
    <>
      <Field label="Sort repositories by" help="Attention puts failing CI first, then running, then the most recently pushed.">
        <SegmentedControl<RepoSort> value={value.sort} onValueChange={(sort) => onChange({ ...value, sort })} options={SORT_OPTIONS} block />
      </Field>
      <Switch label="Show archived repositories" checked={value.showArchived} onCheckedChange={(showArchived) => onChange({ ...value, showArchived })} />
      <Switch label="Show forks" checked={value.showForks} onCheckedChange={(showForks) => onChange({ ...value, showForks })} />
    </>
  );
}
