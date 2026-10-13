/**
 * Agenda (§10.8): events grouped by day with sticky day headers, an all-day row per day,
 * multi-day spans on every day they cover, and a "now" marker in today's list.
 */
import { CalendarCheck, MapPin, Video } from 'lucide-react';
import type { CalendarEvent } from '@homebase/shared';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { useCalendarWidget } from './context.tsx';
import { EventTrigger } from './EventPopover.tsx';
import { agendaTimes, dayHeading, eventColorStyle, relativeDayName } from './labels.ts';
import { daysBetweenKeys, groupAgenda, isOngoing, isPast, nowMarkerIndex, type AgendaItem, type DayRange } from './model.ts';
import styles from './Calendar.module.css';

export interface AgendaViewProps {
  events: readonly CalendarEvent[];
  range: DayRange;
  compact: boolean;
}

function AllDayChip({ item }: { item: AgendaItem }) {
  const { calendars } = useCalendarWidget();
  const { event } = item;
  return (
    <EventTrigger event={event} style={eventColorStyle(calendars.get(event.calendarId))}>
      <span
        className={styles.chip}
        data-status={event.status}
        data-continued={item.continued ? 'true' : undefined}
        data-continues={item.continues ? 'true' : undefined}
      >
        <span className={styles.chipTitle}>{event.title}</span>
        {item.dayOf ? (
          <span className={styles.chipMeta}>
            {' '}
            · Day {item.dayOf.day}/{item.dayOf.days}
          </span>
        ) : null}
      </span>
    </EventTrigger>
  );
}

function TimedRow({ item }: { item: AgendaItem }) {
  const { calendars, fmt, now } = useCalendarWidget();
  const { event } = item;
  const times = agendaTimes(item, fmt);
  return (
    <EventTrigger event={event} style={eventColorStyle(calendars.get(event.calendarId))}>
      <span
        className={styles.row}
        data-status={event.status}
        data-past={isPast(event, now) ? 'true' : undefined}
        data-ongoing={isOngoing(event, now) ? 'true' : undefined}
      >
        <span className={styles.rowTime}>
          <strong>{times.start}</strong>
          {times.end ? <span>{times.end}</span> : null}
        </span>
        <span className={styles.rowBar} aria-hidden="true" />
        <span className={styles.rowMain}>
          <span className={styles.rowTitle}>{event.title}</span>
          {event.location || event.meetingUrl ? (
            <span className={styles.rowMeta}>
              {event.location ? (
                <>
                  <MapPin aria-hidden="true" />
                  <span>{event.location}</span>
                </>
              ) : (
                <>
                  <Video aria-hidden="true" />
                  <span>Online meeting</span>
                </>
              )}
            </span>
          ) : null}
        </span>
      </span>
    </EventTrigger>
  );
}

export function AgendaView({ events, range, compact }: AgendaViewProps) {
  const { today, fmt, now } = useCalendarWidget();
  const days = groupAgenda(events, range, today);
  const hasEvents = days.some((d) => d.allDay.length > 0 || d.timed.length > 0);

  if (!hasEvents) {
    const length = daysBetweenKeys(range.from, range.to);
    return (
      <EmptyState
        icon={CalendarCheck}
        compact={compact}
        title={length <= 1 ? 'Nothing scheduled' : `Nothing in the next ${length} days`}
        body="Enjoy the free time."
      />
    );
  }

  return (
    <div className={styles.agenda} data-no-grid-drag="">
      {days.map(({ day, allDay, timed }) => {
        const isToday = day === today;
        const relative = relativeDayName(day, today, fmt);
        const marker = isToday ? nowMarkerIndex(timed, now) : -1;
        return (
          <section key={day} className={styles.day} aria-label={`${relative ? `${relative}, ` : ''}${dayHeading(day, today, fmt)}`}>
            <h3 className={styles.dayHeader} data-today={isToday ? 'true' : undefined}>
              {relative ? <span className={styles.dayRelative}>{relative}</span> : null}
              <span className={relative ? styles.dayDate : undefined}>{dayHeading(day, today, fmt)}</span>
            </h3>
            {allDay.length === 0 && timed.length === 0 ? <p className={styles.emptyDay}>Nothing scheduled</p> : null}
            <ul className={styles.dayItems}>
              {allDay.map((item) => (
                <li key={`a:${item.event.id}`} className={styles.allDayItem}>
                  <AllDayChip item={item} />
                </li>
              ))}
              {timed.map((item, index) => (
                <li key={`t:${item.event.id}`}>
                  {index === marker ? <div className={styles.nowMarker} role="presentation" aria-hidden="true" /> : null}
                  <TimedRow item={item} />
                </li>
              ))}
              {marker === timed.length && timed.length > 0 ? (
                <li aria-hidden="true">
                  <div className={styles.nowMarker} />
                </li>
              ) : null}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
