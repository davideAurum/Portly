/**
 * Diagnostics → Connections & sync (ARCHITECTURE §17): every subject the server keeps in sync —
 * accounts with their calendar lists, calendars and mail, then ICS calendars, feeds, Todoist,
 * weather, search suggestions, sports and the scheduled jobs (`health.ts` groups them), whatever
 * needs attention first. Each one shows a status pill (OK / Degraded / Failing since … / Stale —
 * last checked … / Not checked yet), when it last worked, its error while it lasts (code, HTTP
 * status, Homebase's message) with what to do about it (`remedies.ts`), why it fails when that is another
 * subject ("because <account> needs attention", which moves to that subject), and when Homebase
 * tries again. Details add the outcome history, "Show related log lines" (the server log around
 * the last failure) and, for jobs and the subjects a job syncs, "Run now".
 */
import { useId, useState } from 'react';
import { ChevronDown, Play, ScrollText } from 'lucide-react';
import type { DiagnosticsSummary, HealthEntry, JobInfo, OutcomeRow } from '@homebase/shared';
import { useHealthHistory, useRunJob } from '../../api/diagnostics.ts';
import { useFormatters, type Formatters } from '../../lib/format.ts';
import { useNow } from '../../lib/useNow.ts';
import { Badge } from '../../ui/Badge.tsx';
import { Button } from '../../ui/Button.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { ErrorState } from '../../ui/ErrorState.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { SettingsCard } from '../../ui/Section.tsx';
import { SkeletonLines } from '../../ui/Skeleton.tsx';
import { toast, toastError } from '../../ui/toast.ts';
import { formatDuration } from './format.ts';
import { countByStatus, groupHealth, jobToRun, lastErrorIsCurrent, needsAttention, skippedReason, type HealthGroup, type HealthItem } from './health.ts';
import { remedyFor } from './remedies.ts';
import styles from './Diagnostics.module.css';

export interface ConnectionsPanelProps {
  summary: DiagnosticsSummary;
  /** Names an account that has no `account:<id>` entry (from the accounts list). */
  accountLabel?: (accountId: string) => string | null;
  /** "Show related log lines": the log panel switches to this subject. */
  onShowLogs(item: HealthItem): void;
  /** Whether "Run now" is offered (the server answers it). */
  canRunJobs?: boolean;
}

/** `14:02` today, else `25 Sep 2026, 14:02`. */
function sinceText(iso: string, fmt: Formatters, now: Date): string {
  const date = new Date(iso);
  return date.toDateString() === now.toDateString() ? fmt.time(date) : fmt.dateTime(date);
}

export function HealthStatusPill({ item }: { item: Pick<HealthItem, 'status' | 'entry' | 'job'> }) {
  const fmt = useFormatters();
  const now = useNow(30_000);
  const entry = item.entry;
  // A job without a health entry: its own last run.
  const lastRun = item.job?.lastFinishedAt ?? null;
  switch (item.status) {
    case 'ok':
      return (
        <Badge tone="success" dot>
          OK
        </Badge>
      );
    case 'degraded':
      return (
        <Badge tone="warning" dot>
          Degraded
        </Badge>
      );
    case 'failing': {
      const since = entry === null ? lastRun : (entry.failingSince ?? entry.lastFailAt);
      return (
        <Badge tone="danger" dot title={since === null ? undefined : fmt.dateTime(since)}>
          {since === null ? 'Failing' : `Failing since ${sinceText(since, fmt, now)}`}
        </Badge>
      );
    }
    case 'stale': {
      const checked = entry === null ? lastRun : entry.lastCheckedAt;
      return (
        <Badge tone="warning" dot title={checked === null ? undefined : fmt.dateTime(checked)}>
          {checked === null ? 'Stale — never checked' : `Stale — last checked ${fmt.relative(checked, now)}`}
        </Badge>
      );
    }
    default:
      return (
        <Badge tone="neutral" dot>
          Not checked yet
        </Badge>
      );
  }
}

