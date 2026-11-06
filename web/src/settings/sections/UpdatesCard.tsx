/**
 * Updates (ARCHITECTURE §18, design/update-button.md), a card in Settings → About wherever a server
 * answers: whether a newer release exists, and how an update went.
 *
 * Starting an update belongs to Portly's own page, the one the server serves: the server refuses
 * the Pages site on any PC, because the site and the releases are published from one GitHub
 * account. So the Pages site shows the same state with a link to that page instead of the button:
 * the server's page on the main PC, its Tailscale address on another PC.
 *
 * Portly's own page stays on its server while it updates, so it can follow the whole run: the steps
 * while the server answers, a calm line while it is away, the result when it is back, then a reload
 * so the page matches the server. A Pages site that answers 403 or 404 has a server older than the
 * button, and the card stays away.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { isUpdateRunActive, type UpdateRun, type UpdateRunCode, type UpdateStatusResponse } from '@portly/shared';
import { isApiError } from '../../api/client.ts';
import { qk } from '../../api/keys.ts';
import { useCheckForUpdate, useStartUpdate, useUpdateStatus } from '../../api/update.ts';
import { getCapabilities } from '../../capabilities.ts';
import { useLocalServer } from '../../localServer/store.ts';
import type { LocalServerState } from '../../localServer/types.ts';
import { Banner } from '../../ui/Banner.tsx';
import { Button } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/Dialog.tsx';
import { ErrorState } from '../../ui/ErrorState.tsx';
import { ExternalLink } from '../../ui/ExternalLink.tsx';
import { SettingsCard } from '../../ui/Section.tsx';
import { Spinner } from '../../ui/Spinner.tsx';
import styles from '../../styles/settings.module.css';

/** With no answer for this long while an update runs, it is no longer just restarting. */
export const NO_ANSWER_LIMIT_MS = 5 * 60 * 1000;
/** How long the result stays up before the page reloads to match the server. */
export const RELOAD_DELAY_MS = 3_000;

const reloadPage = (): void => window.location.reload();

const STEPS: Readonly<Record<'requested' | 'downloading' | 'installing' | 'restarting', string>> = {
  requested: 'Starting the update',
  downloading: 'Downloading',
  installing: 'Installing',
  restarting: 'Restarting Portly',
};

const FAILURES: Readonly<Record<UpdateRunCode, ReactNode>> = {
  download_failed: 'The download failed.',
  checksum_mismatch: 'The download was damaged, so nothing was installed.',
  file_in_use: 'A file in use stopped the update, so nothing changed.',
  not_newer: 'There was nothing newer to install.',
  did_not_start: (
    <>
      Portly did not start after the update. Check the main PC with <code>portly --status</code>.
    </>
  ),
  unknown: 'The update stopped before it finished.',
};

function stepOf(run: UpdateRun): string {
  return run.state in STEPS ? STEPS[run.state as keyof typeof STEPS] : STEPS.requested;
}

/** Portly's own page for this browser, where an update starts; null when its address is unknown. */
export function ownPageUrl(state: Pick<LocalServerState, 'server' | 'remoteOrigin'>): string | null {
  const page = state.remoteOrigin != null ? `${state.remoteOrigin}/` : (state.server?.appUrl ?? null);
  return page === null ? null : `${page}#/settings/about`;
}

/** Why this install has no Update button, and what to do instead; null when it has one. */
function unavailable(status: UpdateStatusResponse): ReactNode {
  if (status.availability === 'checkout') {
    return (
      <>
        This is a Git checkout. Use <code>portly --rebuild</code>.
      </>
    );
  }
  if (status.availability === 'unsupervised') {
    return (
      <>
        Portly was not started by its scheduled task. Use <code>portly --update</code> on the main PC.
      </>
    );
  }
  if (status.availability === 'no-task') {
    return (
      <>
        The updater is not set up. Run <code>portly --update --force</code> on the main PC.
      </>
    );
  }
  return null;
}

/** How the last run ended, while the server still reports it. */
function RunResult({ run, installed }: { run: UpdateRun; installed: string }) {
  if (run.state === 'done') {
    return (
      <Banner tone="success" title={`Updated to ${run.to ?? installed}`}>
        {run.extensionChanged ? 'Click Reload on Portly New Tab in chrome://extensions on the main PC.' : null}
      </Banner>
    );
  }
  if (run.state === 'rolled-back') {
    return (
      <Banner tone="warning" title={`${run.to ?? 'The new version'} did not start, so Portly went back to ${installed}`}>
        Your data was restored from the copy made before the update.
      </Banner>
    );
  }
  return (
    <Banner tone="danger" title={FAILURES[run.code ?? 'unknown']}>
      Portly is still on {installed}.
    </Banner>
  );
}

