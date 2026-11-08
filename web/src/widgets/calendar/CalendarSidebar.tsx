/**
 * Calendar widget sidebar: every calendar grouped by account, colored with its event color, with
 * an eye toggle per calendar and per account. Toggles change this widget only (its `calendarIds`).
 */
import { Eye, EyeOff } from 'lucide-react';
import { eventColorStyle } from './labels.ts';
import type { CalendarGroup } from './model.ts';
import styles from './Calendar.module.css';

interface Props {
  groups: readonly CalendarGroup[];
  /** Ids of the calendars this widget shows. */
  selected: ReadonlySet<string>;
  onToggle(ids: readonly string[], on: boolean): void;
}

export function CalendarSidebar({ groups, selected, onToggle }: Props) {
  return (
    <nav className={styles.sidebar} aria-label="Calendars">
      {groups.map((group) => {
        const shown = group.calendars.filter((c) => selected.has(c.id)).length;
        const allOn = shown === group.calendars.length;
        const ids = group.calendars.map((c) => c.id);
        return (
          <section key={group.key} className={styles.sideGroup} aria-label={group.label}>
            <div className={styles.sideGroupHeader}>
              <h3 className={styles.sideGroupTitle} title={group.label}>
                {group.label}
              </h3>
              <button
                type="button"
                className={styles.eyeButton}
                aria-pressed={allOn}
                aria-label={`${allOn ? 'Hide' : 'Show'} all calendars of ${group.label}`}
                onClick={() => onToggle(ids, !allOn)}
              >
                {shown === 0 ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </div>
            <ul className={styles.sideList}>
              {group.calendars.map((c) => {
                const on = selected.has(c.id);
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={styles.sideItem}
                      style={eventColorStyle(c)}
                      data-on={on ? 'true' : 'false'}
                      aria-pressed={on}
                      aria-label={`${c.name}: ${on ? 'shown' : 'hidden'}`}
                      title={c.name}
                      onClick={() => onToggle([c.id], !on)}
                    >
                      <span className={styles.sideSwatch} aria-hidden="true" />
                      <span className={styles.sideName}>{c.name}</span>
                      {on ? <Eye aria-hidden="true" className={styles.sideEye} /> : <EyeOff aria-hidden="true" className={styles.sideEye} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
