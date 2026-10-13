/**
 * AccountPicker (§10.4): choose `'all'` accounts or a specific subset, limited to accounts with a
 * capability enabled (e.g. mail). Used by widget settings (`accountIds: 'all' | string[]`).
 */
import type { Capability } from '@homebase/shared';
import { useAccounts } from '../../api/accounts.ts';
import { SkeletonLines } from '../Skeleton.tsx';
import { Checkbox, Switch } from '../Toggles.tsx';
import { AccountBadge } from './AccountBadge.tsx';
import { CAPABILITY_LABELS } from './accountKinds.ts';
import styles from '../Display.module.css';

export interface AccountPickerProps {
  value: 'all' | string[];
  onChange(value: 'all' | string[]): void;
  capability: Capability;
}

export function AccountPicker({ value, onChange, capability }: AccountPickerProps) {
  const accounts = useAccounts();
  if (accounts.isPending) return <SkeletonLines lines={2} />;
  const eligible = (accounts.data ?? []).filter((a) => a.enabledCapabilities.includes(capability));

  if (eligible.length === 0) {
    return (
      <p className={styles.muted}>
        No accounts with {CAPABILITY_LABELS[capability].toLowerCase()} yet. <a href="#/settings/accounts">Connect an account</a>
      </p>
    );
  }

  const all = value === 'all';
  const selected = new Set(all ? eligible.map((a) => a.id) : value);

  return (
    <div className={styles.accountPicker}>
      <Switch
        label="All accounts"
        description="Includes accounts you connect later."
        checked={all}
        onCheckedChange={(checked) => onChange(checked ? 'all' : eligible.map((a) => a.id))}
      />
      {all ? null : (
        <ul className={styles.accountPickerList}>
          {eligible.map((account) => (
            <li key={account.id}>
              <Checkbox
                checked={selected.has(account.id)}
                onCheckedChange={(checked) => {
                  const next = new Set(selected);
                  if (checked) next.add(account.id);
                  else next.delete(account.id);
                  onChange(eligible.filter((a) => next.has(a.id)).map((a) => a.id));
                }}
                label={<AccountBadge account={account} showKind />}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
