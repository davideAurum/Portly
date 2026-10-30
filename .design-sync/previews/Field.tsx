import { Field, Input, PasswordInput, Select, SegmentedControl, Switch } from '@portly/ui';
import { MapPin, Search } from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';

// Fields sit on a glass widget surface over the page backdrop, like the settings forms.
const panel: CSSProperties = {
  display: 'grid', gap: 'var(--hb-space-4)', width: 380,
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;

export const WithHelp = () => (
  <Panel>
    <Field label="Your name" help="Used for the greeting on the clock widget.">
      <Input defaultValue="Alex" placeholder="e.g. Alex" />
    </Field>
    <Field label="Location" help="City name or coordinates, for the weather widget.">
      <Input leading={<MapPin size={16} aria-hidden="true" />} defaultValue="Lisbon, Portugal" />
    </Field>
  </Panel>
);

export const Required = () => (
  <Panel>
    <Field label="Feed address" required help="An RSS or Atom feed URL.">
      <Input type="url" placeholder="https://example.com/feed.xml" />
    </Field>
    <Field label="Personal access token" required help="Stored in the vault on this PC and never shown again.">
      <PasswordInput placeholder="Paste the token" />
    </Field>
  </Panel>
);

export const WithError = () => (
  <Panel>
    <Field label="Language tag" required error="Not a language tag. Try en-IE or fr-CA." help="A BCP 47 tag, for example en-IE or fr-CA.">
      <Input defaultValue="english-ireland" spellCheck={false} />
    </Field>
    <Field label="Refresh every (minutes)" error="Use a number from 5 to 1440.">
      <Input type="number" defaultValue="2" />
    </Field>
  </Panel>
);

export const OtherControls = () => {
  const [units, setUnits] = useState<'C' | 'F'>('C');
  return (
    <Panel>
      <Field label="Search engine">
        <Select defaultValue="ddg">
          <option value="ddg">DuckDuckGo</option>
          <option value="bing">Bing</option>
          <option value="google">Google</option>
        </Select>
      </Field>
      <Field label="Temperature">
        <SegmentedControl
          value={units}
          onValueChange={setUnits}
          options={[
            { value: 'C', label: '°C' },
            { value: 'F', label: '°F' },
          ]}
        />
      </Field>
      <Field label="Quick search" hideLabel>
        <Input leading={<Search size={16} aria-hidden="true" />} placeholder="Search bookmarks" />
      </Field>
    </Panel>
  );
};

export const Inline = () => {
  const [on, setOn] = useState(true);
  return (
    <Panel>
      <Field label="Show seconds" inline help="On the clock widget only.">
        <Switch checked={on} onCheckedChange={setOn} />
      </Field>
    </Panel>
  );
};
