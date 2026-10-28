/**
 * Launch pad sync on the Accounts page (docs/design/launchpad-sync.md sections 6.6, 6.10 and 10),
 * browser backend only:
 *
 * - {@link SyncStatusLine}: on the card of the connection that syncs (a Microsoft connection with
 *   the service on, or the GitHub row): the status, when it last synced, **Sync now**, and details
 *   (when a change last came in and went out, where the files are, Open Diagnostics on errors).
 *   It also asks the first-sync question when this browser and the synced file both have a launch
 *   pad (default: use the synced one); closed, **Choose** asks again.
 * - {@link LaunchpadSyncNotices}: once per page, the warning when more than one sync connection is
 *   set up (nothing syncs then).
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw, TriangleAlert } from 'lucide-react';
import type { Account } from '@portly/shared';
import { useAccounts } from '../../../api/accounts.ts';
import { useGitHubSync } from '../../../api/githubSync.ts';
import { useLaunchpadSync, useSyncNow, type FirstSyncChoice, type LaunchpadSyncInfo } from '../../../api/launchpadSync.ts';
import { getCapabilities } from '../../../capabilities.ts';
import { useFormatters } from '../../../lib/format.ts';
import { Badge } from '../../../ui/Badge.tsx';
import { Banner } from '../../../ui/Banner.tsx';
import { Button } from '../../../ui/Button.tsx';
import { Dialog } from '../../../ui/Dialog.tsx';
import { FormFooter } from '../../../ui/Section.tsx';
import { toast, toastError } from '../../../ui/toast.ts';
import styles from '../../../styles/settings.module.css';

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

/** Problem codes as the page says them (`SyncStoreError` codes and the file checks). */
const PROBLEMS: Readonly<Record<string, string>> = Object.freeze({
  network_error: 'Portly could not reach the sync storage.',
  rate_limited: 'The sync storage is limiting requests.',
  too_large: 'The launch pad is too large to sync.',
  unavailable: 'The sync storage did not answer as expected.',
  internal: 'Something went wrong in this browser.',
});

function problemText(problem: string | null): string {
  return (problem !== null && PROBLEMS[problem]) || 'The synced launch pad could not be read.';
}

/** The status in a few words, its tone, and what to do about it (if anything). */
export function syncStatus(info: LaunchpadSyncInfo): { label: string; tone: Tone; help: string | null } {
  if (info.running) return { label: 'Syncing…', tone: 'neutral', help: null };
  const github = info.connection?.kind === 'github';
  switch (info.status) {
    case 'off':
      return { label: 'Not synced yet', tone: 'neutral', help: 'It syncs within a few seconds, or press Sync now.' };
    case 'up_to_date':
      return info.waiting ? { label: 'Changes waiting to upload', tone: 'neutral', help: null } : { label: 'Up to date', tone: 'success', help: null };
    case 'needs_choice':
      return { label: 'Waiting for your choice', tone: 'warning', help: 'This browser and the synced launch pad are different: choose which one to keep.' };
    case 'paused_reauth':
      return {
        label: 'Paused',
        tone: 'warning',
        help: github
          ? 'GitHub refused the token or the repository. Save a new token under Manage, or make the repository private again, then press Sync now.'
          : 'Reconnect the account to sync again.',
      };
    case 'several_sources':
      return { label: 'Set up twice', tone: 'warning', help: 'Nothing syncs while more than one connection has launch pad sync.' };
    case 'stopped_newer':
      return { label: 'Stopped', tone: 'danger', help: 'The synced launch pad was written by a newer Portly. Reload the page to update Portly in this browser.' };
    case 'refused':
      return { label: 'Stopped', tone: 'danger', help: `${problemText(info.problem)} It is left as it is; Diagnostics has the details.` };
    case 'busy':
      return { label: 'Trying again later', tone: 'warning', help: 'Other browsers kept saving at the same moment.' };
    case 'error':
      return { label: 'Error', tone: 'danger', help: problemText(info.problem) };
  }
}

/** Where the synced files are, for the details. */
function whereStored(info: LaunchpadSyncInfo): string {
  return info.connection?.kind === 'github'
    ? 'In your private GitHub repository: launchpad.json and the launchpad-icons folder. Every change is a commit.'
    : 'In your OneDrive, under Apps, in the folder named after your Microsoft app registration.';
}

