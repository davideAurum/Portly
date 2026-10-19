/**
 * Settings → Bookmarks (§10.8), top to bottom: group management (create, rename/color, reorder,
 * delete); one import & export card (import from the Chrome/Edge profiles found on this PC or from
 * an exported HTML bookmark file, with a report of what was imported and skipped; export every
 * group as a bookmark HTML file); and the `bookmarks` settings namespace (default group for new
 * bookmarks, automatic website icons).
 */
import { useId, useState } from 'react';
import { ArrowDown, ArrowUp, Download, FileUp, FolderPlus, Globe, Pencil, RefreshCw, Trash } from 'lucide-react';
import type { BookmarkGroup, BookmarkImportReport, BrowserImport } from '@portly/shared';
import { useBookmarks, useImportFromBrowser, useImportFromHtml, useImportSources, useReorderGroups } from '../../api/bookmarks.ts';
import { useSettings, useUpdateSettings } from '../../api/settings.ts';
import { getCapabilities } from '../../capabilities.ts';
import { bookmarksFilename, toNetscapeBookmarks } from '../../lib/bookmarkExport.ts';
import { safeColor } from '../../lib/color.ts';
import { saveBlob } from '../../lib/download.ts';
import {
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  SegmentedControl,
  Select,
  SettingsCard,
  SkeletonList,
  Switch,
  toast,
  toastError,
} from '../../ui/index.ts';
import { DeleteGroupDialog, GroupDialog } from '../../widgets/launchpad/GroupDialog.tsx';
import styles from '../../styles/settings.module.css';
import own from '../../widgets/search/SearchSettingsPage.module.css';

type Strategy = BrowserImport['targetGroupStrategy'];

