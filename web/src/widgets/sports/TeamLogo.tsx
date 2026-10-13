import { useState } from 'react';
import { LetterTile } from '../../ui/Badge.tsx';
import styles from './Sports.module.css';

/** ESPN logo (a dark-theme variant when there is one), or a letter tile when it fails to load. */
export function TeamLogo({ src, srcDark, label, size = 20 }: { src: string | null; srcDark?: string | null; label: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <LetterTile label={label} size={size} className={styles.logo} />;
  const common = { width: size, height: size, alt: '', loading: 'lazy' as const, decoding: 'async' as const, referrerPolicy: 'no-referrer' as const, onError: () => setFailed(true) };
  const box = { width: size, height: size };
  if (!srcDark || srcDark === src) return <img src={src} className={styles.logo} style={box} {...common} />;
  return (
    <span className={styles.logo} style={box} aria-hidden="true">
      <img src={src} className={styles.logoLight} {...common} />
      <img src={srcDark} className={styles.logoDark} {...common} />
    </span>
  );
}
