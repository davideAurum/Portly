import { afterEach, describe, expect, it, vi } from 'vitest';
import { bakeBlurredBackdrop, bakePlan } from './backdropBake.ts';

const SCREEN = { width: 2560, height: 1440, devicePixelRatio: 1.5 };

class FakeImage {
  static fail = false;
  naturalWidth = 2560;
  naturalHeight = 1600;
  decoding = '';
  src = '';
  decode(): Promise<void> {
    return FakeImage.fail ? Promise.reject(new DOMException('cannot decode', 'EncodingError')) : Promise.resolve();
  }
}

/** A 2D context whose `filter` either works or, like a browser without canvas filters, ignores writes. */
function fakeContext(filterWorks: boolean) {
  let filter = 'none';
  const draws: { filter: string; quality: string; args: unknown[] }[] = [];
  const ctx = {
    get filter() {
      return filter;
    },
    set filter(value: string) {
      if (filterWorks) filter = value;
    },
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    drawImage(...args: unknown[]) {
      draws.push({ filter, quality: ctx.imageSmoothingQuality, args });
    },
  };
  return { ctx, draws };
}

function stubOffscreen(filterWorks: boolean) {
  const context = fakeContext(filterWorks);
  const sizes: [number, number][] = [];
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(width: number, height: number) {
        sizes.push([width, height]);
      }
      getContext() {
        return context.ctx;
      }
      convertToBlob(options: { type: string }) {
        return Promise.resolve(new Blob(['x'], { type: options.type }));
      }
    },
  );
  return { ...context, sizes };
}

function stubDocumentCanvas(filterWorks: boolean) {
  const context = fakeContext(filterWorks);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context.ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => callback(new Blob(['x'], { type })));
  return context;
}

describe('bakeBlurredBackdrop', () => {
  afterEach(() => {
    FakeImage.fail = false;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('draws the photo blurred, enlarged and centered on a small canvas, saved as PNG', async () => {
    vi.stubGlobal('Image', FakeImage);
    const offscreen = stubOffscreen(true);
    const blob = await bakeBlurredBackdrop('blob:http://localhost/photo', 20, SCREEN);
    expect(blob?.type).toBe('image/png');
    expect(offscreen.sizes).toEqual([[512, 320]]);
    expect(offscreen.draws).toHaveLength(1);
    const draw = offscreen.draws[0]!;
    expect(draw.filter).toBe('blur(4.00px)');
    expect(draw.quality).toBe('high');
    // 512x320 enlarged by 1.03125 and centered.
    expect(draw.args.slice(1)).toEqual([-8, -5, 528, 330]);
  });

  it('saves a large copy (light blur) as WebP', async () => {
    vi.stubGlobal('Image', FakeImage);
    stubOffscreen(true);
    const blob = await bakeBlurredBackdrop('blob:http://localhost/photo', 1, SCREEN);
    expect(blob?.type).toBe('image/webp');
  });

  it('tries the other kind of canvas when one cannot blur, and gives up (null) when neither can', async () => {
    vi.stubGlobal('Image', FakeImage);
    stubOffscreen(false);
    const page = stubDocumentCanvas(true);
    expect((await bakeBlurredBackdrop('blob:http://localhost/photo', 20, SCREEN))?.type).toBe('image/png');
    expect(page.draws[0]?.filter).toBe('blur(4.00px)');

    vi.restoreAllMocks();
    stubDocumentCanvas(false);
    expect(await bakeBlurredBackdrop('blob:http://localhost/photo', 20, SCREEN)).toBeNull();
  });

  it('has nothing to bake without a blur, and rejects when the image does not decode', async () => {
    vi.stubGlobal('Image', FakeImage);
    stubOffscreen(true);
    expect(await bakeBlurredBackdrop('blob:http://localhost/photo', 0, SCREEN)).toBeNull();
    FakeImage.fail = true;
    await expect(bakeBlurredBackdrop('blob:http://localhost/photo', 20, SCREEN)).rejects.toThrow('cannot decode');
  });
});

describe('bakePlan', () => {
  it('has nothing to bake without a blur or a size', () => {
    const viewport = { width: 1920, height: 1080, devicePixelRatio: 1 };
    expect(bakePlan({ width: 2560, height: 1600 }, 0, viewport)).toBeNull();
    expect(bakePlan({ width: 0, height: 1600 }, 10, viewport)).toBeNull();
    expect(bakePlan({ width: 2560, height: 1600 }, 10, { ...viewport, width: 0 })).toBeNull();
  });

  it('draws a strong blur at a fraction of the screen and converts the radius to canvas pixels', () => {
    // 4K at 150% scaling: the photo is drawn 1:1 in CSS px (cover), 1.5 device px per CSS px.
    const plan = bakePlan({ width: 2560, height: 1600 }, 20, { width: 2560, height: 1440, devicePixelRatio: 1.5 });
    // 4 samples per sigma of 30 device px → 0.133 canvas px per device px → 0.2 per image px.
    // The zoom matches the live filter's layer, 2 × 20 px larger on each side: 2640 / 2560.
    expect(plan).toEqual({ width: 512, height: 320, sigma: 4, zoom: 1.03125 });
  });

  it('keeps at least a 2-sigma margin of photo beyond every visible edge', () => {
    for (const viewport of [
      { width: 2560, height: 1440, devicePixelRatio: 1.5 },
      { width: 1200, height: 1900, devicePixelRatio: 1 },
      { width: 3000, height: 800, devicePixelRatio: 2 },
    ]) {
      const image = { width: 2560, height: 1600 };
      const plan = bakePlan(image, 12, viewport)!;
      const cover = Math.max(viewport.width / image.width, viewport.height / image.height);
      // Shown size of the canvas in CSS px, and how far the zoomed photo reaches past the viewport.
      const shownWidth = image.width * cover;
      const shownHeight = image.height * cover;
      const marginX = (shownWidth * plan.zoom - viewport.width) / 2;
      const marginY = (shownHeight * plan.zoom - viewport.height) / 2;
      expect(Math.min(marginX, marginY)).toBeGreaterThanOrEqual(2 * 12 - 1e-9);
    }
  });

  it('never upscales the photo, and keeps a light blur at full detail', () => {
    const plan = bakePlan({ width: 2560, height: 1600 }, 1, { width: 2560, height: 1440, devicePixelRatio: 1.5 });
    expect(plan?.width).toBe(2560);
    expect(plan?.height).toBe(1600);
    expect(plan?.sigma).toBe(1);
  });

  it('scales a huge photo down to what the screen shows, keeping the blur radius on screen', () => {
    // An 8000x6000 photo covering 1920x1080 is drawn at 0.24 CSS px per image px.
    const plan = bakePlan({ width: 8000, height: 6000 }, 2, { width: 1920, height: 1080, devicePixelRatio: 1 });
    expect(plan?.width).toBe(1920);
    expect(plan?.height).toBe(1440);
    // 2 CSS px on screen = 2 canvas px, because the canvas is drawn 1:1 with the screen.
    expect(plan?.sigma).toBeCloseTo(2, 10);
  });

  it('caps the canvas size', () => {
    const plan = bakePlan({ width: 20_000, height: 10_000 }, 1, { width: 7680, height: 4320, devicePixelRatio: 2 });
    expect(Math.max(plan?.width ?? 0, plan?.height ?? 0)).toBeLessThanOrEqual(4096);
  });
});
