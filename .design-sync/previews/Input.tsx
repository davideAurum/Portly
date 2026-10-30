import { Field, Input } from '@portly/ui';
import { MapPin, Search } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

// Portly controls sit on a glass widget surface over the page backdrop.
const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 'var(--hb-space-3)', width: 360,
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;

export const Default = () => (
  <Panel>
    <Field label="Widget title" help="Shown in the widget header.">
      <Input defaultValue="Morning headlines" />
    </Field>
    <Field label="Location">
      <Input placeholder="City or postcode, e.g. Lisbon" />
    </Field>
  </Panel>
);

export const WithAffixes = () => (
  <Panel>
    <Input leading={<Search size={16} aria-hidden="true" />} placeholder="Search bookmarks" aria-label="Search bookmarks" />
    <Input leading={<MapPin size={16} aria-hidden="true" />} defaultValue="Porto, Portugal" aria-label="Weather location" />
    <Field label="Refresh every">
      <Input type="number" defaultValue={15} trailing="minutes" />
    </Field>
  </Panel>
);

export const Sizes = () => (
  <Panel>
    <Input size="md" defaultValue="Hacker News front page" aria-label="Feed name" />
    <Input size="sm" defaultValue="Hacker News front page" aria-label="Feed name" />
  </Panel>
);

export const States = () => (
  <Panel>
    <Field label="Feed URL" error="That address didn't return an RSS or Atom feed.">
      <Input defaultValue="https://example.com/blog" />
    </Field>
    <Field label="Account email" help="Set by the provider when you connected.">
      <Input defaultValue="alex@example.com" readOnly />
    </Field>
    <Field label="Calendar name">
      <Input defaultValue="Holidays in Portugal" disabled />
    </Field>
  </Panel>
);
