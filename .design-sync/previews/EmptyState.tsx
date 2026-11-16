import { BrandMark, Button, EmptyState } from '@portly/ui';
import { CalendarCheck, FolderPlus, Inbox, LayoutGrid, Plus, Rss, UserRoundPlus } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

// Empty states fill a glass widget panel over the page backdrop.
const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', justifyContent: 'center',
  padding: 'var(--pt-space-4)', borderRadius: 'var(--pt-radius-lg)', border: '1px solid var(--pt-glass-border)',
  background: 'var(--pt-glass)', boxShadow: 'var(--pt-shadow)', color: 'var(--pt-text)',
};
const Panel = ({ children, height }: { children: ReactNode; height?: number }) => (
  <div style={{ ...panel, minHeight: height }}>{children}</div>
);

export const Default = () => (
  <Panel height={220}>
    <EmptyState icon={CalendarCheck} title="Nothing scheduled" body="Enjoy the free time." />
  </Panel>
);

export const WithAction = () => (
  <Panel height={240}>
    <EmptyState
      icon={UserRoundPlus}
      title="No accounts yet"
      body="Connect Google, Outlook.com, a CalDAV server or an IMAP mailbox to see your calendars and mail."
      action={<Button variant="primary" size="sm" icon={Plus}>Connect account</Button>}
    />
  </Panel>
);

export const WithMedia = () => (
  <Panel height={260}>
    <EmptyState
      media={<BrandMark size={56} />}
      title="Your dashboard is empty"
      body="Add widgets for your calendar, mail, feeds and weather."
      action={<Button variant="primary" size="sm" icon={LayoutGrid}>Add widget</Button>}
    />
  </Panel>
);

export const Compact = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--pt-space-3)' }}>
    <Panel>
      <EmptyState icon={Inbox} compact title="Inbox zero" />
    </Panel>
    <Panel>
      <EmptyState icon={Rss} compact title="No new stories" />
    </Panel>
    <Panel>
      <EmptyState
        icon={FolderPlus}
        compact
        title="No groups yet"
        action={<Button size="sm" icon={Plus}>New group</Button>}
      />
    </Panel>
  </div>
);
