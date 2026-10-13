/**
 * Theme (§7a Theme, §4.5 theme safety). Every value is strictly typed so that the web app can
 * apply it with `style.setProperty(name, value)` for a fixed list of variables — no CSS text is
 * ever built from user input. Colors are hex only, fonts are an enum of system stacks, numbers
 * are bounded, the background image is referenced by upload id only.
 */
import { z } from 'zod';
import { HexColor, Uuid } from './core.ts';

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export const THEME_FONTS = ['system', 'serif', 'mono', 'rounded'] as const;
export const THEME_DENSITIES = ['comfortable', 'compact'] as const;

export const ThemeModeSchema = z.enum(THEME_MODES);
export type ThemeMode = z.output<typeof ThemeModeSchema>;

export const ThemeFontSchema = z.enum(THEME_FONTS);
export type ThemeFont = z.output<typeof ThemeFontSchema>;

export const ThemeDensitySchema = z.enum(THEME_DENSITIES);
export type ThemeDensity = z.output<typeof ThemeDensitySchema>;

export const GradientStopSchema = z
  .object({
    color: HexColor,
    at: z.number().min(0).max(100),
  })
  .strict();
export type GradientStop = z.output<typeof GradientStopSchema>;

export const ColorBackgroundSchema = z
  .object({
    type: z.literal('color'),
    color: HexColor,
  })
  .strict();

export const GradientBackgroundSchema = z
  .object({
    type: z.literal('gradient'),
    angle: z.number().min(0).max(360),
    stops: z.array(GradientStopSchema).min(2).max(5),
  })
  .strict();

export const ImageBackgroundSchema = z
  .object({
    type: z.literal('image'),
    /** The URL is always built as `/api/uploads/${uploadId}` (see `uploadUrl`). */
    uploadId: Uuid,
    blur: z.number().min(0).max(40).default(0),
    dim: z.number().min(0).max(0.9).default(0.2),
  })
  .strict();

export const ThemeBackgroundSchema = z.discriminatedUnion('type', [
  ColorBackgroundSchema,
  GradientBackgroundSchema,
  ImageBackgroundSchema,
]);
export type ThemeBackground = z.output<typeof ThemeBackgroundSchema>;

/**
 * Fresh copy of the default background (a function so callers can never mutate a shared default):
 * the Beacon brand's Harbor to Deep gradient (docs/brand/README.md).
 */
export function defaultThemeBackground(): ThemeBackground {
  return {
    type: 'gradient',
    angle: 160,
    stops: [
      { color: '#0b4f63', at: 0 },
      { color: '#072f3b', at: 100 },
    ],
  };
}

/** Tide: white button text and the Tide-derived link color both pass WCAG AA in light and dark. */
export const DEFAULT_ACCENT = '#137a85';

/** The accent and gradient that were the defaults before the Beacon brand. */
export const LEGACY_DEFAULT_ACCENT = '#2563eb';
export const LEGACY_DEFAULT_GRADIENT = Object.freeze({ angle: 160, from: '#1e3a8a', to: '#6d28d9' });

export const ThemeSchema = z
  .object({
    mode: ThemeModeSchema.default('system'),
    accent: HexColor.default(DEFAULT_ACCENT),
    background: ThemeBackgroundSchema.default(defaultThemeBackground),
    font: ThemeFontSchema.default('system'),
    density: ThemeDensitySchema.default('comfortable'),
    radius: z.number().int().min(0).max(24).default(12),
    widgetOpacity: z.number().min(0.3).max(1).default(0.85),
  })
  .strict();

export type Theme = z.output<typeof ThemeSchema>;
export type ThemeInput = z.input<typeof ThemeSchema>;

function isLegacyDefaultBackground(background: ThemeBackground): boolean {
  if (background.type !== 'gradient' || background.angle !== LEGACY_DEFAULT_GRADIENT.angle || background.stops.length !== 2) return false;
  const [first, second] = background.stops;
  return (
    first?.color.toLowerCase() === LEGACY_DEFAULT_GRADIENT.from &&
    first.at === 0 &&
    second?.color.toLowerCase() === LEGACY_DEFAULT_GRADIENT.to &&
    second.at === 100
  );
}

/**
 * One-time upgrade of stored appearance settings to the Beacon defaults (the server's
 * `004_beacon_defaults.sql` migration and the static backend's settings `ready()` do the same).
 * Settings are stored with their defaults filled in, so an accent or background that still equals
 * the old default exactly was never chosen and moves to the new default; anything else is kept.
 */
export function upgradeLegacyThemeDefaults(theme: Theme): Theme {
  const accent = theme.accent.toLowerCase() === LEGACY_DEFAULT_ACCENT ? DEFAULT_ACCENT : theme.accent;
  const background = isLegacyDefaultBackground(theme.background) ? defaultThemeBackground() : theme.background;
  return accent === theme.accent && background === theme.background ? theme : { ...theme, accent, background };
}
