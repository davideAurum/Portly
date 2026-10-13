/**
 * Color helpers (§10.4, §4.5). User/provider colors are only ever used after passing the shared
 * hex regex; text drawn on top of them uses {@link readableTextColor}.
 */
import { HEX_COLOR_REGEX } from '@homebase/shared';

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

/** `#rrggbb` / `#rrggbbaa` → channels, or null for anything else. */
export function parseHexColor(value: unknown): Rgb | null {
  if (typeof value !== 'string' || !HEX_COLOR_REGEX.test(value)) return null;
  const hex = value.slice(1);
  const channel = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return { r: channel(0), g: channel(2), b: channel(4), a: hex.length === 8 ? channel(6) / 255 : 1 };
}

/** The color when it is a valid hex color, otherwise `fallback`. */
export function safeColor(value: unknown, fallback: string): string;
export function safeColor(value: unknown, fallback?: null): string | null;
export function safeColor(value: unknown, fallback: string | null = null): string | null {
  return typeof value === 'string' && HEX_COLOR_REGEX.test(value) ? value : fallback;
}

/** `#rrggbb` without alpha (for `<input type="color">`, which rejects the 8-digit form). */
export function toOpaqueHex(value: string): string {
  const rgb = parseHexColor(value);
  if (!rgb) return '#000000';
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
}

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 = black, 1 = white). Alpha is ignored. */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
}

/** WCAG contrast ratio between two luminances (1–21). */
export function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export const DARK_TEXT = '#111827';
export const LIGHT_TEXT = '#ffffff';

/**
 * Text color with the better WCAG contrast on `background` (a hex color). Invalid input yields
 * the dark text color, which is correct for the light default surfaces.
 */
export function readableTextColor(background: unknown): typeof DARK_TEXT | typeof LIGHT_TEXT {
  const rgb = parseHexColor(background);
  if (!rgb) return DARK_TEXT;
  const l = relativeLuminance(rgb);
  const dark = relativeLuminance(parseHexColor(DARK_TEXT)!);
  return contrastRatio(l, dark) >= contrastRatio(l, 1) ? DARK_TEXT : LIGHT_TEXT;
}

/**
 * Palette offered by ColorPicker and used to derive stable colors for items without one
 * (letter tiles, accounts): calm, mid-saturation hues that work in light and dark mode.
 */
export const SWATCHES = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#84cc16',
  '#22c55e',
  '#14b8a6',
  '#06b6d4',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#d946ef',
  '#64748b',
] as const;

/** Spoken names of the {@link SWATCHES} (screen readers announce these, not hex codes). */
export const SWATCH_NAMES: Readonly<Record<(typeof SWATCHES)[number], string>> = Object.freeze({
  '#ef4444': 'Red',
  '#f97316': 'Orange',
  '#f59e0b': 'Amber',
  '#84cc16': 'Lime',
  '#22c55e': 'Green',
  '#14b8a6': 'Teal',
  '#06b6d4': 'Cyan',
  '#3b82f6': 'Blue',
  '#6366f1': 'Indigo',
  '#8b5cf6': 'Violet',
  '#d946ef': 'Fuchsia',
  '#64748b': 'Slate',
});

/** A human name for a swatch color, or the hex code for any other color. */
export function colorName(hex: string): string {
  return (SWATCH_NAMES as Record<string, string>)[hex.toLowerCase()] ?? hex;
}

/** Deterministic palette color for a string (e.g. a bookmark title). */
export function colorFromString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return SWATCHES[Math.abs(hash) % SWATCHES.length]!;
}
