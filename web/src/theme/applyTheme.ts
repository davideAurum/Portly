/**
 * Applies a Theme (§4.5) to the document. Values are re-validated with ThemeSchema first and then
 * written only through `style.setProperty(name, value)` for the fixed {@link THEME_VARIABLES}
 * list, plus `data-theme` / `data-density` / `data-backdrop` attributes whose values are closed
 * enums. No CSS text is ever built from user input: colors are regex-checked hex, numbers are
 * bounded, fonts map to constant stacks, and the only URL is `/api/uploads/<validated UUID>` as
 * `getAssetUrl` resolves it for this page load (itself, a `blob:` URL, or a base64 `data:` URL).
 * While that image is not loaded yet (a Pages page load on the Homebase server on this PC) the
 * backdrop has no image; `useApplyTheme` applies the theme again once it is there.
 *
 * `--hb-focus` deliberately stays with the stylesheet's per-scheme values: an arbitrary accent
 * (pale yellow on white, navy on the dark surfaces) can make focus rings invisible.
 */
import { ThemeSchema, uploadUrl, type Theme, type ThemeBackground, type ThemeFont } from '@homebase/shared';
import { readableTextColor } from '../lib/color.ts';
import { getAssetUrl } from '../static/assets.ts';

export const THEME_VARIABLES = [
  '--hb-accent',
  '--hb-accent-contrast',
  '--hb-widget-opacity',
  '--hb-radius-sm',
  '--hb-radius-md',
  '--hb-radius-lg',
  '--hb-font-sans',
  '--hb-backdrop',
  '--hb-backdrop-blur',
  '--hb-backdrop-dim',
] as const;
export type ThemeVariable = (typeof THEME_VARIABLES)[number];

/** System font stacks for `theme.font` (no web fonts, §2a). */
export const FONT_STACKS: Readonly<Record<ThemeFont, string>> = Object.freeze({
  system: "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, Roboto, 'Helvetica Neue', Arial, sans-serif",
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'Cascadia Code', 'Cascadia Mono', Consolas, 'SF Mono', 'Liberation Mono', monospace",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif",
});

/** What may not go inside `url("…")`: a quote, backslash, whitespace or control character could end it early. */
const CSS_URL_UNSAFE = /["'\\\s\u0000-\u001f\u007f]/;

/**
 * CSS value for the page backdrop. Inputs are validated by ThemeSchema before this runs. An image
 * background whose image has no URL yet on this page load is `none` (the page color shows).
 */
export function backdropValue(background: ThemeBackground): string {
  switch (background.type) {
    case 'color':
      return background.color;
    case 'gradient': {
      const stops = [...background.stops].sort((a, b) => a.at - b.at);
      return `linear-gradient(${background.angle}deg, ${stops.map((s) => `${s.color} ${s.at}%`).join(', ')})`;
    }
    case 'image': {
      // uploadId is a validated UUID; the URL is always /api/uploads/<id> (the Pages build maps it
      // to a blob: object URL or a base64 data: URL, which contain no user input either).
      const url = getAssetUrl(uploadUrl(background.uploadId));
      return url !== null && url !== '' && !CSS_URL_UNSAFE.test(url) ? `url("${url}")` : 'none';
    }
  }
}

/** `/api/uploads/<id>` of a theme's background image; null for other backgrounds and invalid themes. */
export function backdropImageUrl(input: unknown): string | null {
  const parsed = ThemeSchema.safeParse(input);
  if (!parsed.success || parsed.data.background.type !== 'image') return null;
  return uploadUrl(parsed.data.background.uploadId);
}

export function themeVariables(theme: Theme): Record<ThemeVariable, string> {
  const r = theme.radius;
  const image = theme.background.type === 'image' ? theme.background : null;
  return {
    '--hb-accent': theme.accent,
    '--hb-accent-contrast': readableTextColor(theme.accent),
    '--hb-widget-opacity': String(theme.widgetOpacity),
    '--hb-radius-sm': `${Math.round(r / 2)}px`,
    '--hb-radius-md': `${Math.round((r * 5) / 6)}px`,
    '--hb-radius-lg': `${r}px`,
    '--hb-font-sans': FONT_STACKS[theme.font],
    '--hb-backdrop': backdropValue(theme.background),
    '--hb-backdrop-blur': image ? `${image.blur}px` : '0px',
    '--hb-backdrop-dim': image ? String(image.dim) : '0',
  };
}

/**
 * Validates and applies a theme. Invalid input is ignored (the previous theme stays) and false
 * is returned.
 */
export function applyTheme(input: unknown, root: HTMLElement = document.documentElement): boolean {
  const parsed = ThemeSchema.safeParse(input);
  if (!parsed.success) return false;
  const theme = parsed.data;
  if (theme.mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme.mode);
  root.setAttribute('data-density', theme.density);
  // Glass surfaces only use live backdrop blur over image backgrounds (tokens.css).
  root.setAttribute('data-backdrop', theme.background.type);
  const vars = themeVariables(theme);
  for (const name of THEME_VARIABLES) root.style.setProperty(name, vars[name]);
  return true;
}

/** The effective color scheme for a theme mode, given the OS preference. */
export function resolveColorScheme(mode: Theme['mode'], prefersDark: boolean): 'light' | 'dark' {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}
