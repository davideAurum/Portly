import { Badge, Button, Field, FieldGrid, FormFooter, Input, SegmentedControl, SettingsCard, Switch } from '@portly/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';

// Settings cards stack on the settings page.
const Page = ({ children }: { children: ReactNode }) => (
  <div style={{ display: 'grid', gap: 'var(--hb-space-4)', width: 560, color: 'var(--hb-text)' }}>{children}</div>
);
const line: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--hb-text-sm)' };

export const WithFields = () => {
  const [temp, setTemp] = useState<'C' | 'F'>('C');
  const [wind, setWind] = useState<'kmh' | 'mph' | 'ms'>('kmh');
  return (
    <Page>
      <SettingsCard title="Units" description="Used by the weather widget unless a widget overrides them.">
        <FieldGrid>
          <Field label="Temperature">
            <SegmentedControl value={temp} onValueChange={setTemp} options={[{ value: 'C', label: '°C' }, { value: 'F', label: '°F' }]} />
          </Field>
          <Field label="Wind speed">
            <SegmentedControl
              value={wind}
              onValueChange={setWind}
              options={[{ value: 'kmh', label: 'km/h' }, { value: 'mph', label: 'mph' }, { value: 'ms', label: 'm/s' }]}
            />
          </Field>
        </FieldGrid>
      </SettingsCard>
    </Page>
  );
};

export const WithActions = () => (
  <Page>
    <SettingsCard
      title="Connected accounts"
      description="Mail, calendars and tasks that your widgets can read."
      actions={<Button size="sm" variant="primary" icon={Plus}>Connect account</Button>}
    >
      <div style={line}>
        <span>Outlook.com (personal)</span>
        <Badge tone="success" dot>Connected</Badge>
      </div>
      <div style={line}>
        <span>Todoist</span>
        <Badge tone="warning" dot>Needs reconnect</Badge>
      </div>
    </SettingsCard>
  </Page>
);

export const WithFooter = () => {
  const [name, setName] = useState('Alex');
  const [newTab, setNewTab] = useState(true);
  return (
    <Page>
      <SettingsCard title="You" description="Used for the greeting on the clock widget.">
        <Field label="Your name">
          <Input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="e.g. Alex" />
        </Field>
        <Switch
          label="Open bookmarks in a new tab"
          description="When off, the launch pad opens pages in this tab."
          checked={newTab}
          onCheckedChange={setNewTab}
        />
        <FormFooter status="All changes saved">
          <Button variant="ghost">Reset</Button>
          <Button variant="primary">Save</Button>
        </FormFooter>
      </SettingsCard>
    </Page>
  );
};

export const Danger = () => (
  <Page>
    <SettingsCard
      tone="danger"
      title="Delete all data"
      description="Removes every profile, widget and saved account from this PC. Export a backup first if you might want them back."
      actions={<Button size="sm" variant="danger" icon={Trash2}>Delete everything</Button>}
    />
  </Page>
);
