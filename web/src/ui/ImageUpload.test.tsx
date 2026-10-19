/**
 * ImageUpload's preview through `useAssetUrl`: `/api/uploads/<id>` in the server build; on the
 * Pages build's server backend (hybrid mode) the empty drop zone until the Portly server on this
 * PC has delivered the image, then the loaded URL; a preview that fails to load gives way to the
 * drop zone until the URL changes. With `prepare`, the chosen file is turned into the uploaded one
 * first ("Preparing…", then "Uploading…").
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadUrl } from '@portly/shared';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { setServerAssetSource } from '../static/assets.ts';
import { manualAssetSource } from '../test/hybrid.ts';
import { stubApi, type MockRequest } from '../test/render.tsx';
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

  it('Pages build on the Portly server: the drop zone until the image is loaded, then the loaded URL', () => {
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

describe('ImageUpload prepare', () => {
  it('uploads what prepare returns, saying what it is doing meanwhile', async () => {
    let finish: (file: File) => void = () => {};
    const prepare = vi.fn((_file: File) => new Promise<File>((resolve) => (finish = resolve)));
    let answer: (value: unknown) => void = () => {};
    const uploads: File[] = [];
    stubApi({
      'POST /api/uploads': (req: MockRequest) => {
        uploads.push((req.body as FormData).get('file') as File);
        return new Promise((resolve) => (answer = resolve));
      },
    });
    const onChange = vi.fn();
    const { container } = render(<ImageUpload value={null} onChange={onChange} prepare={prepare} aria-label="Background image" />);
    const chosen = new File(['original'], 'photo.jpg', { type: 'image/jpeg' });
    await userEvent.setup().upload(container.querySelector<HTMLInputElement>('input[type="file"]')!, chosen);

    expect(prepare).toHaveBeenCalledWith(chosen);
    expect(screen.getByText('Preparing…')).toBeInTheDocument();
    act(() => finish(new File(['copy'], 'photo.webp', { type: 'image/webp' })));
    expect(await screen.findByText('Uploading…')).toBeInTheDocument();
    act(() => answer({ id: UPLOAD_A, url: uploadUrl(UPLOAD_A) }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(UPLOAD_A));
    expect(uploads.map((file) => file.name)).toEqual(['photo.webp']);
  });
});