/** Running / stuck / overdue, for a scheduled job. */
function JobBadges({ job }: { job: JobInfo }) {
  return (
    <>
      {job.stuckForMs !== null ? (
        <Badge tone="danger">Stuck for {formatDuration(job.stuckForMs)}</Badge>
      ) : job.running ? (
        <Badge tone="accent">Running</Badge>
      ) : null}
      {job.overdue ? <Badge tone="warning">Overdue</Badge> : null}
    </>
  );
}

interface ProblemProps {
  item: HealthItem;
  causeLabel: string | null;
  onCause: (() => void) | null;
}

/**
 * The current problem: the last error (code, HTTP status, Homebase's message) with its remedy
 * while it lasts — not an error the subject recovered from before it went stale — and the subject
 * it depends on.
 */
function Problem({ item, causeLabel, onCause }: ProblemProps) {
  const entry = item.entry;
  const current = entry !== null && lastErrorIsCurrent(entry) ? entry : null;
  const jobError = entry === null && item.job?.lastOk === false ? item.job.lastError : null;
  const code = current?.lastCode ?? jobError?.code ?? null;
  const httpStatus = current?.lastStatus ?? null;
  const message = current?.lastMessage ?? jobError?.message ?? null;
  const show = needsAttention(item.status) && (code !== null || message !== null || httpStatus !== null || entry?.causeKey);
  if (!show) return null;
  const remedy = remedyFor(code, item.key);
  return (
    <div className={styles.problem} data-tone={item.status === 'failing' ? 'danger' : 'warning'}>
      <span className={styles.problemTitle}>
        {code !== null ? <span className={styles.code}>{code}</span> : null}
        {httpStatus !== null ? <span>HTTP {httpStatus}</span> : null}
        {message !== null ? <span>{message}</span> : null}
      </span>
      {remedy !== null ? (
        <span className={styles.remedy}>
          {remedy.remedy} <span className={styles.anchor}>{remedy.anchor}</span>
        </span>
      ) : null}
      {causeLabel !== null ? (
        <span className={styles.remedy}>
          Because{' '}
          {onCause !== null ? (
            <button type="button" className={styles.linkButton} onClick={onCause}>
              {causeLabel}
            </button>
          ) : (
            <strong>{causeLabel}</strong>
          )}{' '}
          needs attention.
        </span>
      ) : null}
    </div>
  );
}

