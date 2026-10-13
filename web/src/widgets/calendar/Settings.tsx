/**
 * Calendar widget settings: view, number of agenda days (1–14), which calendars (the ones marked
 * visible in Settings › Calendars, or an explicit selection) and whether declined events show.
 */
import { useMemo } from 'react';
import { CalendarDays, CalendarRange, List } from 'lucide-react';
import type { Calendar } from '@homebase/shared';
import { useAccounts } from '../../api/accounts.ts';
import { useCalendars } from '../../api/calendar.ts';
import { Field } from '../../ui/Field.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { Checkbox, SegmentedControl, Slider, Switch } from '../../ui/Toggles.tsx';
import type { WidgetSettingsProps } from '../types.ts';
import type { CalendarConfig } from './index.ts';
import { eventColorStyle } from './labels.ts';
import styles from './Calendar.module.css';

const VIEWS = [
  { value: 'agenda', label: 'Agenda', icon: List },
  { value: 'week', label: 'Week', icon: CalendarRange },
  { value: 'month', label: 'Month', icon: CalendarDays },
] as const;

export function groupCalendars(
  calendars: readonly Calendar[],
  accountLabel: (id: string) => string,
): { key: string; label: string; calendars: Calendar[] }[] {
  const groups = new Map<string, { key: string; label: string; calendars: Calendar[] }>();
  for (const calendar of calendars) {
    const key = calendar.accountId ?? 'ics';
    let group = groups.get(key);
    if (!group) {
      group = { key, label: calendar.accountId ? accountLabel(calendar.accountId) : 'Subscriptions (ICS)', calendars: [] };
      groups.set(key, group);
    }
    group.calendars.push(calendar);
  }
  return [...groups.values()];
}

export default function CalendarSettings({ value, onChange }: WidgetSettingsProps<CalendarConfig>) {
  const calendars = useCalendars();
  const accounts = useAccounts();
  const accountLabel = useMemo(() => {
    const byId = new Map((accounts.data ?? []).map((a) => [a.id, a.label] as const));
    return (id: string) => byId.get(id) ?? 'Account';
  }, [accounts.data]);
  const list = calendars.data ?? [];
  const followVisible = value.calendarIds === 'visible';
  const selected = new Set(followVisible ? list.filter((c) => c.visible).map((c) => c.id) : value.calendarIds);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onChange({ ...value, calendarIds: list.map((c) => c.id).filter((cid) => next.has(cid)) });
  };

  return (
    <div className={styles.settings}>
      <Field label="View">
        <SegmentedControl value={value.view} options={VIEWS} onValueChange={(view) => onChange({ ...value, view })} />
      </Field>

      <Field label="Agenda length" help="How many days the agenda shows, starting today.">
        <Slider
          min={1}
          max={14}
          value={value.days}
          onChange={(days) => onChange({ ...value, days })}
          format={(d) => (d === 1 ? '1 day' : `${d} days`)}
        />
      </Field>

      <Switch
        label="Show declined events"
        description="Invitations you declined stay hidden unless this is on."
        checked={value.showDeclined}
        onCheckedChange={(showDeclined) => onChange({ ...value, showDeclined })}
      />

      <div>
        <Switch
          label="Use the calendars marked visible"
          description="Follow Settings › Calendars. Turn off to pick calendars for this widget only."
          checked={followVisible}
          onCheckedChange={(on) => onChange({ ...value, calendarIds: on ? 'visible' : list.filter((c) => c.visible).map((c) => c.id) })}
        />
        {!followVisible ? (
          calendars.data === undefined ? (
            <SkeletonList rows={2} avatar={false} />
          ) : (
            groupCalendars(list, accountLabel).map((group) => (
              <div key={group.key}>
                <p className={styles.choiceGroup}>{group.label}</p>
                <ul className={styles.calendarChoices}>
                  {group.calendars.map((c) => (
                    <li key={c.id}>
                      <Checkbox
                        checked={selected.has(c.id)}
                        onCheckedChange={(on) => toggle(c.id, on)}
                        label={
                          <span className={styles.choiceLabel} style={eventColorStyle(c)}>
                            <span className={styles.swatchOption} aria-hidden="true" />
                            {c.name}
                          </span>
                        }
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )
        ) : null}
      </div>
    </div>
  );
}
