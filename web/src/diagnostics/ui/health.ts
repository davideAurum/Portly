/**
 * Connections & sync (Settings → Diagnostics, ARCHITECTURE §17): the server's health entries
 * grouped the way a user thinks about them — per account first (the account itself, its calendar
 * list, each calendar, its mail), then per area (ICS calendars, feeds, Todoist, weather, search
 * suggestions, sports, scheduled jobs) — with whatever needs attention first. Scheduled jobs are
 * listed from the summary's job stats, joined with their `job:<name>` health entries, so that a job
 * that never ran yet shows too. Also: which job "Run now" starts for a subject, and the log filter
 * of "Show related log lines".
 */
import type { DiagnosticsSummary, HealthEntry, HealthStatus, JobInfo } from '@portly/shared';

export interface HealthItem {
  key: string;
  /** The health entry (null: a job that has not run since its entry was purged, or never ran). */
  entry: HealthEntry | null;
  /** The job's stats, for `job:<name>` items. */
  job: JobInfo | null;
  /** What to call it: the entry's resolved label, the job name, else the key. */
  label: string;
  status: HealthStatus;
}

export interface HealthGroup {
  /** `account:<id>` or `area:<name>`. */
  id: string;
  title: string;
  accountId: string | null;
  items: HealthItem[];
  /** Some item is failing, stale or degraded. */
  attention: boolean;
}

const SEVERITY: Readonly<Record<HealthStatus, number>> = { failing: 0, stale: 1, degraded: 2, unknown: 3, ok: 4 };

/** Failing, stale and degraded subjects come first. */
export function needsAttention(status: HealthStatus): boolean {
  return SEVERITY[status] <= SEVERITY.degraded;
}

/**
 * The entry's last error (code, HTTP status, message) is its problem now: it is failing or
 * degraded, or stale while it was (`failingSince`, cleared by the next OK). The server keeps the
 * last error after a recovery, so a subject that recovered and then went stale (its check or job
 * is late) would otherwise show an old error as its problem.
 */
export function lastErrorIsCurrent(entry: Pick<HealthEntry, 'status' | 'failingSince'>): boolean {
  return entry.status === 'failing' || entry.status === 'degraded' || entry.failingSince !== null;
}

/** The order inside an account: the account, its calendar list, its calendars, its mail. */
const ACCOUNT_KEY_ORDER = ['account:', 'calendar-list:', 'calendar:', 'mail:'];

/** Groups of subjects without an account, in this order (anything else: "Other"). */
const AREA_GROUPS: readonly { id: string; title: string; matches(key: string): boolean }[] = [
  { id: 'ics', title: 'ICS calendars', matches: (key) => key.startsWith('ics:') },
  { id: 'feeds', title: 'Feeds', matches: (key) => key.startsWith('feed:') },
  { id: 'todoist', title: 'Todoist', matches: (key) => key === 'todoist' || key.startsWith('todoist:') },
  { id: 'weather', title: 'Weather', matches: (key) => key === 'weather' || key.startsWith('weather:') },
  { id: 'search', title: 'Search suggestions', matches: (key) => key.startsWith('suggest:') },
  { id: 'sports', title: 'Sports', matches: (key) => key.startsWith('sports:') },
  { id: 'jobs', title: 'Scheduled jobs', matches: (key) => key.startsWith('job:') },
];
const OTHER_GROUP = { id: 'other', title: 'Other' };

/** Keys whose suffix is an account id (when the entry itself does not say). */
const ACCOUNT_KEY = /^(?:account|calendar-list|mail):(.+)$/;

function accountIdOf(entry: HealthEntry): string | null {
  return entry.accountId ?? ACCOUNT_KEY.exec(entry.key)?.[1] ?? null;
}

function keyRank(key: string): number {
  const rank = ACCOUNT_KEY_ORDER.findIndex((prefix) => key.startsWith(prefix));
  return rank === -1 ? ACCOUNT_KEY_ORDER.length : rank;
}

function byAttentionThenOrder(a: HealthItem, b: HealthItem): number {
  return (
    Number(!needsAttention(a.status)) - Number(!needsAttention(b.status)) ||
    keyRank(a.key) - keyRank(b.key) ||
    SEVERITY[a.status] - SEVERITY[b.status] ||
    a.label.localeCompare(b.label)
  );
}

/** A name for a subject the server gave no label (Todoist, weather, a suggestion provider). */
function defaultLabel(key: string): string {
  if (key === 'todoist') return 'Todoist';
  if (key === 'weather') return 'Weather';
  if (key.startsWith('suggest:')) return `Suggestions from ${key.slice('suggest:'.length)}`;
  if (key.startsWith('job:')) return key.slice('job:'.length);
  return key;
}

function itemOf(entry: HealthEntry, job: JobInfo | null = null): HealthItem {
  return { key: entry.key, entry, job, label: entry.label ?? job?.name ?? defaultLabel(entry.key), status: entry.status };
}

/** A job without a health entry: its stats decide (never ran: not checked yet). */
function jobItem(job: JobInfo): HealthItem {
  const status: HealthStatus = job.stuckForMs !== null || job.overdue ? 'stale' : job.lastOk === null ? 'unknown' : job.lastOk ? 'ok' : 'failing';
  return { key: `job:${job.name}`, entry: null, job, label: job.name, status };
}

