/**
 * Import & export (§7 Core): download the configuration export; import is upload → preview
 * summary (counts, search engines with their hosts, dropped items) → explicit confirmation →
 * commit. Accounts, passwords, tokens and calendars are never part of an export. When the data
 * lives in this browser (the in-browser backend), the data an import replaced is kept in this
 * browser and offered for download (it imports like any export file); the server backs its
 * database up to a file instead. There, launch pad sync also keeps a backup before a sync that
 * replaced or removed much of the launch pad, offered the same way, and the import preview warns
 * that an import replaces the launch pad in every browser that syncs.
 */
import { useRef, useState, type ChangeEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileUp, TriangleAlert } from 'lucide-react';
import type { ImportPreviewResponse } from '@portly/shared';
import { expectNewIcons } from '../../api/bookmarks.ts';
import { apiGet, apiPath } from '../../api/client.ts';
import { checkImportFile, commitImport, downloadExport, previewImport } from '../../api/importExport.ts';
import { useLaunchpadSync } from '../../api/launchpadSync.ts';
import { getCapabilities } from '../../capabilities.ts';
import { saveBlob } from '../../lib/download.ts';
import { Banner } from '../../ui/Banner.tsx';
import { Button } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/Dialog.tsx';
import { FormFooter, SettingsCard } from '../../ui/Section.tsx';
import { errorMessage, toast, toastError } from '../../ui/toast.ts';
import { useFormatters } from '../../lib/format.ts';
import styles from '../../styles/settings.module.css';
import { syncedThrough } from './SyncPointer.tsx';

export default function ImportExportSettings() {
  return (
    <div className={styles.stack}>
      <ExportCard />
      <ImportCard />
      {getCapabilities().browserBackups ? <BackupCards /> : null}
    </div>
  );
}

/** `GET /api/backups` of the in-browser backend (newest first). */
interface BackupInfo {
  id: string;
  at: string;
  bytes: number;
  /** Taken before an import, or before a launch pad sync that replaced or removed a lot. */
  reason?: 'import' | 'sync';
}

const BACKUPS_KEY = ['backups'] as const;

