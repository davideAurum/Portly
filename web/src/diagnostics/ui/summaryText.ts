/**
 * "Copy summary" (Settings → Diagnostics, Report; ARCHITECTURE §17): a plain-text digest of at most
 * 40 lines to paste into a message or an issue — when it was made (with the UTC offset), the
 * server (version, boot, uptime, Node, OS, supervisor and its last restart), this page (build,
 * version, backend, hybrid status and permission, version skew), log level, vault, modules down,
 * the Pages origin and foreign origins, overdue or stuck jobs, health counts and every subject
 * that is not OK, the last distinct server warnings and errors (with how often each happened) and
 * the last browser warnings and errors. The Report panel redacts it with `redactForSharing` when
 * "Hide hosts, emails and names" is ticked.
 */
import type { ClientEvent, DiagnosticsSummary, LogRecord } from '@portly/shared';
import type { LocalServerStatus, LoopbackPermission } from '../../localServer/types.ts';
import type { ClientLogEntry } from '../clientLog.ts';
import { describeLastExit, formatDuration, localTimeWithOffset, logTime } from './format.ts';
import { countByStatus, lastErrorIsCurrent, needsAttention } from './health.ts';

export const SUMMARY_MAX_LINES = 40;
const MAX_SERVER_LINES = 10;
const MAX_BROWSER_LINES = 5;

export interface SummaryPage {
  build: 'server' | 'pages';
  version: string;
  backend: 'server' | 'browser';
}

export interface SummaryTextInput {
  now: Date;
  /** null: no summary (the browser backend, a server without diagnostics, or it failed). */
  summary: DiagnosticsSummary | null;
  /** Why there is no summary, when there should be one. */
  summaryProblem?: string | null;
  page: SummaryPage;
  /** The Pages build's local server state (null in the server build). */
  hybrid: { status: LocalServerStatus; permission: LoopbackPermission | null } | null;
  /** The server's recent warn+ records (null: not read). */
  serverRecords: readonly LogRecord[] | null;
  browserEvents: readonly ClientLogEntry[];
}

