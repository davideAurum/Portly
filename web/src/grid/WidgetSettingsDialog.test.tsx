/** UX-10: a call to action can open a widget's settings in the field it is about. */
import { lazy } from 'react';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { settings, widget } from '../test/fixtures.ts';
import { renderWithProviders } from '../test/render.tsx';
import { getWidgetDefinition } from '../widgets/registry.ts';
import type { AnyWidgetDefinition } from '../widgets/types.ts';
import { WidgetSettingsDialog } from './WidgetSettingsDialog.tsx';

async function renderDialog(focus: string | null, definition: AnyWidgetDefinition = getWidgetDefinition('weather')!) {
  // The weather settings are lazily loaded: load their code first, so that on a busy machine their
  // first load does not count against the waits below. (The tests that hold them back say so.)
  await import('../widgets/weather/Settings.tsx');
  return renderWithProviders(
    <WidgetSettingsDialog
      instance={widget('w-weather', 'weather', 8, 3, 4, 5)}
      definition={definition}
      focus={focus}
      onClose={vi.fn()}
      onPreview={vi.fn()}
      onSave={vi.fn(async () => {})}
    />,
    { apiMocks: { 'GET /api/settings': settings() } },
  );
}

/** The weather widget with settings whose code arrives only when `release()` is called. */
function slowWeatherSettings(): { definition: AnyWidgetDefinition; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const Settings = lazy(async () => {
    await gate;
    return import('../widgets/weather/Settings.tsx');
  });
  return { definition: { ...getWidgetDefinition('weather')!, Settings }, release };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe('widget settings focus target', () => {
  it('"Set location" opens the weather settings in the city search, not on Close', async () => {
    await renderDialog('location');
    const search = await screen.findByRole('combobox', { name: /Location/ });
    await waitFor(() => expect(search).toHaveFocus());
  });

  it('without a target the dialog keeps its default first focus', async () => {
    await renderDialog(null);
    await screen.findByRole('combobox', { name: /Location/ });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());
  });

  it('still starts in the city search when the settings take seconds to load', async () => {
    const slow = slowWeatherSettings();
    await renderDialog('location', slow.definition);
    await screen.findByRole('dialog', { name: 'Weather settings' });
    // Five seconds pass before the settings' code arrives (a slow network, a busy PC).
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + 5000);
    slow.release();
    const search = await screen.findByRole('combobox', { name: /Location/ });
    await waitFor(() => expect(search).toHaveFocus());
  });

  it('leaves focus where the user put it while the settings were loading', async () => {
    const slow = slowWeatherSettings();
    await renderDialog('location', slow.definition);
    const title = await screen.findByRole('textbox', { name: 'Title' });
    title.focus();
    slow.release();
    await screen.findByRole('combobox', { name: /Location/ });
    // The search was there for a frame or more: time enough to take focus, had it tried.
    await nextFrame();
    await nextFrame();
    expect(title).toHaveFocus();
  });
});
