/** Badge, Kbd and LetterTile (§10.4). */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { colorFromString, readableTextColor, safeColor } from '../lib/color.ts';
import styles from './Display.module.css';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  tone?: BadgeTone;
  icon?: LucideIcon;
  children: ReactNode;
  /** Show a leading status dot instead of an icon. */
  dot?: boolean;
  title?: string;
}

export function Badge({ tone = 'neutral', icon: Icon, dot = false, children, title }: BadgeProps) {
  return (
    <span className={styles.badge} data-tone={tone} title={title}>
      {dot ? <span className={styles.badgeDot} aria-hidden="true" /> : null}
      {Icon ? <Icon aria-hidden="true" className={styles.badgeIcon} /> : null}
      {children}
    </span>
  );
}

/** A keyboard key, e.g. <Kbd>E</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={styles.kbd}>{children}</kbd>;
}

export interface LetterTileProps {
  /** Text the letter is taken from (first grapheme, upper-cased). */
  label: string;
  /** Background color (validated hex); defaults to a stable palette color for the label. */
  color?: string | null;
  /** Pixel size (default 32). */
  size?: number;
  className?: string;
}

function firstGrapheme(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '?';
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const first = segmenter ? segmenter.segment(trimmed)[Symbol.iterator]().next().value?.segment : undefined;
  return (first ?? trimmed.charAt(0)).toLocaleUpperCase();
}

/** A colored square with the label's first letter (icon fallback for bookmarks and accounts). */
export function LetterTile({ label, color, size = 32, className }: LetterTileProps) {
  const background = safeColor(color, colorFromString(label));
  return (
    <span
      className={[styles.letterTile, className].filter(Boolean).join(' ')}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46), backgroundColor: background, color: readableTextColor(background) }}
      aria-hidden="true"
    >
      {firstGrapheme(label)}
    </span>
  );
}