/** `2026-10-11 14:32` in local time (the offset is on the summary's first line). */
function localMinute(iso: string | null): string {
  if (iso === null) return '';
  return localTimeWithOffset(new Date(iso)).slice(0, 16);
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function serverLine(summary: DiagnosticsSummary): string {
  const { server } = summary;
  const parts = [`Server: ${server.version}`, `boot ${server.boot}`, `up ${formatDuration(server.uptimeMs) || '0 s'}`, `Node ${server.node}`, server.platform];
  if (server.supervised) {
    const restart = server.restart;
    const exit = describeLastExit(restart?.lastExit ?? null);
    parts.push(restart !== null && restart.attempt > 0 ? `supervised, restart ${restart.attempt}${exit === null ? '' : ` (${exit})`}` : 'supervised');
  } else {
    parts.push('not supervised');
  }
  return parts.join(' · ');
}

function pageLine(input: SummaryTextInput): string {
  const { page, hybrid, summary } = input;
  const parts = [`Page: ${page.build === 'pages' ? 'Pages site' : "Portly's own page"} ${page.version}`, page.backend === 'server' ? 'data from Portly on this PC' : 'data in this browser'];
  if (hybrid !== null) parts.push(`hybrid: ${hybrid.status}${hybrid.permission === null ? '' : ` (permission: ${hybrid.permission})`}`);
  if (summary !== null && summary.server.version !== page.version) parts.push(`version differs from the server (${summary.server.version})`);
  return parts.join(' · ');
}

function logLevelLine(summary: DiagnosticsSummary): string {
  const { logLevel } = summary;
  if (!logLevel.verbose) return `Log level: Normal (${logLevel.level})`;
  const until = logLevel.until === null ? 'until turned off' : `until ${localMinute(logLevel.until)}`;
  const areas = logLevel.areas === null ? 'all areas' : `areas: ${logLevel.areas.join(', ')}`;
  return `Log level: Verbose (${logLevel.level}) ${until}, ${areas}`;
}

function hybridLine(summary: DiagnosticsSummary): string {
  const { hybrid } = summary;
  const parts = [`Pages origin: ${hybrid.pagesOrigin ?? 'not set'}`, plural(hybrid.pairings, 'paired browser')];
  if (hybrid.foreignOrigins.length > 0) {
    parts.push(`foreign origins: ${hybrid.foreignOrigins.map((o) => `${o.origin} (${o.count}×, last ${localMinute(o.lastAt)})`).join(', ')}`);
  }
  if (hybrid.foreignOriginRequests > 0) parts.push(`${plural(hybrid.foreignOriginRequests, 'request')} from other sites`);
  return parts.join(' · ');
}

function jobsLine(summary: DiagnosticsSummary): string {
  const troubled = summary.jobs
    .filter((job) => job.overdue || job.stuckForMs !== null)
    .map((job) => (job.stuckForMs !== null ? `${job.name} stuck for ${formatDuration(job.stuckForMs)}` : `${job.name} overdue`));
  return `Jobs: ${troubled.length === 0 ? `${summary.jobs.length} scheduled, none overdue or stuck` : troubled.join('; ')}`;
}

function healthLines(summary: DiagnosticsSummary): { counts: string; entries: string[] } {
  const c = countByStatus(summary.health);
  const counts = `Health: ${c.ok} OK, ${c.degraded} degraded, ${c.failing} failing, ${c.stale} stale, ${c.unknown} not checked`;
  const entries = summary.health
    .filter((entry) => needsAttention(entry.status))
    .map((entry) => {
      // A subject that recovered and then went stale: its last error is history, its last check the news.
      const current = lastErrorIsCurrent(entry);
      const facts = current
        ? [entry.lastCode, entry.lastStatus === null ? null : `HTTP ${entry.lastStatus}`]
        : [entry.lastCheckedAt === null ? 'never checked' : `last checked ${localMinute(entry.lastCheckedAt)}`];
      if (entry.failingSince !== null) facts.push(`since ${localMinute(entry.failingSince)}`);
      if (entry.consecutiveFailures > 0) facts.push(`${entry.consecutiveFailures}×`);
      const head = `- ${entry.status} ${entry.key}${entry.label === null ? '' : ` (${entry.label})`}`;
      const detail = facts.filter((f): f is string => f !== null && f !== '').join(', ');
      const message = !current || entry.lastMessage === null ? '' : ` — ${entry.lastMessage}`;
      const cause = entry.causeKey === null ? '' : `; because ${entry.causeKey}`;
      return `${head}${detail === '' ? '' : `: ${detail}`}${message}${cause}`;
    });
  return { counts, entries };
}

interface WarningGroup {
  level: string;
  area: string;
  msg: string;
  code: string | null;
  count: number;
  last: number;
}

function isWarnLevel(value: unknown): value is 'warn' | 'error' {
  return value === 'warn' || value === 'error';
}

/**
 * The last distinct warn/error lines (message + area + code), newest first, with how often each
 * happened. The server writes the repeats of a warning within 30 minutes at debug, each with
 * `repeatOf` (the level), `repeatSince` (its window's start) and `repeats` (the window's running
 * count, not 1), and closes the window with an info `repeated` summary (`repeatOf`, `repeatMsg`,
 * `since`, `count`): a window adds the largest count seen for it. A browser event's own `repeats`
 * (identical events it stands for) multiplies it.
 */
function serverWarningLines(records: readonly LogRecord[]): string[] {
  const groups = new Map<string, WarningGroup>();
  /** `<group>|<window start>` → the group and the window's largest count seen. */
  const windows = new Map<string, { group: WarningGroup; count: number }>();
  const groupFor = (level: string, area: string, msg: string, code: string | null, time: number): WarningGroup => {
    const id = `${level}|${area}|${msg}|${code ?? ''}`;
    let group = groups.get(id);
    if (group === undefined) {
      group = { level, area, msg, code, count: 0, last: time };
      groups.set(id, group);
    }
    return group;
  };
  for (const record of records) {
    const fields = record.fields;
    const code = typeof fields.code === 'string' ? fields.code : null;
    const time = Date.parse(record.t);
    if (!isWarnLevel(record.level)) {
      const repeatOf = fields.repeatOf;
      if (!isWarnLevel(repeatOf)) continue;
      const summary = typeof fields.repeatMsg === 'string';
      const msg = summary ? fields.repeatMsg : record.msg;
      const since = summary ? fields.since : fields.repeatSince;
      const count = summary ? fields.count : fields.repeats;
      if (typeof msg !== 'string' || typeof count !== 'number' || !(count > 0)) continue;
      const group = groupFor(repeatOf, record.area, msg, code, time);
      // A summary is written when its window closes, later than the repeats it stands for.
      if (!summary) group.last = Math.max(group.last, time);
      const id = `${repeatOf}|${record.area}|${msg}|${code ?? ''}|${String(since)}`;
      const window = windows.get(id);
      if (window === undefined) windows.set(id, { group, count });
      else window.count = Math.max(window.count, count);
      continue;
    }
    const repeats = typeof fields.repeats === 'number' && fields.repeats > 0 ? fields.repeats : 1;
    const group = groupFor(record.level, record.area, record.msg, code, time);
    group.count += repeats;
    group.last = Math.max(group.last, time);
  }
  for (const window of windows.values()) window.group.count += window.count;
  return [...groups.values()]
    .sort((a, b) => b.last - a.last)
    .slice(0, MAX_SERVER_LINES)
    .map((g) => `- ${g.count}× ${g.level} [${g.area}] ${g.msg}${g.code === null ? '' : ` (${g.code})`}`);
}

function eventFacts(event: ClientEvent): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(event.fields)) {
    if (parts.length >= 6) break;
    if (value === null || Array.isArray(value)) continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.length === 0 ? '' : ` (${parts.join(' ')})`;
}