const BROWSER_NAMES = { chrome: 'Chrome', edge: 'Edge' } as const;
const MAX_HTML_BYTES = 25 * 1024 * 1024;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default function BookmarksSettings() {
  const [report, setReport] = useState<{ source: string; report: BookmarkImportReport } | null>(null);
  return (
    <div className={styles.stack}>
      <GroupsCard />
      <ImportExportCard onReport={(source, r) => setReport({ source, report: r })} />
      {report ? <ImportReport source={report.source} report={report.report} onDismiss={() => setReport(null)} /> : null}
      <PreferencesCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import & export
// ---------------------------------------------------------------------------

function ImportExportCard({ onReport }: { onReport(source: string, report: BookmarkImportReport): void }) {
  const [strategy, setStrategy] = useState<Strategy>('folders');
  // The in-browser backend cannot read profile files from disk: the subsection is hidden and the
  // sources are never requested.
  const browserImport = getCapabilities().browserBookmarkImport;
  const sources = useImportSources(browserImport);
  const importBrowser = useImportFromBrowser();
  const importHtml = useImportFromHtml();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputId = useId();
  const bookmarks = useBookmarks();
  const groups = bookmarks.data?.groups ?? [];
  const count = groups.reduce((n, g) => n + g.bookmarks.length, 0);

  const runBrowser = async (id: string, label: string) => {
    setBusyId(id);
    try {
      onReport(label, await importBrowser.mutateAsync({ sourceId: id, targetGroupStrategy: strategy }));
    } catch (error) {
      toastError(error, 'The bookmarks could not be imported.');
    } finally {
      setBusyId(null);
    }
  };

  const runHtml = async () => {
    if (!file) {
      setFileError('Choose the exported bookmarks file first.');
      return;
    }
    try {
      onReport(file.name, await importHtml.mutateAsync({ file, strategy }));
      setFile(null);
    } catch (error) {
      toastError(error, 'The file could not be imported.');
    }
  };

  const pick = (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size === 0 || picked.size > MAX_HTML_BYTES) {
      setFileError('Choose a bookmarks file up to 25 MB.');
      return;
    }
    setFileError(null);
    setFile(picked);
  };

  const download = () => {
    const now = new Date();
    saveBlob(new Blob([toNetscapeBookmarks(groups, now)], { type: 'text/html' }), bookmarksFilename(now));
    toast.success(`Exported ${plural(count, 'bookmark')}.`);
  };

  return (
    <SettingsCard
      title="Import & export bookmarks"
      description="Importing copies bookmarks into Portly; your browser is not changed. Bookmarklets and other non-web addresses are skipped, as are addresses already in the same group."
    >
      <div className={own.strategy}>
        <Field label="Put imported bookmarks into">
          <SegmentedControl<Strategy>
            value={strategy}
            onValueChange={setStrategy}
            options={[
              { value: 'folders', label: 'One group per folder' },
              { value: 'single', label: 'A single group' },
            ]}
          />
        </Field>
      </div>

      {browserImport ? (
        <>
          <h3 className={styles.itemTitle}>From a browser on this PC</h3>
          {sources.data === undefined ? (
            sources.isError ? (
              <ErrorState error={sources.error} onRetry={() => void sources.refetch()} compact />
            ) : (
              <SkeletonList rows={2} />
            )
          ) : sources.data.length === 0 ? (
            <EmptyState
              icon={Globe}
              compact
              title="No Chrome or Edge profiles found"
              body="Export your bookmarks to an HTML file from any browser and import that file below."
              action={
                <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void sources.refetch()}>
                  Look again
                </Button>
              }
            />
          ) : (
            <ul className={styles.list} aria-label="Browser profiles">
              {sources.data.map((source) => {
                const label = `${BROWSER_NAMES[source.browser]} — ${source.profileName}`;
                return (
                  <li key={source.id} className={styles.listItem}>
                    <span className={own.sourceIcon} aria-hidden="true">
                      <Globe />
                    </span>
                    <div className={styles.grow}>
                      <p className={styles.itemTitle}>{label}</p>
                      <p className={styles.itemMeta}>{plural(source.bookmarkCount, 'bookmark')}</p>
                    </div>
                    <div className={styles.itemActions}>
                      <Button
                        size="sm"
                        loading={busyId === source.id}
                        disabled={busyId !== null && busyId !== source.id}
                        onClick={() => void runBrowser(source.id, label)}
                        aria-label={`Import from ${label}`}
                      >
                        Import
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}

      <h3 className={styles.itemTitle}>From an exported HTML file</h3>
      <p className={styles.intro}>
        Chrome and Edge: Bookmarks manager → ⋮ → Export bookmarks. Firefox: Bookmarks → Manage bookmarks → Import and Backup → Export
        Bookmarks to HTML. Safari: File → Export → Bookmarks.
      </p>
      <div className={own.fileRow}>
        <label htmlFor={fileInputId} className={own.fileButton}>
          <FileUp aria-hidden="true" />
          <span>{file ? file.name : 'Choose file…'}</span>
        </label>
        <input
          id={fileInputId}
          type="file"
          accept=".html,.htm,text/html"
          className="hb-visually-hidden"
          onChange={(event) => {
            pick(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }}
        />
        <Button variant="primary" size="sm" loading={importHtml.isPending} disabled={!file} onClick={() => void runHtml()}>
          Import file
        </Button>
      </div>
      {fileError ? (
        <p className={styles.itemMeta} role="alert">
          {fileError}
        </p>
      ) : null}

      <h3 className={styles.itemTitle}>Export to an HTML file</h3>
      <p className={styles.intro}>
        Saves every group as a folder in a bookmark HTML file. Import it into another Portly (choose “One group per folder” to keep your
        groups) or into Chrome, Edge, Firefox or Safari. Icons and group colors are not included; Settings → Import & export saves your
        whole setup.
      </p>
      <div className={own.fileRow}>
        <Button size="sm" icon={Download} disabled={count === 0} onClick={download}>
          Export bookmarks
        </Button>
      </div>
    </SettingsCard>
  );
}

function ImportReport({ source, report, onDismiss }: { source: string; report: BookmarkImportReport; onDismiss(): void }) {
  const nothing = report.bookmarks === 0;
  return (
    <Banner
      tone={nothing ? 'warning' : 'success'}
      title={nothing ? `Nothing new was imported from ${source}` : `Imported ${plural(report.bookmarks, 'bookmark')} from ${source}`}
      actions={
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      <dl className={own.report} aria-label="Import report">
        <div>
          <dt>Groups created</dt>
          <dd>{report.groups}</dd>
        </div>
        <div>
          <dt>Bookmarks added</dt>
          <dd>{report.bookmarks}</dd>
        </div>
        <div>
          <dt>Skipped</dt>
          <dd>{report.skipped}</dd>
        </div>
      </dl>
    </Banner>
  );
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function GroupsCard() {
  const bookmarks = useBookmarks();
  const reorder = useReorderGroups();
  const [editing, setEditing] = useState<BookmarkGroup | 'new' | null>(null);
  const [deleting, setDeleting] = useState<BookmarkGroup | null>(null);
  const groups = bookmarks.data?.groups ?? [];

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= groups.length) return;
    const ids = groups.map((g) => g.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorder.mutate(ids);
  };

  return (
    <SettingsCard
      title="Groups"
      description="Launch pads show these groups in this order. Drag bookmarks between groups in the dashboard’s edit mode (press E)."
      actions={
        <Button size="sm" variant="primary" icon={FolderPlus} onClick={() => setEditing('new')}>
          New group
        </Button>
      }
    >
      {bookmarks.data === undefined ? (
        bookmarks.isError ? (
          <ErrorState error={bookmarks.error} onRetry={() => void bookmarks.refetch()} compact />
        ) : (
          <SkeletonList rows={3} avatar={false} />
        )
      ) : groups.length === 0 ? (
        <EmptyState icon={FolderPlus} compact title="No groups yet" body="Create a group, or import bookmarks below." />
      ) : (
        <ul className={styles.list} aria-label="Bookmark groups">
          {groups.map((group, index) => {
            const color = safeColor(group.color);
            return (
              <li key={group.id} className={styles.listItem}>
                <span className={own.groupSwatch} style={color ? { background: color } : undefined} aria-hidden="true" />
                <div className={styles.grow}>
                  <p className={styles.itemTitle}>{group.name}</p>
                  <p className={styles.itemMeta}>{plural(group.bookmarks.length, 'bookmark')}</p>
                </div>
                <div className={styles.itemActions}>
                  <IconButton icon={ArrowUp} size="sm" aria-label={`Move ${group.name} up`} disabled={index === 0} onClick={() => move(index, -1)} />
                  <IconButton
                    icon={ArrowDown}
                    size="sm"
                    aria-label={`Move ${group.name} down`}
                    disabled={index === groups.length - 1}
                    onClick={() => move(index, 1)}
                  />
                  <IconButton icon={Pencil} size="sm" aria-label={`Edit ${group.name}`} onClick={() => setEditing(group)} />
                  <IconButton icon={Trash} size="sm" aria-label={`Delete ${group.name}`} onClick={() => setDeleting(group)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <GroupDialog
        open={editing !== null}
        group={editing === 'new' ? null : editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
      <DeleteGroupDialog
        group={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      />
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Preferences (settings.bookmarks)
// ---------------------------------------------------------------------------

function PreferencesCard() {
  const settings = useSettings();
  const bookmarks = useBookmarks();
  const update = useUpdateSettings();
  const prefs = settings.data?.bookmarks;
  if (!prefs) return null;
  const groups = bookmarks.data?.groups ?? [];
  const defaultKnown = prefs.defaultGroupId !== null && groups.some((g) => g.id === prefs.defaultGroupId);

  return (
    <SettingsCard title="Preferences">
      <div className={own.toggles}>
        <Field label="New bookmarks go to" help="Used by the “+” button of launch pads that show all groups.">
          <Select
            value={defaultKnown ? prefs.defaultGroupId! : ''}
            onChange={(event) => update.mutate({ bookmarks: { defaultGroupId: event.currentTarget.value === '' ? null : event.currentTarget.value } })}
            options={[{ value: '', label: 'The first group' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
          />
        </Field>
        <Switch
          label="Fetch website icons automatically"
          description={
            getCapabilities().backend === 'browser'
              ? 'Icons are loaded by your browser from DuckDuckGo’s icon service, so that service sees the names of the sites you bookmark. Sites it has no icon for show its generic placeholder; choose a letter tile or upload an icon for those. Sites on your home network are never looked up and show a letter tile instead. When off, bookmarks show a letter tile unless you fetch or upload an icon.'
              : 'Portly downloads each site’s icon once (refreshed monthly). Sites on your home network are never looked up with outside icon services. When off, bookmarks show a letter tile unless you fetch or upload an icon.'
          }
          checked={prefs.autoFetchIcons}
          onCheckedChange={(autoFetchIcons) => update.mutate({ bookmarks: { autoFetchIcons } })}
        />
      </div>
    </SettingsCard>
  );
}