/** `portly-backup-2026-09-25.json` (local date of the import or sync that replaced the data). */
function backupFilename(at: string): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `portly-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

/** The newest backup of each kind: before the last import, before the last sync that replaced a lot. */
function BackupCards() {
  const backups = useQuery({
    queryKey: BACKUPS_KEY,
    queryFn: ({ signal }) => apiGet<BackupInfo[]>('/api/backups', { signal }),
    meta: { persist: false },
  });
  const list = backups.data ?? [];
  const latestImport = list.find((b) => (b.reason ?? 'import') === 'import');
  const latestSync = list.find((b) => b.reason === 'sync');
  return (
    <>
      {latestImport ? <BackupCard latest={latestImport} /> : null}
      {latestSync ? <BackupCard latest={latestSync} /> : null}
    </>
  );
}

function BackupCard({ latest }: { latest: BackupInfo }) {
  const fmt = useFormatters();
  const [busy, setBusy] = useState(false);
  const sync = latest.reason === 'sync';

  const download = async () => {
    setBusy(true);
    try {
      const data = await apiGet<unknown>(apiPath`/api/backups/${latest.id}`);
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      saveBlob(new Blob([text], { type: 'application/json' }), backupFilename(latest.at));
      toast.success('Backup downloaded.');
    } catch (error) {
      toastError(error, 'The backup could not be downloaded.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsCard
      title={sync ? 'Backup before sync' : 'Backup before the last import'}
      description={
        sync
          ? `Your settings, profiles and bookmarks as they were before launch pad sync replaced or removed much of the launch pad on ${fmt.dateTime(latest.at)}. Download it and import it here to go back.`
          : `Your settings, profiles and bookmarks as they were before the import on ${fmt.dateTime(latest.at)}. Download it and import it here to go back.`
      }
      actions={
        <Button icon={Download} onClick={() => void download()} loading={busy}>
          Download backup
        </Button>
      }
    />
  );
}

function ExportCard() {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      await downloadExport();
      toast.success('Export downloaded.');
    } catch (error) {
      toastError(error, 'The export could not be created.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsCard
      title="Export"
      description="Settings, profiles and widgets, bookmarks, your background image and custom icons, in one file. Accounts, passwords, tokens, calendars and the Todoist token are never included."
      actions={
        <Button icon={Download} onClick={() => void download()} loading={busy}>
          Download export
        </Button>
      }
    />
  );
}

// The server backs the database up to a file before an import; the in-browser backend keeps a
// snapshot of the previous export in its own storage instead, and has no accounts to leave alone.
function importDescription(): string {
  return getCapabilities().browserBackups
    ? "Replace your settings, profiles and bookmarks with those from an export file. You'll see what the file contains before anything changes, and a backup is kept in this browser."
    : "Replace your settings, profiles and bookmarks with those from an export file. You'll see what the file contains before anything changes, and a backup is made first.";
}

function confirmDescription(): string {
  return getCapabilities().browserBackups
    ? 'Settings, profiles, widgets and bookmarks are replaced with the contents of the file. A backup of the current data is kept in this browser.'
    : 'Settings, profiles, widgets and bookmarks are replaced with the contents of the file. Portly saves a backup of the current data first. Accounts are not affected.';
}

const COUNT_LABELS: [keyof ImportPreviewResponse['summary']['counts'], string][] = [
  ['profiles', 'Profiles'],
  ['widgets', 'Widgets'],
  ['bookmarkGroups', 'Bookmark groups'],
  ['bookmarks', 'Bookmarks'],
  ['uploads', 'Images'],
  ['customIcons', 'Custom icons'],
];

function ImportCard() {
  const client = useQueryClient();
  const fmt = useFormatters();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const sync = useLaunchpadSync().data;
  const syncing = sync ? syncedThrough(sync) : null;

  const reset = () => {
    setPreview(null);
    setFileName(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setPreview(null);
    setError(null);
    setFileName(file.name);
    const problem = checkImportFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    setLoading(true);
    try {
      setPreview(await previewImport(file));
    } catch (err) {
      setError(errorMessage(err, 'This file could not be read.'));
    } finally {
      setLoading(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    try {
      await commitImport(preview.previewId);
    } catch (err) {
      toastError(err, 'The import failed. Nothing was changed.');
      throw err;
    }
    reset();
    // Everything imported (settings, profiles, bookmarks, …) is refetched; bookmark icons the
    // server is still fetching arrive through a short poll.
    await client.invalidateQueries();
    expectNewIcons(client);
    toast.success('Import complete.');
  };

  const summary = preview?.summary;

  return (
    <SettingsCard title="Import" description={importDescription()}>
      <div className={styles.inlineRow}>
        {/* Opened by the button below; kept out of the tab order but labelled for assistive tech. */}
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          className="hb-visually-hidden"
          tabIndex={-1}
          aria-label="Portly export file"
          onChange={(event) => void onFile(event)}
        />
        <Button icon={FileUp} loading={loading} onClick={() => inputRef.current?.click()}>
          Choose export file…
        </Button>
        {fileName ? <span className={styles.itemMeta}>{fileName}</span> : null}
      </div>

      {error ? (
        <Banner tone="danger" title="This file can't be imported">
          {error}
        </Banner>
      ) : null}

      {summary ? (
        <section className={styles.stack} aria-label="Import preview">
          {syncing !== null ? (
            <Banner tone="warning" icon={TriangleAlert} title="This replaces the launch pad in every synced browser">
              Launch pad sync is on through {syncing}: after the import, every browser that syncs with it takes the imported groups and
              bookmarks (a browser that would lose many of its own keeps a backup first).
            </Banner>
          ) : null}
          <p className={styles.preview}>
            Exported <strong>{fmt.dateTime(summary.exportedAt)}</strong>. Importing replaces:
          </p>
          <dl className={styles.summaryGrid}>
            {COUNT_LABELS.map(([key, label]) => (
              <div key={key} className={styles.summaryItem}>
                <dt>{label}</dt>
                <dd>{summary.counts[key]}</dd>
              </div>
            ))}
          </dl>
          {summary.searchEngines.length > 0 ? (
            <div>
              <p className={styles.preview}>
                <strong>Search engines</strong> — searches will be sent to these sites:
              </p>
              <ul className={styles.list}>
                {summary.searchEngines.map((engine, index) => (
                  <li key={`${engine.name}-${index}`} className={styles.listItem}>
                    <span className={styles.grow}>{engine.name}</span>
                    <span className={styles.mono}>{engine.host}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {summary.dropped.unknownWidgets > 0 || summary.dropped.notes.length > 0 ? (
            <Banner tone="warning" icon={TriangleAlert} title="Some items will be skipped">
              <ul className={styles.steps}>
                {summary.dropped.unknownWidgets > 0 ? (
                  <li>
                    {summary.dropped.unknownWidgets} widget{summary.dropped.unknownWidgets === 1 ? '' : 's'} of a type this version doesn't
                    know
                  </li>
                ) : null}
                {summary.dropped.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
          <FormFooter status="Your current settings, profiles and bookmarks will be replaced.">
            <Button variant="ghost" onClick={reset}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Import…
            </Button>
          </FormFooter>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Replace your configuration?"
        description={confirmDescription()}
        confirmLabel="Import"
        destructive
        onConfirm={commit}
      />
    </SettingsCard>
  );
}