function HistoryTable({ itemKey }: { itemKey: string }) {
  const history = useHealthHistory(itemKey);
  const fmt = useFormatters();
  if (history.data === undefined) {
    return history.isError ? <ErrorState error={history.error} onRetry={() => void history.refetch()} compact title="The history could not be loaded" /> : <SkeletonLines lines={3} />;
  }
  const rows: OutcomeRow[] = history.data.rows;
  if (rows.length === 0) return <p className={styles.text}>No history yet.</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="hb-visually-hidden">Outcome history</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Result</th>
            <th scope="col">Code</th>
            <th scope="col">HTTP</th>
            <th scope="col">Message</th>
            <th scope="col">Took</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td title={row.count > 1 ? `Last at ${fmt.dateTime(row.lastAt)}` : undefined}>
                {fmt.dateTime(row.at)}
                {row.count > 1 ? ` (${row.count}×)` : ''}
              </td>
              <td>{row.ok ? (row.status === 'degraded' ? 'Degraded' : 'OK') : 'Failed'}</td>
              <td className={styles.key}>{row.code ?? ''}</td>
              <td>{row.httpStatus ?? ''}</td>
              <td>{row.message ?? ''}</td>
              <td>{row.ms === null ? '' : formatDuration(row.ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function detailText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

function ItemDetails({ item, id, onShowLogs }: { item: HealthItem; id: string; onShowLogs(): void }) {
  const entry: HealthEntry | null = item.entry;
  const job = item.job;
  const fmt = useFormatters();
  const facts: [string, string][] = [];
  const time = (iso: string | null) => (iso === null ? null : fmt.dateTime(iso));
  const push = (label: string, value: string | null) => {
    if (value !== null && value !== '') facts.push([label, value]);
  };
  if (entry !== null) {
    push('Last checked', time(entry.lastCheckedAt));
    push('Last OK', time(entry.lastOkAt));
    push('Last failure', time(entry.lastFailAt));
    push('Failing since', time(entry.failingSince));
    if (entry.consecutiveFailures > 0) push('Failures in a row', String(entry.consecutiveFailures));
    push('Took', entry.lastMs === null ? null : formatDuration(entry.lastMs));
    push('Stale after', entry.expectEveryMs === null ? 'Never (checked when used)' : `${formatDuration(entry.expectEveryMs)} without a check`);
    push('Next attempt', time(entry.nextAttemptAt));
    for (const [key, value] of Object.entries(entry.detail ?? {})) push(key, detailText(value));
  }
  if (job !== null) {
    push('Runs every', formatDuration(job.intervalMs));
    push('Next run', time(job.nextRunAt));
    push('Runs', `${job.runs} (${job.failures} failed)`);
    push('Last run', job.lastFinishedAt === null ? null : `${fmt.dateTime(job.lastFinishedAt)}${job.lastMs === null ? '' : `, took ${formatDuration(job.lastMs)}`}`);
    if (job.lastError !== null) push('Last error', `${job.lastError.name}${job.lastError.code === null ? '' : ` [${job.lastError.code}]`}: ${job.lastError.message}`);
  }
  return (
    <div id={id} className={styles.details}>
      {facts.length > 0 ? (
        <dl className={styles.detailList}>
          {facts.map(([label, value]) => (
            <div key={label} className={styles.detailPair}>
              <dt>{label}</dt>
              <dd className={label === 'Last error' ? styles.mono : undefined}>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className={styles.inlineRow}>
        <Button size="sm" icon={ScrollText} onClick={onShowLogs}>
          Show related log lines
        </Button>
      </div>
      {entry !== null ? <HistoryTable itemKey={item.key} /> : null}
    </div>
  );
}

function RunNowButton({ job, running }: { job: string; running: boolean }) {
  const run = useRunJob();
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={Play}
      loading={run.isPending}
      disabled={running}
      aria-label={`Run now: ${job}`}
      onClick={() =>
        run.mutate(job, {
          onSuccess: () => toast.success(`${job} started.`),
          onError: (error) => toastError(error, `${job} could not be started.`),
        })
      }
    >
      Run now
    </Button>
  );
}

/** Inside an account's group the account is the heading: its own subjects are named by what they are. */
const ACCOUNT_SUBJECT_TITLES: readonly [prefix: string, title: string][] = [
  ['account:', 'Account'],
  ['calendar-list:', 'Calendar list'],
  ['mail:', 'Mail'],
];

function itemTitle(item: HealthItem, group: HealthGroup): string {
  if (group.accountId === null) return item.label;
  return ACCOUNT_SUBJECT_TITLES.find(([prefix]) => item.key.startsWith(prefix))?.[1] ?? item.label;
}

/** The subject's full name, for controls that must say which subject they act on ("Work, Mail"). */
function itemName(item: HealthItem, group: HealthGroup): string {
  return group.accountId === null ? item.label : `${group.title}, ${itemTitle(item, group)}`;
}

interface ItemRowProps {
  item: HealthItem;
  /** What the row is called (in an account's group: Account, Calendar list, Mail or the calendar's name). */
  title: string;
  /** Its full name (the account's name too): what its Details button names. */
  name: string;
  domId: string;
  jobs: readonly JobInfo[];
  canRunJobs: boolean;
  cause: { label: string; domId: string | null } | null;
  onShowLogs(item: HealthItem): void;
}

function ItemRow({ item, title, name, domId, jobs, canRunJobs, cause, onShowLogs }: ItemRowProps) {
  const [open, setOpen] = useState(false);
  const entry = item.entry;
  const job = item.job;
  const runnable = canRunJobs ? jobToRun(item.key, jobs) : null;
  const skipped = skippedReason(entry);
  const causeDomId = cause?.domId ?? null;
  const focusCause =
    causeDomId === null
      ? null
      : () => {
          const target = document.getElementById(causeDomId);
          target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          target?.focus({ preventScroll: true });
        };
  const runningJob = runnable === null ? null : (jobs.find((j) => j.name === runnable) ?? null);
  return (
    <li id={domId} tabIndex={-1} className={styles.item} aria-label={title}>
      <div className={styles.itemHead}>
        <HealthStatusPill item={item} />
        <span className={styles.itemLabel}>{title}</span>
        {job !== null ? <JobBadges job={job} /> : null}
        <div className={styles.itemActions}>
          {runnable !== null ? <RunNowButton job={runnable} running={runningJob?.running === true} /> : null}
          <Button
            size="sm"
            variant="ghost"
            icon={ChevronDown}
            aria-label={`${open ? 'Hide details' : 'Details'}: ${name}`}
            aria-expanded={open}
            aria-controls={open ? `${domId}-details` : undefined}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide details' : 'Details'}
          </Button>
        </div>
      </div>
      <p className={styles.meta}>
        <span className={styles.key}>{item.key}</span>
        {entry?.lastOkAt ? (
          <span>
            last OK <RelativeTime date={entry.lastOkAt} />
          </span>
        ) : entry !== null && entry.status !== 'unknown' ? (
          <span>never OK yet</span>
        ) : null}
        {entry !== null && entry.expectEveryMs === null && entry.lastCheckedAt !== null && entry.status === 'ok' ? (
          <span>
            last checked <RelativeTime date={entry.lastCheckedAt} />
          </span>
        ) : null}
        {entry?.nextAttemptAt ? (
          <span>
            next attempt <RelativeTime date={entry.nextAttemptAt} />
          </span>
        ) : null}
        {job?.nextRunAt && !job.running ? (
          <span>
            next run <RelativeTime date={job.nextRunAt} />
          </span>
        ) : null}
        {skipped !== null ? <span>skipped: {skipped}</span> : null}
      </p>
      <Problem item={item} causeLabel={cause?.label ?? null} onCause={focusCause} />
      {open ? <ItemDetails item={item} id={`${domId}-details`} onShowLogs={() => onShowLogs(item)} /> : null}
    </li>
  );
}

export function ConnectionsPanel({ summary, accountLabel, onShowLogs, canRunJobs = true }: ConnectionsPanelProps) {
  const baseId = useId();
  const groups: HealthGroup[] = groupHealth(summary, accountLabel);
  const items = groups.flatMap((g) => g.items);
  const domIds = new Map(items.map((item, index) => [item.key, `${baseId}-subject-${index}`]));
  const labels = new Map(items.map((item) => [item.key, item.label]));
  const counts = countByStatus(items.map((item) => ({ status: item.status })));

  const causeOf = (item: HealthItem): ItemRowProps['cause'] => {
    const causeKey = item.entry?.causeKey ?? null;
    if (causeKey === null) return null;
    const accountId = /^account:(.+)$/.exec(causeKey)?.[1];
    const label = labels.get(causeKey) ?? (accountId === undefined ? undefined : accountLabel?.(accountId)) ?? causeKey;
    return { label, domId: domIds.get(causeKey) ?? null };
  };

  return (
    <SettingsCard
      id="diagnostics-connections"
      title="Connections & sync"
      description={
        groups.length === 0
          ? 'Every account, calendar, feed and job Homebase keeps in sync.'
          : `${counts.ok} OK · ${counts.failing} failing · ${counts.stale} stale · ${counts.degraded} degraded · ${counts.unknown} not checked yet. What needs attention comes first.`
      }
    >
      {groups.length === 0 ? (
        <EmptyState title="Nothing checked yet" body="Accounts, calendars, feeds and jobs appear here once Homebase has synced them." />
      ) : (
        <div className={styles.groups}>
          {groups.map((group) => (
            <section key={group.id} className={styles.group} aria-labelledby={`${baseId}-${group.id}`}>
              <h3 id={`${baseId}-${group.id}`} className={styles.groupTitle}>
                {group.title}
              </h3>
              <ul className={styles.list}>
                {group.items.map((item) => (
                  <ItemRow
                    key={item.key}
                    item={item}
                    title={itemTitle(item, group)}
                    name={itemName(item, group)}
                    domId={domIds.get(item.key)!}
                    jobs={summary.jobs}
                    canRunJobs={canRunJobs}
                    cause={causeOf(item)}
                    onShowLogs={onShowLogs}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </SettingsCard>
  );
}
