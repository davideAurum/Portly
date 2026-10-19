/**
 * Theme hooks: keep the document in sync with `settings.appearance` (every cache update, including
 * optimistic ones from the Appearance page, previews instantly) and expose the effective scheme.
 * An image background is applied again when its image URL resolves differently (a Pages page load
 * on the Portly server on this PC loads it after the first paint).
 */
import { useEffect, useMemo, useState } from 'react';
import { ThemeSchema, type Theme } from '@portly/shared';
import { useSettings } from '../api/settings.ts';
import { useMediaQuery } from '../lib/useMediaQuery.ts';
import { useAssetUrl } from '../static/assets.ts';
import { applyTheme, backdropImageUrl, resolveColorScheme } from './applyTheme.ts';
import { bakeBlurredBackdrop, currentViewport, type BakeViewport } from './backdropBake.ts';
import { useFrostedGlass } from './glassPreference.ts';

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
  const blur = appearance?.background.type === 'image' ? appearance.background.blur : 0;
  const baked = useBakedBackdrop(imageUrl, blur);
  const frostedGlass = useFrostedGlass();
  useEffect(() => {
    if (appearance) applyTheme(appearance, document.documentElement, { bakedBackdrop: baked, frostedGlass });
  }, [appearance, imageUrl, baked, frostedGlass]);
  return appearance ?? DEFAULT_THEME;
}

/** Wait this long after the image, blur or window size last changed before baking (slider drags). */
const BAKE_DELAY_MS = 150;
/** Keep a replaced object URL this long, so the backdrop has switched before it is revoked. */
const REVOKE_DELAY_MS = 2_000;

export interface BackdropBakeDeps {
  bake(src: string, blur: number, viewport: BakeViewport): Promise<Blob | null>;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  /**
   * Loads and decodes `url`, so the backdrop never shows a frame without its image when it
   * switches. What it resolves with is kept while the copy is on screen (the decoded image stays
   * in the browser's memory cache).
   */
  preload(url: string): Promise<unknown>;
}

const BROWSER_BAKE: BackdropBakeDeps = {
  bake: bakeBlurredBackdrop,
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  preload: async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  },
};

interface Baked {
  src: string;
  blur: number;
  sizeKey: string;
  url: string;
  /** The decoded copy, held while this URL is on screen. */
  decoded: unknown;
}

/**
 * The `blob:` URL of `src` with `blur` baked in (backdropBake.ts), or null while there is none:
 * no blur, not baked yet, or this browser cannot bake (then applyTheme keeps the live CSS blur).
 * A copy baked for another window size is still returned while the new one is made; one for
 * another image or blur is not. A new copy is returned only once it is decoded. `deps` must be a
 * stable object (tests pass fakes).
 */
export function useBakedBackdrop(src: string | null, blur: number, deps: BackdropBakeDeps = BROWSER_BAKE): string | null {
  const sizeKey = useWindowSizeKey();
  const [baked, setBaked] = useState<Baked | null>(null);
  const target = src !== null && blur > 0 ? { src, blur } : null;
  const current = target !== null && baked !== null && baked.src === target.src && baked.blur === target.blur ? baked : null;
  const upToDate = current !== null && current.sizeKey === sizeKey;

  useEffect(() => {
    if (target === null) {
      // Not a blurred photo (any more): let the old copy go.
      setBaked(null);
      return;
    }
    if (upToDate) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        let url: string | null = null;
        try {
          // The window as it is now (the key only says when it changed enough to bake again).
          const blob = await deps.bake(target.src, target.blur, currentViewport());
          if (cancelled || blob === null) return;
          url = deps.createObjectUrl(blob);
          const decoded = await deps.preload(url);
          if (cancelled) return;
          setBaked({ src: target.src, blur: target.blur, sizeKey, url, decoded });
          url = null;
        } catch {
          // The image did not load or decode: the live blur (or no image) stays.
        } finally {
          if (url !== null) deps.revokeObjectUrl(url);
        }
      })();
    }, BAKE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // target is recreated on every render; its fields are the real inputs.
  }, [target?.src, target?.blur, upToDate, sizeKey, deps]);

  // Revoke each object URL once it has been replaced (or the hook goes away).
  useEffect(() => {
    if (baked === null) return;
    const url = baked.url;
    return () => {
      setTimeout(() => deps.revokeObjectUrl(url), REVOKE_DELAY_MS);
    };
  }, [baked, deps]);

  return current?.url ?? null;
}

/**
 * A key for the window's size that changes when its CSS width or height changes by roughly a fifth
 * or more, or its device pixel ratio changes (browser zoom, another monitor): then the baked copy,
 * made for a given cover scale and blur in CSS px, is made again.
 */
export function windowSizeKey(viewport: BakeViewport = currentViewport()): string {
  const bucket = (cssPx: number) => Math.round(Math.log2(Math.max(1, cssPx)) * 4);
  return `${bucket(viewport.width)}x${bucket(viewport.height)}@${Math.round(viewport.devicePixelRatio * 100)}`;
}

/** {@link windowSizeKey}, updated (debounced) on resize. */
function useWindowSizeKey(): string {
  const [key, setKey] = useState(() => windowSizeKey());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setKey(windowSizeKey()), BAKE_DELAY_MS);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return key;
}

/** 'light' | 'dark' after resolving 'system' against the OS preference. */
export function useColorScheme(): 'light' | 'dark' {
  const theme = useTheme();
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  return resolveColorScheme(theme.mode, prefersDark);
}
