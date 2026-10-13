/**
 * ImageUpload's preview through `useAssetUrl`: `/api/uploads/<id>` in the server build; on the
 * Pages build's server backend (hybrid mode) the empty drop zone until the Homebase server on this
 * PC has delivered the image, then the loaded URL; a preview that fails to load gives way to the
 * drop zone until the URL changes.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { uploadUrl } from '@homebase/shared';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { setServerAssetSource } from '../static/assets.ts';
import { manualAssetSource } from '../test/hybrid.ts';
import { ImageUpload } from './ImageUpload.tsx';

const UPLOAD_A = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b';
const UPLOAD_B = '2c5f39cb-3fb2-4e4c-b4f6-f02ac6b8744c';

afterEach(() => setServerAssetSource(null));

function preview(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector('img');
}

describe('ImageUpload preview', () => {
  it('server build: the upload URL itself, with the prompt over the image', () => {
    const { container } = render(<ImageUpload value={UPLOAD_A} onChange={() => {}} aria-label="Background image" />);
    expect(preview(container)).toHaveAttribute('src', uploadUrl(UPLOAD_A));
    expect(screen.getByText('Replace image').parentElement).toHaveAttribute('data-over-image', 'true');
  });

  it('Pages build on the Homebase server: the drop zone until the image is loaded, then the loaded URL', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const fake = manualAssetSource();
    setServerAssetSource(fake.source);
    const { container } = render(<ImageUpload value={UPLOAD_A} onChange={() => {}} aria-label="Background image" />);
    expect(preview(container)).toBeNull();
    // The prompt is shown on the plain zone, not hidden over a (missing) image.
    expect(screen.getByText('Replace image').parentElement).not.toHaveAttribute('data-over-image');
    expect(fake.load).toHaveBeenCalledWith(uploadUrl(UPLOAD_A));

    act(() => fake.finish(uploadUrl(UPLOAD_A), 'blob:http://pages.example/a'));
    expect(preview(container)).toHaveAttribute('src', 'blob:http://pages.example/a');
    expect(screen.getByText('Replace image').parentElement).toHaveAttribute('data-over-image', 'true');
    expect(container.innerHTML).not.toContain('/api/uploads/');
  });

  it('a preview that fails to load gives way to the drop zone until the URL changes', () => {
    const { container, rerender } = render(<ImageUpload value={UPLOAD_A} onChange={() => {}} aria-label="Background image" />);
    fireEvent.error(preview(container)!);
    expect(preview(container)).toBeNull();
    rerender(<ImageUpload value={UPLOAD_B} onChange={() => {}} aria-label="Background image" />);
    expect(preview(container)).toHaveAttribute('src', uploadUrl(UPLOAD_B));
    rerender(<ImageUpload value={UPLOAD_A} onChange={() => {}} aria-label="Background image" />);
    expect(preview(container)).toHaveAttribute('src', uploadUrl(UPLOAD_A));
  });
});
