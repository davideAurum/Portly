/** Music widget settings: which account it controls, when more than one is connected. */
import { useAccounts } from '../../api/accounts.ts';
import { Field } from '../../ui/Field.tsx';
import { Select } from '../../ui/Input.tsx';
import type { WidgetSettingsProps } from '../types.ts';
import type { MusicConfig } from './index.ts';
import styles from './Music.module.css';

const FIRST_ACCOUNT = '';

export default function MusicSettings({ value, onChange }: WidgetSettingsProps<MusicConfig>) {
  const accounts = (useAccounts().data ?? []).filter((account) => account.enabledCapabilities.includes('music'));
  if (accounts.length < 2) {
    return <p className={styles.settingsNote}>This widget uses your connected music account. Accounts are managed in Settings → Accounts.</p>;
  }
  return (
    <Field label="Account">
      <Select
        value={value.accountId ?? FIRST_ACCOUNT}
        onChange={(event) => onChange({ ...value, accountId: event.currentTarget.value === FIRST_ACCOUNT ? null : event.currentTarget.value })}
        options={[{ value: FIRST_ACCOUNT, label: 'First connected account' }, ...accounts.map((account) => ({ value: account.id, label: account.label }))]}
      />
    </Field>
  );
}
