import { Field, SegmentedControl } from '@portly/ui';
import { CalendarDays, LayoutGrid, List, Monitor, Moon, Rows3, Sun } from 'lucide-react';
import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

// Portly controls sit on a glass widget surface over the page backdrop.
const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--hb-space-3)', width: 380,
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;

const wind = [
  { value: 'kmh', label: 'km/h' },
  { value: 'mph', label: 'mph' },
  { value: 'ms', label: 'm/s' },
] as const;

export const WithIcons = () => {
  const [mode, setMode] = useState<'light' | 'dark' | 'system'>('dark');
  return (
    <Panel>
      <Field label="Mode">
        <SegmentedControl
          value={mode}
          onValueChange={setMode}
          options={[
            { value: 'light', label: 'Light', icon: Sun },
            { value: 'dark', label: 'Dark', icon: Moon },
            { value: 'system', label: 'System', icon: Monitor },
          ]}
        />
      </Field>
    </Panel>
  );
};

export const TextOnly = () => {
  const [time, setTime] = useState<'system' | '12h' | '24h'>('24h');
  const [temp, setTemp] = useState<'C' | 'F'>('C');
  return (
    <Panel>
      <Field label="Time format">
        <SegmentedControl
          value={time}
          onValueChange={setTime}
          options={[
            { value: 'system', label: 'Automatic' },
            { value: '12h', label: '12-hour' },
            { value: '24h', label: '24-hour' },
          ]}
        />
      </Field>
      <Field label="Temperature">
        <SegmentedControl
          value={temp}
          onValueChange={setTemp}
          options={[
            { value: 'C', label: '°C' },
            { value: 'F', label: '°F' },
          ]}
        />
      </Field>
    </Panel>
  );
};

export const SizesAndIconOnly = () => (
  <Panel>
    <SegmentedControl aria-label="Wind speed" size="md" value="kmh" onValueChange={() => {}} options={wind} />
    <SegmentedControl aria-label="Wind speed" size="sm" value="kmh" onValueChange={() => {}} options={wind} />
    <SegmentedControl
      aria-label="Bookmark layout"
      size="sm"
      value="grid"
      onValueChange={() => {}}
      options={[
        { value: 'grid', label: 'Grid', icon: LayoutGrid, iconOnly: true },
        { value: 'list', label: 'List', icon: List, iconOnly: true },
        { value: 'compact', label: 'Compact list', icon: Rows3, iconOnly: true },
      ]}
    />
  </Panel>
);

export const BlockAndDisabled = () => (
  <div style={{ ...panel, alignItems: 'stretch' }}>
    <Field label="Density">
      <SegmentedControl
        block
        value="comfortable"
        onValueChange={() => {}}
        options={[
          { value: 'comfortable', label: 'Comfortable' },
          { value: 'compact', label: 'Compact' },
        ]}
      />
    </Field>
    <Field label="Calendar view" help="Agenda needs a connected calendar.">
      <SegmentedControl
        value="month"
        onValueChange={() => {}}
        options={[
          { value: 'month', label: 'Month', icon: CalendarDays },
          { value: 'agenda', label: 'Agenda', icon: List, disabled: true },
        ]}
      />
    </Field>
    <Field label="Font">
      <SegmentedControl
        disabled
        value="system"
        onValueChange={() => {}}
        options={[
          { value: 'system', label: 'System' },
          { value: 'serif', label: 'Serif' },
          { value: 'mono', label: 'Mono' },
        ]}
      />
    </Field>
  </div>
);
