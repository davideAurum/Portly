import { Checkbox } from '@portly/ui';
import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

// Portly controls sit on a glass widget surface over the page backdrop.
const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 'var(--hb-space-3)', width: 380,
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;

export const Default = () => {
  const [readOnly, setReadOnly] = useState(true);
  const [holidays, setHolidays] = useState(false);
  return (
    <Panel>
      <Checkbox label="Read-only here" checked={readOnly} onCheckedChange={setReadOnly} />
      <Checkbox label="Show public holidays" checked={holidays} onCheckedChange={setHolidays} />
    </Panel>
  );
};

export const WithDescription = () => {
  const [picked, setPicked] = useState({ mail: true, calendar: true, tasks: false });
  return (
    <Panel>
      <Checkbox
        label="Mail"
        description="Unread count and recent messages in the mail widget."
        checked={picked.mail}
        onCheckedChange={(mail) => setPicked((p) => ({ ...p, mail }))}
      />
      <Checkbox
        label="Calendar"
        description="Upcoming events, and adding new ones from Portly."
        checked={picked.calendar}
        onCheckedChange={(calendar) => setPicked((p) => ({ ...p, calendar }))}
      />
      <Checkbox
        label="Tasks"
        description="Your task lists in the to-do widget."
        checked={picked.tasks}
        onCheckedChange={(tasks) => setPicked((p) => ({ ...p, tasks }))}
      />
    </Panel>
  );
};

export const States = () => (
  <Panel>
    <Checkbox label="Hide finished tasks" checked={false} onCheckedChange={() => {}} />
    <Checkbox label="Hide finished tasks" checked onCheckedChange={() => {}} />
    <Checkbox label="All feeds" description="3 of 7 feeds shown in this widget." checked="indeterminate" onCheckedChange={() => {}} />
    <Checkbox
      label="Contacts"
      description="This account's provider doesn't offer contacts."
      checked={false}
      disabled
      onCheckedChange={() => {}}
    />
  </Panel>
);
