import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { APP_UPDATED, Footer, formatUpdated } from './Footer.tsx';

describe('Footer', () => {
  it('shows the version and the date it was last updated', () => {
    render(<Footer version="1.2.3" updated="2026-10-11" onShowShortcuts={() => {}} />);
    expect(screen.getByText('Version 1.2.3')).toBeInTheDocument();
    const time = screen.getByText('Oct 11, 2026');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', '2026-10-11');
    expect(screen.getByText('© 2026 Portly')).toBeInTheDocument();
  });

  it('defaults to the build-time timestamp, with the time of day', () => {
    render(<Footer version="1.2.3" onShowShortcuts={() => {}} />);
    expect(APP_UPDATED).toBe('2026-01-15T14:30:00Z');
    const time = screen.getByText(formatUpdated(APP_UPDATED));
    expect(time).toHaveAttribute('datetime', APP_UPDATED);
    expect(time.textContent).toMatch(/^Jan 1[45], 2026, \d{1,2}:\d{2} [AP]M$/);
  });

  it('links to app routes and opens public pages in a new tab', () => {
    render(<Footer version="1.2.3" onShowShortcuts={() => {}} />);
    const nav = screen.getByRole('navigation', { name: 'Footer' });
    expect(nav).toContainElement(screen.getByRole('link', { name: 'Settings' }));
    expect(screen.getByRole('link', { name: 'About' })).toHaveAttribute('href', '#/settings/about');
    const privacy = screen.getByRole('link', { name: 'Privacy' });
    expect(privacy).toHaveAttribute('href', 'https://davideaurum.github.io/portly-site/privacy.html');
    expect(privacy).toHaveAttribute('target', '_blank');
    expect(privacy).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('opens the shortcut help', async () => {
    const onShowShortcuts = vi.fn();
    render(<Footer version="1.2.3" onShowShortcuts={onShowShortcuts} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Shortcuts' }));
    expect(onShowShortcuts).toHaveBeenCalledOnce();
  });

  it('ends the version line with the serverStatus slot, and has no slot without it', () => {
    const { rerender, container } = render(
      <Footer version="1.2.3" onShowShortcuts={() => {}} serverStatus={<button type="button">Connected</button>} />,
    );
    const status = screen.getByRole('button', { name: 'Connected' });
    const slot = status.parentElement!;
    // The slot is the meta line's last item; its separator is CSS (hidden when the slot is empty).
    expect(slot.parentElement!.lastElementChild).toBe(slot);
    expect(slot.parentElement).toHaveTextContent('Version 1.2.3');
    rerender(<Footer version="1.2.3" onShowShortcuts={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Connected' })).not.toBeInTheDocument();
    expect(container.querySelector('time')!.parentElement!.nextElementSibling).toBeNull();
  });

  it('formats timestamps with a 3-letter month and the time in the given zone', () => {
    expect(formatUpdated('2026-10-11T08:12:34-05:00', 'America/Chicago')).toBe('Oct 11, 2026, 8:12 AM');
    expect(formatUpdated('2026-10-11T08:12:34-05:00', 'UTC')).toBe('Oct 11, 2026, 1:12 PM');
    expect(formatUpdated('2026-12-31T23:30:00Z', 'Europe/Berlin')).toBe('Jan 1, 2027, 12:30 AM');
  });

  it('formats calendar dates without a time zone shift', () => {
    expect(formatUpdated('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatUpdated('not-a-date')).toBe('not-a-date');
    expect(formatUpdated('2026-13-45T99:00:00Z')).toBe('2026-13-45T99:00:00Z');
  });
});
