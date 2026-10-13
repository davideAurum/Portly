import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { uploadUrl } from '@portly/shared';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { setServerAssetSource } from '../../static/assets.ts';
import { useApplyTheme } from '../../theme/useTheme.ts';
import AppearanceSettings, { replacementPatch } from '../../settings/sections/Appearance.tsx';
import { createFakeServer } from '../fakeServer.ts';
import { manualAssetSource } from '../hybrid.ts';
import { renderWithProviders } from '../render.tsx';

function WithTheme() {
  useApplyTheme();
  return <AppearanceSettings />;
}

describe('Appearance settings', () => {
  it('applies changes to the page immediately and saves them with a debounced merge patch', async () => {
    const server = createFakeServer([]);
    const { requestsTo } = renderWithProviders(<WithTheme />, { apiMocks: server.mocks });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('radio', { name: 'Dark' }));
    // Live preview: the theme is applied before the server has seen anything.
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
    await user.click(screen.getByRole('radio', { name: 'Compact' }));
    await user.click(screen.getByRole('radio', { name: 'Red' }));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--hb-accent')).toBe('#ef4444'));
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');

    await waitFor(() => expect(server.settings.appearance).toMatchObject({ mode: 'dark', density: 'compact', accent: '#ef4444' }));
    // Rapid edits are combined into as few requests as the debounce allows.
    expect(requestsTo('PATCH /api/settings').length).toBeLessThanOrEqual(3);
    // Server responses never undo edits that are still pending.
    expect(document.documentElement.style.getPropertyValue('--hb-accent')).toBe('#ef4444');
  });

  it('switching background type replaces the whole background object', async () => {
    const server = createFakeServer([]);
    const { requestsTo } = renderWithProviders(<WithTheme />, { apiMocks: server.mocks });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Color' }));
    await waitFor(() => expect(requestsTo('PATCH /api/settings')).toHaveLength(1));
    expect(requestsTo('PATCH /api/settings')[0]!.body).toEqual({
      appearance: { background: { type: 'color', color: '#0b4f63', angle: null, stops: null } },
    });
    expect(server.settings.appearance.background).toEqual({ type: 'color', color: '#0b4f63' });
    expect(document.documentElement.style.getPropertyValue('--hb-backdrop')).toBe('#0b4f63');
  });

  it('switching Image → Gradient → Image brings the uploaded photo back (UX-11)', async () => {
    const server = createFakeServer([]);
    const uploadId = '8f654906-1111-4111-8111-111111111111';
    server.settings.appearance.background = { type: 'image', uploadId, blur: 4, dim: 0.3 };
    renderWithProviders(<WithTheme />, { apiMocks: server.mocks });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Gradient' }));
    await waitFor(() => expect(server.settings.appearance.background).toMatchObject({ type: 'gradient' }));
    await user.click(screen.getByRole('radio', { name: 'Image' }));
    await waitFor(() => expect(server.settings.appearance.background).toEqual({ type: 'image', uploadId, blur: 4, dim: 0.3 }));
    expect(screen.queryByText('Choose an image or drop it here')).toBeNull();
  });

  it('edits gradient stops within the 2–5 bounds', async () => {
    const server = createFakeServer([]);
    renderWithProviders(<WithTheme />, { apiMocks: server.mocks });
    const user = userEvent.setup();
    const add = await screen.findByRole('button', { name: 'Add color stop' });
    expect(screen.getByRole('button', { name: 'Remove stop 1' })).toBeDisabled();
    for (let i = 0; i < 3; i++) await user.click(add);
    expect(add).toBeDisabled();
    expect(screen.getAllByRole('slider', { name: /Stop \d position/ })).toHaveLength(5);
    await waitFor(() => expect(server.settings.appearance.background).toMatchObject({ type: 'gradient' }));
    await waitFor(() => expect((server.settings.appearance.background as { stops: unknown[] }).stops).toHaveLength(5));
  });

  it('resets appearance to the defaults with a null patch', async () => {
    const server = createFakeServer([]);
    server.settings.appearance = { ...server.settings.appearance, mode: 'dark', radius: 3 };
    const { requestsTo } = renderWithProviders(<WithTheme />, { apiMocks: server.mocks });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reset appearance to defaults' }));
    await waitFor(() => expect(requestsTo('PATCH /api/settings')).toHaveLength(1));
    expect(requestsTo('PATCH /api/settings')[0]!.body).toEqual({ appearance: null });
    await waitFor(() => expect(server.settings.appearance.mode).toBe('system'));
  });

  it('replacementPatch nulls stale keys', () => {
    expect(replacementPatch({ type: 'gradient', angle: 1, stops: [] }, { type: 'color', color: '#000000' })).toEqual({
      type: 'color',
      color: '#000000',
      angle: null,
      stops: null,
    });
  });
});

describe('Appearance on the Portly server on this PC (Pages build, hybrid mode)', () => {
  afterEach(() => setServerAssetSource(null));

  it('shows the background image (page backdrop and preview) once the server has delivered it, never the raw /api URL', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const fake = manualAssetSource();
    setServerAssetSource(fake.source);
    const server = createFakeServer([]);
    const uploadId = '8f654906-1111-4111-8111-111111111111';
    server.settings.appearance.background = { type: 'image', uploadId, blur: 4, dim: 0.3 };
    const { container } = renderWithProviders(<WithTheme />, { apiMocks: server.mocks });

    await waitFor(() => expect(document.documentElement.getAttribute('data-backdrop')).toBe('image'));
    // Not loaded yet: no image anywhere (the page color shows), and the load has started.
    expect(document.documentElement.style.getPropertyValue('--hb-backdrop')).toBe('none');
    expect(document.documentElement.style.getPropertyValue('--hb-backdrop-blur')).toBe('4px');
    expect(container.querySelector('img')).toBeNull();
    await waitFor(() => expect(fake.load).toHaveBeenCalledWith(uploadUrl(uploadId)));

    act(() => fake.finish(uploadUrl(uploadId), 'blob:http://pages.example/photo'));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--hb-backdrop')).toBe('url("blob:http://pages.example/photo")'));
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:http://pages.example/photo');
    expect(document.documentElement.style.cssText).not.toContain('/api/uploads/');
  });
});
