import { Button, Spinner } from '@portly/ui';
import type { CSSProperties, ReactNode } from 'react';

// Spinners show inline progress inside a glass widget panel.
const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 'var(--hb-space-3)',
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 'var(--hb-space-2)', fontSize: 14 };
const muted: CSSProperties = { ...row, color: 'var(--hb-text-muted)' };

export const WithLabel = () => (
  <Panel>
    <div style={row}>
      <Spinner label="Syncing calendars" />
      <span>Syncing calendars...</span>
    </div>
    <div style={muted}>
      <Spinner />
      <span>Checking 4 feeds for new stories</span>
    </div>
  </Panel>
);

export const Sizes = () => (
  <Panel>
    <div style={{ ...row, gap: 'var(--hb-space-4)' }}>
      <Spinner size={12} />
      <Spinner size={16} />
      <Spinner size={24} />
      <Spinner size={32} label="Loading" />
    </div>
    <div style={muted}>12, 16 (default), 24 and 32 px</div>
  </Panel>
);

export const WidgetLoading = () => (
  <Panel>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <strong style={{ fontSize: 14 }}>Weather</strong>
      <Spinner size={14} label="Refreshing" />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--hb-space-2)', padding: 'var(--hb-space-4) 0', color: 'var(--hb-text-muted)', fontSize: 13 }}>
      <Spinner size={28} label="Loading forecast" />
      <span>Getting the forecast for your location</span>
    </div>
  </Panel>
);

export const InButton = () => (
  <Panel>
    <div style={{ display: 'flex', gap: 'var(--hb-space-2)', alignItems: 'center' }}>
      <Button variant="primary" loading>Connecting</Button>
      <Button loading>Importing bookmarks</Button>
    </div>
  </Panel>
);
