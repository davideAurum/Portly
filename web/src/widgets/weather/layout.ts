/**
 * Layout tiers of the weather widget, from its grid size (rows are 40 px + 12 px gaps). Which
 * sections exist is decided here; container queries in Widget.module.css then refine each tier
 * to the actual width/height (narrow cards drop labels, short ones shrink the type).
 *
 * - compact (≤ 3 rows): icon + temperature (+ condition, place and high/low when wide enough)
 * - medium (4–6 rows): + feels-like / wind / humidity + hourly strip (or a day strip)
 * - large (≥ 7 rows): + 7-day list with min/max bars
 */
export type WeatherTier = 'compact' | 'medium' | 'large';

export function weatherTier(size: { w: number; h: number }): WeatherTier {
  if (size.h <= 3) return 'compact';
  if (size.h >= 7) return 'large';
  return 'medium';
}

/**
 * A short but wide card (compact tier, ≥ 6 columns) has room beside the current conditions for
 * a short hourly strip instead of an empty middle (UX-9).
 */
export function isWideCompact(size: { w: number; h: number }): boolean {
  return weatherTier(size) === 'compact' && size.w >= 6;
}

/** Hours shown in the hourly strip (the report carries 48). */
export const HOURLY_STRIP_HOURS = 24;
/** Precipitation chances below this are not worth a label. */
export const PRECIP_LABEL_MIN = 20;
