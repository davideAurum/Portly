/**
 * "Connected accounts" (§7 Accounts): one row per account (name, email, status, the services in
 * use as chips; Manage, Reconnect for OAuth accounts, Test and Remove), plus Todoist and GitHub
 * (launch pad sync) while their tokens are saved. Manage renames, recolors and switches services
 * on and off; for Google and Microsoft it can also add a service the account was not granted, by
 * signing in again for the extra scopes (incremental consent). Switching a service off never
 * revokes anything at the provider.
 *
 * Launch pad sync (browser backend): the connection that syncs shows its status line
 * (`LaunchpadSync.tsx`). A browser syncs through one connection: switching the service on while
 * another Microsoft connection has it offers to move it; while GitHub syncs it is refused. Adding
 * the service to a connection first says what Microsoft will ask for (the app folder only).
 */
import { useState, type FormEvent } from 'react';
import { FlaskConical, LogIn, Plus, Settings2, Trash, UserRoundPlus } from 'lucide-react';
import { CAPABILITIES, type Account, type Capability } from '@portly/shared';
import { useAccounts, useDeleteAccount, useStartOAuth, useTestAccount, useUpdateAccount } from '../../../api/accounts.ts';
import { useGitHubSync } from '../../../api/githubSync.ts';
import { useLaunchpadSync, type LaunchpadSyncInfo } from '../../../api/launchpadSync.ts';
import { useTodoistToken } from '../../../api/todoist.ts';
import { getCapabilities } from '../../../capabilities.ts';
import { accountColor } from '../../../ui/accounts/AccountBadge.tsx';
import { ACCOUNT_KIND_LABELS, CAPABILITY_ICONS, CAPABILITY_LABELS, reconnectsWithOAuth } from '../../../ui/accounts/accountKinds.ts';
import { Badge, LetterTile } from '../../../ui/Badge.tsx';
import { Button, IconButton } from '../../../ui/Button.tsx';
import { ColorPickerPopover } from '../../../ui/ColorPicker.tsx';
import { ConfirmDialog, Dialog } from '../../../ui/Dialog.tsx';
import { EmptyState } from '../../../ui/EmptyState.tsx';
import { ErrorState } from '../../../ui/ErrorState.tsx';
import { Field, FieldGroup } from '../../../ui/Field.tsx';
import { Input } from '../../../ui/Input.tsx';
import { SettingsCard } from '../../../ui/Section.tsx';
import { SkeletonList } from '../../../ui/Skeleton.tsx';
import { toast, toastError } from '../../../ui/toast.ts';
import { Switch } from '../../../ui/Toggles.tsx';
import { connectionServices, serviceDescription } from './connections.ts';
import { summarizeProbes } from './CredentialForms.tsx';
import { GitHubSyncRow } from './GitHubSync.tsx';
import { LaunchpadSyncNotices, SyncStatusLine, otherSyncConnection, useSyncConnections } from './LaunchpadSync.tsx';
import { TodoistRow } from './Todoist.tsx';
import { useVaultLocked } from './vault.ts';
import styles from '../../../styles/settings.module.css';

const RETURN_TO = '#/settings/accounts';