function browserLines(entries: readonly ClientLogEntry[]): string[] {
  return entries
    .filter((entry) => entry.event.level === 'warn' || entry.event.level === 'error')
    .slice(-MAX_BROWSER_LINES)
    .reverse()
    .map(({ event }) => `- ${logTime(event.t)} ${event.level} ${event.cat}: ${event.msg}${eventFacts(event)}`);
}

/** The Copy summary text (≤ {@link SUMMARY_MAX_LINES} lines; subjects beyond the budget are counted). */
export function buildSummaryText(input: SummaryTextInput): string {
  const { summary } = input;
  const head: string[] = [`Portly diagnostics, ${localTimeWithOffset(input.now)}`];
  let health: { counts: string; entries: string[] } | null = null;
  if (summary === null) {
    head.push(`Server: ${input.summaryProblem ?? 'not available on this page'}`);
    head.push(pageLine(input));
  } else {
    head.push(serverLine(summary), pageLine(input), logLevelLine(summary), `Vault: ${summary.vault}`);
    const down = summary.modules.filter((m) => !m.ok).map((m) => m.name);
    head.push(`Modules down: ${down.length === 0 ? 'none' : down.join(', ')}`);
    head.push(hybridLine(summary), jobsLine(summary));
    health = healthLines(summary);
    head.push(health.counts);
  }

  const tail: string[] = [];
  if (input.serverRecords !== null) {
    const lines = serverWarningLines(input.serverRecords);
    tail.push(lines.length === 0 ? 'Recent server warnings and errors: none' : 'Recent server warnings and errors:', ...lines);
  }
  const browser = browserLines(input.browserEvents);
  tail.push(browser.length === 0 ? 'Recent browser warnings and errors: none' : 'Recent browser warnings and errors:', ...browser);

  const entries = health?.entries ?? [];
  const room = Math.max(0, SUMMARY_MAX_LINES - head.length - tail.length);
  const shown = entries.length <= room ? entries : room === 0 ? [] : [...entries.slice(0, room - 1), `- … and ${entries.length - (room - 1)} more`];
  return [...head, ...shown, ...tail].slice(0, SUMMARY_MAX_LINES).join('\n');
}
