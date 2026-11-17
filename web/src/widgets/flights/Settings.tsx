/**
 * Flight tracker settings: the flights typed in (flight number and local departure date), adding
 * and removing them; whether flights in calendar events are tracked too, and bringing back the
 * ones hidden from the widget. The FlightAware key is in Settings → Accounts.
 */
import { useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { FlightDateSchema, normalizeFlightIdent } from '@portly/shared';
import { Button, IconButton } from '../../ui/Button.tsx';
import { Field } from '../../ui/Field.tsx';
import { Input } from '../../ui/Input.tsx';
import { Switch } from '../../ui/Toggles.tsx';
import type { WidgetSettingsProps } from '../types.ts';
import { MAX_TRACKED_FLIGHTS, type FlightsConfig } from './index.ts';
import { flightKey, localDateOf } from './model.ts';
import styles from './Settings.module.css';

export default function FlightsSettings({ value, onChange }: WidgetSettingsProps<FlightsConfig>) {
  const update = (patch: Partial<FlightsConfig>) => onChange({ ...value, ...patch });
  const [ident, setIdent] = useState('');
  const [date, setDate] = useState(() => localDateOf(Date.now()));
  const [error, setError] = useState<string | null>(null);
  const full = value.flights.length >= MAX_TRACKED_FLIGHTS;

  const add = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeFlightIdent(ident);
    if (normalized === null) {
      setError('Enter a flight number such as UA 123 or BA117.');
      return;
    }
    if (!FlightDateSchema.safeParse(date).success) {
      setError('Pick the departure date.');
      return;
    }
    const entry = { ident: normalized, date };
    if (value.flights.some((f) => flightKey(f) === flightKey(entry))) {
      setError(`${normalized} on that date is already tracked.`);
      return;
    }
    setError(null);
    setIdent('');
    update({ flights: [...value.flights, entry], dismissed: value.dismissed.filter((k) => k !== flightKey(entry)) });
  };

  return (
    <div className={styles.stack}>
      <div className={styles.group} role="group" aria-labelledby="pt-flights-list">
        <div className={styles.groupHeader}>
          <p id="pt-flights-list" className={styles.groupLabel}>
            Your flights
          </p>
          <span className={styles.count}>
            {value.flights.length} / {MAX_TRACKED_FLIGHTS}
          </span>
        </div>
        {value.flights.length > 0 ? (
          <ul className={styles.list} aria-label="Tracked flights">
            {value.flights.map((f) => (
              <li key={flightKey(f)} className={styles.row}>
                <span className={styles.ident}>{f.ident}</span>
                <span className={styles.date}>{f.date}</span>
                <IconButton size="sm" icon={X} aria-label={`Remove ${f.ident} on ${f.date}`} onClick={() => update({ flights: value.flights.filter((x) => flightKey(x) !== flightKey(f)) })} />
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.note}>No flights typed in yet.</p>
        )}
        <form className={styles.addForm} onSubmit={add} aria-label="Add a flight" data-settings-focus="flights-add" noValidate>
          <Field label="Flight number" error={error}>
            <Input
              value={ident}
              onChange={(e) => {
                setIdent(e.currentTarget.value);
                if (error) setError(null);
              }}
              placeholder="UA 123"
              maxLength={12}
              autoComplete="off"
              spellCheck={false}
              disabled={full}
            />
          </Field>
          <Field label="Departure date (local)">
            <Input type="date" value={date} onChange={(e) => setDate(e.currentTarget.value)} disabled={full} />
          </Field>
          <Button type="submit" icon={Plus} disabled={full || ident.trim() === ''}>
            Add
          </Button>
        </form>
        <p className={styles.note}>FlightAware has a flight’s details from two days before it departs; until then it shows as waiting.</p>
      </div>
      <Switch
        label="Also track flights from my calendar"
        description="Flight numbers in the titles or locations of events in the next 30 days, such as “Flight to Denver (UA 123)”."
        checked={value.fromCalendar}
        onCheckedChange={(fromCalendar) => update({ fromCalendar })}
      />
      {value.dismissed.length > 0 ? (
        <div className={styles.dismissed}>
          <span className={styles.note}>
            {value.dismissed.length} calendar {value.dismissed.length === 1 ? 'flight is' : 'flights are'} hidden.
          </span>
          <Button size="sm" variant="ghost" onClick={() => update({ dismissed: [] })}>
            Show again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
