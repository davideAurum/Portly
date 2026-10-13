/**
 * SiteIcon's image URL through `useAssetUrl`: the URL itself in the server build; on the Pages
 * build's server backend (hybrid mode) the letter tile until the Portly server on this PC has
 * delivered the icon, then the loaded `blob:` URL — never the raw `/api/icons/…` path — and a
 * failed image falls back to the letter tile only until the URL changes.
 */
import { act, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { iconUrl } from '@portly/shared';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { setServerAssetSource } from '../../static/assets.ts';
import { manualAssetSource } from '../../test/hybrid.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { SiteIcon } from './SiteIcon.tsx';

const ICON_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ICON_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

afterEach(() => setServerAssetSource(null));

describe('SiteIcon', () => {
  it('server build: the stored icon URL itself', () => {
    const { container } = renderWithProviders(<SiteIcon label="Github" iconId={ICON_A} size={32} />, { toaster: false });
    expect(container.querySelector('img')).toHaveAttribute('src', iconUrl(ICON_A));
  });

  it('Pages build on the Portly server: the letter tile until the icon is loaded, then the loaded URL', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const fake = manualAssetSource();
    setServerAssetSource(fake.source);
    const { container } = renderWithProviders(<SiteIcon label="Github" iconId={ICON_A} size={32} />, { toaster: false });
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('G');
    expect(fake.load).toHaveBeenCalledWith(iconUrl(ICON_A));

    act(() => fake.finish(iconUrl(ICON_A), 'blob:http://pages.example/a'));
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:http://pages.example/a');
    expect(container.innerHTML).not.toContain('/api/icons/');
  });

  it('keeps the letter tile when the server has no such icon', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const fake = manualAssetSource();
    setServerAssetSource(fake.source);
    const { container } = renderWithProviders(<SiteIcon label="Nas" iconId={ICON_A} size={32} />, { toaster: false });
    act(() => fake.finish(iconUrl(ICON_A), null));
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('N');
  });

  it('a failed image shows the letter tile until the resolved URL changes', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const fake = manualAssetSource();
    setServerAssetSource(fake.source);
    act(() => {
      fake.finish(iconUrl(ICON_A), 'blob:http://pages.example/a');
      fake.finish(iconUrl(ICON_B), 'blob:http://pages.example/b');
    });
    const { container, rerender } = renderWithProviders(<SiteIcon label="Github" iconId={ICON_A} size={32} />, { toaster: false });
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();

    rerender(<SiteIcon label="Github" iconId={ICON_B} size={32} />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:http://pages.example/b');
    // Back to the first icon: its URL is resolved anew, so it gets another chance.
    rerender(<SiteIcon label="Github" iconId={ICON_A} size={32} />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:http://pages.example/a');
  });
});
