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
