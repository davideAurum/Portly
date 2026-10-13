import { afterEach, describe, expect, it } from 'vitest';
import { ThemeSchema, uploadUrl, type Theme } from '@homebase/shared';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { AssetRegistry, setActiveAssetRegistry, setServerAssetSource } from '../static/assets.ts';
import { manualAssetSource } from '../test/hybrid.ts';
import { FONT_STACKS, THEME_VARIABLES, applyTheme, backdropImageUrl, backdropValue, resolveColorScheme, themeVariables } from './applyTheme.ts';
import { applyPersistedTheme } from './persistedTheme.ts';

const UPLOAD_ID = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b';

function theme(overrides: Partial<Theme> = {}): Theme {
  return { ...ThemeSchema.parse({}), ...overrides };
}

describe('applyTheme', () => {
  it('writes exactly the fixed variable list plus enum data attributes', () => {
    const root = document.createElement('div');
    expect(applyTheme(theme({ mode: 'dark', accent: '#ff0000', density: 'compact', radius: 12, widgetOpacity: 0.6 }), root)).toBe(true);

    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-density')).toBe('compact');
    expect(root.style.length).toBe(THEME_VARIABLES.length);
    for (let i = 0; i < root.style.length; i++) expect(THEME_VARIABLES).toContain(root.style.item(i));

    expect(root.style.getPropertyValue('--hb-accent')).toBe('#ff0000');
    expect(root.style.getPropertyValue('--hb-accent-contrast')).toBe('#111827');
    expect(root.style.getPropertyValue('--hb-widget-opacity')).toBe('0.6');
    expect(root.style.getPropertyValue('--hb-radius-lg')).toBe('12px');
    expect(root.style.getPropertyValue('--hb-radius-md')).toBe('10px');
    expect(root.style.getPropertyValue('--hb-radius-sm')).toBe('6px');
    // Focus rings keep the stylesheet's high-contrast per-scheme color, whatever the accent.
    expect(root.style.getPropertyValue('--hb-focus')).toBe('');
  });

  it('marks the backdrop type so live glass blur is only used over images', () => {
    const root = document.createElement('div');
    applyTheme(theme({ background: { type: 'gradient', angle: 90, stops: [{ color: '#000000', at: 0 }, { color: '#ffffff', at: 100 }] } }), root);
    expect(root.getAttribute('data-backdrop')).toBe('gradient');
    applyTheme(theme({ background: { type: 'image', uploadId: UPLOAD_ID, blur: 0, dim: 0 } }), root);
    expect(root.getAttribute('data-backdrop')).toBe('image');
    applyTheme(theme({ background: { type: 'color', color: '#112233' } }), root);
    expect(root.getAttribute('data-backdrop')).toBe('color');
  });

  it('removes data-theme for system mode so the OS preference applies', () => {
    const root = document.createElement('div');
    root.setAttribute('data-theme', 'dark');
    applyTheme(theme({ mode: 'system' }), root);
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('maps fonts to constant system stacks', () => {
    for (const font of ['system', 'serif', 'mono', 'rounded'] as const) {
      expect(themeVariables(theme({ font }))['--hb-font-sans']).toBe(FONT_STACKS[font]);
    }
  });

  it('builds backgrounds: color, sorted gradient stops, and images only from /api/uploads/<uuid>', () => {
    expect(backdropValue({ type: 'color', color: '#112233' })).toBe('#112233');
    expect(
      backdropValue({
        type: 'gradient',
        angle: 90,
        stops: [
          { color: '#000000', at: 100 },
          { color: '#ffffff', at: 0 },
        ],
      }),
    ).toBe('linear-gradient(90deg, #ffffff 0%, #000000 100%)');

    const vars = themeVariables(theme({ background: { type: 'image', uploadId: UPLOAD_ID, blur: 12, dim: 0.4 } }));
    expect(vars['--hb-backdrop']).toBe(`url("/api/uploads/${UPLOAD_ID}")`);
    expect(vars['--hb-backdrop-blur']).toBe('12px');
    expect(vars['--hb-backdrop-dim']).toBe('0.4');

    const plain = themeVariables(theme({ background: { type: 'color', color: '#112233' } }));
    expect(plain['--hb-backdrop-blur']).toBe('0px');
    expect(plain['--hb-backdrop-dim']).toBe('0');
  });

  it('ignores invalid or hostile themes and keeps the previous values', () => {
    const root = document.createElement('div');
    applyTheme(theme({ accent: '#00ff00' }), root);
    const hostile: unknown[] = [
      { ...theme(), accent: 'red; background: url(https://evil.example/x)' },
      { ...theme(), accent: 'rgb(0,0,0)' },
      { ...theme(), background: { type: 'image', uploadId: '../../etc/passwd', blur: 0, dim: 0 } },
      { ...theme(), background: { type: 'image', uploadId: `${UPLOAD_ID}") , url("https://evil.example`, blur: 0, dim: 0 } },
      { ...theme(), background: { type: 'gradient', angle: 90, stops: [{ color: '#fff', at: 0 }] } },
      { ...theme(), radius: 1000 },
      { ...theme(), widgetOpacity: 0 },
      { ...theme(), font: 'Comic Sans' },
      { ...theme(), mode: 'sepia' },
      { ...theme(), extra: 'x' },
      null,
      'dark',
    ];
    for (const input of hostile) expect(applyTheme(input, root)).toBe(false);
    expect(root.style.getPropertyValue('--hb-accent')).toBe('#00ff00');
    expect(root.style.cssText).not.toContain('evil');
  });

  it('applies the persisted theme before the app mounts (validated like any theme)', () => {
    const persisted = (appearance: unknown) => ({
      getItem: () =>
        JSON.stringify({
          buster: 'x',
          timestamp: 1,
          clientState: { mutations: [], queries: [{ queryKey: ['settings'], state: { data: { appearance } } }] },
        }),
    });
    expect(applyPersistedTheme('k', persisted(theme({ mode: 'dark', accent: '#123456' })))).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--hb-accent')).toBe('#123456');
    expect(applyPersistedTheme('k', persisted({ ...theme(), accent: 'url(x)' }))).toBe(false);
    expect(applyPersistedTheme('k', { getItem: () => '{not json' })).toBe(false);
    expect(applyPersistedTheme('k', { getItem: () => null })).toBe(false);
  });

  it('resolves the effective color scheme', () => {
    expect(resolveColorScheme('system', true)).toBe('dark');
    expect(resolveColorScheme('system', false)).toBe('light');
    expect(resolveColorScheme('light', true)).toBe('light');
    expect(resolveColorScheme('dark', false)).toBe('dark');
  });
});

describe('image backdrops on this page load', () => {
  const image = { type: 'image', uploadId: UPLOAD_ID, blur: 0, dim: 0 } as const;

  afterEach(() => {
    setServerAssetSource(null);
    setActiveAssetRegistry(null);
  });

  it('Pages build, in-browser backend: the registered object URL', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const assets = new AssetRegistry({ createObjectUrl: () => 'blob:http://pages.example/photo', revokeObjectUrl: () => {} });
    setActiveAssetRegistry(assets);
    assets.registerBlob('uploads', UPLOAD_ID, new Blob(['x']));
    expect(backdropValue(image)).toBe('url("blob:http://pages.example/photo")');
  });

  it('Pages build on the Homebase server: no image until it is loaded, never the raw /api URL', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const fake = manualAssetSource();
    setServerAssetSource(fake.source);
    expect(backdropValue(image)).toBe('none');
    const root = document.createElement('div');
    applyTheme(theme({ background: image }), root);
    expect(root.style.getPropertyValue('--hb-backdrop')).toBe('none');
    expect(root.getAttribute('data-backdrop')).toBe('image');

    fake.finish(uploadUrl(UPLOAD_ID), 'data:image/svg+xml;base64,PHN2Zy8+');
    expect(backdropValue(image)).toBe('url("data:image/svg+xml;base64,PHN2Zy8+")');
  });

  it('refuses a resolved URL that could end the CSS string early', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const fake = manualAssetSource();
    setServerAssetSource(fake.source);
    for (const hostile of ['blob:x") , url("https://evil.example', "blob:x'", 'blob:x\\', 'blob:a b', 'blob:a\nb', 'blob:a\u0001b', '']) {
      fake.finish(uploadUrl(UPLOAD_ID), hostile);
      expect(backdropValue(image), hostile).toBe('none');
    }
  });

  it('backdropImageUrl names the upload of a valid image theme only', () => {
    expect(backdropImageUrl(theme({ background: image }))).toBe(uploadUrl(UPLOAD_ID));
    expect(backdropImageUrl(theme())).toBeNull();
    expect(backdropImageUrl({ ...theme(), background: { type: 'image', uploadId: '../../etc/passwd', blur: 0, dim: 0 } })).toBeNull();
    expect(backdropImageUrl(null)).toBeNull();
  });
});
