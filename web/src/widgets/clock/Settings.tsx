/**
 * Clock widget settings (§10.8 Clock): time format, seconds, date, greeting, and up to six
 * extra time zones (label + IANA zone) picked from a searchable list built from
 * `Intl.supportedValuesOf('timeZone')`. Every change goes to the dialog draft via `onChange`.
 */
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Globe, X } from 'lucide-react';
import { useSettings } from '../../api/settings.ts';
import { safeHref } from '../../lib/openUrl.ts';
import { IconButton } from '../../ui/Button.tsx';
import { Field } from '../../ui/Field.tsx';
import { Input } from '../../ui/Input.tsx';
import { SegmentedControl, Switch } from '../../ui/Toggles.tsx';
import type { WidgetSettingsProps } from '../types.ts';
import { SearchCombobox } from '../weather/SearchCombobox.tsx';
import { MAX_EXTRA_ZONES, type ClockConfig, type ExtraZone } from './index.ts';
import { defaultZoneLabel, listTimeZones, offsetLabel, searchTimeZones, zoneOffsetMinutes, zoneOptions, type ZoneOption } from './clock.ts';
import styles from './Settings.module.css';

const TIME_FORMAT_NAMES = { system: 'system', '12h': '12-hour', '24h': '24-hour' } as const;

export default function ClockSettings({ value, onChange }: WidgetSettingsProps<ClockConfig>) {
  const settings = useSettings();
  const general = settings.data?.general;
  const userName = general?.userName?.trim();
  const update = (patch: Partial<ClockConfig>) => onChange({ ...value, ...patch });
  const zones = value.extraZones;
  const generalHref = safeHref('#/settings/general');

  const setZones = (next: ExtraZone[]) => update({ extraZones: next });
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= zones.length) return;
    const next = [...zones];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setZones(next);
  };

  return (
    <div className={styles.stack}>
      <Field label="Time format">
        <SegmentedControl
          value={value.format}
          onValueChange={(format) => update({ format })}
          options={[
            { value: 'inherit', label: `Default (${TIME_FORMAT_NAMES[general?.timeFormat ?? 'system']})` },
            { value: '12h', label: '12-hour' },
            { value: '24h', label: '24-hour' },
          ]}
        />
      </Field>

      <Switch label="Show seconds" checked={value.showSeconds} onCheckedChange={(showSeconds) => update({ showSeconds })} />
      <Switch label="Show date" checked={value.showDate} onCheckedChange={(showDate) => update({ showDate })} />
      <Switch
        label="Show greeting"
        description={
          userName ? (
            `“Good morning, ${userName}” — changes with the time of day.`
          ) : (
            <>
              Add your name in{' '}
              {generalHref ? <a href={generalHref}>General settings</a> : 'General settings'} to be greeted by name.
            </>
          )
        }
        checked={value.greeting}
        onCheckedChange={(greeting) => update({ greeting })}
      />

      <div className={styles.zonesGroup} role="group" aria-labelledby="hb-clock-zones">
        <div className={styles.groupHeader}>
          <p id="hb-clock-zones" className={styles.groupLabel}>
            Other time zones
          </p>
          <span className={styles.count}>
            {zones.length} / {MAX_EXTRA_ZONES}
          </span>
        </div>
        {zones.length > 0 ? (
          <p className={styles.zonesHint}>
            Zones that don’t fit on the card are summed up as “+N” (hover it to see them). In short cards (three rows or fewer) the
            greeting makes room for the zones.
          </p>
        ) : null}
        {zones.length > 0 ? (
          <ul className={styles.zoneList}>
            {zones.map((zone, index) => (
              <ZoneRow
                key={`${zone.tz}-${index}`}
                zone={zone}
                first={index === 0}
                last={index === zones.length - 1}
                onLabelChange={(label) => setZones(zones.map((z, i) => (i === index ? { ...z, label } : z)))}
                onRemove={() => setZones(zones.filter((_, i) => i !== index))}
                onMove={(delta) => move(index, delta)}
              />
            ))}
          </ul>
        ) : (
          <p className={styles.note}>Show the time in other places under the clock (medium and large sizes).</p>
        )}
        <TimeZonePicker
          exclude={zones.map((z) => z.tz)}
          disabled={zones.length >= MAX_EXTRA_ZONES}
          onSelect={(tz) => setZones([...zones, { label: defaultZoneLabel(tz), tz }])}
        />
        {zones.length >= MAX_EXTRA_ZONES ? <p className={styles.note}>Up to {MAX_EXTRA_ZONES} time zones. Remove one to add another.</p> : null}
      </div>
    </div>
  );
}

