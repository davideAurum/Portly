import { AccountBadge } from '@portly/ui';
import type { CSSProperties, ReactNode } from 'react';

// Account badges label calendars, mailboxes and pickers inside glass widget panels.
const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--hb-space-3)',
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;

const work = { id: 'acc-work', kind: 'google', label: 'Work calendar', email: 'alex@example.com', color: '#4f8cff', status: 'ok' } as const;
const family = { id: 'acc-family', kind: 'microsoft', label: 'Family', email: 'riley.family@example.com', color: '#e0679c', status: 'ok' } as const;
const club = { id: 'acc-club', kind: 'caldav', label: 'Running club', email: null, color: '#3fbf7f', status: 'ok' } as const;
const mail = { id: 'acc-mail', kind: 'imap', label: 'Home mail', email: 'alex@example.net', color: '#f2a93b', status: 'ok' } as const;
const expired = { ...work, id: 'acc-expired', label: 'Old work mail', color: '#9b7bff', status: 'reauth' } as const;
const broken = { ...club, id: 'acc-broken', label: 'School events', color: '#ef6b5b', status: 'error' } as const;
const noColor = { id: 'acc-side', kind: 'yahoo', label: 'Side project', email: 'jordan@example.org', color: null, status: 'ok' } as const;

export const Default = () => (
  <Panel>
    <AccountBadge account={work} />
    <AccountBadge account={family} />
    <AccountBadge account={club} />
  </Panel>
);

export const WithKind = () => (
  <Panel>
    <AccountBadge account={work} showKind />
    <AccountBadge account={family} showKind />
    <AccountBadge account={club} showKind />
    <AccountBadge account={mail} showKind />
    <AccountBadge account={noColor} showKind />
  </Panel>
);

export const NeedsAttention = () => (
  <Panel>
    <AccountBadge account={work} showStatus showKind />
    <AccountBadge account={expired} showStatus showKind />
    <AccountBadge account={broken} showStatus showKind />
  </Panel>
);
