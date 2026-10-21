/**
 * Accounts (§4.6, §4.7, §7 Accounts, §8, §10.5): connect a main account, then choose what Portly
 * uses it for.
 *
 * - **Connected accounts** on top: every account (status, the services in use, Manage, Reconnect,
 *   Test, Remove) and Todoist while its token is saved (parts in `accounts/`).
 * - **Add a connection**: a tile per provider (Google, Microsoft, Yahoo, Todoist, Other). Each opens
 *   a connect dialog: the app registration when the provider needs one and has none yet, the
 *   services to use, then the sign-in (Google, Microsoft: only the scopes of those services) or the
 *   credential form (Yahoo, CalDAV, IMAP) or the Todoist token. "App registrations" under the tiles
 *   edits a registration later.
 * - The vault-locked banner with "Reset credentials".
 *
 * The same on Portly's own page and on the Pages site paired with it. The Pages site on its
 * in-browser backend offers only what works there (`capabilities.ts`): Microsoft (calendar only,
 * signed in from the browser with a single-page-app registration) and Todoist.
 *
 * Deep links: `#/settings/accounts?focus=todoist` (and the old `#/settings/todoist`) open Todoist:
 * its Manage dialog when it is connected, else its connect dialog.
 */
import { useEffect, useState } from 'react';
import { KeyRound, RotateCcw, Server } from 'lucide-react';
import { OAUTH_PROVIDERS } from '@portly/shared';
import { clearHashFocus, hashFocus } from '../../app/router.ts';
import { useCalendars } from '../../api/calendar.ts';
import { useTodoistToken } from '../../api/todoist.ts';
import { useResetVault } from '../../api/vault.ts';
import { getCapabilities } from '../../capabilities.ts';
import { LetterTile } from '../../ui/Badge.tsx';
import { Banner } from '../../ui/Banner.tsx';
import { Button } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/Dialog.tsx';
import { SettingsCard } from '../../ui/Section.tsx';
import { toast, toastError } from '../../ui/toast.ts';
import { AppRegistrations } from './accounts/AppRegistration.tsx';
import { ConnectDialog } from './accounts/ConnectDialog.tsx';
import { ConnectedAccounts } from './accounts/ConnectedAccounts.tsx';
import { availableConnections, connectionServices, servicesSummary, type ConnectionId, type ConnectionInfo } from './accounts/connections.ts';
import { TodoistManageDialog } from './accounts/Todoist.tsx';
import { useVaultLocked } from './accounts/vault.ts';
import styles from '../../styles/settings.module.css';

export default function AccountsSettings() {
  const locked = useVaultLocked();
  const [connecting, setConnecting] = useState<ConnectionId | null>(null);
  const [managingTodoist, setManagingTodoist] = useState(false);
  useTodoistDeepLink(setConnecting, setManagingTodoist);
  return (
    <div className={styles.stack}>
      {locked ? <VaultLockedBanner /> : null}
      <ConnectedAccounts onManageTodoist={() => setManagingTodoist(true)} />
      <AddConnection onConnect={setConnecting} />
      <ConnectDialog connection={connecting} onClose={() => setConnecting(null)} />
      <TodoistManageDialog open={managingTodoist} onOpenChange={setManagingTodoist} />
    </div>
  );
}

/** `?focus=todoist` (or the old Todoist section's address): open Todoist once its state is known. */
function useTodoistDeepLink(connect: (id: ConnectionId) => void, manage: (open: boolean) => void): void {
  const [pending, setPending] = useState(() => hashFocus() === 'todoist');
  const token = useTodoistToken();
  const configured = token.data?.configured;
  useEffect(() => {
    if (!pending || configured === undefined) return;
    setPending(false);
    clearHashFocus();
    if (configured) manage(true);
    else connect('todoist');
  }, [pending, configured, connect, manage]);
}

// ---------------------------------------------------------------------------
// Add a connection
// ---------------------------------------------------------------------------

