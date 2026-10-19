/**
 * Bakes a photo background's blur into a small copy of the image once (§7a Theme), so the page
 * shows an already-blurred picture instead of a live CSS `filter: blur()` over the whole window.
 * The GPU redoes a live filter whenever that layer is drawn again (scrolling, repaints of the
 * glass above it), always at full screen resolution. A blurred image has no fine detail, so the
 * baked copy is drawn at a fraction of the screen's device pixels and scaled up by the browser:
 * after one short bake it costs nothing.
 *
 * The blur radius is in CSS pixels of the page, so it depends on how large the photo is drawn
 * (`background-size: cover` over the viewport). {@link bakePlan} converts it for a viewport;
 * `useBakedBackdrop` bakes again when the window size changes a lot. When a browser cannot blur on
 * a canvas (no `CanvasRenderingContext2D.filter`) {@link bakeBlurredBackdrop} returns null and the
 * page keeps the live filter. An animated image bakes its first frame, so a blurred animated
 * background stops moving once the copy is ready (it no longer redraws the window every frame).
 */

export interface BakeViewport {
  /** CSS pixels. */
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface BakePlan {
  /** Canvas size in pixels. */
  width: number;
  height: number;
  /** Gaussian standard deviation in canvas pixels (what CSS `blur(r)` means by r). */
  sigma: number;
  /** The photo is drawn this much larger than the canvas, centered, so the edges blur over photo. */
  zoom: number;
}

/** Canvas samples per blur sigma (in device pixels): more would add nothing visible. */
const SAMPLES_PER_SIGMA = 4;
/** Longest canvas edge, whatever the photo and screen. */
const MAX_CANVAS_EDGE = 4096;
/**
 * Up to this many canvas pixels the copy is saved as lossless PNG: a small copy is scaled up a lot,
 * which would magnify lossy compression blocks. Larger copies (light blurs) are barely scaled up,
 * so WebP keeps them small and quick to encode.
 */
const MAX_PNG_PIXELS = 1_500_000;

/**
 * Canvas size and blur for drawing `image` (natural size) blurred by `blur` CSS px as the cover
 * background of `viewport`. Null when there is nothing to bake.
 */
export function bakePlan(image: { width: number; height: number }, blur: number, viewport: BakeViewport): BakePlan | null {
  if (!(blur > 0) || !(image.width > 0) || !(image.height > 0) || !(viewport.width > 0) || !(viewport.height > 0)) return null;
  const dpr = viewport.devicePixelRatio > 0 ? viewport.devicePixelRatio : 1;
  // CSS px per image px for background-size: cover.
  const cover = Math.max(viewport.width / image.width, viewport.height / image.height);
  // Canvas px per device px: enough samples per sigma, never more than the screen shows.
  const perDevicePixel = Math.min(1, SAMPLES_PER_SIGMA / (blur * dpr));
  // Canvas px per image px: never upscale the photo, never exceed the canvas limit.
  const scale = Math.min(1, cover * dpr * perDevicePixel, MAX_CANVAS_EDGE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  // blur CSS px × canvas px per CSS px.
  const sigma = (blur * scale) / cover;
  // Enlarge the photo exactly as the live filter's layer does (base.css: 2 × blur beyond each edge,
  // still covered), so swapping the live blur for this copy does not shift the picture.
  const liveCover = Math.max((viewport.width + 4 * blur) / image.width, (viewport.height + 4 * blur) / image.height);
  const zoom = liveCover / cover;
  return { width, height, sigma, zoom };
}

/** The current window as a {@link BakeViewport}. */
export function currentViewport(): BakeViewport {
  return { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 };
}

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Whether this context really applies `filter` (an unsupported property reads back unchanged or absent). */
function canvasFilterWorks(ctx: Canvas2D): boolean {
  if (!('filter' in ctx)) return false;
  ctx.filter = 'blur(1px)';
  const works = ctx.filter === 'blur(1px)';
  ctx.filter = 'none';
  return works;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = 'async';
  image.src = src;
  await image.decode();
  return image;
}

/**
 * Loads `src` (the page's own `/api/uploads/…`, `blob:` or `data:` URL, so the canvas stays
 * readable) and returns it blurred for `viewport` as a PNG or WebP blob. Null when there is
 * nothing to bake or this browser cannot; rejects when the image does not load.
 */
export async function bakeBlurredBackdrop(src: string, blur: number, viewport: BakeViewport): Promise<Blob | null> {
  const image = await loadImage(src);
  const plan = bakePlan({ width: image.naturalWidth, height: image.naturalHeight }, blur, viewport);
  if (!plan) return null;
  // A browser without WebP encoding falls back to PNG by itself.
  const type = plan.width * plan.height <= MAX_PNG_PIXELS ? 'image/png' : 'image/webp';
  // Some browsers blur in one kind of canvas and not the other.
  return (await bakeOffscreen(image, plan, type)) ?? (await bakeInDocument(image, plan, type));
}

async function bakeOffscreen(image: HTMLImageElement, plan: BakePlan, type: string): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'function') return null;
  const canvas = new OffscreenCanvas(plan.width, plan.height);
  const ctx = canvas.getContext('2d');
  if (!ctx || !canvasFilterWorks(ctx)) return null;
  draw(ctx, image, plan);
  return canvas.convertToBlob({ type, quality: 0.92 });
}

function bakeInDocument(image: HTMLImageElement, plan: BakePlan, type: string): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext('2d');
  if (!ctx || !canvasFilterWorks(ctx)) return Promise.resolve(null);
  draw(ctx, image, plan);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, 0.92));
}

function draw(ctx: Canvas2D, image: HTMLImageElement, plan: BakePlan): void {
  const width = plan.width * plan.zoom;
  const height = plan.height * plan.zoom;
  // A good downscale first: plain bilinear sampling of a much larger photo would skip most of
  // its pixels and leave blotches the blur cannot hide.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = `blur(${plan.sigma.toFixed(2)}px)`;
  ctx.drawImage(image, (plan.width - width) / 2, (plan.height - height) / 2, width, height);
}
