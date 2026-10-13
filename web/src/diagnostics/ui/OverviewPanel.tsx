/**
 * Diagnostics → Overview (ARCHITECTURE §17): the server at a glance — version (and a warning when
 * this page runs another version), uptime and boot, process, supervisor and its last restart,
 * modules that are down, the vault, warnings and errors of the last hour (server and browser),
 * the log level, what is in progress, the Pages site and paired browsers — and banners for what
 * needs a fix: a site that tried to use this server although `HOMEBASE_PAGES_URL` names another
 * (or none), and (Pages build) Homebase answering on this PC but not to this site.
 *
 * The Pages build adds "This site": its version and backend, the local server status and the
 * browser's local network permission, and "Open diagnostics on this PC", which always works on
 * Homebase's own page. On the in-browser backend that card (with this browser's counts) is the
 * whole overview.
 */
import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { KeyRound, LockKeyhole } from 'lucide-react';
import type { DiagnosticsSummary } from '@homebase/shared';
import { localServerStatusView, useDisplayedLocalServerStatus } from '../../app/LocalServerPanel.tsx';
import { APP_VERSION } from '../../app/providers.tsx';
import { getCapabilities } from '../../capabilities.ts';
import { useFormatters } from '../../lib/format.ts';
import { useNow } from '../../lib/useNow.ts';
import { useLocalServer } from '../../localServer/store.ts';
import type { LoopbackPermission } from '../../localServer/types.ts';
import { Badge } from '../../ui/Badge.tsx';
import { Banner } from '../../ui/Banner.tsx';
import { CopyField } from '../../ui/CopyField.tsx';
import { ErrorState, StaleIndicator } from '../../ui/ErrorState.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { FactList, SettingsCard } from '../../ui/Section.tsx';
import { SkeletonLines } from '../../ui/Skeleton.tsx';
import type { ClientLogEntry } from '../clientLog.ts';
import { answersWithoutCors, describeLastExit, diagnosticsUnavailable, formatBytes, formatDuration, thisSiteAddress } from './format.ts';
import { useClientEvents } from './hooks.ts';
import { LocalDiagnosticsLink, LogLevelBadge, UnavailableNotice } from './parts.tsx';
import styles from './Diagnostics.module.css';

type SummaryQuery = Pick<UseQueryResult<DiagnosticsSummary>, 'data' | 'error' | 'isError' | 'refetch' | 'dataUpdatedAt'>;

