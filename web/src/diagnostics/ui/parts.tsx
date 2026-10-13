/**
 * Small pieces shared by the Diagnostics panels: a record's level, the server's log level
 * ("Normal" / "Verbose until 14:32"), the formatted JSON of a record's fields, the notice for a
 * server without diagnostics, and the link to the diagnostics page of Portly on this PC (the
 * Pages build).
 */
import type { LogLevel, LogLevelState } from '@portly/shared';
import { ArrowUpRight, CloudOff } from 'lucide-react';
import { useFormatters } from '../../lib/format.ts';
import { Badge, type BadgeTone } from '../../ui/Badge.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { ExternalLink } from '../../ui/ExternalLink.tsx';
import { escapeUnsafeJson, localDiagnosticsUrl } from './format.ts';
import styles from './Diagnostics.module.css';

const LEVEL_VIEWS: Readonly<Record<LogLevel, { label: string; tone: BadgeTone }>> = {
  debug: { label: 'debug', tone: 'neutral' },
  info: { label: 'info', tone: 'accent' },
  warn: { label: 'warn', tone: 'warning' },
  error: { label: 'error', tone: 'danger' },
};

export function LevelBadge({ level }: { level: LogLevel }) {
  const view = LEVEL_VIEWS[level];
  return <Badge tone={view.tone}>{view.label}</Badge>;
}

/** "Normal" or "Verbose until 14:32" (the badge shown in the overview and the log level panel). */
export function LogLevelBadge({ state }: { state: LogLevelState }) {
  const fmt = useFormatters();
  if (!state.verbose) return <Badge tone="neutral">Normal ({state.level})</Badge>;
  const until = state.until === null ? 'until turned off' : `until ${fmt.time(state.until)}`;
  return (
    <Badge tone="warning" title={state.areas === null ? 'Every area' : `Areas: ${state.areas.join(', ')}`}>
      Verbose {until}
    </Badge>
  );
}

/** A record's fields as indented JSON (already scrubbed by whoever recorded them; controls and bidi characters escaped). */
export function FieldsView({ fields, id }: { fields: unknown; id?: string }) {
  let text: string;
  try {
    text = escapeUnsafeJson(JSON.stringify(fields, null, 2) ?? '');
  } catch {
    text = String(fields);
  }
  return (
    <pre id={id} className={styles.fields}>
      {text === '{}' ? 'No fields' : text}
    </pre>
  );
}

/** Title of the notice for a server that predates diagnostics (`403 local_only` / `404`). */
export const UPDATE_PORTLY_NOTICE = 'Update Portly on this PC to see its diagnostics';

export function UnavailableNotice() {
  return (
    <EmptyState
      icon={CloudOff}
      title={UPDATE_PORTLY_NOTICE}
      body="Portly on this PC is older than this page and has no diagnostics yet. This browser's own events are listed under This browser."
    />
  );
}

/** "Open diagnostics on this PC": Portly's own diagnostics page, which works even when this site can't reach it. */
export function LocalDiagnosticsLink() {
  return (
    <ExternalLink href={localDiagnosticsUrl()} className={styles.localLink}>
      <ArrowUpRight aria-hidden="true" className={styles.inlineIcon} />
      Open diagnostics on this PC
    </ExternalLink>
  );
}
