/**
 * The background prepare step with the browser's image APIs replaced by fakes (jsdom has neither
 * createImageBitmap nor OffscreenCanvas): what is decoded, the size it is drawn at, how it is
 * encoded, and every case in which the original goes up instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImagePrepareError, MAX_UPLOAD_BYTES } from '../api/uploads.ts';
import { IMAGE_SAMPLES } from '../static/lib/__fixtures__/images.ts';
import { avif, fileOf, gif, jpeg, latin1, png, svg, webp } from './__fixtures__/images.ts';
import { BACKGROUND_WEBP_QUALITY, prepareBackgroundImage } from './prepareBackground.ts';

/** Targets (backgroundTargetEdge) of a 4K screen at 150 % and of a 1080p screen. */
const TARGET_4K = 3840;
const TARGET_1080 = 2560;

interface FakeCanvas {
  width: number;
  height: number;
  draws: unknown[][];
  smoothing: string;
  encodes: { type?: string; quality?: number }[];
}

let canvases: FakeCanvas[];
/** What convertToBlob answers for a requested type. */
let encode: (type: string | undefined) => Blob;

function stubCanvas(): void {
  canvases = [];
  encode = (type) => new Blob([new Uint8Array(1000)], { type: type ?? 'image/png' });
  class OffscreenCanvasFake {
    readonly state: FakeCanvas;
    constructor(width: number, height: number) {
      this.state = { width, height, draws: [], smoothing: 'low', encodes: [] };
      canvases.push(this.state);
    }
    getContext() {
      const state = this.state;
      return {
        imageSmoothingEnabled: false,
        set imageSmoothingQuality(value: string) {
          state.smoothing = value;
        },
        drawImage: (...args: unknown[]) => state.draws.push(args),
      };
    }
    async convertToBlob(options?: { type?: string; quality?: number }) {
      this.state.encodes.push({ ...options });
      return encode(options?.type);
    }
  }
  vi.stubGlobal('OffscreenCanvas', OffscreenCanvasFake);
}

function stubBitmap(width: number, height: number) {
  const close = vi.fn();
  const create = vi.fn(async (_source: Blob) => ({ width, height, close }));
  vi.stubGlobal('createImageBitmap', create);
  return { create, close };
}

beforeEach(stubCanvas);

