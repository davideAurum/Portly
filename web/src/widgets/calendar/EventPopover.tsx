/**
 * Event details in a popover (§10.8): time range per locale/time format, calendar, location,
 * plain-text description with SafeHttpUrl links rendered as React elements, Join (meetingUrl),
 * Open in provider (htmlUrl), Edit/Delete when editable. Every link goes through safeHref.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { AlignLeft, CalendarDays, ExternalLink as ExternalLinkIcon, MapPin, Pencil, Repeat, Trash, Video } from 'lucide-react';
import type { CalendarEvent } from '@portly/shared';
import { linkProps, openUrl } from '../../lib/openUrl.ts';
import { Badge } from '../../ui/Badge.tsx';
import { Button, IconButton } from '../../ui/Button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/Popover.tsx';
import { useCalendarWidget } from './context.tsx';
import { eventAriaLabel, eventColorStyle, whenLabel } from './labels.ts';
import { linkify, providerName } from './model.ts';
import styles from './Calendar.module.css';

/** Plain text with SafeHttpUrl matches as external links (never HTML). */
export function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((part, index) => {
        if (part.type === 'text') return <span key={index}>{part.value}</span>;
        const props = linkProps(part.href);
        if (!props) return <span key={index}>{part.value}</span>;
        return (
          <a key={index} {...props}>
            {part.value}
          </a>
        );
      })}
    </>
  );
}

export interface EventDetailsProps {
  event: CalendarEvent;
  /** Called before Edit/Delete hand over to a dialog. */
  onClose?: () => void;
  /** Extra leading content (e.g. a Back button in the month day list). */
  before?: ReactNode;
}

export function EventDetails({ event, onClose, before }: EventDetailsProps) {
  const { calendars, fmt, editEvent, deleteEvent } = useCalendarWidget();
  const calendar = calendars.get(event.calendarId);
  const openInProvider = linkProps(event.htmlUrl);
  const statusBadge =
    event.status === 'tentative' ? <Badge tone="warning">Tentative</Badge> : event.status === 'declined' ? <Badge>Declined</Badge> : event.status === 'cancelled' ? <Badge tone="danger">Cancelled</Badge> : null;

  return (
    <div className={styles.popover} style={eventColorStyle(calendar)}>
      {before}
      <div className={styles.popHeader}>
        <span className={styles.popSwatch} aria-hidden="true" />
        <div>
          <h3 className={styles.popTitle} data-status={event.status}>
            {event.title}
          </h3>
          <p className={styles.popWhen}>{whenLabel(event, fmt)}</p>
        </div>
      </div>
      <ul className={styles.popRows}>
        {calendar ? (
          <li className={styles.popRow}>
            <CalendarDays aria-hidden="true" />
            <span className={styles.popText}>
              {calendar.name} {statusBadge}
            </span>
          </li>
        ) : null}
        {event.recurring ? (
          <li className={styles.popRow}>
            <Repeat aria-hidden="true" />
            <span className={styles.popText}>Part of a repeating series</span>
          </li>
        ) : null}
        {event.location ? (
          <li className={styles.popRow}>
            <MapPin aria-hidden="true" />
            <span className={styles.popText}>
              <LinkifiedText text={event.location} />
            </span>
          </li>
        ) : null}
        {event.description ? (
          <li className={styles.popRow}>
            <AlignLeft aria-hidden="true" />
            <div className={`${styles.popText} ${styles.description}`} tabIndex={0} aria-label="Description">
              <LinkifiedText text={event.description} />
            </div>
          </li>
        ) : null}
      </ul>
      {event.meetingUrl || openInProvider || event.editable ? (
        <div className={styles.popActions}>
          {event.meetingUrl && linkProps(event.meetingUrl) ? (
            <Button variant="primary" size="sm" icon={Video} onClick={() => openUrl(event.meetingUrl)}>
              Join
            </Button>
          ) : null}
          {openInProvider ? (
            <a {...openInProvider} className={styles.linkButton}>
              <ExternalLinkIcon aria-hidden="true" />
              {calendar?.source === 'google' || calendar?.source === 'microsoft' ? `Open in ${providerName(calendar)}` : 'Open event link'}
            </a>
          ) : null}
          <span className={styles.spacer} />
          {event.editable ? (
            <>
              <IconButton
                icon={Pencil}
                size="sm"
                aria-label="Edit event"
                onClick={() => {
                  onClose?.();
                  editEvent(event);
                }}
              />
              <IconButton
                icon={Trash}
                size="sm"
                aria-label="Delete event"
                onClick={() => {
                  onClose?.();
                  deleteEvent(event);
                }}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface EventTriggerProps {
  /** Show the title (and start time) as a hover tooltip: for chips too small to show it (month view). */
  tooltip?: boolean;
  event: CalendarEvent;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** A focusable button showing `children` that opens the event's details. */
export function EventTrigger({ event, children, className, style, tooltip = false }: EventTriggerProps) {
  const { calendars, fmt } = useCalendarWidget();
  const [open, setOpen] = useState(false);
  const title = tooltip ? (event.allDay ? event.title : `${fmt.time(new Date(event.start))} ${event.title}`) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={[styles.eventButton, className].filter(Boolean).join(' ')}
          style={style}
          aria-label={eventAriaLabel(event, calendars.get(event.calendarId), fmt)}
          title={title}
          data-no-grid-drag=""
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={12}>
        <EventDetails event={event} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
