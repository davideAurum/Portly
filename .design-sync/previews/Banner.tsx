import { Banner, Button } from '@portly/ui';
import type { CSSProperties, ReactNode } from 'react';

const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 'var(--hb-space-3)',
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;

export const Tones = () => (
  <Panel>
    <Banner tone="info" title="Calendar sync runs every 15 minutes">
      New events can take a little while to appear here.
    </Banner>
    <Banner tone="success" title="Account connected">
      Your work calendar is now available to every calendar widget.
    </Banner>
    <Banner tone="warning" title="Sign-in expires soon">
      Reconnect your mail account within 3 days to keep new messages coming in.
    </Banner>
    <Banner tone="danger" title="Couldn't reach the weather service">
      Showing the last forecast from 2 hours ago.
    </Banner>
  </Panel>
);

export const WithActions = () => (
  <Panel>
    <Banner
      tone="warning"
      title="Mail account needs attention"
      actions={<Button size="sm" variant="primary">Reconnect</Button>}
    >
      Access was revoked on the provider's side. Reconnect to resume syncing.
    </Banner>
    <Banner
      tone="info"
      title="A new version of Portly is ready"
      actions={
        <>
          <Button size="sm" variant="ghost">Later</Button>
          <Button size="sm" variant="primary">Update</Button>
        </>
      }
    />
  </Panel>
);

export const TitleOnly = () => (
  <Panel>
    <Banner tone="success" title="Settings saved" />
  </Panel>
);
