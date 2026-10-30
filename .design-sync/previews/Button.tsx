import { Button } from '@portly/ui';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

// Portly controls sit on a glass widget surface over the page backdrop.
const panel: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--hb-space-2)',
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;

export const Variants = () => (
  <Panel>
    <Button variant="primary">Save changes</Button>
    <Button variant="secondary">Cancel</Button>
    <Button variant="ghost">Skip for now</Button>
    <Button variant="danger">Remove widget</Button>
  </Panel>
);

export const WithIcons = () => (
  <Panel>
    <Button variant="primary" icon={Plus}>Add widget</Button>
    <Button icon={RefreshCw}>Refresh</Button>
    <Button variant="danger" icon={Trash2}>Delete feed</Button>
  </Panel>
);

export const Sizes = () => (
  <Panel>
    <Button variant="primary" size="md">Connect account</Button>
    <Button variant="primary" size="sm">Connect account</Button>
    <Button size="sm" icon={RefreshCw}>Sync now</Button>
  </Panel>
);

export const States = () => (
  <Panel>
    <Button variant="primary" loading>Saving</Button>
    <Button disabled>Unavailable</Button>
    <div style={{ width: '100%' }}>
      <Button variant="primary" block>Continue</Button>
    </div>
  </Panel>
);
