import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandLockup, BrandMark } from './BrandMark.tsx';
import { EmptyState } from './EmptyState.tsx';

describe('BrandMark', () => {
  it('is decorative by default and named when given a label', () => {
    const { container } = render(<BrandMark />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    render(<BrandMark label="Portly" />);
    expect(screen.getByRole('img', { name: 'Portly' })).toBeTruthy();
  });

  it('uses the simplified drawing below 48 px and the full one from 48 px', () => {
    const { container } = render(
      <>
        <BrandMark size={36} />
        <BrandMark size={48} />
      </>,
    );
    const [small, full] = [...container.querySelectorAll('svg')];
    expect(small?.dataset.variant).toBe('small');
    expect(small?.getAttribute('width')).toBe('36');
    expect(full?.dataset.variant).toBe('full');
    expect(full!.querySelectorAll('*').length).toBeGreaterThan(small!.querySelectorAll('*').length);
  });

  it('lockup shows the lowercase wordmark, hidden from assistive tech', () => {
    const { container } = render(<BrandLockup />);
    expect(container.textContent).toBe('portly');
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('EmptyState media', () => {
  it('shows media instead of the icon, and drops it in compact layouts', () => {
    const { container, rerender } = render(<EmptyState media={<BrandMark size={64} />} title="Nothing here" />);
    expect(container.querySelector('svg[data-variant="full"]')).not.toBeNull();
    rerender(<EmptyState media={<BrandMark size={64} />} title="Nothing here" compact />);
    expect(container.querySelector('svg')).toBeNull();
  });
});
