/**
 * Applies a Theme (§4.5) to the document. Values are re-validated with ThemeSchema first and then
 * written only through `style.setProperty(name, value)` for the fixed {@link THEME_VARIABLES}
 * list, plus `data-theme` / `data-density` / `data-backdrop` / `data-backdrop-filter` /
 * `data-glass` / `data-opaque-widgets` attributes whose values are closed enums. No CSS text is
 * ever built from user input: colors are regex-checked hex, numbers are bounded, fonts map to
 * constant stacks, and the only URLs are `/api/uploads/<validated UUID>` as `getAssetUrl` resolves
 * it for this page load (itself, a `blob:` URL, or a base64 `data:` URL) and the page's own baked
 * `blob:` copy of that image (`bakedBackdrop`).
 * While that image is not loaded yet (a Pages page load on the Portly server on this PC) the
 * backdrop has no image; `useApplyTheme` applies the theme again once it is there.
 *
 * Performance (§7a Theme): the dim is a dark gradient layer in `--hb-backdrop`, never a filter, and
 * a blur is normally baked into a small copy of the image once (`backdropBake.ts`, passed in as
 * `bakedBackdrop`). Only while that copy is not ready, or cannot be made, does the backdrop use a
 * live CSS blur (`data-backdrop-filter='live'`). Glass surfaces blur the photo behind them only
 * when this browser has frosted glass turned on (`data-glass='frosted'`, tokens.css).
 *
 * `--hb-focus` deliberately stays with the stylesheet's per-scheme values: an arbitrary accent
 * (pale yellow on white, navy on the dark surfaces) can make focus rings invisible.
 */
import { ThemeSchema, uploadUrl, type Theme, type ThemeBackground, type ThemeFont } from '@portly/shared';
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

/** Widgets at least this opaque hide a frosted blur behind them, so their frames skip it. */
export const OPAQUE_WIDGET_OPACITY = 0.95;

export interface ApplyThemeOptions {
  /**
   * `blob:` URL of the theme's background image with its blur already baked in for this screen
   * (`useBakedBackdrop`). Shown instead of the original image under a live CSS blur. Ignored for
   * other backgrounds and for anything that is not a plain `blob:` URL.
   */
  bakedBackdrop?: string | null;
  /** This browser's frosted glass setting (`glassPreference.ts`; not part of the theme). */
  frostedGlass?: boolean;
}

/** The baked image URL if it may be used: our own object URL, safe inside `url("…")`. */
function usableBakedUrl(background: ThemeBackground, baked: string | null | undefined): string | null {
  if (background.type !== 'image' || background.blur <= 0 || typeof baked !== 'string') return null;
  return baked.startsWith('blob:') && !CSS_URL_UNSAFE.test(baked) ? baked : null;
}

/**
 * CSS value for the page backdrop. Inputs are validated by ThemeSchema before this runs. An image
 * background whose image has no URL yet on this page load is `none` (the page color shows); its
 * dim is a dark gradient layer over the image (no filter). `bakedImage` replaces the image's URL
 * (see {@link ApplyThemeOptions.bakedBackdrop}).
 */
export function backdropValue(background: ThemeBackground, bakedImage: string | null = null): string {
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
      const url = usableBakedUrl(background, bakedImage) ?? getAssetUrl(uploadUrl(background.uploadId));
      if (url === null || url === '' || CSS_URL_UNSAFE.test(url)) return 'none';
      // dim is a ThemeSchema-bounded number (0–0.9).
      if (background.dim <= 0) return `url("${url}")`;
      const shade = `rgb(0 0 0 / ${background.dim})`;
      return `linear-gradient(${shade}, ${shade}), url("${url}")`;
    }
  }
}

/** `/api/uploads/<id>` of a theme's background image; null for other backgrounds and invalid themes. */
export function backdropImageUrl(input: unknown): string | null {
  const parsed = ThemeSchema.safeParse(input);
  if (!parsed.success || parsed.data.background.type !== 'image') return null;
  return uploadUrl(parsed.data.background.uploadId);
}

/** Whether the backdrop needs a live CSS blur: an image with blur, shown without a baked copy. */
function needsLiveBlur(theme: Theme, options: ApplyThemeOptions): boolean {
  const background = theme.background;
  return background.type === 'image' && background.blur > 0 && usableBakedUrl(background, options.bakedBackdrop) === null;
}

export function themeVariables(theme: Theme, options: ApplyThemeOptions = {}): Record<ThemeVariable, string> {
  const r = theme.radius;
  const background = theme.background;
  return {
    '--hb-accent': theme.accent,
    '--hb-accent-contrast': readableTextColor(theme.accent),
    '--hb-widget-opacity': String(theme.widgetOpacity),
    '--hb-radius-sm': `${Math.round(r / 2)}px`,
    '--hb-radius-md': `${Math.round((r * 5) / 6)}px`,
    '--hb-radius-lg': `${r}px`,
    '--hb-font-sans': FONT_STACKS[theme.font],
    '--hb-backdrop': backdropValue(background, options.bakedBackdrop ?? null),
    '--hb-backdrop-blur': background.type === 'image' && needsLiveBlur(theme, options) ? `${background.blur}px` : '0px',
  };
}

/**
 * Validates and applies a theme. Invalid input is ignored (the previous theme stays) and false
 * is returned.
 */
export function applyTheme(input: unknown, root: HTMLElement = document.documentElement, options: ApplyThemeOptions = {}): boolean {
  const parsed = ThemeSchema.safeParse(input);
  if (!parsed.success) return false;
  const theme = parsed.data;
  if (theme.mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme.mode);
  root.setAttribute('data-density', theme.density);
  root.setAttribute('data-backdrop', theme.background.type);
  const vars = themeVariables(theme, options);
  for (const name of THEME_VARIABLES) root.style.setProperty(name, vars[name]);
  const photoShown = theme.background.type === 'image' && vars['--hb-backdrop'] !== 'none';
  // Live filters (base.css, tokens.css) only where they show: over a photo that is on screen.
  setFlag(root, 'data-backdrop-filter', photoShown && needsLiveBlur(theme, options) ? 'live' : null);
  root.setAttribute('data-glass', photoShown && options.frostedGlass === true ? 'frosted' : 'clear');
  setFlag(root, 'data-opaque-widgets', theme.widgetOpacity >= OPAQUE_WIDGET_OPACITY ? 'true' : null);
  return true;
}

function setFlag(root: HTMLElement, name: string, value: string | null): void {
  if (value === null) root.removeAttribute(name);
  else root.setAttribute(name, value);
}

/** The effective color scheme for a theme mode, given the OS preference. */
export function resolveColorScheme(mode: Theme['mode'], prefersDark: boolean): 'light' | 'dark' {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}