/** The status line of the connection that syncs, with Sync now and the details. */
export function SyncStatusLine({ info }: { info: LaunchpadSyncInfo }) {
  const fmt = useFormatters();
  const syncNow = useSyncNow();
  const [open, setOpen] = useState(false);
  const asking = info.status === 'needs_choice' && !info.running;
  const [askClosed, setAskClosed] = useState(false);
  // Asked again when the question comes back.
  useEffect(() => {
    if (!asking) setAskClosed(false);
  }, [asking]);
  const status = syncStatus(info);
  const canSync = info.status !== 'several_sources' && info.status !== 'stopped_newer' && !(info.status === 'paused_reauth' && info.connection?.kind === 'microsoft');

  const run = async () => {
    try {
      const next = await syncNow.mutateAsync(undefined);
      const after = syncStatus(next);
      if (next.status === 'up_to_date') toast.success('Launch pad synced.');
      else if (next.status !== 'needs_choice') toast.info(`Launch pad sync: ${after.label.toLowerCase()}.`, after.help ? { description: after.help } : undefined);
    } catch (error) {
      toastError(error, 'Launch pad sync could not run.');
    }
  };

  return (
    <div className={styles.syncStatus} role="group" aria-label="Launch pad sync">
      <div className={styles.syncStatusLine}>
        <span className={styles.itemMeta}>Launch pad sync</span>
        <Badge tone={status.tone} dot={status.tone === 'success'}>
          {status.label}
        </Badge>
        {info.syncedAt ? <span className={styles.itemMeta}>Last synced {fmt.relative(info.syncedAt)}</span> : null}
        {asking ? (
          <Button size="sm" variant="secondary" onClick={() => setAskClosed(false)}>
            Choose…
          </Button>
        ) : canSync ? (
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={syncNow.isPending || info.running} onClick={() => void run()}>
            Sync now
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" icon={open ? ChevronUp : ChevronDown} aria-expanded={open} onClick={() => setOpen(!open)}>
          Details
        </Button>
      </div>
      {status.help ? <span className={styles.itemMeta}>{status.help}</span> : null}
      {open ? (
        <dl className={styles.syncDetails}>
          <dt>Last synced</dt>
          <dd>{info.syncedAt ? fmt.dateTime(info.syncedAt) : 'Never'}</dd>
          <dt>Last change received</dt>
          <dd>{info.receivedAt ? fmt.dateTime(info.receivedAt) : 'None yet'}</dd>
          <dt>Last change sent</dt>
          <dd>{info.sentAt ? fmt.dateTime(info.sentAt) : 'None yet'}</dd>
          {info.retryAt ? (
            <>
              <dt>Next try</dt>
              <dd>{fmt.dateTime(info.retryAt)}</dd>
            </>
          ) : null}
          <dt>Stored</dt>
          <dd>{whereStored(info)}</dd>
          {status.tone === 'danger' ? (
            <>
              <dt>Problem</dt>
              <dd>
                <a href="#/settings/diagnostics">Open Diagnostics</a>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <FirstSyncDialog info={info} open={asking && !askClosed} onClose={() => setAskClosed(true)} />
    </div>
  );
}

/** The two-connection warning, once per Accounts page. */
export function LaunchpadSyncNotices() {
  const sync = useLaunchpadSync();
  const info = sync.data;
  if (!getCapabilities().launchpadSync || !info || info.connections <= 1) return null;
  return (
    <Banner tone="warning" icon={TriangleAlert} title="Launch pad sync is set up twice">
      A browser syncs through one connection. Nothing syncs until only one is left: turn Launch pad sync off on a Microsoft connection
      under Manage, or remove GitHub.
    </Banner>
  );
}

/** Both sides have a launch pad: keep the synced one (a backup of this browser's first) or replace it. */
function FirstSyncDialog({ info, open, onClose }: { info: LaunchpadSyncInfo; open: boolean; onClose(): void }) {
  const syncNow = useSyncNow();
  const [busy, setBusy] = useState<FirstSyncChoice | null>(null);

  const choose = async (choice: FirstSyncChoice) => {
    setBusy(choice);
    try {
      const next = await syncNow.mutateAsync(choice);
      if (next.status === 'up_to_date') {
        toast.success(choice === 'use_synced' ? 'This browser now uses the synced launch pad.' : 'The synced launch pad now has this browser’s.');
      } else {
        const after = syncStatus(next);
        toast.info(`Launch pad sync: ${after.label.toLowerCase()}.`, after.help ? { description: after.help } : undefined);
      }
    } catch (error) {
      toastError(error, 'Launch pad sync could not run.');
    } finally {
      setBusy(null);
    }
  };

  const where = info.connection?.kind === 'github' ? 'your GitHub repository' : info.connection ? `${info.connection.label}’s OneDrive` : 'the synced file';
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Which launch pad should this browser use?"
      description={`This browser and ${where} both have a launch pad, and they are different.`}
    >
      <div className={styles.dialogStack}>
        <ul className={styles.steps}>
          <li>
            <strong>Use the synced launch pad</strong> (recommended): this browser's groups and bookmarks are replaced. A backup of them is
            kept under Settings → Import &amp; export.
          </li>
          <li>
            <strong>Replace the synced launch pad with this browser's</strong>: every other browser that syncs takes this browser's launch
            pad next time (each keeps a backup, and its changes since its last sync).
          </li>
        </ul>
        <p className={styles.intro}>Sync waits until you choose. To decide later, close this and press Choose on the status line.</p>
        <FormFooter>
          <Button variant="secondary" loading={busy === 'replace_synced'} disabled={busy !== null} onClick={() => void choose('replace_synced')}>
            Replace the synced launch pad
          </Button>
          <Button variant="primary" loading={busy === 'use_synced'} disabled={busy !== null} onClick={() => void choose('use_synced')}>
            Use the synced launch pad
          </Button>
        </FormFooter>
      </div>
    </Dialog>
  );
}

/**
 * The sync connections this page knows of (design 6.10): Microsoft connections with the service
 * on, and whether GitHub is set up. The backend refuses a second one anyway (`409 conflict`).
 */
export function useSyncConnections(): { accounts: Account[]; github: boolean } {
  const accounts = useAccounts({ enabled: getCapabilities().launchpadSync });
  const github = useGitHubSync();
  return {
    accounts: (accounts.data ?? []).filter((a) => a.capabilities.includes('launchpadSync') && a.enabledCapabilities.includes('launchpadSync')),
    github: github.data?.configured === true,
  };
}

/** The connection that already syncs, other than the one asking: its name, or null. */
export function otherSyncConnection(connections: { accounts: Account[]; github: boolean }, except: { accountId?: string; github?: boolean }): string | null {
  if (connections.github && !except.github) return 'GitHub';
  return connections.accounts.find((a) => a.id !== except.accountId)?.label ?? null;
}
