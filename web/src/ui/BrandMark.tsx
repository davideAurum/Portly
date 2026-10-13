/**
 * The Beacon lighthouse (docs/brand/README.md) as inline SVG: the full drawing at 48 px and up,
 * the simplified one below that (the same split as the extension icons). Paths are copied from
 * docs/brand/portly-icon.svg and portly-icon-small.svg. Decorative by default (`aria-hidden`);
 * pass `label` when the mark is the only thing naming its control.
 *
 * `turn` plays docs/brand/portly-icon-animated.svg: each new value makes the light go round
 * once (the right-hand beam swings in front of the tower with a flash, round to the left, behind
 * the tower and back). The beam is drawn twice, behind and in front of the tower, and
 * BrandMark.module.css shows one or the other. Reduced motion shows the still mark.
 */
import styles from './BrandMark.module.css';

const FULL_MIN_SIZE = 48;

export interface BrandMarkProps {
  /** Rendered width and height in CSS pixels. */
  size?: number;
  /** Accessible name; omit for decorative uses. */
  label?: string;
  className?: string;
  /** Change this number to make the light turn once; 0 or unset is the still mark. */
  turn?: number;
}

export function BrandMark({ size = 32, label, className, turn = 0 }: BrandMarkProps) {
  const full = size >= FULL_MIN_SIZE;
  const turning = turn > 0;
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <svg
      // A new key remounts the drawing, which restarts the animation.
      key={turn}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      focusable="false"
      className={[className, turning ? styles.turning : undefined].filter(Boolean).join(' ') || undefined}
      data-variant={full ? 'full' : 'small'}
      {...a11y}
    >
      <rect width="64" height="64" rx="14" fill="#0b4f63" />
      {full ? (
        <>
          <path className={styles.leftBeam} d="M29 19 6 11v16z" fill="#ffd166" fillOpacity=".3" />
          <path className={styles.backBeam} d="M35 19l23-8v16z" fill="#ffd166" fillOpacity=".3" />
          <path d="M25.5 52l3-28h7l3 28z" fill="#fff" />
          <path d="M27.75 31h8.5l.43 4h-9.36zm-1.07 10h10.64l.43 4H26.25z" fill="#e3a82b" />
          <rect x="30.5" y="47" width="3" height="5" rx="1.5" fill="#0b4f63" />
          {turning ? <path className={styles.frontBeam} d="M35 19l23-8v16z" fill="#ffd166" fillOpacity=".3" /> : null}
          <rect x="26.5" y="22.5" width="11" height="2.5" rx="1" fill="#e3a82b" />
          <rect x="29" y="16" width="6" height="6.5" rx="1" fill="#ffd166" />
          <path d="M28 16l4-5 4 5z" fill="#e3a82b" />
          <circle cx="32" cy="10.5" r="1.2" fill="#e3a82b" />
          {turning ? <Flash /> : null}
          <rect x="16" y="52" width="32" height="3.5" rx="1.75" fill="#137a85" />
          <path d="M12 58q5-2 10 0t10 0 10 0 10 0" fill="none" stroke="#a6dedb" strokeWidth="2" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path className={styles.leftBeam} d="M29 19 5 10v18z" fill="#ffd166" fillOpacity=".45" />
          <path className={styles.backBeam} d="M35 19l24-9v18z" fill="#ffd166" fillOpacity=".45" />
          <path d="M24 54l4-30h8l4 30z" fill="#fff" />
          {turning ? <path className={styles.frontBeam} d="M35 19l24-9v18z" fill="#ffd166" fillOpacity=".45" /> : null}
          <rect x="28" y="14" width="8" height="10" rx="1.5" fill="#ffd166" />
          <path d="M26.5 14 32 8l5.5 6z" fill="#e3a82b" />
          {turning ? <Flash /> : null}
        </>
      )}
    </svg>
  );
}

/** The lantern's glow as the beam faces the viewer. */
function Flash() {
  return (
    <g className={styles.flash} fill="#ffd166">
      <circle cx="32" cy="19" r="13" opacity=".2" />
      <circle cx="32" cy="19" r="8.5" opacity=".35" />
      <circle cx="32" cy="19" r="5.5" opacity=".6" />
    </g>
  );
}

/** The mark plus the lowercase "portly" wordmark in the app's system font. Decorative. */
export function BrandLockup({ size = 40 }: { size?: number }) {
  return (
    <span className={styles.lockup} aria-hidden="true" style={{ fontSize: Math.round(size * 0.6) }}>
      <BrandMark size={size} />
      <span className={styles.wordmark}>portly</span>
    </span>
  );
}
