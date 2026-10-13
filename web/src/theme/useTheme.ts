/**
 * Theme hooks: keep the document in sync with `settings.appearance` (every cache update, including
 * optimistic ones from the Appearance page, previews instantly) and expose the effective scheme.
 * An image background is applied again when its image URL resolves differently (a Pages page load
 * on the Homebase server on this PC loads it after the first paint).
 */
import { useEffect, useMemo } from 'react';
import { ThemeSchema, type Theme } from '@homebase/shared';
import { useSettings } from '../api/settings.ts';
import { useMediaQuery } from '../lib/useMediaQuery.ts';
import { useAssetUrl } from '../static/assets.ts';
import { applyTheme, backdropImageUrl, resolveColorScheme } from './applyTheme.ts';

const DEFAULT_THEME: Theme = ThemeSchema.parse({});

/** The current theme (defaults until settings have loaded). */
export function useTheme(): Theme {
  const settings = useSettings();
  return settings.data?.appearance ?? DEFAULT_THEME;
}

/**
 * Applies the current theme to <html> whenever it changes. Until settings are known (the
 * persisted cache is still being restored, or the first fetch is in flight) nothing is applied,
 * so the page keeps the theme painted from the persisted cache before React mounted — or the
 * stylesheet defaults, which equal the default theme. Applying the defaults here would flash
 * them over the user's theme on every new tab.
 */
export function useApplyTheme(): Theme {
  const settings = useSettings();
  const appearance = settings.data?.appearance;
  // The background image's URL on this page load: applied again when it changes (e.g. once loaded).
  const imagePath = useMemo(() => (appearance ? backdropImageUrl(appearance) : null), [appearance]);
  const imageUrl = useAssetUrl(imagePath);
  useEffect(() => {
    if (appearance) applyTheme(appearance);
  }, [appearance, imageUrl]);
  return appearance ?? DEFAULT_THEME;
}

/** 'light' | 'dark' after resolving 'system' against the OS preference. */
export function useColorScheme(): 'light' | 'dark' {
  const theme = useTheme();
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  return resolveColorScheme(theme.mode, prefersDark);
}