function tileSummary(connection: ConnectionInfo): string {
  switch (connection.id) {
    case 'todoist':
      return 'Tasks';
    case 'other':
      return 'CalDAV calendar or IMAP mail';
    case 'microsoft':
      return `Outlook.com ${servicesSummary(connectionServices('microsoft')).toLowerCase()}`;
    default:
      return servicesSummary(connectionServices(connection.id));
  }
}

function AddConnection({ onConnect }: { onConnect(id: ConnectionId): void }) {
  const caps = getCapabilities();
  const connections = availableConnections(caps);
  const providers = OAUTH_PROVIDERS.filter((provider) => connections.some((c) => c.id === provider));
  return (
    <SettingsCard title="Add a connection" description="Connect an account once, then choose what Portly uses it for.">
      <ul className={styles.tileGrid} aria-label="Add a connection">
        {connections.map((connection) => (
          <li key={connection.id}>
            <button
              type="button"
              className={styles.tile}
              onClick={() => onConnect(connection.id)}
              aria-label={connection.id === 'other' ? 'Connect another account (CalDAV or IMAP)' : `Connect ${connection.title}`}
            >
              {connection.mark ? (
                <LetterTile label={connection.mark.letter} color={connection.mark.color} size={32} />
              ) : (
                <span className={styles.tileIcon} aria-hidden="true">
                  <Server />
                </span>
              )}
              <span className={styles.tileText}>
                <span className={styles.tileTitle}>{connection.title}</span>
                <span className={styles.tileSummary}>{tileSummary(connection)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {caps.remoteClient ? (
        <p className={styles.intro}>Google and Microsoft accounts are connected on the main PC; once connected there, they work here too.</p>
      ) : null}
      {caps.backend === 'browser' ? (
        <p className={styles.intro}>Google, Yahoo, CalDAV and IMAP accounts need the Portly server on your PC.</p>
      ) : null}
      {caps.remoteClient ? null : <AppRegistrations providers={providers} />}
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

function VaultLockedBanner() {
  const reset = useResetVault();
  const [confirming, setConfirming] = useState(false);
  // Resetting is a decision for the main PC (the route is refused from another PC).
  const mainPc = !getCapabilities().remoteClient;
  const icsCount = (useCalendars().data ?? []).filter((c) => c.source === 'ics').length;
  const icsNote =
    icsCount === 0
      ? ''
      : ` The addresses of your ${icsCount === 1 ? 'ICS calendar subscription are' : `${icsCount} ICS calendar subscriptions are`} deleted too and must be entered again in Settings → Calendars.`;
  return (
    <>
      <Banner
        tone="danger"
        icon={KeyRound}
        title="Saved credentials can't be unlocked"
        actions={
          mainPc ? (
            <Button variant="danger" size="sm" icon={RotateCcw} onClick={() => setConfirming(true)}>
              Reset credentials
            </Button>
          ) : undefined
        }
      >
        Portly could not read its encryption key (for example after restoring the data folder on another PC or Windows
        account). Accounts, Todoist and ICS calendar subscriptions are paused. Resetting deletes every stored password, token and
        subscription address and creates a new key; you then reconnect your accounts and re-enter your ICS feed addresses.
        {mainPc ? '' : ' Reset them on the main PC, in its Settings → Accounts.'}
      </Banner>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Reset all stored credentials?"
        description={`Every saved password, token and OAuth client secret is deleted and a new encryption key is created. Your accounts stay listed but need to be reconnected.${icsNote} This cannot be undone.`}
        confirmLabel="Reset credentials"
        destructive
        onConfirm={async () => {
          try {
            await reset.mutateAsync();
            toast.success('Credentials were reset. Reconnect your accounts to resume syncing.');
          } catch (error) {
            toastError(error, 'The credentials could not be reset.');
            throw error;
          }
        }}
      />
    </>
  );
}
