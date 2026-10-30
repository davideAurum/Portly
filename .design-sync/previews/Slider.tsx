import { Field, FieldGrid, Slider } from '@portly/ui';
import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

// Portly controls sit on a glass widget surface over the page backdrop.
const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 'var(--hb-space-3)', width: 360,
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;

export const Default = () => {
  const [radius, setRadius] = useState(12);
  return (
    <Panel>
      <Field label="Corner radius">
        <Slider value={radius} min={0} max={24} onChange={setRadius} format={(v) => `${v}px`} />
      </Field>
    </Panel>
  );
};

export const Formats = () => {
  const [opacity, setOpacity] = useState(0.75);
  const [angle, setAngle] = useState(135);
  const [blur, setBlur] = useState(8);
  return (
    <Panel>
      <Field label="Widget opacity" help="Lower values let more of the background show through.">
        <Slider value={opacity} min={0.3} max={1} step={0.05} onChange={setOpacity} format={(v) => `${Math.round(v * 100)}%`} />
      </Field>
      <Field label="Gradient angle">
        <Slider value={angle} min={0} max={360} step={5} onChange={setAngle} format={(v) => `${v}°`} />
      </Field>
      <Field label="Background blur">
        <Slider value={blur} min={0} max={40} onChange={setBlur} format={(v) => `${v}px`} />
      </Field>
    </Panel>
  );
};

export const Range = () => (
  <Panel>
    <Field label="Headlines shown (minimum)">
      <Slider value={3} min={3} max={20} onChange={() => {}} />
    </Field>
    <Field label="Headlines shown (maximum)">
      <Slider value={20} min={3} max={20} onChange={() => {}} />
    </Field>
  </Panel>
);

export const Disabled = () => (
  <Panel>
    <Field label="Background blur" help="Turn on frosted glass to change the blur.">
      <Slider value={12} min={0} max={40} onChange={() => {}} format={(v) => `${v}px`} disabled />
    </Field>
    <Field label="Widget opacity">
      <Slider value={0.85} min={0.3} max={1} step={0.05} onChange={() => {}} format={(v) => `${Math.round(v * 100)}%`} />
    </Field>
  </Panel>
);

// Two sliders side by side, as on the Appearance settings page and the photo background editor.
export const SettingsGrid = () => {
  const [blur, setBlur] = useState(12);
  const [dim, setDim] = useState(20);
  return (
    <div style={{ ...panel, width: 520 }}>
      <FieldGrid>
        <Field label="Photo blur" help="Softens the photo behind widgets.">
          <Slider value={blur} min={0} max={40} onChange={setBlur} format={(v) => `${v}px`} />
        </Field>
        <Field label="Photo dim" help="Darkens the photo so widgets stay readable.">
          <Slider value={dim} min={0} max={80} step={5} onChange={setDim} format={(v) => `${v}%`} />
        </Field>
      </FieldGrid>
    </div>
  );
};
