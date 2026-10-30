import { Badge } from '@portly/ui';
import { CircleAlert, CircleCheck, Clock, RefreshCw, Sparkles, Unplug } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

// Portly badges sit on a glass widget surface over the page backdrop.
const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 'var(--hb-space-3)',
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;
const Row = ({ children }: { children: ReactNode }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--hb-space-2)' }}>{children}</div>
);
const ListRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--hb-space-3)' }}>
    <span style={{ fontSize: 14 }}>{label}</span>
    {children}
  </div>
);

export const Tones = () => (
  <Panel>
    <Row>
      <Badge tone="neutral">Read only</Badge>
      <Badge tone="accent">New</Badge>
      <Badge tone="success">Connected</Badge>
      <Badge tone="warning">Expires soon</Badge>
      <Badge tone="danger">Sync failed</Badge>
    </Row>
  </Panel>
);

export const WithIcons = () => (
  <Panel>
    <Row>
      <Badge tone="success" icon={CircleCheck}>Up to date</Badge>
      <Badge tone="accent" icon={Sparkles}>Beta</Badge>
      <Badge tone="warning" icon={Unplug}>Reconnect needed</Badge>
      <Badge tone="danger" icon={CircleAlert}>Error</Badge>
      <Badge icon={Clock}>Every 15 min</Badge>
    </Row>
  </Panel>
);

export const StatusDots = () => (
  <Panel>
    <Row>
      <Badge tone="success" dot>Online</Badge>
      <Badge tone="warning" dot>Paused</Badge>
      <Badge tone="danger" dot>Offline</Badge>
      <Badge dot>Idle</Badge>
    </Row>
  </Panel>
);

export const InAList = () => (
  <Panel>
    <ListRow label="Hacker News">
      <Badge tone="accent">12 new</Badge>
    </ListRow>
    <ListRow label="City weather alerts">
      <Badge tone="warning" icon={RefreshCw}>Retrying</Badge>
    </ListRow>
    <ListRow label="Team blog">
      <Badge tone="success" dot>Synced</Badge>
    </ListRow>
    <ListRow label="Old podcast feed">
      <Badge tone="danger">Not found</Badge>
    </ListRow>
  </Panel>
);
