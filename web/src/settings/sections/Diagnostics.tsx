/**
 * Diagnostics (ARCHITECTURE §17): why something does not connect, sync or update. What a page load
 * shows follows its backend:
 *
 * - **the server** (Portly's own page, or the Pages site using Portly on this PC — every
 *   diagnostics route is paired): Overview, Connections & sync, Logging level, Server log, This
 *   browser and Report (panels in `diagnostics/ui/`). "Show related log lines" in Connections
 *   switches to the Server log, filtered to that subject around its last failure.
 * - **a server without diagnostics** (older than this page: the summary answers `403 local_only`
 *   or `404`): the Overview says "Update Portly on this PC to see its diagnostics", plus This
 *   browser.
 * - **the in-browser backend**: its own intro, the Overview of this site (hybrid status,
 *   permission, and "Open diagnostics on this PC" once something answers there) and This browser.
 *
 * Every diagnostics query is unpersisted (`api/diagnostics.ts`); errors render notices, never a
 * broken section.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { DiagnosticsSummary } from '@portly/shared';
import { useAccounts } from '../../api/accounts.ts';
import { useDiagnosticsSummary } from '../../api/diagnostics.ts';
import { getCapabilities, type Backend } from '../../capabilities.ts';
import { BrowserEventsPanel } from '../../diagnostics/ui/BrowserEventsPanel.tsx';
import { ConnectionsPanel } from '../../diagnostics/ui/ConnectionsPanel.tsx';
import { diagnosticsUnavailable, takesDebugEvents } from '../../diagnostics/ui/format.ts';
import { relatedLogWindow, type HealthItem } from '../../diagnostics/ui/health.ts';
import { LogLevelPanel } from '../../diagnostics/ui/LogLevelPanel.tsx';
import { DEFAULT_LOG_FILTERS, logNameSource, logNamesFrom, type LogFilters } from '../../diagnostics/ui/logs.ts';
import { OverviewPanel } from '../../diagnostics/ui/OverviewPanel.tsx';
import { UPDATE_PORTLY_NOTICE } from '../../diagnostics/ui/parts.tsx';
import { ReportPanel } from '../../diagnostics/ui/ReportPanel.tsx';
import { ServerLogPanel } from '../../diagnostics/ui/ServerLogPanel.tsx';
import { ErrorState } from '../../ui/ErrorState.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/Tabs.tsx';
import { errorMessage } from '../../ui/toast.ts';
import diagnosticsStyles from '../../diagnostics/ui/Diagnostics.module.css';
import styles from '../../styles/settings.module.css';

type TabId = 'overview' | 'connections' | 'level' | 'log' | 'browser' | 'report';

const TAB_LABELS: Readonly<Record<TabId, string>> = {
  overview: 'Overview',
  connections: 'Connections & sync',
  level: 'Logging level',
  log: 'Server log',
  browser: 'This browser',
  report: 'Report',
};

const ALL_TABS: readonly TabId[] = ['overview', 'connections', 'level', 'log', 'browser', 'report'];
const BROWSER_TABS: readonly TabId[] = ['overview', 'browser'];

/** What the page shows: a server's diagnostics, or (the in-browser backend) this site's and this browser's. */
function Intro({ backend }: { backend: Backend }) {
  return (
    <p className={styles.intro}>
      {backend === 'server'
        ? 'Why something doesn’t connect, sync or update: the state of every account, calendar, feed and job, the server’s log and what this browser noticed.'
        : 'Why something on this site doesn’t connect, sync or load: where its data lives, whether Portly runs on this PC, and what this browser noticed (failed requests to Outlook.com, Todoist, weather and the other services this site uses, and errors on this page).'}
    </p>
  );
}

interface DiagnosticsTabsProps {
  tabs: readonly TabId[];
  value: TabId;
  onValueChange(tab: TabId): void;
  /** The tab buttons, by tab (to move focus to one). Radix keeps their ids: its panels are labelled by them. */
  triggers?: RefObject<Map<TabId, HTMLButtonElement>>;
  children: ReactNode;
}

function DiagnosticsTabs({ tabs, value, onValueChange, triggers, children }: DiagnosticsTabsProps) {
  return (
    <Tabs className={diagnosticsStyles.tabs} value={value} onValueChange={(next) => onValueChange(tabs.find((t) => t === next) ?? 'overview')}>
      <TabsList aria-label="Diagnostics">
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            ref={(element: HTMLButtonElement | null) => {
              if (element === null) triggers?.current.delete(tab);
              else triggers?.current.set(tab, element);
            }}
          >
            {TAB_LABELS[tab]}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
  );
}

