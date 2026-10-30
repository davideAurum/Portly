import { Field, Switch } from '@portly/ui';
import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

// Portly controls sit on a glass widget surface over the page backdrop.
const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 'var(--hb-space-3)', width: 420,
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;

export const SettingsList = () => {
  const [suggestions, setSuggestions] = useState(true);
  const [bookmarks, setBookmarks] = useState(true);
  const [newTab, setNewTab] = useState(false);
  return (
    <Panel>
      <Switch
        label="Search suggestions"
        description="Suggests searches as you type, using your default search engine."
        checked={suggestions}
        onCheckedChange={setSuggestions}
      />
      <Switch
        label="Matching bookmarks"
        description="Shows up to four of your bookmarks above the suggestions. Never leaves this PC."
        checked={bookmarks}
        onCheckedChange={setBookmarks}
      />
      <Switch
        label="Open bookmarks and searches in a new tab"
        description="When off, the launch pad and search open pages in this tab."
        checked={newTab}
        onCheckedChange={setNewTab}
      />
    </Panel>
  );
};

export const Sizes = () => (
  <Panel>
    <Switch size="md" label="Show header" description="Icon, title and widget buttons." checked onCheckedChange={() => {}} />
    <Switch size="sm" label="Work calendar visible" checked onCheckedChange={() => {}} />
    <Switch size="sm" label="Family calendar visible" checked={false} onCheckedChange={() => {}} />
  </Panel>
);

export const States = () => (
  <Panel>
    <Switch label="Frosted glass" description="On. Saved for this browser only." checked onCheckedChange={() => {}} />
    <Switch label="Frosted glass" description="Off. Saved for this browser only." checked={false} onCheckedChange={() => {}} />
    <Switch
      label="Wikipedia suggestions instead"
      description="Turn on search suggestions first."
      checked={false}
      disabled
      onCheckedChange={() => {}}
    />
  </Panel>
);

export const InField = () => (
  <Panel>
    <Field label="Auto-refresh feeds" inline help="Checks for new articles every 30 minutes.">
      <Switch checked onCheckedChange={() => {}} />
    </Field>
  </Panel>
);
