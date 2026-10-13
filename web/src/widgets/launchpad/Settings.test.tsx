import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BookmarkGroup } from '@homebase/shared';
import { renderWithProviders } from '../../test/render.tsx';
import { launchpadConfigSchema, type LaunchpadConfig } from './index.ts';
import LaunchpadSettings from './Settings.tsx';

const groups: BookmarkGroup[] = [
  { id: 'g1', name: 'Bookmarks', sort: 0, color: null, collapsed: false, bookmarks: [] },
  { id: 'g2', name: 'News', sort: 1, color: null, collapsed: false, bookmarks: [] },
  { id: 'g3', name: 'Finance', sort: 2, color: null, collapsed: false, bookmarks: [] },
];

function renderSettings(config: Partial<LaunchpadConfig> = {}) {
  const onChange = vi.fn();
  renderWithProviders(<LaunchpadSettings value={launchpadConfigSchema.parse(config)} onChange={onChange} />, {
    apiMocks: { 'GET /api/bookmarks': { groups } },
  });
  return { onChange, user: userEvent.setup() };
}

describe('Launch pad settings', () => {
  it('reorders the chosen groups (Finance next to Bookmarks)', async () => {
    const { onChange, user } = renderSettings({ groupIds: ['g1', 'g2', 'g3'] });
    await user.click(await screen.findByRole('button', { name: 'Move Finance up' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupIds: ['g1', 'g3', 'g2'] }));
  });

  it('adds a newly ticked group at the end of this launch pad’s order', async () => {
    const { onChange, user } = renderSettings({ groupIds: ['g3'] });
    await user.click(await screen.findByRole('checkbox', { name: /Bookmarks/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupIds: ['g3', 'g1'] }));
  });

  it('sets a group’s width when the groups sit side by side in fixed columns', async () => {
    const { onChange, user } = renderSettings({ groupLayout: 'columns', groupColumns: 3 });
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Width of Bookmarks' }), '2');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupSpans: { g1: 2 } }));
  });

  it('offers the list display options and keeps at least one part of a row visible', async () => {
    const { onChange, user } = renderSettings({ style: 'list', listDetail: 'none', listIcons: false });
    const name = await screen.findByRole('switch', { name: /Show page name/ });
    expect(name).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Full URL' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ listDetail: 'url' }));
  });
});
