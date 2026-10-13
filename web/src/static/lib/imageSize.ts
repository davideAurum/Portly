/**
 * Pixel size of an icon image from its bytes (header parsing only, no decoding), used to pick the
 * best favicon (§8: "prefer largest ≥ 32 px raster or SVG") and stored as the custom icon's
 * `width`. Returns the larger of width and height, or null when unknown (SVG, AVIF, truncated
 * data). Verbatim copy of server/src/modules/bookmarks/image-size.ts (pure).
 */
import type { ImageContentType } from '@portly/shared';

function u16be(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
}
function u16le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}
function u24le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
}
function u32be(b: Uint8Array, o: number): number {
  return (((b[o] ?? 0) << 24) >>> 0) + (((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0));
}
function i32le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24);
}

function pngSize(b: Uint8Array): number | null {
  if (b.length < 24) return null;
  return Math.max(u32be(b, 16), u32be(b, 20)) || null;
}

function gifSize(b: Uint8Array): number | null {
  if (b.length < 10) return null;
  return Math.max(u16le(b, 6), u16le(b, 8)) || null;
}

function jpegSize(b: Uint8Array): number | null {
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) return null;
    const marker = b[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // SOFn markers carry the frame size (C4 = DHT, C8 = JPG, CC = DAC are not frames).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return Math.max(u16be(b, offset + 5), u16be(b, offset + 7)) || null;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = u16be(b, offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): number | null {
  if (b.length < 30) return null;
  const chunk = String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0);
  if (chunk === 'VP8 ') return Math.max(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff) || null;
  if (chunk === 'VP8L') {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
    return Math.max((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') return Math.max(u24le(b, 24) + 1, u24le(b, 27) + 1);
  return null;
}

function icoSize(b: Uint8Array): number | null {
  const count = u16le(b, 4);
  let best = 0;
  for (let i = 0; i < count && 6 + i * 16 + 16 <= b.length; i++) {
    const w = b[6 + i * 16] || 256;
    const h = b[6 + i * 16 + 1] || 256;
    best = Math.max(best, w, h);
  }
  return best || null;
}

function bmpSize(b: Uint8Array): number | null {
  if (b.length < 26) return null;
  const header = i32le(b, 14);
  if (header === 12) return Math.max(u16le(b, 18), u16le(b, 20)) || null;
  return Math.max(Math.abs(i32le(b, 18)), Math.abs(i32le(b, 22))) || null;
}

export function imageSize(bytes: Uint8Array, type: ImageContentType): number | null {
  switch (type) {
    case 'image/png':
      return pngSize(bytes);
    case 'image/gif':
      return gifSize(bytes);
    case 'image/jpeg':
      return jpegSize(bytes);
    case 'image/webp':
      return webpSize(bytes);
    case 'image/x-icon':
      return icoSize(bytes);
    case 'image/bmp':
      return bmpSize(bytes);
    default:
      return null;
  }
}
