/**
 * One line on where launch pad sync stands, for the launch pad's side of Settings (Bookmarks) and
 * the import preview (docs/design/launchpad-sync.md section 10). Shown only where launch pad sync
 * can run (this page's data lives in the browser).
 */
import { useLaunchpadSync, type LaunchpadSyncInfo } from '../../api/launchpadSync.ts';
import { getCapabilities } from '../../capabilities.ts';
import styles from '../../styles/settings.module.css';

/** "your Outlook.com account's OneDrive" / "your GitHub repository". */
export function syncedThrough(info: LaunchpadSyncInfo): string | null {
  if (info.connection === null) return null;
  return info.connection.kind === 'github' ? 'your GitHub repository' : `${info.connection.label} (OneDrive)`;
}

/** "Synced through …" with a link to Accounts, or "Not synced". */
export function SyncPointer() {
  const sync = useLaunchpadSync();
  if (!getCapabilities().launchpadSync || !sync.data) return null;
  const through = syncedThrough(sync.data);
  return (
    <p className={styles.itemMeta}>
      {through !== null ? `Synced through ${through}. ` : sync.data.connections > 1 ? 'Not synced: launch pad sync is set up twice. ' : 'Not synced. '}
      <a href="#/settings/accounts">{through !== null || sync.data.connections > 1 ? 'Launch pad sync in Accounts' : 'Set up launch pad sync in Accounts'}</a>
    </p>
  );
}
