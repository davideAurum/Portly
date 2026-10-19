/**
 * The Appearance background image: the browser prepares the chosen file before the upload (a
 * screen-sized still copy, `theme/prepareBackground.ts`), and a stored background that would gain
 * from it gets an "Optimize image" offer. jsdom has no createImageBitmap / OffscreenCanvas, so
 * they are faked; jsdom's screen is 0 x 0, which makes the target long edge the 2560 minimum.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { uploadUrl } from '@portly/shared';
import { qk } from '../../api/keys.ts';
import AppearanceSettings from '../../settings/sections/Appearance.tsx';
import { fileOf, gif, jpeg, png } from '../../theme/__fixtures__/images.ts';
import { useApplyTheme } from '../../theme/useTheme.ts';
import { createFakeServer, type FakeServer } from '../fakeServer.ts';
import { renderWithProviders, type MockRequest } from '../render.tsx';

const STORED = '8f654906-1111-4111-8111-111111111111';
const UPLOADED = '9a765a17-2222-4222-8222-222222222222';
/** What the fake canvas encodes: a tiny WebP. */
const COPY = new Uint8Array([...new TextEncoder().encode('RIFF'), 4, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8 ')]);

function WithTheme() {
  useApplyTheme();
  return <AppearanceSettings />;
}

/** Fakes the decoder (every image decodes to `width` x `height`) and the canvas (encodes {@link COPY}). */
function stubImageApis(width: number, height: number) {
  const create = vi.fn(async () => ({ width, height, close: () => {} }));
  const canvases: { width: number; height: number }[] = [];
  vi.stubGlobal('createImageBitmap', create);
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(w: number, h: number) {
        canvases.push({ width: w, height: h });
      }
      getContext() {
        return { drawImage: () => {} };
      }
      async convertToBlob(options?: { type?: string }) {
        return new Blob([COPY], { type: options?.type ?? 'image/png' });
      }
    },
  );
  return { create, canvases };
}

/** Serves stored uploads (`bytes` by id) and stores new ones under {@link UPLOADED}. */
function withUploads(server: FakeServer, bytes: Record<string, Uint8Array>) {
  const uploads: File[] = [];
  server.mocks['GET /api/uploads/:id'] = (req: MockRequest) => {
    const stored = bytes[req.params.id ?? ''];
    return stored ? new Response(new Uint8Array(stored), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }) : undefined;
  };
  server.mocks['POST /api/uploads'] = (req: MockRequest) => {
    const file = (req.body as FormData).get('file') as File;
    uploads.push(file);
    bytes[UPLOADED] = COPY;
    return { id: UPLOADED, url: uploadUrl(UPLOADED) };
  };
  return uploads;
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  return input!;
}

describe('Appearance background upload', () => {
  it('uploads a screen-sized WebP copy of a large photo instead of the photo', async () => {
    const server = createFakeServer([]);
    const uploads = withUploads(server, {});
    const { canvases } = stubImageApis(6000, 4000);
    const { container, requestsTo } = renderWithProviders(<WithTheme />, { apiMocks: server.mocks });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Image' }));
    expect(screen.getByText(/Big photos are scaled to fit your screen, and an animated image keeps its first frame/)).toBeInTheDocument();

    await user.upload(fileInput(container), fileOf(jpeg(6000, 4000), 'beach.jpg', 'image/jpeg'));

    await waitFor(() => expect(server.settings.appearance.background).toEqual({ type: 'image', uploadId: UPLOADED, blur: 0, dim: 0.2 }));
    expect(canvases).toEqual([{ width: 2560, height: 1707 }]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.name).toBe('beach.webp');
    expect(uploads[0]!.type).toBe('image/webp');
    expect(new Uint8Array(await uploads[0]!.arrayBuffer())).toEqual(COPY);
    // The copy needs nothing more: no offer to optimize it.
    await waitFor(() => expect(requestsTo('GET /api/uploads/' + UPLOADED)).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Optimize image' })).toBeNull();
  });

  it('takes a photo up to 25 MB before preparing it, and needs the copy to fit 10 MB', async () => {
    const server = createFakeServer([]);
    const uploads = withUploads(server, {});
    const { container } = renderWithProviders(<WithTheme />, { apiMocks: server.mocks });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Image' }));

    await user.upload(fileInput(container), new File([new Uint8Array(26 * 1024 * 1024)], 'huge.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Images must be 25 MB or smaller.');

    // Without the browser APIs the photo itself would go up, and it is too large for that.
    const large = new File([new Uint8Array(jpeg(6000, 4000)), new Uint8Array(12 * 1024 * 1024)], 'large.jpg', { type: 'image/jpeg' });
    await user.upload(fileInput(container), large);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Images must be 10 MB or smaller.'));
    expect(uploads).toHaveLength(0);
  });

  it('refuses an image the browser cannot open, with a message that says what to do', async () => {
    const server = createFakeServer([]);
    const uploads = withUploads(server, {});
    stubImageApis(1, 1);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
      }),
    );
    const { container } = renderWithProviders(<WithTheme />, { apiMocks: server.mocks });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Image' }));
    await user.upload(fileInput(container), fileOf(jpeg(6000, 4000), 'broken.jpg', 'image/jpeg'));
    expect(await screen.findByRole('alert')).toHaveTextContent('This image could not be opened. Try saving it as a JPEG or PNG first.');
    expect(uploads).toHaveLength(0);
  });
});

