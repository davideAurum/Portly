import { Button, Tooltip } from '@portly/ui';
import { Keyboard, Pencil, Settings } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

// The dashboard header toolbar: glass chips over the page backdrop.
const bar: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 'var(--hb-space-2)',
  padding: 'var(--hb-space-2)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Bar = ({ children }: { children: ReactNode }) => (
  <div style={{ padding: 'var(--hb-space-4)', minHeight: 160 }}>
    <div style={bar}>{children}</div>
  </div>
);

// Tooltip has no `open` prop: Radix opens it on keyboard focus, so the trigger is auto-focused.
export const OnFocus = () => (
  <Bar>
    <Tooltip content="Edit layout (E)">
      <Button variant="ghost" icon={Pencil} autoFocus aria-label="Edit layout" />
    </Tooltip>
    <Tooltip content="Keyboard shortcuts (?)">
      <Button variant="ghost" icon={Keyboard} aria-label="Keyboard shortcuts" />
    </Tooltip>
    <Tooltip content="Settings">
      <Button variant="ghost" icon={Settings} aria-label="Settings" />
    </Tooltip>
  </Bar>
);

export const AboveTrigger = () => (
  <div style={{ padding: '56px var(--hb-space-4) var(--hb-space-4)', minHeight: 160 }}>
    <div style={bar}>
      <Tooltip side="top" content="Couldn't refresh. Click to retry.">
        <Button size="sm" autoFocus>Updated 2 hours ago</Button>
      </Tooltip>
    </div>
  </div>
);