/** The in-browser backend: this site's overview and this browser's events. */
function BrowserDiagnostics() {
  const [tab, setTab] = useState<TabId>('overview');
  return (
    <div className={styles.stack}>
      <Intro backend="browser" />
      <DiagnosticsTabs tabs={BROWSER_TABS} value={tab} onValueChange={setTab}>
        <TabsContent value="overview">
          <OverviewPanel query={null} />
        </TabsContent>
        <TabsContent value="browser">
          <BrowserEventsPanel />
        </TabsContent>
      </DiagnosticsTabs>
    </div>
  );
}

/** A server backend: every panel (only Overview and This browser while the server has no diagnostics). */
function ServerDiagnostics() {
  const summary = useDiagnosticsSummary();
  const accounts = useAccounts();
  const unavailable = summary.data === undefined && summary.isError && diagnosticsUnavailable(summary.error);
  const tabs = unavailable ? BROWSER_TABS : ALL_TABS;
  const [selected, setSelected] = useState<TabId>('overview');
  const tab = tabs.includes(selected) ? selected : 'overview';
  const [filters, setFilters] = useState<LogFilters>(DEFAULT_LOG_FILTERS);
  const [timeline, setTimeline] = useState(false);
  // Keyed on the names, not the summary: it is new every 30 s, and new names re-render every log row.
  const nameSource = logNameSource(summary.data?.health ?? [], accounts.data ?? []);
  const names = useMemo(() => logNamesFrom(nameSource), [nameSource]);

  // "Show related log lines" unmounts the button it was clicked on: focus the Server log tab instead.
  const triggers = useRef(new Map<TabId, HTMLButtonElement>());
  const focusLogTab = useRef(false);
  useEffect(() => {
    if (!focusLogTab.current || tab !== 'log') return;
    focusLogTab.current = false;
    triggers.current.get('log')?.focus();
  }, [tab]);

  const showLogs = (item: HealthItem) => {
    const around = relatedLogWindow(item.entry);
    setFilters({ ...DEFAULT_LOG_FILTERS, level: 'debug', key: item.key, keyLabel: item.label, since: around?.since ?? null, before: around?.before ?? null });
    focusLogTab.current = true;
    setSelected('log');
  };

  /** A panel that needs the summary: it, or its loading/error state. */
  const withSummary = (render: (data: DiagnosticsSummary) => ReactNode) =>
    summary.data !== undefined ? (
      render(summary.data)
    ) : summary.isError ? (
      <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
    ) : (
      <SkeletonList rows={4} />
    );

  const summaryProblem = summary.data !== undefined ? null : summary.isError ? (unavailable ? UPDATE_PORTLY_NOTICE : errorMessage(summary.error)) : 'still loading';

  return (
    <div className={styles.stack}>
      <Intro backend="server" />
      <DiagnosticsTabs tabs={tabs} value={tab} onValueChange={setSelected} triggers={triggers}>
        <TabsContent value="overview">
          <OverviewPanel query={summary} />
        </TabsContent>
        {unavailable ? null : (
          <>
            <TabsContent value="connections">
              {withSummary((data) => (
                <ConnectionsPanel summary={data} accountLabel={names.account} onShowLogs={showLogs} />
              ))}
            </TabsContent>
            <TabsContent value="level">{withSummary((data) => <LogLevelPanel state={data.logLevel} />)}</TabsContent>
            <TabsContent value="log">
              <ServerLogPanel filters={filters} setFilters={setFilters} timeline={timeline} setTimeline={setTimeline} names={names} boot={summary.data?.server.boot ?? null} />
            </TabsContent>
          </>
        )}
        <TabsContent value="browser">
          <BrowserEventsPanel serverRefuses={unavailable} acceptDebug={summary.data !== undefined && takesDebugEvents(summary.data.logLevel)} />
        </TabsContent>
        {unavailable ? null : (
          <TabsContent value="report">
            <ReportPanel summary={summary.data ?? null} summaryProblem={summaryProblem} accounts={accounts.data ?? []} />
          </TabsContent>
        )}
      </DiagnosticsTabs>
    </div>
  );
}

export default function DiagnosticsSettings() {
  return getCapabilities().backend === 'server' ? <ServerDiagnostics /> : <BrowserDiagnostics />;
}
