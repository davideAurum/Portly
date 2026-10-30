import { IconButton } from '@portly/ui';
import { CloudSun, FlaskConical, Pin, Plus, RefreshCw, Settings2, Trash, Trash2 } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

// Portly controls sit on a glass widget surface over the page backdrop.
const panel: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--hb-space-2)', width: 'fit-content',
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;

// A widget header: icon, title, then the small ghost actions WidgetFrame shows.
export const WidgetHeader = () => (
  <div style={{ ...panel, flexWrap: 'nowrap', width: 340 }}>
    <CloudSun aria-hidden="true" size={18} style={{ color: 'var(--hb-text-muted)' }} />
    <h2 style={{ margin: 0, flex: 1, fontSize: 'var(--hb-text-md)', fontWeight: 600 }}>Weather</h2>
    <IconButton icon={RefreshCw} size="sm" aria-label="Refresh Weather" tooltip={false} />
    <IconButton icon={Settings2} size="sm" aria-label="Weather settings" tooltip={false} />
    <IconButton icon={Trash} size="sm" aria-label="Remove Weather" tooltip={false} />
  </div>
);

export const Variants = () => (
  <Panel>
    <IconButton icon={Settings2} variant="ghost" aria-label="Widget settings" tooltip={false} />
    <IconButton icon={RefreshCw} variant="secondary" aria-label="Sync now" tooltip={false} />
    <IconButton icon={Plus} variant="primary" aria-label="Add widget" tooltip={false} />
    <IconButton icon={Trash2} variant="danger" aria-label="Delete feed" tooltip={false} />
  </Panel>
);

export const Sizes = () => (
  <Panel>
    <IconButton icon={Plus} variant="secondary" size="md" aria-label="Add bookmark" tooltip={false} />
    <IconButton icon={Plus} variant="secondary" size="sm" aria-label="Add bookmark" tooltip={false} />
    <IconButton icon={Settings2} size="md" aria-label="Launch pad settings" tooltip={false} />
    <IconButton icon={Settings2} size="sm" aria-label="Launch pad settings" tooltip={false} />
  </Panel>
);

export const States = () => (
  <Panel>
    <IconButton icon={FlaskConical} variant="secondary" aria-label="Test Todoist" loading tooltip={false} />
    <IconButton icon={RefreshCw} variant="secondary" aria-label="Sync calendars" disabled tooltip={false} />
    <IconButton icon={Pin} aria-label="Unpin from header" pressed tooltip={false} />
    <IconButton icon={Pin} aria-label="Pin to header" pressed={false} tooltip={false} />
  </Panel>
);
