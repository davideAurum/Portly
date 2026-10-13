/**
 * Diagnostics → Logging level (ARCHITECTURE §17): Normal (state changes and failures) or Verbose
 * (everything) for 30 minutes, 2 hours, 24 hours or until turned off — which ends at the next
 * restart — optionally for some areas only. A timed verbose survives a restart. While verbose is
 * on, a changed duration or area choice is applied with "Apply"; the switch applies at once.
 */
import { useState } from 'react';
import { DIAGNOSTIC_AREAS, type DiagnosticArea, type LogLevelState, type SetLogLevelInput } from '@homebase/shared';
import { useSetLogLevel } from '../../api/diagnostics.ts';
import { useFormatters } from '../../lib/format.ts';
import { Button } from '../../ui/Button.tsx';
import { Field, FieldGroup } from '../../ui/Field.tsx';
import { SettingsCard } from '../../ui/Section.tsx';
import { toastError } from '../../ui/toast.ts';
import { Checkbox, SegmentedControl, Switch } from '../../ui/Toggles.tsx';
import { areaLabel } from './format.ts';
import { LogLevelBadge } from './parts.tsx';
import styles from './Diagnostics.module.css';

type DurationValue = '30' | '120' | '1440' | 'off';

export const VERBOSE_DURATIONS: readonly { value: DurationValue; label: string; minutes: number | null }[] = [
  { value: '30', label: '30 min', minutes: 30 },
  { value: '120', label: '2 h', minutes: 120 },
  { value: '1440', label: '24 h', minutes: 1440 },
  { value: 'off', label: 'Until turned off', minutes: null },
];

/** The areas this version knows (a newer server may name others). */
function knownAreas(areas: readonly string[] | null): DiagnosticArea[] {
  return DIAGNOSTIC_AREAS.filter((area) => areas?.includes(area) === true);
}

function statusText(state: LogLevelState, time: (iso: string) => string): string {
  if (!state.verbose) return `Normal: state changes, failures and recoveries (level ${state.level}).`;
  const areas = state.areas === null ? '' : ` for ${state.areas.map(areaLabel).join(', ')}`;
  return state.until === null
    ? `Verbose${areas} until turned off. Ends at the next restart of Homebase.`
    : `Verbose${areas} until ${time(state.until)}${state.persisted ? ', also after a restart' : ''}.`;
}

export function LogLevelPanel({ state }: { state: LogLevelState }) {
  const fmt = useFormatters();
  const setLevel = useSetLogLevel();
  const [duration, setDuration] = useState<DurationValue>(state.verbose && state.until === null ? 'off' : '120');
  const [areas, setAreas] = useState<DiagnosticArea[]>(() => knownAreas(state.areas));
  /** The duration or areas changed while verbose is on (Apply sends them). */
  const [dirty, setDirty] = useState(false);

  const minutes = VERBOSE_DURATIONS.find((d) => d.value === duration)?.minutes ?? null;
  const send = (body: SetLogLevelInput) =>
    setLevel.mutate(body, {
      onSuccess: () => setDirty(false),
      onError: (error) => toastError(error, 'The log level could not be changed.'),
    });
  const turnOn = () => send({ verbose: true, minutes, areas: areas.length === 0 ? null : areas });

  return (
    <SettingsCard
      id="diagnostics-level"
      title="Logging level"
      description="Normal keeps the log short. Turn on Verbose while you reproduce a problem: every request, sync and outbound call is logged, then it switches back by itself."
      actions={<LogLevelBadge state={state} />}
    >
      <Switch
        label="Verbose logging"
        description={statusText(state, (iso) => fmt.time(iso))}
        checked={state.verbose}
        disabled={setLevel.isPending}
        onCheckedChange={(on) => (on ? turnOn() : send({ verbose: false }))}
      />
      <Field label="For" help="“Until turned off” ends at the next restart of Homebase.">
        <SegmentedControl
          value={duration}
          options={VERBOSE_DURATIONS.map(({ value, label }) => ({ value, label }))}
          onValueChange={(value) => {
            setDuration(value);
            if (state.verbose) setDirty(true);
          }}
          size="sm"
        />
      </Field>
      <FieldGroup legend="Areas" description="Leave every box empty to log all areas verbosely, or tick the areas you are looking into.">
        <div className={styles.areaGrid}>
          {DIAGNOSTIC_AREAS.map((area) => (
            <Checkbox
              key={area}
              label={areaLabel(area)}
              checked={areas.includes(area)}
              onCheckedChange={(checked) => {
                setAreas((current) => DIAGNOSTIC_AREAS.filter((a) => (a === area ? checked : current.includes(a))));
                if (state.verbose) setDirty(true);
              }}
            />
          ))}
        </div>
      </FieldGroup>
      {state.verbose && dirty ? (
        <div className={styles.inlineRow}>
          <Button variant="primary" size="sm" loading={setLevel.isPending} onClick={turnOn}>
            Apply
          </Button>
          <span className={styles.text}>The new duration starts now.</span>
        </div>
      ) : null}
      {state.bootLevel !== 'info' ? (
        <p className={styles.text}>
          Homebase starts at level <strong>{state.bootLevel}</strong> (HOMEBASE_LOG_LEVEL); Normal means that level.
        </p>
      ) : null}
    </SettingsCard>
  );
}