export function ConnectedAccounts({ onManageTodoist }: { onManageTodoist(): void }) {
  const accounts = useAccounts();
  const todoist = useTodoistToken();
  const [managing, setManaging] = useState<string | null>(null);
  const list = [...(accounts.data ?? [])].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
  const todoistConnected = todoist.data?.configured === true;
  const githubConnected = useGitHubSync().data?.configured === true;
  const sync = useLaunchpadSync().data;
  const managed = list.find((a) => a.id === managing);

  let body;
  if (accounts.data === undefined) {
    body = accounts.isError ? <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} /> : <SkeletonList rows={2} />;
  } else if (list.length === 0 && !todoistConnected && !githubConnected) {
    body = (
      <EmptyState
        icon={UserRoundPlus}
        title="No accounts yet"
        body={
          getCapabilities().googleAccounts
            ? 'Connect Google, Microsoft, Yahoo, Todoist, a CalDAV server or an IMAP mailbox below to see your calendars, mail and tasks.'
            : getCapabilities().remoteClient
              ? 'Connect Yahoo, Todoist, a CalDAV server or an IMAP mailbox below to see your calendars, mail and tasks. Google and Microsoft accounts are connected on the main PC.'
              : 'Connect Microsoft (Outlook.com) or Todoist below to see your calendars and tasks.'
        }
      />
    );
  } else {
    body = (
      <ul className={styles.list} aria-label="Connected accounts">
        {list.map((account) => (
          <li key={account.id}>
            <AccountRow
              account={account}
              sync={sync?.connection?.kind === 'microsoft' && sync.connection.accountId === account.id ? sync : null}
              onManage={() => setManaging(account.id)}
            />
          </li>
        ))}
        {todoistConnected ? (
          <li>
            <TodoistRow onManage={onManageTodoist} />
          </li>
        ) : null}
        {githubConnected ? (
          <li>
            <GitHubSyncRow sync={sync?.connection?.kind === 'github' ? sync : null} />
          </li>
        ) : null}
      </ul>
    );
  }

  return (
    <SettingsCard title="Connected accounts">
      <LaunchpadSyncNotices />
      {body}
      <Dialog
        open={managed !== undefined}
        onOpenChange={(open) => {
          if (!open) setManaging(null);
        }}
        title={managed ? `Manage ${managed.label}` : ''}
        description={managed ? [ACCOUNT_KIND_LABELS[managed.kind], managed.email].filter(Boolean).join(' · ') : undefined}
        size="lg"
      >
        {managed ? <ManageAccount account={managed} /> : null}
      </Dialog>
    </SettingsCard>
  );
}

function StatusBadge({ account }: { account: Account }) {
  if (account.status === 'reauth') return <Badge tone="warning">Reconnect needed</Badge>;
  if (account.status === 'error') return <Badge tone="danger">Error</Badge>;
  if (account.statusMessage) return <Badge tone="neutral">{account.statusMessage}</Badge>;
  return (
    <Badge tone="success" dot>
      Connected
    </Badge>
  );
}

/** The services switched on, as chips. */
function ServiceChips({ account }: { account: Account }) {
  if (account.capabilities.length === 0) return <span className={styles.itemMeta}>No calendar or mail access was granted.</span>;
  const enabled = CAPABILITIES.filter((c) => account.enabledCapabilities.includes(c) && account.capabilities.includes(c));
  if (enabled.length === 0) return <span className={styles.itemMeta}>Nothing switched on. Turn a service on under Manage.</span>;
  return (
    <ul className={styles.serviceChips} aria-label={`${account.label} services in use`}>
      {enabled.map((capability) => {
        const Icon = CAPABILITY_ICONS[capability];
        return (
          <li key={capability} className={styles.serviceChip}>
            <Icon aria-hidden="true" />
            {CAPABILITY_LABELS[capability]}
          </li>
        );
      })}
    </ul>
  );
}

