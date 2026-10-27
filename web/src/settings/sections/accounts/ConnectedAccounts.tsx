/**
 * "Connected accounts" (§7 Accounts): one row per account (name, email, status, the services in
 * use as chips; Manage, Reconnect for OAuth accounts, Test and Remove), plus Todoist and GitHub
 * (launch pad sync) while their tokens are saved. Manage renames, recolors and switches services on and off; for Google and
 * Microsoft it can also add a service the account was not granted, by signing in again for the
 * extra scopes (incremental consent). Switching a service off never revokes anything at the
 * provider.
 */
import { useState, type FormEvent } from 'react';
import { FlaskConical, LogIn, Plus, Settings2, Trash, UserRoundPlus } from 'lucide-react';
import { CAPABILITIES, type Account, type Capability } from '@portly/shared';
import { useAccounts, useDeleteAccount, useStartOAuth, useTestAccount, useUpdateAccount } from '../../../api/accounts.ts';
import { useGistToken } from '../../../api/gistSync.ts';
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
import { GitHubGistRow } from './GitHubGist.tsx';
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
  const githubConnected = useGistToken().data?.configured === true;
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
            <AccountRow account={account} onManage={() => setManaging(account.id)} />
          </li>
        ))}
        {todoistConnected ? (
          <li>
            <TodoistRow onManage={onManageTodoist} />
          </li>
        ) : null}
        {githubConnected ? (
          <li>
            <GitHubGistRow />
          </li>
        ) : null}
      </ul>
    );
  }

  return (
    <SettingsCard title="Connected accounts">
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

function AccountRow({ account, onManage }: { account: Account; onManage(): void }) {
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
        description={
          account.kind === 'google'
            ? 'Portly deletes its stored tokens, calendars and cached events for this account and asks Google to revoke access.'
            : 'Portly deletes its stored credentials, calendars and cached events for this account. Nothing is deleted at the provider.'
        }
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

  const toggle = (capability: Capability, on: boolean) => {
    const next = on ? [...new Set([...account.enabledCapabilities, capability])] : account.enabledCapabilities.filter((c) => c !== capability);
    update.mutate({ id: account.id, enabledCapabilities: CAPABILITIES.filter((c) => next.includes(c)) });
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
        {CAPABILITIES.filter((c) => account.capabilities.includes(c)).map((capability) => (
          <li key={capability} className={styles.serviceRow}>
            <Switch
              className={styles.grow}
              label={CAPABILITY_LABELS[capability]}
              description={serviceDescription(account.kind, capability)}
              checked={account.enabledCapabilities.includes(capability)}
              onCheckedChange={(on) => toggle(capability, on)}
            />
          </li>
        ))}
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
              disabled={locked || adding !== null}
              onClick={() => add(service.capability)}
              aria-label={`Add ${service.label}`}
            >
              Add
            </Button>
          </li>
        ))}
      </ul>
    </FieldGroup>
  );
}
