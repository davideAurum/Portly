/**
 * App-wide notices under the header. Which ones apply depends on this page load's backend:
 *
 * - `browser` (the Pages build with its data in this browser): the in-browser backend could not
 *   load the stored data, another tab closed its database, or nothing can be saved (memory only).
 * - Pages build, either backend: a backend switch waits for the page to be idle ("Switch now";
 *   switching reloads the page, so it waits while a dialog is open, the layout is edited or the
 *   user is typing in a field).
 * - `server` in the Pages build (Portly on this PC): reconnecting to it, with the last saved
 *   data shown (no Reload: the controller reconnects or switches by itself).
 * - Every backend: the backend is unreachable (cached data is shown), and the credential vault is
 *   locked (§4.6 — accounts and Todoist are paused until it is reset in Settings → Accounts).
 */
import { isApiError } from '../api/client.ts';
import { useHealth } from '../api/about.ts';
import { getCapabilities } from '../capabilities.ts';
import { localServerActions, useLocalServer } from '../localServer/store.ts';
import type { PendingSwitch, PendingSwitchReason } from '../localServer/types.ts';
import { Banner } from '../ui/Banner.tsx';
import { Button } from '../ui/Button.tsx';
import styles from './Shell.module.css';
import { useStaticBackendStatus } from './staticStatus.ts';

function ReloadButton() {
  return (
    <Button size="sm" onClick={() => window.location.reload()}>
      Reload
    </Button>
  );
}

/**
 * Why a backend switch waits, and where it goes (this banner and the local server panel). Here,
 * not in the panel: the shell is in the main bundle, the panel loads only in the Pages build.
 */
export function pendingSwitchText(pending: PendingSwitch): string {
  const where = pending.target === 'server' ? 'Portly on this PC' : 'the copy saved in this browser';
  return `This page switches to ${where} when you're done: switching reloads the page, so it waits while a dialog is open, you're editing the layout or typing.`;
}

const SWITCH_TITLES: Readonly<Record<PendingSwitchReason, string>> = Object.freeze({
  connected: 'Portly on this PC is ready',
  unreachable: "Portly on this PC isn't reachable",
  revoked: 'Portly on this PC no longer accepts this browser',
  'other-server': 'A different Portly is running on this PC',
  incompatible: "Portly on this PC can't work with this version of the site",
  blocked: 'Your browser blocked access to Portly on this PC',
  disconnected: 'This browser was disconnected from Portly on this PC',
});

function PendingSwitchBanner({ pending }: { pending: PendingSwitch }) {
  return (
    <Banner
      tone={pending.target === 'server' ? 'info' : 'warning'}
      title={SWITCH_TITLES[pending.reason]}
      actions={
        <Button size="sm" variant="primary" onClick={() => localServerActions.switchNow()}>
          Switch now
        </Button>
      }
    >
      {pendingSwitchText(pending)}
    </Banner>
  );
}

export function StatusBanners({ onAccountsPage }: { onAccountsPage: boolean }) {
  const caps = getCapabilities();
  const health = useHealth();
  const staticBackend = useStaticBackendStatus();
  const localServer = useLocalServer();

  const pending = caps.pagesBuild ? localServer.pendingSwitch : null;
  if (pending !== null) {
    return (
      <div className={styles.banners}>
        <PendingSwitchBanner pending={pending} />
      </div>
    );
  }

  if (caps.backend === 'browser' && staticBackend?.state === 'failed') {
    return (
      <div className={styles.banners}>
        <Banner tone="danger" title="Portly couldn't load its saved data" actions={<ReloadButton />}>
          Its storage in this browser could not be opened, so you're seeing the last data shown here and changes can't be saved.
          Reload the page to try again. If this keeps happening, the device may be out of space.
        </Banner>
      </div>
    );
  }

  if (caps.backend === 'browser' && staticBackend?.state === 'closed') {
    return (
      <div className={styles.banners}>
        <Banner tone="warning" title="Reload to keep saving changes" actions={<ReloadButton />}>
          Portly was updated or its data was cleared in another tab, so this tab can no longer save. Reload the page to continue.
        </Banner>
      </div>
    );
  }

  if (caps.backend === 'browser' && staticBackend?.state === 'ready' && staticBackend.storage === 'memory') {
    return (
      <div className={styles.banners}>
        <Banner tone="warning" title="Nothing can be saved in this browser">
          Portly couldn't open its browser storage (private browsing or blocked site data), so changes last only until this
          tab closes. Export your settings before leaving if you want to keep them.
        </Banner>
      </div>
    );
  }

  if (caps.remoteServer && localServer.status === 'reconnecting') {
    return (
      <div className={styles.banners}>
        <Banner tone="warning" title="Reconnecting to Portly on this PC — showing the last saved data">
          Portly on this PC stopped answering. If it doesn't come back soon, this page switches to the copy saved in this browser.
        </Banner>
      </div>
    );
  }

  if (health.isError && isApiError(health.error, 'network_error')) {
    return (
      <div className={styles.banners}>
        {caps.backend === 'browser' ? (
          <Banner tone="warning" title="Portly couldn't load its data" actions={<ReloadButton />}>
            You're seeing the last saved data. Reload the page to try again.
          </Banner>
        ) : caps.remoteServer ? (
          <Banner tone="warning" title="Can't reach Portly on this PC">
            You're seeing the last saved data. It will refresh when Portly on this PC is back.
          </Banner>
        ) : (
          <Banner tone="warning" title="Can't reach the Portly server">
            You're seeing the last saved data. It will refresh when the server is back.
          </Banner>
        )}
      </div>
    );
  }

  if (health.data?.vault === 'locked' && !onAccountsPage) {
    return (
      <div className={styles.banners}>
        <Banner
          tone="warning"
          title="Saved credentials are locked"
          actions={
            <a className={styles.bannerLink} href="#/settings/accounts">
              Review in settings
            </a>
          }
        >
          Portly couldn't unlock its credential store, so connected accounts and Todoist are paused. Everything else keeps working.
        </Banner>
      </div>
    );
  }

  return null;
}