interface Fact {
  label: ReactNode;
  value: ReactNode;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function warnErrorText(counts: { warn: number; error: number }): string {
  return `${plural(counts.warn, 'warning')}, ${plural(counts.error, 'error')}`;
}

/** This browser's warnings and errors of the last hour (its own ring: also those never uploaded). */
function recentBrowserCounts(entries: readonly ClientLogEntry[], now: number): { warn: number; error: number } {
  const counts = { warn: 0, error: 0 };
  for (const { event } of entries) {
    if (now - Date.parse(event.t) > 60 * 60 * 1000) continue;
    if (event.level === 'warn') counts.warn += 1;
    else if (event.level === 'error') counts.error += 1;
  }
  return counts;
}

function supervisorFact(summary: DiagnosticsSummary): ReactNode {
  const { supervised, restart } = summary.server;
  if (!supervised) return 'Not supervised (started by hand or by the developer server)';
  const exit = describeLastExit(restart?.lastExit ?? null);
  if (restart === null || restart.attempt === 0) return 'Supervised: restarted automatically if it stops';
  return (
    <span>
      Supervised · restarted {plural(restart.attempt, 'time')}
      {exit === null ? null : (
        <>
          {' · last exit: '}
          <span className={styles.mono}>{exit}</span>
        </>
      )}
    </span>
  );
}

function inFlightFact(summary: DiagnosticsSummary): ReactNode {
  const { count, oldestMs, routes, outbound } = summary.inFlight;
  if (count === 0 && outbound.length === 0) return 'Nothing in progress';
  const parts: string[] = [];
  if (count > 0) parts.push(`${plural(count, 'request')}${oldestMs === null ? '' : ` (oldest ${formatDuration(oldestMs)})`}${routes.length > 0 ? `: ${routes.join(', ')}` : ''}`);
  if (outbound.length > 0) {
    parts.push(`outbound: ${outbound.map((o) => `${o.host}${o.purpose === null ? '' : ` (${o.purpose})`} ${formatDuration(o.ms)}`).join(', ')}`);
  }
  return <span className={styles.mono}>{parts.join(' · ')}</span>;
}

function hybridFact(summary: DiagnosticsSummary): ReactNode {
  const { pagesOrigin, pairings, lastPairedRequestAt } = summary.hybrid;
  return (
    <span className={styles.inlineRow}>
      {pagesOrigin === null ? <span>Not set (HOMEBASE_PAGES_URL)</span> : <span className={styles.mono}>{pagesOrigin}</span>}
      <span>· {plural(pairings, 'paired browser')}</span>
      {lastPairedRequestAt === null ? null : (
        <span>
          · last used <RelativeTime date={lastPairedRequestAt} />
        </span>
      )}
    </span>
  );
}

function serverFacts(summary: DiagnosticsSummary, pagesBuild: boolean): Fact[] {
  const { server } = summary;
  const down = summary.modules.filter((m) => !m.ok);
  const facts: Fact[] = [
    {
      label: 'Version',
      value: (
        <span className={styles.inlineRow}>
          <span className={styles.mono}>{server.version}</span>
          {server.version !== APP_VERSION ? <Badge tone="warning">{pagesBuild ? `This site: ${APP_VERSION}` : `This page: ${APP_VERSION}`}</Badge> : null}
        </span>
      ),
    },
    {
      label: 'Running',
      value: (
        <span>
          Up {formatDuration(server.uptimeMs) || '0 s'} · started <RelativeTime date={server.startedAt} /> · boot <span className={styles.mono}>{server.boot}</span>
        </span>
      ),
    },
    {
      label: 'Process',
      value: [
        server.pid === null ? null : `pid ${server.pid}`,
        `Node ${server.node}`,
        server.platform,
        server.memory === null ? null : `${formatBytes(server.memory.rssBytes)} memory`,
      ]
        .filter((part): part is string => part !== null)
        .join(' · '),
    },
    { label: 'Supervisor', value: supervisorFact(summary) },
    {
      label: 'Modules',
      value:
        down.length === 0 ? (
          `All ${summary.modules.length} running`
        ) : (
          <span className={styles.inlineRow}>
            {down.map((m) => (
              <Badge key={m.name} tone="danger">
                {m.name} is down
              </Badge>
            ))}
          </span>
        ),
    },
    {
      label: 'Credential vault',
      value:
        summary.vault === 'ready' ? (
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
    },
    { label: 'Log level', value: <LogLevelBadge state={summary.logLevel} /> },
    {
      label: 'Last hour',
      value: `Server: ${warnErrorText(summary.counts.server)} · Browsers: ${warnErrorText(summary.counts.client)}`,
    },
    { label: 'In progress', value: inFlightFact(summary) },
    { label: 'Pages site', value: hybridFact(summary) },
  ];
  if (server.logDir !== '') facts.push({ label: 'Log folder', value: <CopyField value={server.logDir} label="Log folder path" /> });
  return facts;
}

/**
 * How a new `HOMEBASE_PAGES_URL` takes effect: Homebase reads it when it starts, from the
 * environment it was started with — the autostart task and the supervisor keep the old one, so a
 * plain restart is not enough (docs/setup/pages-local-server.md, step 2).
 */
function PagesUrlSteps() {
  return (
    <p className={styles.text}>
      Set it as a Windows user environment variable. Homebase reads it only when it starts, and a plain restart keeps the old value: re-run{' '}
      <code>scripts/install-autostart.ps1</code> from your Homebase folder (add <code>-Trigger Logon</code> if you use Logon mode), or sign out of Windows
      and back in; if you start Homebase yourself, start it from a new PowerShell window. Step by step: <code>docs/setup/pages-local-server.md</code>.
    </p>
  );
}

/** A site that tried to use this server but is not its configured Pages site. */
function ForeignOriginsBanner({ summary }: { summary: DiagnosticsSummary }) {
  const { foreignOrigins, pagesOrigin } = summary.hybrid;
  if (foreignOrigins.length === 0) return null;
  const latest = [...foreignOrigins].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt))[0]!;
  const setting = pagesOrigin === null ? 'HOMEBASE_PAGES_URL is not set' : `HOMEBASE_PAGES_URL is set to ${pagesOrigin}`;
  return (
    <Banner tone="warning" title={`A page at ${latest.origin} tried to use this server, but ${setting}`}>
      <p className={styles.text}>
        If that is your Pages site, set <code>HOMEBASE_PAGES_URL</code> to its full address (it starts with <code>{latest.origin}/</code>; a project site adds its
        path).
      </p>
      <PagesUrlSteps />
      <ul className={styles.list} aria-label="Sites that tried to use this server">
        {foreignOrigins.map((o) => (
          <li key={o.origin} className={styles.meta}>
            <span className={styles.key}>{o.origin}</span>
            <span>
              {plural(o.count, 'request')}, last <RelativeTime date={o.lastAt} />
            </span>
          </li>
        ))}
      </ul>
    </Banner>
  );
}

