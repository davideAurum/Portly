/**
 * What an Appearance background image costs to show, read from its bytes without decoding them
 * (§7a Theme rendering, background uploads): its type, whether it is animated and the pixels of
 * its long edge, plus the long edge a background needs on this screen. Used by
 * `prepareBackground.ts` before an upload and by the Appearance page's "Optimize image" offer.
 *
 * The bytes are hostile: every read is bounds-checked, every walk moves forward by at least one
 * byte, and anything malformed counts as "still" or "size unknown" (never an error).
 *
 * Animation: a GIF with a second image descriptor, a PNG whose `acTL` chunk (before the first
 * `IDAT`) announces more than one frame, a WebP with a second `ANMF` chunk, an AVIF whose `ftyp`
 * lists the image-sequence brand `avis`. Size: the header-only reader the bookmark icons use
 * (`static/lib/imageSize.ts`), plus the largest `ispe` property of an AVIF.
 */
import type { ImageContentType } from '@portly/shared';
import { imageSize } from '../static/lib/imageSize.ts';
import { sniffImageType } from '../static/lib/imageSniff.ts';

/** The smallest long edge a prepared background gets, whatever the screen. */
export const BACKGROUND_MIN_EDGE = 2560;
/** The largest long edge a prepared background gets (a 4K screen). */
export const BACKGROUND_MAX_EDGE = 3840;

export interface ScreenSize {
  /** CSS pixels, like `window.screen`. */
  width: number;
  height: number;
  devicePixelRatio: number;
}