/**
 * The summary's health entries and jobs as groups: accounts (attention first, then by name), then
 * the area groups in their fixed order — with groups that need attention before the others.
 * `accountLabel` names an account that has no `account:<id>` entry of its own.
 */
export function groupHealth(summary: Pick<DiagnosticsSummary, 'health' | 'jobs'>, accountLabel: (accountId: string) => string | null = () => null): HealthGroup[] {
  const accounts = new Map<string, HealthItem[]>();
  const areas = new Map<string, HealthItem[]>();
  const jobs = new Map(summary.jobs.map((job) => [`job:${job.name}`, job]));
  const add = (map: Map<string, HealthItem[]>, id: string, item: HealthItem) => {
    const list = map.get(id);
    if (list === undefined) map.set(id, [item]);
    else list.push(item);
  };

  for (const entry of summary.health) {
    const accountId = accountIdOf(entry);
    if (accountId !== null) {
      add(accounts, accountId, itemOf(entry));
      continue;
    }
    const group = AREA_GROUPS.find((g) => g.matches(entry.key)) ?? OTHER_GROUP;
    add(areas, group.id, itemOf(entry, jobs.get(entry.key) ?? null));
    jobs.delete(entry.key);
  }
  for (const job of jobs.values()) add(areas, 'jobs', jobItem(job));

  const groups: (HealthGroup & { order: number })[] = [];
  for (const [accountId, items] of accounts) {
    // The server names `account:`, `calendar-list:` and `mail:` subjects after their account.
    const named = items.find((item) => item.key === `account:${accountId}`) ?? items.find((item) => /^(?:calendar-list|mail):/.test(item.key));
    const title = (named?.entry?.label ?? null) || accountLabel(accountId) || accountId;
    items.sort(byAttentionThenOrder);
    groups.push({ id: `account:${accountId}`, title, accountId, items, attention: items.some((i) => needsAttention(i.status)), order: 0 });
  }
  for (const [id, items] of areas) {
    const index = AREA_GROUPS.findIndex((g) => g.id === id);
    const title = index === -1 ? OTHER_GROUP.title : AREA_GROUPS[index]!.title;
    items.sort(byAttentionThenOrder);
    groups.push({ id: `area:${id}`, title, accountId: null, items, attention: items.some((i) => needsAttention(i.status)), order: index === -1 ? AREA_GROUPS.length + 1 : index + 1 });
  }
  groups.sort((a, b) => Number(!a.attention) - Number(!b.attention) || a.order - b.order || a.title.localeCompare(b.title));
  return groups.map(({ order: _order, ...group }) => group);
}

/** Counts per status (`unknown` = not checked yet), for the overview and the Copy summary. */
export function countByStatus(health: readonly Pick<HealthEntry, 'status'>[]): Record<HealthStatus, number> {
  const counts: Record<HealthStatus, number> = { ok: 0, degraded: 0, failing: 0, stale: 0, unknown: 0 };
  for (const entry of health) counts[entry.status] += 1;
  return counts;
}

/** Subjects synced by a job of their own: "Run now" starts that job. */
const JOB_FOR_KEY: readonly [prefix: string, job: string][] = [
  ['calendar-list:', 'calendar:sync'],
  ['calendar:', 'calendar:sync'],
  ['ics:', 'calendar:ics'],
];

/** The job "Run now" starts for an item: its own (`job:<name>`), or the job that syncs it — when the server has it. */
export function jobToRun(key: string, jobs: readonly Pick<JobInfo, 'name'>[]): string | null {
  const names = new Set(jobs.map((job) => job.name));
  if (key.startsWith('job:')) {
    const name = key.slice('job:'.length);
    return names.has(name) ? name : null;
  }
  const match = JOB_FOR_KEY.find(([prefix]) => key.startsWith(prefix));
  return match !== undefined && names.has(match[1]) ? match[1] : null;
}

/** Why a check was skipped (`detail.skipped` of a `touch`), in words. */
const SKIPPED: Readonly<Record<string, string>> = {
  backoff: 'waiting before trying again',
  vault_locked: 'saved credentials are locked',
  missing_url: 'no address saved',
  disabled: 'turned off',
  account_unavailable: 'its account needs attention',
};

export function skippedReason(entry: Pick<HealthEntry, 'detail'> | null): string | null {
  const skipped = entry?.detail?.skipped;
  if (typeof skipped !== 'string') return null;
  return SKIPPED[skipped] ?? skipped;
}

/** One hour before and after the last failure: the window of "Show related log lines". */
export const RELATED_LOG_WINDOW_MS = 60 * 60 * 1000;

/** The time window of "Show related log lines" for an entry (null: no failure to center on). */
export function relatedLogWindow(entry: Pick<HealthEntry, 'lastFailAt'> | null): { since: string; before: string } | null {
  const at = entry?.lastFailAt ? Date.parse(entry.lastFailAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return { since: new Date(at - RELATED_LOG_WINDOW_MS).toISOString(), before: new Date(at + RELATED_LOG_WINDOW_MS).toISOString() };
}
