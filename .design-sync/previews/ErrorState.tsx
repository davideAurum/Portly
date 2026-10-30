import { ErrorState, PortlyQueryProvider } from '@portly/ui';
import type { CSSProperties, ReactNode } from 'react';

// Error states replace a widget's body on its glass panel. Previews can't build the kit's
// ApiError class, so these show the generic branch (any thrown error) with Retry. ErrorState
// reads the account through React Query, so it needs PortlyQueryProvider around it.
const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', justifyContent: 'center',
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children, height }: { children: ReactNode; height?: number }) => (
  <PortlyQueryProvider>
    <div style={{ ...panel, minHeight: height }}>{children}</div>
  </PortlyQueryProvider>
);
const retry = () => {};

export const WithRetry = () => (
  <Panel height={220}>
    <ErrorState error={new Error('Feed request failed')} onRetry={retry} />
  </Panel>
);

export const CustomTitle = () => (
  <Panel height={220}>
    <ErrorState error={new Error('Forecast request failed')} title="Couldn't load the forecast" onRetry={retry} />
  </Panel>
);

export const WithoutRetry = () => (
  <Panel height={200}>
    <ErrorState error={new Error('Agenda request failed')} title="Calendar unavailable" />
  </Panel>
);

export const Compact = () => (
  <Panel>
    <ErrorState error={new Error('Mail request failed')} title="Couldn't load mail" onRetry={retry} compact />
  </Panel>
);