describe('Optimize current background', () => {
  function storedBackground(bytes: Uint8Array) {
    const server = createFakeServer([]);
    server.settings.appearance.background = { type: 'image', uploadId: STORED, blur: 6, dim: 0.35 };
    const uploads = withUploads(server, { [STORED]: bytes });
    return { server, uploads };
  }

  it('offers a 3840-pixel copy of a photo larger than any screen needs, and switches to it', async () => {
    const { server, uploads } = storedBackground(jpeg(6000, 4000));
    // Whatever this screen is (jsdom's makes the upload target 2560), the copy suits a 4K one.
    const { canvases } = stubImageApis(6000, 4000);
    const { requestsTo } = renderWithProviders(<WithTheme />, { apiMocks: server.mocks });
    const user = userEvent.setup();

    expect(await screen.findByText('This photo is larger than any screen needs')).toBeInTheDocument();
    expect(screen.getByText(/Its long side is 6.000 pixels; even a 4K screen shows 3.840/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Optimize image' }));

    // Blur and dim stay; only the image changes.
    await waitFor(() => expect(server.settings.appearance.background).toEqual({ type: 'image', uploadId: UPLOADED, blur: 6, dim: 0.35 }));
    expect(canvases).toEqual([{ width: 3840, height: 2560 }]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.type).toBe('image/webp');
    expect(await screen.findByText('Background optimized')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('This photo is larger than any screen needs')).toBeNull());
    expect(requestsTo('GET /api/uploads/' + UPLOADED)).toHaveLength(1);
  });

  it('offers to keep the first frame of an animated background', async () => {
    const { server } = storedBackground(gif(3));
    renderWithProviders(<WithTheme />, { apiMocks: server.mocks });
    expect(await screen.findByText('This background is animated')).toBeInTheDocument();
    expect(screen.getByText(/Optimizing keeps the first frame as a still picture/)).toBeInTheDocument();
  });

  it('says so when this browser cannot make the copy', async () => {
    const { server, uploads } = storedBackground(gif(3));
    renderWithProviders(<WithTheme />, { apiMocks: server.mocks });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Optimize image' }));
    expect(await screen.findByText('This browser could not make a lighter copy of the background.')).toBeInTheDocument();
    expect(uploads).toHaveLength(0);
    expect(server.settings.appearance.background).toMatchObject({ uploadId: STORED });
  });

  it('offers nothing for a still background up to 3840 pixels', async () => {
    const { server } = storedBackground(png(3840, 2160));
    const { queryClient } = renderWithProviders(<WithTheme />, { apiMocks: server.mocks });
    await waitFor(() => expect(queryClient.getQueryState(qk.uploads.backgroundCheck(STORED))?.status).toBe('success'));
    expect(screen.getByText('Background image')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Optimize image' })).toBeNull();
  });
});
