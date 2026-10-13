/**
 * EventDialog (§10.8): title, writable calendar (default `settings.calendar.defaultCalendarId`),
 * all-day toggle, local start/end with sensible defaults and validation (end after start),
 * location, description. Editing a recurring instance changes that occurrence only, with a link
 * to edit the series in Google Calendar / Outlook (htmlUrl).
 */
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Repeat } from 'lucide-react';
import type { Calendar, CalendarEvent } from '@portly/shared';
import { Banner } from '../../ui/Banner.tsx';
import { Button } from '../../ui/Button.tsx';
import { Dialog } from '../../ui/Dialog.tsx';
import { ExternalLink } from '../../ui/ExternalLink.tsx';
import { Field } from '../../ui/Field.tsx';
import { Input, Select, TextArea } from '../../ui/Input.tsx';
import { Switch } from '../../ui/Toggles.tsx';
import {
  DESCRIPTION_MAX,
  LOCATION_MAX,
  TITLE_MAX,
  addDaysKey,
  combine,
  dateKey,
  daysBetweenKeys,
  providerName,
  validateEventForm,
  type EventFormErrors,
  type EventFormValues,
} from './model.ts';
import styles from './Calendar.module.css';

export interface EventDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The event being edited (null = new event). */
  event: CalendarEvent | null;
  initial: EventFormValues;
  writableCalendars: readonly Calendar[];
  calendars: ReadonlyMap<string, Calendar>;
  onSubmit(values: EventFormValues): void;
}

/** Keeps the duration when the start moves (the end follows). */
function shiftEnd(prev: EventFormValues, next: EventFormValues): EventFormValues {
  if (prev.allDay) {
    const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
    if (!valid(prev.startDate) || !valid(prev.endDate) || !valid(next.startDate)) return next;
    return { ...next, endDate: addDaysKey(next.startDate, Math.max(0, daysBetweenKeys(prev.startDate, prev.endDate))) };
  }
  const oldStart = combine(prev.startDate, prev.startTime);
  const oldEnd = combine(prev.endDate, prev.endTime);
  const newStart = combine(next.startDate, next.startTime);
  if (!oldStart || !oldEnd || !newStart) return next;
  const end = new Date(newStart.getTime() + Math.max(0, oldEnd.getTime() - oldStart.getTime()));
  return { ...next, endDate: dateKey(end), endTime: `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}` };
}

export function EventDialog({ open, onOpenChange, event, initial, writableCalendars, calendars, onSubmit }: EventDialogProps) {
  const formId = useId();
  const [values, setValues] = useState<EventFormValues>(initial);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      setValues(initial);
      setSubmitted(false);
    }
  }, [open, initial]);

  const writableIds = useMemo(() => new Set(writableCalendars.map((c) => c.id)), [writableCalendars]);
  const errors: EventFormErrors = submitted ? validateEventForm(values, writableIds) : {};
  const calendar = calendars.get(values.calendarId);

  const set = <K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) => {
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      return key === 'startDate' || key === 'startTime' ? shiftEnd(prev, next) : next;
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    const found = validateEventForm(values, writableIds);
    if (Object.keys(found).length > 0) return;
    onSubmit({ ...values, title: values.title.trim(), location: values.location.trim() });
  };

  const seriesLink = event?.recurring ? event.htmlUrl : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={event ? 'Edit event' : 'New event'}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId}>
            {event ? 'Save' : 'Add event'}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={submit} noValidate aria-label={event ? 'Edit event' : 'New event'}>
        {event?.recurring ? (
          <Banner tone="info" icon={Repeat} title="This changes only this occurrence.">
            {seriesLink ? (
              <ExternalLink href={seriesLink} showIcon>
                Edit series in {providerName(calendars.get(event.calendarId))}
              </ExternalLink>
            ) : (
              <>To change every occurrence, edit the series in {providerName(calendars.get(event.calendarId))}.</>
            )}
          </Banner>
        ) : null}

        <Field label="Title" error={errors.title} required>
          <Input value={values.title} onChange={(e) => set('title', e.currentTarget.value)} maxLength={TITLE_MAX + 20} autoFocus autoComplete="off" />
        </Field>

        <Field label="Calendar" error={errors.calendarId} help={event ? 'Events stay in their calendar.' : undefined}>
          <Select value={values.calendarId} onChange={(e) => set('calendarId', e.currentTarget.value)} disabled={event !== null}>
            {writableCalendars.length === 0 ? <option value="">No writable calendars</option> : null}
            {writableCalendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {calendar && !writableIds.has(calendar.id) ? <option value={calendar.id}>{calendar.name}</option> : null}
          </Select>
        </Field>

        <Switch label="All day" checked={values.allDay} onCheckedChange={(on) => set('allDay', on)} />

        <div className={styles.when}>
          <div className={styles.whenRow} data-all-day={values.allDay ? 'true' : undefined}>
            <Field label={values.allDay ? 'First day' : 'Starts'} error={errors.startDate}>
              <Input type="date" value={values.startDate} onChange={(e) => set('startDate', e.currentTarget.value)} required />
            </Field>
            {values.allDay ? null : (
              <Field label="Start time" error={errors.startTime}>
                <Input type="time" value={values.startTime} step={300} onChange={(e) => set('startTime', e.currentTarget.value)} required />
              </Field>
            )}
          </div>
          <div className={styles.whenRow} data-all-day={values.allDay ? 'true' : undefined}>
            <Field label={values.allDay ? 'Last day' : 'Ends'} error={errors.endDate}>
              <Input type="date" value={values.endDate} min={values.startDate} onChange={(e) => set('endDate', e.currentTarget.value)} required />
            </Field>
            {values.allDay ? null : (
              <Field label="End time" error={errors.endTime}>
                <Input type="time" value={values.endTime} step={300} onChange={(e) => set('endTime', e.currentTarget.value)} required />
              </Field>
            )}
          </div>
        </div>

        <Field label="Location" error={errors.location}>
          <Input value={values.location} onChange={(e) => set('location', e.currentTarget.value)} maxLength={LOCATION_MAX} autoComplete="off" />
        </Field>

        <Field label="Description" error={errors.description}>
          <TextArea value={values.description} onChange={(e) => set('description', e.currentTarget.value)} maxLength={DESCRIPTION_MAX} rows={3} autoGrow />
        </Field>
      </form>
    </Dialog>
  );
}