function RunProgress({ run, away, gaveUp }: { run: UpdateRun; away: boolean; gaveUp: boolean }) {
  if (gaveUp) {
    return (
      <Banner tone="warning" title="Portly has not come back">
        Check the main PC, or run <code>portly --status</code> there.
      </Banner>
    );
  }
  if (away) {
    return (
      <Banner title="Restarting Portly">It is away for a moment while it updates, so a notice that it can't be reached is normal here.</Banner>
    );
  }
  return <Banner title={stepOf(run)}>This takes about a minute. You can leave this page open.</Banner>;
}

export function UpdatesCard({ reload = reloadPage }: { reload?: () => void }) {
  const caps = getCapabilities();
  const localServer = useLocalServer();
  const queryClient = useQueryClient();
  const status = useUpdateStatus();
  const check = useCheckForUpdate();
  const start = useStartUpdate();
  const [confirming, setConfirming] = useState(false);

  const data = status.data;
  const run = data?.run ?? null;
  const active = run !== null && isUpdateRunActive(run);

  // A run this page followed to its end, never an old one it opened on.
  const followed = useRef(false);
  const finishedState = run?.state;
  useEffect(() => {
    if (active) {
      followed.current = true;
      return undefined;
    }
    if (!followed.current || finishedState !== 'done') return undefined;
    followed.current = false;
    void queryClient.invalidateQueries({ queryKey: qk.about() });
    // The Pages site is published separately, so a reload gains nothing there.
    if (caps.pagesBuild) return undefined;
    const timer = setTimeout(reload, RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active, finishedState, caps.pagesBuild, queryClient, reload]);

  if (data === undefined) {
    if (!status.isError) {
      return (
        <SettingsCard id="updates" title="Updates">
          <span className={styles.inlineRow}>
            <Spinner size={16} /> Checking for updates
          </span>
        </SettingsCard>
      );
    }
    if (isApiError(status.error) && (status.error.status === 403 || status.error.status === 404)) return null;
    return (
      <SettingsCard id="updates" title="Updates">
        <ErrorState error={status.error} onRetry={() => void status.refetch()} compact />
      </SettingsCard>
    );
  }

  const away = active && status.isError;
  // Read from the query, not the clock: each failed poll then renders this again.
  const gaveUp = away && status.errorUpdatedAt - status.dataUpdatedAt > NO_ANSWER_LIMIT_MS;
  const notReady = unavailable(data);
  const ownPage = !caps.pagesBuild;
  const offerable = notReady === null && !active && data.updateAvailable && data.latest !== null;

  let description: ReactNode = `Portly ${data.installed} is the latest release.`;
  if (notReady !== null) description = notReady;
  else if (active) description = run.to === null ? 'Updating Portly.' : `Updating to ${run.to}.`;
  else if (offerable) description = `Portly ${data.latest} is available.`;
  else if (data.checkFailed) description = 'Could not reach GitHub.';

  const checkAgain = (
    <Button size="sm" icon={RefreshCw} loading={check.isPending} onClick={() => check.mutate()}>
      Check again
    </Button>
  );
  const ownPageLink = ownPageUrl(localServer);
  let action: ReactNode = notReady === null && !active ? checkAgain : null;
  if (offerable) {
    action = ownPage ? (
      <Button size="sm" variant="primary" icon={Download} onClick={() => setConfirming(true)}>
        {run?.state === 'failed' ? 'Try again' : 'Update'}
      </Button>
    ) : ownPageLink !== null ? (
      <ExternalLink href={ownPageLink} showIcon>
        Open Portly's own page
      </ExternalLink>
    ) : null;
  }

  return (
    <SettingsCard id="updates" title="Updates" description={description} actions={action}>
      {run !== null ? (
        active ? (
          <RunProgress run={run} away={away} gaveUp={gaveUp} />
        ) : (
          <RunResult run={run} installed={data.installed} />
        )
      ) : null}
      {offerable && data.notesUrl !== null ? (
        <p className={styles.intro}>
          <ExternalLink href={data.notesUrl} showIcon>
            What's new in {data.latest}
          </ExternalLink>
        </p>
      ) : null}
      {offerable && !ownPage ? (
        <p className={styles.intro}>
          {ownPageLink === null ? (
            <>
              Run <code>portly --update</code> on the main PC.
            </>
          ) : (
            `Updates start from Portly's own page, not from this site.${
              caps.remoteClient ? ' The first time, this PC connects there and the main PC approves it.' : ''
            }`
          )}
        </p>
      ) : null}
      {data.latest !== null ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Update Portly to ${data.latest}?`}
          confirmLabel="Update"
          onConfirm={async () => {
            // A refusal is reported by the mutation, and the dialog closes on what is true now.
            await start.mutateAsync(data.latest ?? '').catch(() => undefined);
          }}
        >
          <p className={styles.intro}>
            Portly will stop for about a minute while it updates, on every PC using it. Your data is copied first.
            {caps.remoteClient ? ' If it does not come back, you will need to fix it on the main PC.' : ''}
          </p>
        </ConfirmDialog>
      ) : null}
    </SettingsCard>
  );
}
