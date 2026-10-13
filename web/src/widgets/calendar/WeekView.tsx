/**
 * Week (§10.8): 7-column time grid with an all-day lane (multi-day spans as bars), overlapping
 * events side by side, a "now" line in today's column; clicking an empty hour starts a new event
 * there (the "+" button is the keyboard path).
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import type { CalendarEvent } from '@homebase/shared';
import { useCalendarWidget } from './context.tsx';
import { EventTrigger } from './EventPopover.tsx';
import { dayNumber, eventColorStyle, fullDay, timeRange, weekdayNarrow, weekdayShort } from './labels.ts';
import { datesInRange, isPast, layoutDay, layoutSpans, type DayRange } from './model.ts';
import styles from './Calendar.module.css';

export interface WeekViewProps {
  events: readonly CalendarEvent[];
  range: DayRange;
  narrow: boolean;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function WeekView({ events, range, narrow }: WeekViewProps) {
  const { calendars, today, now, fmt, canCreate, createEvent } = useCalendarWidget();
  const days = datesInRange(range);
  const spans = layoutSpans(events, days);
  const lanes = spans.reduce((max, s) => Math.max(max, s.lane + 1), 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hourLabel = (h: number) => {
    const d = new Date(2000, 0, 1, h, 0, 0);
    return fmt.is12Hour ? fmt.time(d).replace(':00', '') : fmt.time(d);
  };

  // Start at the working day (7:00); in the current week keep the current time in view.
  const showsToday = days.includes(today);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hourPx = el.scrollHeight / 24;
    const visibleHours = hourPx > 0 ? el.clientHeight / hourPx : 8;
    const nowHour = new Date().getHours();
    let target = 7;
    if (showsToday && nowHour < 7) target = Math.max(0, nowHour - 1);
    else if (showsToday && nowHour + 1 > 7 + visibleHours) target = nowHour - 1;
    el.scrollTop = target * hourPx;
  }, [range.from, showsToday]);

  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  return (
    <div className={styles.week} data-no-grid-drag="">
      <div className={styles.weekHeader} aria-hidden="true">
        <span />
        {days.map((day) => (
          <div key={day} className={styles.weekDay} data-today={day === today ? 'true' : undefined}>
            <span className={styles.weekDayName}>
              {narrow ? weekdayNarrow(day, fmt) : weekdayShort(day, fmt)}
            </span>
            <span className={styles.weekDayNumber}>
              {dayNumber(day)}
            </span>
          </div>
        ))}
      </div>

      {lanes > 0 ? (
        <div className={styles.allDayLane} aria-label="All-day events" role="list">
          <span className={styles.allDayLabel} aria-hidden="true">
            {narrow ? '' : 'all-day'}
          </span>
          {spans.map((bar) => (
            <div
              key={bar.event.id}
              role="listitem"
              className={styles.spanCell}
              style={{ gridColumn: `${bar.start + 2} / span ${bar.span}`, gridRow: bar.lane + 1 }}
            >
              <EventTrigger event={bar.event} style={eventColorStyle(calendars.get(bar.event.calendarId))}>
                <span
                  className={styles.chip}
                  data-status={bar.event.status}
                  data-continued={bar.continued ? 'true' : undefined}
                  data-continues={bar.continues ? 'true' : undefined}
                >
                  <span className={styles.chipTitle}>{bar.event.title}</span>
                </span>
              </EventTrigger>
            </div>
          ))}
        </div>
      ) : null}

      <div className={styles.timeScroll} ref={scrollRef}>
        <div className={styles.timeGrid}>
          <div className={styles.hours} aria-hidden="true">
            {HOURS.slice(1).map((h) => (
              <span key={h} className={styles.hourLabel} style={{ top: `calc(${h} * var(--hour-h))` }}>
                {hourLabel(h)}
              </span>
            ))}
          </div>
          {days.map((day) => {
            const blocks = layoutDay(events, day);
            const isToday = day === today;
            return (
              <div key={day} className={styles.dayColumn} data-today={isToday ? 'true' : undefined} role="list" aria-label={fullDay(day, fmt)}>
                {canCreate
                  ? HOURS.map((h) => (
                      <button
                        key={h}
                        type="button"
                        tabIndex={-1}
                        aria-hidden="true"
                        className={styles.slot}
                        style={{ top: `calc(${h} * var(--hour-h))` }}
                        onClick={() => createEvent(day, h)}
                      />
                    ))
                  : null}
                {blocks.map((b) => {
                  const style: CSSProperties = {
                    top: `calc(${b.startMin / 60} * var(--hour-h))`,
                    height: `calc(${(b.endMin - b.startMin) / 60} * var(--hour-h))`,
                    left: `${(b.column / b.columns) * 100}%`,
                    width: `${100 / b.columns}%`,
                  };
                  return (
                    <div key={b.event.id} className={styles.block} style={style} role="listitem">
                      <EventTrigger event={b.event} style={eventColorStyle(calendars.get(b.event.calendarId))}>
                        <span className={styles.blockInner} data-status={b.event.status} data-past={isPast(b.event, now) ? 'true' : undefined}>
                          <span className={styles.blockTitle}>{b.event.title}</span>
                          {b.endMin - b.startMin >= 45 ? <span className={styles.blockTime}>{timeRange(b.event, fmt)}</span> : null}
                        </span>
                      </EventTrigger>
                    </div>
                  );
                })}
                {isToday ? <div className={styles.nowLine} style={{ top: `calc(${nowMinutes / 60} * var(--hour-h))` }} aria-hidden="true" /> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
