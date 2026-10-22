import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ShortcutList } from './ShortcutsDialog.tsx';

describe('shortcut help (UX-12)', () => {
  it('also documents the search box keys', () => {
    render(<ShortcutList />);
    const search = screen.getByLabelText('In the search box');
    expect(within(search).getByText(/Switch to the engine with that keyword/)).toBeInTheDocument();
    expect(within(search).getByText(/back to the default engine/)).toBeInTheDocument();
    expect(within(search).getByText(/Open in a new tab/)).toBeInTheDocument();
    expect(screen.getByLabelText('Anywhere')).toHaveTextContent('Focus the search box');
  });
});

describe('shortcut help: launch pad tile menu (roadmap 1.10)', () => {
  it('lists the launch pad tile menu key (Shift+F10, the context-menu key too)', () => {
    render(<ShortcutList />);
    const tile = screen.getByLabelText('On a launch pad tile');
    expect(within(tile).getByText('Shift')).toBeInTheDocument();
    expect(within(tile).getByText('F10')).toBeInTheDocument();
    expect(within(tile).getByText(/Open its menu: Edit, Move to, Delete/)).toHaveTextContent('context-menu key');
  });
});
