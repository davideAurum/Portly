/**
 * Skeleton (§10.4): shimmering placeholders for first loads (§10.7 #2). `SkeletonLines` and
 * `SkeletonList` cover the common widget shapes.
 */
import type { CSSProperties } from 'react';
import styles from './Display.module.css';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  /** Pill/circle shape. */
  round?: boolean;
  className?: string;
}

export function Skeleton({ width = '100%', height = 12, round = false, className }: SkeletonProps) {
  const style: CSSProperties = { width, height };
  return <span className={[styles.skeleton, className].filter(Boolean).join(' ')} data-round={round ? 'true' : undefined} style={style} />;
}

/** A few text lines of decreasing width. */
export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div className={styles.skeletonStack} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={`${Math.max(40, 100 - i * 18)}%`} />
      ))}
    </div>
  );
}

/** Rows with a leading dot/avatar and two lines — the shape of mail, agenda and task lists. */
export function SkeletonList({ rows = 4, avatar = true }: { rows?: number; avatar?: boolean }) {
  return (
    <div className={styles.skeletonList} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.skeletonRow}>
          {avatar ? <Skeleton width={28} height={28} round /> : null}
          <div className={styles.skeletonStack}>
            <Skeleton width={`${70 - (i % 3) * 12}%`} height={11} />
            <Skeleton width={`${45 + (i % 2) * 20}%`} height={9} />
          </div>
        </div>
      ))}
    </div>
  );
}
