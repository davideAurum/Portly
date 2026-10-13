/**
 * AccountBadge (§10.4): an account's color dot, label and (optionally) its status. Colors are
 * validated hex values (§4.5); text on them uses readableTextColor.
 */
import { CircleAlert, Unplug } from 'lucide-react';
import type { Account } from '@homebase/shared';
import { colorFromString, safeColor } from '../../lib/color.ts';
import { Badge } from '../Badge.tsx';
import { ACCOUNT_KIND_LABELS } from './accountKinds.ts';
import styles from '../Display.module.css';

export interface AccountBadgeProps {
  account: Pick<Account, 'id' | 'kind' | 'label' | 'email' | 'color' | 'status'>;
  /** Show the status badge when the account needs attention. */
  showStatus?: boolean;
  /** Show the kind ("Google") after the label. */
  showKind?: boolean;
}

export function accountColor(account: Pick<Account, 'id' | 'color'>): string {
  return safeColor(account.color, colorFromString(account.id));
}

export function AccountBadge({ account, showStatus = false, showKind = false }: AccountBadgeProps) {
  return (
    <span className={styles.accountBadge}>
      <span className={styles.accountDot} style={{ backgroundColor: accountColor(account) }} aria-hidden="true" />
      <span className={styles.accountLabel} title={account.email ?? undefined}>
        {account.label}
      </span>
      {showKind ? <span className={styles.accountKind}>{ACCOUNT_KIND_LABELS[account.kind]}</span> : null}
      {showStatus && account.status === 'reauth' ? (
        <Badge tone="warning" icon={Unplug}>
          Reconnect needed
        </Badge>
      ) : null}
      {showStatus && account.status === 'error' ? (
        <Badge tone="danger" icon={CircleAlert}>
          Error
        </Badge>
      ) : null}
    </span>
  );
}
