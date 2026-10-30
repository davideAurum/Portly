import { Field, TextArea } from '@portly/ui';
import type { CSSProperties, ReactNode } from 'react';

// Portly controls sit on a glass widget surface over the page backdrop.
const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 'var(--hb-space-3)', width: 380,
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;

export const Default = () => (
  <Panel>
    <Field label="Description">
      <TextArea defaultValue="Quarterly planning with the design team. Bring the roadmap draft and last sprint's notes." />
    </Field>
    <Field label="Notes" help="Plain text, saved on this PC.">
      <TextArea placeholder="Jot something down for later" />
    </Field>
  </Panel>
);

export const AutoGrow = () => (
  <Panel>
    <Field label="Event description" help="Grows as you type.">
      <TextArea
        autoGrow
        rows={2}
        defaultValue={'Dentist at 9:30, then pick up groceries.\nCall the landlord about the boiler.\nBook train tickets for Friday.\nReturn the library books.'}
      />
    </Field>
  </Panel>
);

export const States = () => (
  <Panel>
    <Field label="Event description" error="Descriptions can be at most 120 characters.">
      <TextArea
        rows={3}
        defaultValue="Team offsite at the lake house. Carpool leaves the office at 8, bring hiking shoes, a rain jacket and something for the shared lunch table."
      />
    </Field>
    <Field label="Shared note">
      <TextArea rows={2} defaultValue="Synced from your other PC. Unlock the vault to edit." disabled />
    </Field>
  </Panel>
);
