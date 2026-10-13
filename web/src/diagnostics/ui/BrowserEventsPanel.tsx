/**
 * Diagnostics → This browser (ARCHITECTURE §17): the events this browser recorded
 * (`clientLog.ts`): failed or slow requests, hybrid-mode changes, in-browser backend and provider
 * failures, widget errors and uncaught app errors — newest first, live (any tab), each marked as
 * sent to Portly, not sent yet, or kept in this browser only, and expandable to its fields.
 * Clear forgets them in every tab.
 *
 * "Not sent yet" only for what the uploader (`upload.ts`, every 15 s) will send: not to a server
 * that predates diagnostics (it refuses them, and the uploads stop for the page load), and debug
 * events only while the server keeps them (verbose logging covers browser events).
 */
import { useId, useState } from 'react';
import { ChevronRight, Eraser } from 'lucide-react';
import { getCapabilities } from '../../capabilities.ts';
import { useFormatters } from '../../lib/format.ts';
import { Badge } from '../../ui/Badge.tsx';
import { Button } from '../../ui/Button.tsx';
import { SettingsCard } from '../../ui/Section.tsx';
import { clearClientEvents, clientSessionId, isUploadable, type ClientLogEntry } from '../clientLog.ts';
import { logTime } from './format.ts';
import { useClientEvents } from './hooks.ts';
import { FieldsView, LevelBadge } from './parts.tsx';
import styles from './Diagnostics.module.css';

interface DeliveryContext {
  /** This page load's backend is the server (it uploads). */
  server: boolean;
  /** The server predates diagnostics: it refuses browser events. */
  refused: boolean;
  /** The server keeps debug events (false while unknown). */
  acceptDebug: boolean;
}

function delivery(entry: ClientLogEntry, context: DeliveryContext): { label: string; title: string } {
  const { event } = entry;
  if (entry.uploaded) return { label: 'Sent', title: 'Portly on this PC has it in its log' };
  if (!isUploadable(event)) {
    return {
      label: 'This browser only',
      title: event.page.backend === 'server' ? 'Portly answered this request and logged it itself' : 'Recorded while this page used the copy saved in this browser',
    };
  }
  if (context.refused) return { label: 'This browser only', title: 'Portly on this PC is older than this page and does not take browser events' };
  if (event.level === 'debug' && !context.acceptDebug) {
    return { label: 'This browser only (debug)', title: 'Debug events are sent only while verbose logging covers browser events (Logging level)' };
  }
  if (!context.server) return { label: 'Not sent yet', title: 'Sent once this site uses Portly on this PC again' };
  return { label: 'Not sent yet', title: 'Sent to Portly on this PC within about 15 seconds' };
}

function EventRow({ entry, current, context }: { entry: ClientLogEntry; current: boolean; context: DeliveryContext }) {
  const [open, setOpen] = useState(false);
  const fmt = useFormatters();
  const fieldsId = useId();
  const { event } = entry;
  const sent = delivery(entry, context);
  return (
    <li className={styles.logRow} data-level={event.level}>
      <button type="button" className={styles.logHead} aria-expanded={open} aria-controls={open ? fieldsId : undefined} onClick={() => setOpen((v) => !v)} title={fmt.dateTime(event.t)}>
        <ChevronRight aria-hidden="true" className={styles.chevron} />
        <span className={styles.time}>{logTime(event.t)}</span>
        <LevelBadge level={event.level} />
        <span className={styles.area}>{event.cat}</span>
        <span className={styles.msg}>{event.msg}</span>
        <Badge tone="neutral" title={sent.title}>
          {sent.label}
        </Badge>
        {current ? null : <Badge tone="neutral">Earlier page load</Badge>}
      </button>
      {open ? <FieldsView fields={{ ...event.fields, page: event.page }} id={fieldsId} /> : null}
    </li>
  );
}

export interface BrowserEventsPanelProps {
  /** The server answered that it predates diagnostics (it refuses browser events). */
  serverRefuses?: boolean;
  /** The server keeps debug events (`takesDebugEvents` of its log level); false while unknown. */
  acceptDebug?: boolean;
}

export function BrowserEventsPanel({ serverRefuses = false, acceptDebug = false }: BrowserEventsPanelProps) {
  const entries = useClientEvents();
  const session = clientSessionId();
  const server = getCapabilities().backend === 'server';
  const context: DeliveryContext = { server, refused: server && serverRefuses, acceptDebug: server && acceptDebug };
  const newestFirst = [...entries].reverse();
  const warnings = entries.filter((e) => e.event.level === 'warn' || e.event.level === 'error').length;
  return (
    <SettingsCard
      id="diagnostics-browser"
      title="This browser"
      description={
        server
          ? 'What this browser noticed: failed requests, the connection with Portly on this PC and app errors. Kept for 7 days in this browser and sent to Portly on this PC.'
          : 'What this browser noticed: failed requests, the search for Portly on this PC and app errors. Kept for 7 days in this browser only.'
      }
      actions={
        <Button size="sm" variant="ghost" icon={Eraser} disabled={entries.length === 0} onClick={() => clearClientEvents()}>
          Clear
        </Button>
      }
    >
      <p className={styles.liveStatus} aria-live="polite">
        {entries.length === 0 ? 'No events recorded.' : `${entries.length} ${entries.length === 1 ? 'event' : 'events'}, ${warnings} ${warnings === 1 ? 'warning or error' : 'warnings or errors'}`}
      </p>
      {entries.length === 0 ? null : (
        <div className={styles.logBox}>
          <ul className={styles.list} aria-label="Browser events">
            {newestFirst.map((entry) => (
              <EventRow key={entry.id} entry={entry} current={entry.event.session === session} context={context} />
            ))}
          </ul>
        </div>
      )}
    </SettingsCard>
  );
}