describe('prepareBackgroundImage', () => {
  it('keeps a still photo that fits the screen without decoding it', async () => {
    const { create } = stubBitmap(2000, 1000);
    for (const bytes of [jpeg(2560, 1440), png(1920, 1080), webp(2400, 1600), gif(1), avif([[2000, 1000]])]) {
      const file = fileOf(bytes, 'photo');
      expect(await prepareBackgroundImage(file, TARGET_1080)).toBe(file);
    }
    expect(create).not.toHaveBeenCalled();
    expect(canvases).toHaveLength(0);
  });

  it('scales a large photo to the screen long edge (4K at 150 %: 3840) and encodes WebP at 0.85', async () => {
    const { create, close } = stubBitmap(6000, 4000);
    const file = fileOf(jpeg(6000, 4000), 'holiday.photo.jpg', 'image/jpeg');
    const prepared = await prepareBackgroundImage(file, TARGET_4K);

    expect(create).toHaveBeenCalledWith(file);
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({ width: 3840, height: 2560, smoothing: 'high' });
    expect(canvases[0]!.draws[0]!.slice(1)).toEqual([0, 0, 3840, 2560]);
    expect(canvases[0]!.encodes).toEqual([{ type: 'image/webp', quality: BACKGROUND_WEBP_QUALITY }]);
    expect(close).toHaveBeenCalledOnce();
    expect(prepared).not.toBe(file);
    expect(prepared.name).toBe('holiday.photo.webp');
    expect(prepared.type).toBe('image/webp');
  });

  it('uses a smaller target as it is, and the decoded (EXIF-turned) shape', async () => {
    // The header says landscape; the decoder applied the orientation and answers portrait.
    stubBitmap(4000, 6000);
    await prepareBackgroundImage(fileOf(jpeg(6000, 4000), 'phone.jpg'), TARGET_1080);
    expect(canvases[0]).toMatchObject({ width: 1707, height: 2560 });
  });

  it('turns an animated image into its first frame at its own size', async () => {
    const { create } = stubBitmap(800, 600);
    const prepared = await prepareBackgroundImage(fileOf(gif(5), 'loop.gif'), TARGET_4K);
    expect(create).toHaveBeenCalledOnce();
    expect(canvases[0]).toMatchObject({ width: 800, height: 600 });
    expect(prepared.name).toBe('loop.webp');

    stubBitmap(6000, 3000);
    await prepareBackgroundImage(fileOf(webp(6000, 3000, 3), 'big.webp'), TARGET_4K);
    expect(canvases[1]).toMatchObject({ width: 3840, height: 1920 });
  });

  it('decodes an AVIF without a readable size and keeps it when it fits', async () => {
    const { create, close } = stubBitmap(1600, 900);
    const file = fileOf(IMAGE_SAMPLES.avif, 'still.avif');
    expect(await prepareBackgroundImage(file, TARGET_1080)).toBe(file);
    expect(create).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(canvases).toHaveLength(0);
  });

  it('falls back to PNG where the browser cannot encode WebP', async () => {
    stubBitmap(5000, 2500);
    encode = (type) => new Blob([new Uint8Array(10)], { type: type === 'image/png' ? 'image/png' : 'image/bmp' });
    const prepared = await prepareBackgroundImage(fileOf(png(5000, 2500), 'scan.png'), TARGET_1080);
    expect(canvases[0]!.encodes.map((e) => e.type)).toEqual(['image/webp', 'image/png']);
    expect(prepared.type).toBe('image/png');
    expect(prepared.name).toBe('scan.png');
  });

  it('keeps the original when the copy is over the upload limit or cannot be read back', async () => {
    stubBitmap(6000, 4000);
    const file = fileOf(jpeg(6000, 4000), 'photo.jpg');
    encode = () => new Blob([new Uint8Array(MAX_UPLOAD_BYTES + 1)], { type: 'image/webp' });
    expect(await prepareBackgroundImage(file, TARGET_4K)).toBe(file);
    encode = () => {
      throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
    };
    expect(await prepareBackgroundImage(file, TARGET_4K)).toBe(file);
  });

  it('keeps the original when the browser lacks the APIs', async () => {
    const file = fileOf(jpeg(6000, 4000), 'photo.jpg');
    vi.stubGlobal('createImageBitmap', undefined);
    expect(await prepareBackgroundImage(file, TARGET_4K)).toBe(file);
    stubBitmap(6000, 4000);
    vi.stubGlobal('OffscreenCanvas', undefined);
    expect(await prepareBackgroundImage(file, TARGET_4K)).toBe(file);
  });

  it('refuses a file the browser cannot decode', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
      }),
    );
    await expect(prepareBackgroundImage(fileOf(jpeg(6000, 4000), 'broken.jpg'), TARGET_4K)).rejects.toBeInstanceOf(ImagePrepareError);
  });

  it('leaves bytes that are no accepted image to the server', async () => {
    const { create } = stubBitmap(10, 10);
    const file = fileOf(latin1('%PDF-1.7'), 'document.png', 'image/png');
    expect(await prepareBackgroundImage(file, TARGET_4K)).toBe(file);
    expect(create).not.toHaveBeenCalled();
  });

  describe('SVG', () => {
    let images: { src: string; decoding: string }[];
    let revoked: string[];
    let objectUrlTypes: string[];
    const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };

    function stubImage(naturalWidth: number, naturalHeight: number, fails = false): void {
      images = [];
      vi.stubGlobal(
        'Image',
        class {
          src = '';
          decoding = '';
          naturalWidth = naturalWidth;
          naturalHeight = naturalHeight;
          constructor() {
            images.push(this);
          }
          async decode() {
            if (fails) throw new DOMException('The source image cannot be decoded.', 'EncodingError');
          }
        },
      );
    }

    beforeEach(() => {
      revoked = [];
      objectUrlTypes = [];
      URL.createObjectURL = vi.fn((blob: Blob) => {
        objectUrlTypes.push(blob.type);
        return 'blob:http://localhost/drawing';
      });
      URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
    });
    afterEach(() => {
      URL.createObjectURL = saved.create;
      URL.revokeObjectURL = saved.revoke;
    });

    it('is drawn from an <img> at the target size, never through createImageBitmap', async () => {
      stubImage(40, 30);
      const { create } = stubBitmap(1, 1);
      // A dropped file may come without a type; the browser reads a blob: URL as SVG only with one.
      const prepared = await prepareBackgroundImage(fileOf(svg(), 'waves.svg', ''), TARGET_4K);
      expect(create).not.toHaveBeenCalled();
      expect(objectUrlTypes).toEqual(['image/svg+xml']);
      expect(images[0]).toMatchObject({ src: 'blob:http://localhost/drawing', decoding: 'async' });
      expect(canvases[0]).toMatchObject({ width: 3840, height: 2880 });
      expect(canvases[0]!.draws[0]![0]).toBe(images[0]);
      expect(revoked).toEqual(['blob:http://localhost/drawing']);
      expect(prepared.name).toBe('waves.webp');
    });

    it('without a size of its own it is drawn 16:9', async () => {
      stubImage(0, 0);
      await prepareBackgroundImage(fileOf(svg('viewBox="0 0 4 3"'), 'pattern.svg'), TARGET_1080);
      expect(canvases[0]).toMatchObject({ width: 2560, height: 1440 });
    });

    it('one the browser cannot read is refused, and one it will not read back goes up as it is', async () => {
      stubImage(40, 30, true);
      await expect(prepareBackgroundImage(fileOf(svg(), 'bad.svg'), TARGET_4K)).rejects.toBeInstanceOf(ImagePrepareError);
      expect(revoked).toEqual(['blob:http://localhost/drawing']);

      stubImage(40, 30);
      encode = () => {
        throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
      };
      const file = fileOf(svg(), 'tainted.svg');
      expect(await prepareBackgroundImage(file, TARGET_4K)).toBe(file);
    });
  });
});
