/** UX-10: a call to action can open a widget's settings in the field it is about. */
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { settings, widget } from '../test/fixtures.ts';
import { renderWithProviders } from '../test/render.tsx';
import { getWidgetDefinition } from '../widgets/registry.ts';
import { WidgetSettingsDialog } from './WidgetSettingsDialog.tsx';

function renderDialog(focus: string | null) {
  return renderWithProviders(
    <WidgetSettingsDialog
      instance={widget('w-weather', 'weather', 8, 3, 4, 5)}
      definition={getWidgetDefinition('weather')!}
      focus={focus}
      onClose={vi.fn()}
      onPreview={vi.fn()}
      onSave={vi.fn(async () => {})}
    />,
    { apiMocks: { 'GET /api/settings': settings() } },
  );
}

describe('widget settings focus target', () => {
  it('"Set location" opens the weather settings in the city search, not on Close', async () => {
    renderDialog('location');
    const search = await screen.findByRole('combobox', { name: /Location/ });
    await waitFor(() => expect(search).toHaveFocus());
  });

  it('without a target the dialog keeps its default first focus', async () => {
    renderDialog(null);
    await screen.findByRole('combobox', { name: /Location/ });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());
  });
});
