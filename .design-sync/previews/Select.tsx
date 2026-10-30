import { Field, Select } from '@portly/ui';
import type { CSSProperties, ReactNode } from 'react';

// Portly controls sit on a glass widget surface over the page backdrop.
const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 'var(--hb-space-3)', width: 360,
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;

const intervals = [5, 10, 15, 30, 60].map((m) => ({ value: String(m), label: m === 60 ? 'Every hour' : `Every ${m} minutes` }));
const groups = [
  { value: 'daily', label: 'Daily' },
  { value: 'news', label: 'News' },
  { value: 'work', label: 'Work tools' },
];

export const Default = () => (
  <Panel>
    <Field label="Sync interval">
      <Select defaultValue="15" options={intervals} />
    </Field>
    <Field label="Default calendar for new events">
      <Select defaultValue="">
        <option value="">Automatic (primary calendar)</option>
        <option value="work">Work</option>
        <option value="family">Family</option>
      </Select>
    </Field>
  </Panel>
);

export const Sizes = () => (
  <Panel>
    <Select size="md" aria-label="Bookmark group" defaultValue="daily" options={groups} />
    <Select size="sm" aria-label="Bookmark group" defaultValue="daily" options={groups} />
  </Panel>
);

export const States = () => (
  <Panel>
    <Field label="Mail account" error="Choose an account for this widget.">
      <Select defaultValue="">
        <option value="" disabled>
          Select an account
        </option>
        <option value="personal">Personal (Outlook.com)</option>
        <option value="work">Work (Google)</option>
      </Select>
    </Field>
    <Field label="Default calendar for new events" help="Connect Google or Outlook.com to add events.">
      <Select defaultValue="" disabled>
        <option value="">Automatic (primary calendar)</option>
      </Select>
    </Field>
  </Panel>
);