interface ZoneRowProps {
  zone: ExtraZone;
  first: boolean;
  last: boolean;
  onLabelChange(label: string): void;
  onRemove(): void;
  onMove(delta: number): void;
}

function ZoneRow({ zone, first, last, onLabelChange, onRemove, onMove }: ZoneRowProps) {
  // The input shows what is typed; the config always holds a valid (non-empty) label.
  const [text, setText] = useState(zone.label);
  const offset = offsetLabel(zoneOffsetMinutes(zone.tz, new Date()));
  const fallback = defaultZoneLabel(zone.tz);
  return (
    <li className={styles.zoneRow}>
      <div className={styles.zoneFields}>
        <Input
          size="sm"
          value={text}
          maxLength={40}
          aria-label={`Label for ${zone.tz}`}
          placeholder={fallback}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setText(next);
            onLabelChange(next.trim() || fallback);
          }}
          onBlur={() => {
            if (text.trim() === '') setText(fallback);
          }}
        />
        <span className={styles.zoneTz}>
          <Globe aria-hidden="true" />
          {zone.tz.replace(/_/g, ' ')} · {offset}
        </span>
      </div>
      <div className={styles.zoneActions}>
        <IconButton size="sm" icon={ArrowUp} aria-label={`Move ${zone.label} up`} disabled={first} onClick={() => onMove(-1)} />
        <IconButton size="sm" icon={ArrowDown} aria-label={`Move ${zone.label} down`} disabled={last} onClick={() => onMove(1)} />
        <IconButton size="sm" icon={X} aria-label={`Remove ${zone.label}`} onClick={onRemove} />
      </div>
    </li>
  );
}

/** Searchable list of every IANA zone (city, region or UTC offset). */
export function TimeZonePicker({ exclude, disabled, onSelect }: { exclude: readonly string[]; disabled?: boolean; onSelect(tz: string): void }) {
  const [text, setText] = useState('');
  const options = useMemo(() => zoneOptions(listTimeZones(), new Date()), []);
  const results = useMemo(() => searchTimeZones(options, text, 60).filter((o) => !exclude.includes(o.tz)), [options, text, exclude]);
  const open = text.trim().length > 0;
  return (
    <SearchCombobox<ZoneOption>
      aria-label="Add a time zone"
      value={text}
      onValueChange={setText}
      items={results}
      open={open}
      status={`No time zones match “${text.trim()}”.`}
      icon={Globe}
      placeholder={disabled ? 'Time zone limit reached' : 'Add a time zone: city, region or UTC offset'}
      disabled={disabled}
      getKey={(o) => o.tz}
      getLabel={(o) => `${o.tz.replace(/_/g, ' ')}, ${o.offsetText}`}
      renderItem={(o) => (
        <span className={styles.optionBody}>
          <span className={styles.optionText}>
            <span className={styles.optionName}>{o.city}</span>
            <span className={styles.optionMeta}>{o.tz.replace(/_/g, ' ')}</span>
          </span>
          <span className={styles.optionOffset}>{o.offsetText}</span>
        </span>
      )}
      onSelect={(o) => {
        onSelect(o.tz);
        setText('');
      }}
    />
  );
}