function AccountRow({ account, sync, onManage }: { account: Account; sync: LaunchpadSyncInfo | null; onManage(): void }) {
  const locked = useVaultLocked();
  const remove = useDeleteAccount();
  const test = useTestAccount();
  const start = useStartOAuth();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const runTest = async () => {
    try {
      const { results } = await test.mutateAsync(account.id);
      const summary = summarizeProbes(results);
      if (!summary.checked) toast.info(`There is nothing to test for ${account.label} yet.`);
      else if (summary.ok) toast.success(`${account.label} is working.`, { description: summary.text });
      else toast.error(`${account.label} has a problem.`, { description: summary.text });
    } catch (error) {
      toastError(error, 'The test could not run.');
    }
  };

  return (
    <div className={styles.accountRow}>
      <LetterTile label={account.label} color={accountColor(account)} size={36} />
      <div className={styles.accountMain}>
        <div className={styles.accountName}>
          <span>{account.label}</span>
          <StatusBadge account={account} />
        </div>
        <span className={styles.itemMeta}>
          {ACCOUNT_KIND_LABELS[account.kind]}
          {account.email ? ` · ${account.email}` : ''}
        </span>
        {account.status !== 'ok' && account.statusMessage ? <span className={styles.itemMeta}>{account.statusMessage}</span> : null}
        {account.status === 'reauth' && !reconnectsWithOAuth(account.kind) ? (
          <span className={styles.itemMeta}>To reconnect, add this account again under “Add a connection” with its current password.</span>
        ) : null}
        {account.status === 'reauth' && reconnectsWithOAuth(account.kind) && getCapabilities().remoteClient ? (
          <span className={styles.itemMeta}>Reconnect it on the main PC, in its Settings → Accounts.</span>
        ) : null}
        <ServiceChips account={account} />
        {sync ? <SyncStatusLine info={sync} /> : null}
      </div>
      <div className={styles.itemActions}>
        <Button size="sm" variant="secondary" icon={Settings2} onClick={onManage} aria-label={`Manage ${account.label}`}>
          Manage
        </Button>
        {reconnectsWithOAuth(account.kind) && !getCapabilities().remoteClient ? (
          <Button
            size="sm"
            variant={account.status === 'reauth' ? 'primary' : 'ghost'}
            icon={LogIn}
            loading={start.isPending}
            disabled={locked}
            onClick={() => start.mutate({ provider: account.kind as 'google' | 'microsoft', accountId: account.id, returnTo: RETURN_TO })}
          >
            Reconnect
          </Button>
        ) : null}
        <IconButton icon={FlaskConical} size="sm" aria-label={`Test ${account.label}`} loading={test.isPending} onClick={() => void runTest()} />
        <IconButton icon={Trash} size="sm" aria-label={`Remove ${account.label}`} onClick={() => setConfirmRemove(true)} />
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${account.label}?`}
        description={[
          account.kind === 'google'
            ? 'Portly deletes its stored tokens, calendars and cached events for this account and asks Google to revoke access.'
            : 'Portly deletes its stored credentials, calendars and cached events for this account. Nothing is deleted at the provider.',
          account.enabledCapabilities.includes('launchpadSync')
            ? 'Launch pad sync stops in this browser. Your launch pad stays here, and the synced copy stays in your OneDrive.'
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        confirmLabel="Remove account"
        destructive
        onConfirm={async () => {
          await remove.mutateAsync(account.id);
          toast.success(`${account.label} removed.`);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manage
// ---------------------------------------------------------------------------

function ManageAccount({ account }: { account: Account }) {
  const update = useUpdateAccount();
  return (
    <div className={styles.dialogStack}>
      <RenameForm account={account} />
      <Field label="Color" help="The dot next to this account's events and mail.">
        <ColorPickerPopover label={`${account.label} color`} value={accountColor(account)} onChange={(color) => update.mutate({ id: account.id, color })} />
      </Field>
      <ServiceSwitches account={account} />
    </div>
  );
}

function RenameForm({ account }: { account: Account }) {
  const update = useUpdateAccount();
  const [label, setLabel] = useState(account.label);
  const [error, setError] = useState<string | null>(null);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (trimmed.length === 0 || trimmed.length > 100) {
      setError('Use 1–100 characters.');
      return;
    }
    setError(null);
    if (trimmed !== account.label) {
      update.mutate({ id: account.id, label: trimmed }, { onSuccess: () => toast.success('Account renamed.') });
    }
  };

  return (
    <form className={styles.inlineForm} onSubmit={save} aria-label="Rename the account">
      <Field label="Account name" error={error} className={styles.grow}>
        <Input value={label} maxLength={120} onChange={(event) => setLabel(event.currentTarget.value)} />
      </Field>
      <Button type="submit" disabled={label.trim() === account.label}>
        Rename
      </Button>
    </form>
  );
}

/** Switches for the granted services; for Google and Microsoft, the services that can still be added. */
function ServiceSwitches({ account }: { account: Account }) {
  const update = useUpdateAccount();
  const start = useStartOAuth();
  const locked = useVaultLocked();
  const oauth = reconnectsWithOAuth(account.kind);
  // Adding a service signs in again, which happens on the main PC.
  const addable =
    oauth && !getCapabilities().remoteClient
      ? connectionServices(account.kind as 'google' | 'microsoft').filter((s) => !account.capabilities.includes(s.capability))
      : [];
  const [adding, setAdding] = useState<Capability | null>(null);
  // Launch pad sync: one connection per browser, and a word on the permission before signing in.
  const connections = useSyncConnections();
  const syncElsewhere = otherSyncConnection(connections, { accountId: account.id });
  const githubSyncs = connections.github;
  const [moving, setMoving] = useState<Account | null>(null);
  const [explaining, setExplaining] = useState(false);

  const enabledWith = (capability: Capability, on: boolean, list: readonly Capability[]) => {
    const next = on ? [...new Set([...list, capability])] : list.filter((c) => c !== capability);
    return CAPABILITIES.filter((c) => next.includes(c));
  };

  const toggle = (capability: Capability, on: boolean) => {
    if (capability === 'launchpadSync' && on && syncElsewhere !== null) {
      const other = connections.accounts.find((a) => a.id !== account.id);
      if (!githubSyncs && other) setMoving(other);
      return;
    }
    // useUpdateAccount reports a failure itself.
    update.mutate({ id: account.id, enabledCapabilities: enabledWith(capability, on, account.enabledCapabilities) });
  };

  /** Launch pad sync off on the other connection, then on here: a first sync with this account's OneDrive. */
  const move = async (from: Account) => {
    // useUpdateAccount reports a failure itself; the dialog stays open.
    await update.mutateAsync({ id: from.id, enabledCapabilities: enabledWith('launchpadSync', false, from.enabledCapabilities) });
    await update.mutateAsync({ id: account.id, enabledCapabilities: enabledWith('launchpadSync', true, account.enabledCapabilities) });
    toast.success(`Launch pad sync now uses ${account.label}.`);
  };

  const add = (capability: Capability) => {
    setAdding(capability);
    start.mutate(
      { provider: account.kind as 'google' | 'microsoft', accountId: account.id, capabilities: [capability], returnTo: RETURN_TO },
      { onSettled: () => setAdding(null) },
    );
  };

  return (
    <FieldGroup
      legend="Services"
      description="What Portly uses this account for. Switching a service off only stops Portly using it; nothing changes at the provider."
    >
      {account.capabilities.length === 0 && addable.length === 0 ? <p className={styles.intro}>No calendar or mail access was granted.</p> : null}
      <ul className={styles.serviceList}>
        {CAPABILITIES.filter((c) => account.capabilities.includes(c)).map((capability) => {
          const blocked = capability === 'launchpadSync' && githubSyncs && !account.enabledCapabilities.includes(capability);
          return (
            <li key={capability} className={styles.serviceRow}>
              <Switch
                className={styles.grow}
                label={CAPABILITY_LABELS[capability]}
                description={
                  blocked
                    ? `${serviceDescription(account.kind, capability)} Launch pad sync uses GitHub in this browser: remove GitHub first.`
                    : serviceDescription(account.kind, capability)
                }
                checked={account.enabledCapabilities.includes(capability)}
                disabled={blocked}
                onCheckedChange={(on) => toggle(capability, on)}
              />
            </li>
          );
        })}
        {addable.map((service) => (
          <li key={service.capability} className={styles.serviceRow} data-addable="true">
            <span className={styles.serviceText}>
              <span className={styles.serviceLabel}>{service.label}</span>
              <span className={styles.itemMeta}>{service.description} Adding it opens the sign-in again to ask for it.</span>
            </span>
            <Button
              size="sm"
              icon={Plus}
              loading={adding === service.capability}
              disabled={locked || adding !== null || (service.capability === 'launchpadSync' && syncElsewhere !== null)}
              onClick={() => (service.capability === 'launchpadSync' ? setExplaining(true) : add(service.capability))}
              aria-label={`Add ${service.label}`}
            >
              Add
            </Button>
            {service.capability === 'launchpadSync' && syncElsewhere !== null ? (
              <span className={styles.itemMeta}>Launch pad sync uses {syncElsewhere} in this browser: turn it off there first.</span>
            ) : null}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={moving !== null}
        onOpenChange={(open) => {
          if (!open) setMoving(null);
        }}
        title={`Move launch pad sync to ${account.label}?`}
        description={
          moving
            ? `A browser syncs through one connection. Launch pad sync stops on ${moving.label} and syncs with ${account.label}’s OneDrive instead. If that launch pad differs from this browser’s, Portly asks which one to keep.`
            : undefined
        }
        confirmLabel="Move launch pad sync"
        onConfirm={() => (moving ? move(moving) : undefined)}
      />
      <ConfirmDialog
        open={explaining}
        onOpenChange={setExplaining}
        title="Add launch pad sync?"
        description="Microsoft asks you to allow one more permission: Portly's own folder in your OneDrive (Apps, then the folder named after your app registration). Portly can't see anything else in your OneDrive. You'll come back here after signing in."
        confirmLabel="Continue to Microsoft"
        onConfirm={() => add('launchpadSync')}
      />
    </FieldGroup>
  );
}
