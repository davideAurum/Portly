import { Skeleton, SkeletonLines, SkeletonList } from '@portly/ui';
import type { CSSProperties, ReactNode } from 'react';

// Skeletons stand in for widget content on first load, inside a glass widget panel.
const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 'var(--hb-space-3)',
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Widget = ({ title, children }: { title: string; children: ReactNode }) => (
  <div style={panel}>
    <strong style={{ fontSize: 14 }}>{title}</strong>
    {children}
  </div>
);

export const MailList = () => (
  <Widget title="Mail">
    <SkeletonList rows={4} />
  </Widget>
);

export const AgendaRows = () => (
  <Widget title="Agenda">
    <SkeletonList rows={3} avatar={false} />
  </Widget>
);

export const TextLines = () => (
  <Widget title="Notes">
    <SkeletonLines lines={4} />
  </Widget>
);

export const WeatherCard = () => (
  <Widget title="Weather">
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--hb-space-3)' }}>
      <Skeleton width={48} height={48} round />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        <Skeleton width="40%" height={22} />
        <Skeleton width="65%" height={10} />
      </div>
    </div>
    <div style={{ display: 'flex', gap: 'var(--hb-space-2)' }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <Skeleton width={24} height={9} />
          <Skeleton width={24} height={24} round />
          <Skeleton width={28} height={9} />
        </div>
      ))}
    </div>
  </Widget>
);
