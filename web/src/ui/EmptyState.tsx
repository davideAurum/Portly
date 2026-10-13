import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  icon?: LucideIcon;
  /** Artwork shown instead of `icon` (e.g. the brand mark); hidden in compact and narrow layouts. Decorative. */
  media?: ReactNode;
  title: string;
  body?: ReactNode;
  /** Optional call to action (a button or link). */
  action?: ReactNode;
  /** Single-row layout for very short containers (e.g. a 2-row widget): icon + title only. */
  compact?: boolean;
}

/** Centered icon + title + text + optional action (§10.4). Adapts to narrow containers. */
export function EmptyState({ icon: Icon, media, title, body, action, compact = false }: EmptyStateProps) {
  return (
    <div className={styles.root} data-compact={compact ? 'true' : undefined}>
      {media && !compact ? (
        <span className={styles.media} aria-hidden="true">
          {media}
        </span>
      ) : Icon ? (
        <span className={styles.iconWrap} aria-hidden="true">
          <Icon className={styles.icon} />
        </span>
      ) : null}
      <div className={styles.text}>
        <p className={styles.title}>{title}</p>
        {body && !compact ? <div className={styles.body}>{body}</div> : null}
      </div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
