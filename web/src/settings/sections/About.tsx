/**
 * About (§10.5): versions, data directory, log file, vault state and keyboard shortcuts. What it
 * shows follows this page load's backend:
 *
 * - the server build: the server's version, data folder, log file and vault, then the browsers
 *   paired with this Portly (`PairedBrowsersCard`);
 * - the Pages build on its `browser` backend: no data folder, log file or vault — where its data
 *   lives (this browser's storage) instead;
 * - the Pages build on its `server` backend (Portly on this PC): this site's and the server's
 *   versions and the vault (the server does not tell this site's origin its paths), then the
 *   paired browsers.
 *
 * The Pages build also gets the local server panel as a card (`LocalServerPanel`).
 */
import type { ReactNode } from 'react';
import { KeyRound, LockKeyhole } from 'lucide-react';
import type { AboutResponse } from '@portly/shared';
import { useAbout } from '../../api/about.ts';
import { LocalServerPanel } from '../../app/LocalServerPanel.tsx';
import { APP_VERSION } from '../../app/providers.tsx';
import { ShortcutList } from '../../app/ShortcutsDialog.tsx';
import { useStaticStorageKind, type StaticStorageKind } from '../../app/staticStatus.ts';
import { getCapabilities, type Capabilities } from '../../capabilities.ts';
import { Badge } from '../../ui/Badge.tsx';
import { BrandMark } from '../../ui/BrandMark.tsx';
import { CopyField } from '../../ui/CopyField.tsx';
import { ErrorState } from '../../ui/ErrorState.tsx';
import { FactList, SettingsCard } from '../../ui/Section.tsx';
import { SkeletonLines } from '../../ui/Skeleton.tsx';
import { PairedBrowsersCard } from './PairedBrowsersCard.tsx';
import styles from '../../styles/settings.module.css';

interface Fact {
  label: ReactNode;
  value: ReactNode;
}

function versionFact(about: AboutResponse): Fact {
  return {
    label: 'Version',
    value: (
      <span className={styles.inlineRow}>
        <span className={styles.mono}>{about.version}</span>
        {about.version !== APP_VERSION ? (
          <Badge tone="warning" title="Reload the page to get the latest app">
            Page is {APP_VERSION} — reload
          </Badge>
        ) : null}
      </span>
    ),
  };
}

/** The vault's state; `locked` links to where it is reset (Accounts here, or Portly's own page). */
function vaultFact(about: AboutResponse, caps: Capabilities): Fact {
  return {
    label: 'Credential vault',
    value:
      about.vault === 'ready' ? (
        <Badge tone="success" icon={LockKeyhole}>
          Unlocked and ready
        </Badge>
      ) : (
        <span className={styles.inlineRow}>
          <Badge tone="danger" icon={KeyRound}>
            Locked
          </Badge>
          <a href="#/settings/accounts">Review in Accounts</a>
        </span>
      ),
  };
}

function serverFacts(about: AboutResponse, caps: Capabilities): Fact[] {
  return [
    versionFact(about),
    { label: 'Data folder', value: <CopyField value={about.dataDir} label="Data folder path" /> },
    { label: 'Log file', value: <CopyField value={about.logPath} label="Log file path" /> },
    vaultFact(about, caps),
  ];
}

/** The Pages site using Portly on this PC: both versions (published separately) and where the data lives. */
function remoteServerFacts(about: AboutResponse, caps: Capabilities): Fact[] {
  return [
    { label: 'This site', value: <span className={styles.mono}>{APP_VERSION}</span> },
    { label: 'Portly on this PC', value: <span className={styles.mono}>{about.version}</span> },
    {
      label: 'Storage',
      value: <span>Portly on this PC, in its data folder.</span>,
    },
    vaultFact(about, caps),
  ];
}

/** Where the browser-only build keeps its data (the backend's storage kind once it is known). */
function storageDescription(kind: StaticStorageKind | null, fallback: string): string {
  if (kind === 'indexeddb') return 'This browser (IndexedDB). Your data stays on this device.';
  if (kind === 'memory') return 'This browser (memory only). Storage could not be opened, so nothing is saved when the tab closes.';
  return fallback;
}

function staticFacts(about: AboutResponse, storageKind: StaticStorageKind | null): Fact[] {
  return [versionFact(about), { label: 'Storage', value: storageDescription(storageKind, about.dataDir) }];
}

function facts(about: AboutResponse, caps: Capabilities, storageKind: StaticStorageKind | null): Fact[] {
  if (caps.backend === 'browser') return staticFacts(about, storageKind);
  return caps.remoteServer ? remoteServerFacts(about, caps) : serverFacts(about, caps);
}

function description(caps: Capabilities): string {
  if (caps.backend === 'browser') return 'Your personal start page, stored in this browser.';
  return caps.remoteServer ? 'Your personal start page, with its data from Portly on this PC.' : 'Your personal start page, served from this PC.';
}

export default function AboutSettings() {
  const caps = getCapabilities();
  const about = useAbout();
  const storageKind = useStaticStorageKind();
  return (
    <div className={styles.stack}>
      <SettingsCard title="Portly" description={description(caps)} actions={<BrandMark size={48} />}>
        {about.data === undefined ? (
          about.isError ? (
            <ErrorState error={about.error} onRetry={() => void about.refetch()} compact />
          ) : (
            <SkeletonLines lines={4} />
          )
        ) : (
          <FactList items={facts(about.data, caps, storageKind)} />
        )}
      </SettingsCard>
      {caps.pagesBuild ? <LocalServerPanel variant="card" /> : null}
      {caps.backend === 'server' ? <PairedBrowsersCard /> : null}
      <SettingsCard title="Keyboard shortcuts">
        <ShortcutList />
      </SettingsCard>
    </div>
  );
}
