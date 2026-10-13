/**
 * Month (§10.8): a compact 6-week grid. Each day shows event bars (all-day, colored) and dots
 * with titles for timed events; narrow widgets show dots only. The day number opens a popover
 * listing the day's events, each of which opens its details.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ChevronLeft } from 'lucide-react';
import type { CalendarEvent } from '@portly/shared';
import { Button } from '../../ui/Button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/Popover.tsx';
import { useCalendarWidget } from './context.tsx';
import { EventDetails, EventTrigger } from './EventPopover.tsx';
import { dayNumber, eventColorStyle, fullDay, weekdayShort } from './labels.ts';
import { compareEvents, datesInRange, eventBounds, isAllDayOn, overlapsDay, type DayRange } from './model.ts';
import styles from './Calendar.module.css';

export interface MonthViewProps {
  events: readonly CalendarEvent[];
  range: DayRange;
  /** Month (`YYYY-MM`) being shown; other days are dimmed. */
  month: string;
}

const CHIP_PX = 17;
const DAY_NUMBER_PX = 26;

/** How many chip rows fit in a day cell (measured; the grid fills the widget body). */
function useChipRows(ref: RefObject<HTMLDivElement | null>): number {
  const [rows, setRows] = useState(2);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cell = el.querySelector<HTMLElement>('[data-cell]');
      const height = cell?.getBoundingClientRect().height ?? 0;
      if (height > 0) setRows(Math.max(0, Math.floor((height - DAY_NUMBER_PX) / CHIP_PX)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return rows;
}

function DayPopover({ day, events }: { day: string; events: CalendarEvent[] }) {
  const { fmt, calendars, today } = useCalendarWidget();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<CalendarEvent | null>(null);
  const label = `${fullDay(day, fmt)}${events.length > 0 ? `, ${events.length} event${events.length === 1 ? '' : 's'}` : ', no events'}`;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSelected(null);
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" className={styles.cellNumber} aria-label={label} aria-current={day === today ? 'date' : undefined} data-no-grid-drag="">
          {dayNumber(day)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start">
        {selected ? (
          <EventDetails
            event={selected}
            onClose={() => setOpen(false)}
            before={
              <Button variant="ghost" size="sm" icon={ChevronLeft} className={styles.back} onClick={() => setSelected(null)}>
                {fullDay(day, fmt)}
              </Button>
            }
          />
        ) : (
          <div className={styles.popover}>
            <h3 className={styles.dayListTitle}>{fullDay(day, fmt)}</h3>
            {events.length === 0 ? (
              <p className={styles.hint}>Nothing scheduled.</p>
            ) : (
              <ul className={styles.dayList}>
                {events.map((event) => (
                  <li key={event.id}>
                    <button type="button" className={styles.eventButton} onClick={() => setSelected(event)} style={eventColorStyle(calendars.get(event.calendarId))}>
                      <span className={styles.dayListItem}>
                        <span className={styles.dot} aria-hidden="true" />
                        <span className={styles.dayListTime}>{isAllDayOn(event, day) ? 'All day' : fmt.time(eventBounds(event).start)}</span>
                        <span className={styles.dayListTitle2}>{event.title}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function MonthView({ events, range, month }: MonthViewProps) {
  const { calendars, today, fmt } = useCalendarWidget();
  const gridRef = useRef<HTMLDivElement>(null);
  const maxChips = useChipRows(gridRef);
  const days = datesInRange(range);
  const sorted = [...events].sort(compareEvents);

  return (
    <div className={styles.month} data-no-grid-drag="" ref={gridRef}>
      {days.slice(0, 7).map((day) => (
        <div key={`h:${day}`} className={styles.monthWeekday} aria-hidden="true">
          {weekdayShort(day, fmt)}
        </div>
      ))}
      {days.map((day) => {
        const dayEvents = sorted.filter((e) => overlapsDay(e, day));
        // Too short for chips plus a "+N more" row: colored dots (the day popover lists them).
        const dotsOnly = dayEvents.length > maxChips && maxChips < 2;
        // When not everything fits, the last row says "+N more".
        const visible = dayEvents.length > maxChips ? dayEvents.slice(0, Math.max(0, maxChips - 1)) : dayEvents;
        const hidden = dayEvents.length - visible.length;
        return (
          <div
            key={day}
            className={styles.cell}
            data-cell=""
            data-dots={dotsOnly ? 'true' : undefined}
            data-outside={day.slice(0, 7) !== month ? 'true' : undefined}
            data-today={day === today ? 'true' : undefined}
          >
            <DayPopover day={day} events={dayEvents} />
            <div className={styles.cellEvents}>
              {visible.map((event) =>
                isAllDayOn(event, day) ? (
                  <EventTrigger key={event.id} event={event} style={eventColorStyle(calendars.get(event.calendarId))} tooltip>
                    <span className={styles.chip} data-status={event.status}>
                      <span className={styles.chipTitle}>{event.title}</span>
                    </span>
                  </EventTrigger>
                ) : (
                  <EventTrigger key={event.id} event={event} style={eventColorStyle(calendars.get(event.calendarId))} tooltip>
                    <span className={styles.timedChip}>
                      <span className={styles.dot} aria-hidden="true" />
                      <span>{event.title}</span>
                    </span>
                  </EventTrigger>
                ),
              )}
              {hidden > 0 ? <span className={styles.more}>+{hidden} more</span> : null}
            </div>
            {dayEvents.length > 0 ? (
              <div className={styles.dots} aria-hidden="true">
                {dayEvents.slice(0, 4).map((event) => (
                  <span key={event.id} className={styles.dot} style={eventColorStyle(calendars.get(event.calendarId))} />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
