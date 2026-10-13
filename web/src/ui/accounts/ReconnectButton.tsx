/**
 * ReconnectButton (§10.4): for Google/Microsoft accounts starts OAuth again for that account
 * (same tab, returning to the current page); app-password accounts link to Accounts settings.
 */
import { LogIn } from 'lucide-react';
import { useAccount, useStartOAuth } from '../../api/accounts.ts';
import { Button, type ButtonSize } from '../Button.tsx';
import { reconnectsWithOAuth } from './accountKinds.ts';
import styles from '../Display.module.css';

export interface ReconnectButtonProps {
  accountId: string;
  size?: ButtonSize;
  variant?: 'primary' | 'secondary';
}

export function ReconnectButton({ accountId, size = 'sm', variant = 'primary' }: ReconnectButtonProps) {
  const account = useAccount(accountId);
  const start = useStartOAuth();

  if (account && reconnectsWithOAuth(account.kind)) {
    const provider = account.kind;
    return (
      <Button
        variant={variant}
        size={size}
        icon={LogIn}
        loading={start.isPending}
        onClick={() => start.mutate({ provider, accountId })}
      >
        Reconnect
      </Button>
    );
  }

  return (
    <a className={styles.setupLink} href="#/settings/accounts">
      <LogIn aria-hidden="true" />
      Reconnect in settings
    </a>
  );
}
