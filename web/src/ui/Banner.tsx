/** Banner: an inline notice (info / warning / danger / success) with optional actions. */
import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import styles from './Display.module.css';

export type BannerTone = 'info' | 'warning' | 'danger' | 'success';

const ICONS: Record<BannerTone, LucideIcon> = {
  info: Info,
  warning: TriangleAlert,
  danger: CircleAlert,
  success: CircleCheck,
};

export interface BannerProps {
  tone?: BannerTone;
  title: ReactNode;
  children?: ReactNode;
  /** Buttons or links, shown on the right (below on narrow screens). */
  actions?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}

export function Banner({ tone = 'info', title, children, actions, icon, className }: BannerProps) {
  const Icon = icon ?? ICONS[tone];
  return (
    <div
      className={[styles.banner, className].filter(Boolean).join(' ')}
      data-tone={tone}
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
    >
      <Icon aria-hidden="true" className={styles.bannerIcon} />
      <div className={styles.bannerText}>
        <p className={styles.bannerTitle}>{title}</p>
        {children ? <div className={styles.bannerBody}>{children}</div> : null}
      </div>
      {actions ? <div className={styles.bannerActions}>{actions}</div> : null}
    </div>
  );
}
