/**
 * Icon for a bookmark or search engine: the stored icon (`/api/icons/<id>`, never a remote URL)
 * or a LetterTile when there is none or it fails to load (§8: the letter tile is the last
 * fallback of the favicon chain).
 *
 * The image URL comes from `useAssetUrl` (static/assets.ts): on a Pages page load backed by the
 * Homebase server on this PC the icon is loaded from that server first, and the letter tile shows
 * until it is there (or when the server has no such icon). A failed image falls back to the letter
 * tile until the URL changes (another icon, or the same icon resolved anew).
 *
 * In-browser backend: an automatic icon (`fav:<host>`) loads from DuckDuckGo's icon service
 * (static/favicon.ts), which answers a host it does not know with HTTP 404 *and* a generic PNG, so
 * `load` fires, not `error`, and that placeholder stays. There the letter tile shows only for
 * local-looking hosts (no id), letter mode, or an image that really fails (offline, blocked).
 *
 * Many favicons are a single dark (or white) glyph on a transparent background, which vanishes
 * on a surface of the same tone. Once loaded, the icon's tone is measured on a tiny canvas (the
 * image is same-origin); a monochrome icon that matches the current scheme gets a contrasting
 * plate.
 */
import { useState } from 'react';
import { iconUrl } from '@homebase/shared';
import { useAssetUrl } from '../../static/assets.ts';
import { useColorScheme } from '../../theme/useTheme.ts';
import { LetterTile } from '../../ui/Badge.tsx';
import styles from './SiteIcon.module.css';

export interface SiteIconProps {
  label: string;
  iconId: string | null;
  /** Letter tile mode: always show the letter (with this color, or a stable one). */
  letter?: boolean;
  letterColor?: string | null;
  size: number;
  className?: string;
}

type Tone = 'dark' | 'light' | 'other';

const SAMPLE = 24;

/** Tone of a transparent monochrome-ish icon ('other' for opaque or colorful icons). */
export function iconTone(img: HTMLImageElement): Tone {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 'other';
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
    let visible = 0;
    let luminance = 0;
    let saturation = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]!;
      if (alpha < 96) continue;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      visible++;
      luminance += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      saturation += Math.max(r, g, b) - Math.min(r, g, b);
    }
    const total = SAMPLE * SAMPLE;
    // Icons with their own background (little transparency) never need a plate.
    if (visible === 0 || visible / total > 0.85) return 'other';
    if (saturation / visible > 60) return 'other';
    const average = luminance / visible;
    if (average < 70) return 'dark';
    if (average > 200) return 'light';
    return 'other';
  } catch {
    return 'other';
  }
}

/** What is known about the image at `src`: whether it failed to load, and its measured tone. */
interface ImageState {
  src: string | null;
  failed: boolean;
  tone: Tone;
}

export function SiteIcon({ label, iconId, letter = false, letterColor = null, size, className }: SiteIconProps) {
  const src = useAssetUrl(letter || !iconId ? null : iconUrl(iconId));
  const [state, setImage] = useState<ImageState>({ src, failed: false, tone: 'other' });
  const scheme = useColorScheme();
  let image = state;
  if (state.src !== src) {
    // A new URL starts over: no failure, no plate (adjusted while rendering, not in an effect).
    image = { src, failed: false, tone: 'other' };
    setImage(image);
  }

  if (src === null || image.failed) {
    return <LetterTile label={label} color={letterColor} size={size} className={[styles.tile, className].filter(Boolean).join(' ')} />;
  }
  const tone = image.tone;
  const plate = (tone === 'dark' && scheme === 'dark') || (tone === 'light' && scheme === 'light');
  return (
    <img
      className={[styles.image, className].filter(Boolean).join(' ')}
      src={src}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      data-plate={plate ? 'true' : undefined}
      style={plate ? { padding: Math.max(2, Math.round(size * 0.14)) } : undefined}
      onLoad={(event) => {
        const measured = iconTone(event.currentTarget);
        setImage((current) => (current.src === src ? { ...current, tone: measured } : current));
      }}
      onError={() => setImage((current) => (current.src === src ? { ...current, failed: true } : current))}
    />
  );
}
