/**
 * The Appearance background upload's "prepare" step (§7a Theme rendering, background uploads): the
 * browser turns the chosen file into one that is cheap to decode and draw in every new tab before
 * it is uploaded. Only the background uses it; bookmark icons are uploaded unchanged.
 *
 * - A still PNG, JPEG, GIF, WebP or AVIF whose long edge fits the target is kept as it is, decided
 *   from its header without decoding it (an AVIF without a readable size is decoded to find out).
 *   The target of a new upload is {@link backgroundTargetEdge} (this screen's long edge in device
 *   pixels, 2560..3840); "Optimize image" uses 3840, so its copy suits every screen.
 * - Anything else is decoded, drawn on an OffscreenCanvas with its long edge at min(original,
 *   target) and encoded as WebP at quality 0.85 (PNG where the browser cannot encode WebP). Raster
 *   files are decoded with `createImageBitmap`, which takes the first frame of an animation and
 *   applies the EXIF orientation like the page would. An SVG is drawn from an `<img>` on a `blob:`
 *   URL, where it runs no script and loads nothing, at the target size (it has no pixels of its own).
 * - The original goes up instead when the browser lacks these APIs, refuses to read the canvas
 *   back, or the copy is over the upload limit. A file the browser cannot decode at all is refused
 *   with an {@link ImagePrepareError}: the page could not show it either. Bytes that are no image
 *   Portly accepts go up unchanged, so the server refuses them with its usual message.
 */
import { ImagePrepareError, MAX_UPLOAD_BYTES } from '../api/uploads.ts';
import { backgroundIssue, backgroundTargetEdge, inspectBackgroundImage } from './backgroundImage.ts';

/** The largest file the background upload takes before it is prepared (the copy must fit the upload limit). */
export const MAX_BACKGROUND_SOURCE_BYTES = 25 * 1024 * 1024;

/** WebP quality of a prepared background. */
export const BACKGROUND_WEBP_QUALITY = 0.85;

const UNREADABLE = 'This image could not be opened. Try saving it as a JPEG or PNG first.';

/** The shape an SVG without a size of its own is drawn in. */
const FALLBACK_SIZE = { width: 1600, height: 900 } as const;

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

function canPrepare(svg: boolean): boolean {
  if (typeof OffscreenCanvas !== 'function' || typeof OffscreenCanvas.prototype.convertToBlob !== 'function') return false;
  return svg ? typeof Image === 'function' : typeof createImageBitmap === 'function';
}

async function decodeRaster(file: File): Promise<DecodedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImagePrepareError(UNREADABLE);
  }
  return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
}

async function decodeSvg(file: File): Promise<DecodedImage> {
  // The browser reads a `blob:` URL as SVG only under the SVG type, which a picked or dropped file
  // may lack; the bytes were sniffed as an SVG document already.
  const url = URL.createObjectURL(new Blob([file], { type: 'image/svg+xml' }));
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new ImagePrepareError(UNREADABLE);
  }
  const sized = image.naturalWidth > 0 && image.naturalHeight > 0;
  return {
    source: image,
    width: sized ? image.naturalWidth : FALLBACK_SIZE.width,
    height: sized ? image.naturalHeight : FALLBACK_SIZE.height,
    release: () => URL.revokeObjectURL(url),
  };
}

/** Draws `source` at `width` x `height` and encodes it; null when the canvas cannot be read back. */
async function drawAndEncode(source: CanvasImageSource, width: number, height: number): Promise<Blob | null> {
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, width, height);
    const webp = await canvas.convertToBlob({ type: 'image/webp', quality: BACKGROUND_WEBP_QUALITY });
    // A browser that cannot encode WebP answers with a PNG, which is the fallback anyway.
    if (webp.type === 'image/webp' || webp.type === 'image/png') return webp;
    return await canvas.convertToBlob({ type: 'image/png' });
  } catch {
    // A canvas the browser will not read back, or no memory for it.
    return null;
  }
}

function renamed(name: string, type: string): string {
  const base = name.replace(/\.[^.]*$/, '') || 'background';
  return `${base}.${type === 'image/webp' ? 'webp' : 'png'}`;
}

/**
 * The file to upload for `file` as the page background, with its long edge at most `target` pixels
 * (see module docs); `file` itself when it is fine as it is.
 */
export async function prepareBackgroundImage(file: File, target = backgroundTargetEdge()): Promise<File> {
  const info = inspectBackgroundImage(new Uint8Array(await file.arrayBuffer()));
  if (!info) return file;
  const issue = backgroundIssue(info, target);
  const svg = info.type === 'image/svg+xml';
  if (issue === null || !canPrepare(svg)) return file;

  const decoded = svg ? await decodeSvg(file) : await decodeRaster(file);
  try {
    const longEdge = Math.max(decoded.width, decoded.height);
    if (issue === 'unknown' && longEdge <= target) return file;
    const scale = svg ? target / longEdge : Math.min(1, target / longEdge);
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const blob = await drawAndEncode(decoded.source, width, height);
    if (!blob || blob.size === 0 || blob.size > MAX_UPLOAD_BYTES) return file;
    return new File([blob], renamed(file.name, blob.type), { type: blob.type, lastModified: file.lastModified });
  } finally {
    decoded.release();
  }
}