function VersionSkewBanner({ summary, pagesBuild }: { summary: DiagnosticsSummary; pagesBuild: boolean }) {
  if (summary.server.version === APP_VERSION) return null;
  return pagesBuild ? (
    <Banner tone="warning" title={`This site is version ${APP_VERSION}; Homebase on this PC is ${summary.server.version}`}>
      Update Homebase on this PC (or reload this site) so both run the same version; until then some details may be missing or not shown.
    </Banner>
  ) : (
    <Banner tone="warning" title={`This page is version ${APP_VERSION}; Homebase is ${summary.server.version}`}>
      Reload the page to get the app that matches the server.
    </Banner>
  );
}

/** The server card: the summary, or why there is none. */
function ServerCard({ query, pagesBuild }: { query: SummaryQuery; pagesBuild: boolean }) {
  const title = pagesBuild ? 'Homebase on this PC' : 'Homebase server';
  if (query.data === undefined) {
    return (
      <SettingsCard id="diagnostics-server" title={title}>
        {query.isError ? (
          diagnosticsUnavailable(query.error) ? (
            <UnavailableNotice />
          ) : (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} compact />
          )
        ) : (
          <SkeletonLines lines={6} />
        )}
      </SettingsCard>
    );
  }
  const summary = query.data;
  return (
    <>
      <VersionSkewBanner summary={summary} pagesBuild={pagesBuild} />
      <ForeignOriginsBanner summary={summary} />
      <SettingsCard
        id="diagnostics-server"
        title={title}
        description="Refreshes every 30 seconds while this page is open."
        actions={<StaleIndicator updatedAt={query.dataUpdatedAt} error={query.isError ? query.error : undefined} always onRetry={() => void query.refetch()} />}
      >
        <FactList items={serverFacts(summary, pagesBuild)} />
      </SettingsCard>
    </>
  );
}

const PERMISSION_TEXT: Readonly<Record<LoopbackPermission, string>> = {
  granted: 'Allowed',
  denied: 'Blocked',
  prompt: 'Not decided yet (the browser asks)',
  unsupported: 'Not needed in this browser',
};

/** The Pages build: this site, the local server as the controller sees it, and the way to full diagnostics. */
function ThisSiteCard({ summary }: { summary: DiagnosticsSummary | null }) {
  const caps = getCapabilities();
  const state = useLocalServer();
  const status = useDisplayedLocalServerStatus(state);
  const view = localServerStatusView(status, state.server);
  const events = useClientEvents();
  const now = useNow(60_000);
  const counts = recentBrowserCounts(events, now.getTime());
  const facts: Fact[] = [
    { label: 'This site', value: <span className={styles.mono}>{APP_VERSION}</span> },
    { label: 'Data', value: caps.backend === 'server' ? 'From Homebase on this PC' : 'Saved in this browser' },
    {
      label: 'Homebase on this PC',
      value: (
        <span className={styles.inlineRow}>
          <Badge tone={view.tone}>{view.label}</Badge>
          {state.checkedAt === null ? null : (
            <span className={styles.meta}>
              checked <RelativeTime date={state.checkedAt} />
            </span>
          )}
        </span>
      ),
    },
    { label: 'Local network access', value: state.permission === null ? 'Not checked yet' : PERMISSION_TEXT[state.permission] },
    { label: 'This browser, last hour', value: warnErrorText(counts) },
  ];
  return (
    <>
      {answersWithoutCors(state) ? (
        <Banner tone="warning" title="Homebase runs on this PC but does not accept this site">
          <p className={styles.text}>
            Something answers on Homebase’s port, but not to this site. Homebase answers this site only when it is the address in{' '}
            <code>HOMEBASE_PAGES_URL</code>: set <code>HOMEBASE_PAGES_URL={thisSiteAddress()}</code>.
          </p>
          <PagesUrlSteps />
          <p className={styles.text}>
            If it already is this address, what answers is probably a Homebase older than this site (or another program on its port): update Homebase
            with <code>scripts/update.ps1</code> in your Homebase folder.
          </p>
        </Banner>
      ) : null}
      <SettingsCard
        id="diagnostics-site"
        title="This site"
        description={
          summary === null
            ? 'Full diagnostics (connections, server log, report) are on Homebase’s own page on this PC.'
            : 'Homebase’s own page on this PC shows the same diagnostics, and works even when this site can’t reach it.'
        }
        actions={<LocalDiagnosticsLink />}
      >
        <FactList items={facts} />
      </SettingsCard>
    </>
  );
}

export interface OverviewPanelProps {
  /** The summary query (null on the in-browser backend, which has no server to ask). */
  query: SummaryQuery | null;
}

export function OverviewPanel({ query }: OverviewPanelProps) {
  const caps = getCapabilities();
  return (
    <div className={styles.panel}>
      {query === null ? null : <ServerCard query={query} pagesBuild={caps.pagesBuild} />}
      {caps.pagesBuild ? <ThisSiteCard summary={query?.data ?? null} /> : null}
    </div>
  );
}

