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

/** Fresh copy of the default background (a function so callers can never mutate a shared default). */
export function defaultThemeBackground(): ThemeBackground {
  return {
    type: 'gradient',
    angle: 160,
    stops: [
      { color: '#1e3a8a', at: 0 },
      { color: '#6d28d9', at: 100 },
    ],
  };
}

export const DEFAULT_ACCENT = '#2563eb';

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