export function currentScreen(): ScreenSize {
  return {
    width: window.screen?.width ?? 0,
    height: window.screen?.height ?? 0,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

/**
 * The long edge (device pixels) a background needs: the screen's long edge times its pixel ratio,
 * kept within {@link BACKGROUND_MIN_EDGE}..{@link BACKGROUND_MAX_EDGE} (4K at 150 %: 3840).
 */
export function backgroundTargetEdge(screen: ScreenSize = currentScreen()): number {
  const ratio = Number.isFinite(screen.devicePixelRatio) && screen.devicePixelRatio > 0 ? screen.devicePixelRatio : 1;
  const longest = Math.max(screen.width, screen.height) * ratio;
  const edge = Number.isFinite(longest) ? Math.round(longest) : 0;
  return Math.min(Math.max(BACKGROUND_MIN_EDGE, edge), BACKGROUND_MAX_EDGE);
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function u32be(b: Uint8Array, o: number): number {
  return (((b[o] ?? 0) << 24) >>> 0) + (((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0));
}

function u32le(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;
}

function ascii(b: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < Math.min(end, b.length); i++) out += String.fromCharCode(b[i] ?? 0);
  return out;
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

/** Skips GIF data sub-blocks starting at `offset`; returns the offset after the terminator. */
function skipGifSubBlocks(b: Uint8Array, offset: number): number {
  while (offset < b.length) {
    const size = b[offset] ?? 0;
    offset += 1 + size;
    if (size === 0) return offset;
  }
  return b.length;
}

/** A global or local color table's byte length from a GIF packed-fields byte. */
function gifColorTableBytes(flags: number): number {
  return flags & 0x80 ? 3 * (1 << ((flags & 0x07) + 1)) : 0;
}

function gifHasTwoFrames(b: Uint8Array): boolean {
  if (b.length < 13) return false;
  let offset = 13 + gifColorTableBytes(b[10] ?? 0);
  let frames = 0;
  while (offset < b.length) {
    const block = b[offset];
    if (block === 0x21) {
      // Extension: introducer, label, then data sub-blocks.
      offset = skipGifSubBlocks(b, offset + 2);
    } else if (block === 0x2c) {
      if (++frames >= 2) return true;
      if (offset + 10 > b.length) return false;
      // Image descriptor (10 bytes), local color table, LZW minimum code size, image data.
      offset = skipGifSubBlocks(b, offset + 10 + gifColorTableBytes(b[offset + 9] ?? 0) + 1);
    } else {
      // The trailer (0x3b) or bytes that are not GIF blocks.
      return false;
    }
  }
  return false;
}

function apngHasTwoFrames(b: Uint8Array): boolean {
  let offset = 8;
  while (offset + 8 <= b.length) {
    const length = u32be(b, offset);
    const type = ascii(b, offset + 4, offset + 8);
    // acTL: num_frames, then num_plays. It must come before the image data to count.
    if (type === 'acTL') return offset + 12 <= b.length && u32be(b, offset + 8) > 1;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += 12 + length;
  }
  return false;
}

function webpHasTwoFrames(b: Uint8Array): boolean {
  let offset = 12;
  let frames = 0;
  while (offset + 8 <= b.length) {
    const size = u32le(b, offset + 4);
    if (ascii(b, offset, offset + 4) === 'ANMF' && ++frames >= 2) return true;
    offset += 8 + size + (size & 1);
  }
  return false;
}

/** The major and compatible brands of an ISO-BMFF `ftyp` box at the start of `b`. */
function ftypBrands(b: Uint8Array): Set<string> {
  const brands = new Set<string>();
  if (b.length < 16 || ascii(b, 4, 8) !== 'ftyp') return brands;
  const boxSize = Math.min(u32be(b, 0), b.length);
  brands.add(ascii(b, 8, 12));
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) brands.add(ascii(b, offset, offset + 4));
  return brands;
}

/** True when the image has more than one frame (see module docs). SVG animations are not detected. */
export function isAnimatedImage(bytes: Uint8Array, type: ImageContentType): boolean {
  switch (type) {
    case 'image/gif':
      return gifHasTwoFrames(bytes);
    case 'image/png':
      return apngHasTwoFrames(bytes);
    case 'image/webp':
      return webpHasTwoFrames(bytes);
    case 'image/avif':
      return ftypBrands(bytes).has('avis');
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

interface Box {
  type: string;
  /** Content start (after the header) and end. */
  start: number;
  end: number;
}

/** The ISO-BMFF boxes directly inside `start..end`; stops at the first malformed one. */
function boxesIn(b: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = u32be(b, offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = u32be(b, offset + 8) * 2 ** 32 + u32be(b, offset + 12);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    boxes.push({ type: ascii(b, offset + 4, offset + 8), start: offset + header, end: offset + size });
    offset += size;
  }
  return boxes;
}

function childBox(b: Uint8Array, parent: Box | undefined, type: string, fullBox = false): Box | undefined {
  if (!parent) return undefined;
  return boxesIn(b, parent.start + (fullBox ? 4 : 0), parent.end).find((box) => box.type === type);
}

/** The largest `ispe` (image spatial extents) in `meta/iprp/ipco`: the full picture of a grid, too. */
function avifLongEdge(b: Uint8Array): number | null {
  const meta = boxesIn(b, 0, b.length).find((box) => box.type === 'meta');
  // meta is a full box (version and flags before its children).
  const ipco = childBox(b, childBox(b, meta, 'iprp', true), 'ipco');
  if (!ipco) return null;
  let best = 0;
  for (const box of boxesIn(b, ipco.start, ipco.end)) {
    // ispe: version and flags, then 32-bit width and height.
    if (box.type === 'ispe' && box.start + 12 <= box.end) best = Math.max(best, u32be(b, box.start + 4), u32be(b, box.start + 8));
  }
  return best || null;
}

/** Pixels of the image's long edge from its header, or null when unknown (always for SVG). */
export function imageLongEdge(bytes: Uint8Array, type: ImageContentType): number | null {
  return type === 'image/avif' ? avifLongEdge(bytes) : imageSize(bytes, type);
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export interface BackgroundImageInfo {
  type: ImageContentType;
  animated: boolean;
  /** From the header; null when unknown. */
  longEdge: number | null;
}

/** Type, animation and size of `bytes`, or null when they are not an image Portly accepts. */
export function inspectBackgroundImage(bytes: Uint8Array): BackgroundImageInfo | null {
  const type = sniffImageType(bytes);
  if (!type) return null;
  return { type, animated: isAnimatedImage(bytes, type), longEdge: imageLongEdge(bytes, type) };
}

/** Formats a still image of the right size is shown in as uploaded. */
const KEPT_TYPES: ReadonlySet<ImageContentType> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

/**
 * Why a background is worth preparing: `animated` (redraws the window on every frame), `format`
 * (an SVG drawing, or a BMP / ICO that a compressed copy beats), `large` (more pixels than
 * `target`), `unknown` when the header did not say how large it is (decode it to find out), or
 * null when it can be shown as it is.
 */
export type BackgroundIssue = 'animated' | 'format' | 'large' | 'unknown';

export function backgroundIssue(info: BackgroundImageInfo, target: number): BackgroundIssue | null {
  if (info.animated) return 'animated';
  if (!KEPT_TYPES.has(info.type)) return 'format';
  if (info.longEdge === null) return 'unknown';
  return info.longEdge > target ? 'large' : null;
}
