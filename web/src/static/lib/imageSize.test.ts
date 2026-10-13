import { describe, expect, it } from 'vitest';
import { IMAGE_SAMPLES, concatBytes, latin1 } from './__fixtures__/images.ts';
import { imageSize } from './imageSize.ts';

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  b.set(latin1('IHDR'), 12);
  const view = new DataView(b.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return b;
}

/** ICO directory with one entry per size (256 is encoded as 0, like the format says). */
function ico(...sizes: number[]): Uint8Array {
  const b = new Uint8Array(6 + sizes.length * 16);
  b.set([0, 0, 1, 0, sizes.length & 0xff, sizes.length >> 8], 0);
  sizes.forEach((size, i) => {
    b[6 + i * 16] = size === 256 ? 0 : size;
    b[6 + i * 16 + 1] = size === 256 ? 0 : size;
  });
  return b;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, APP0 (16 bytes), SOF0 with the frame size, padding.
  const b = new Uint8Array(32);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
  b.set(latin1('JFIF\0'), 6);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20);
  const view = new DataView(b.buffer);
  view.setUint16(25, height);
  view.setUint16(27, width);
  return b;
}

function webp(chunk: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): Uint8Array {
  const b = new Uint8Array(32);
  b.set(latin1('RIFF'), 0);
  b.set(latin1('WEBP'), 8);
  b.set(latin1(chunk), 12);
  const view = new DataView(b.buffer);
  if (chunk === 'VP8 ') {
    b.set([0x9d, 0x01, 0x2a], 23);
    view.setUint16(26, width, true);
    view.setUint16(28, height, true);
  } else if (chunk === 'VP8L') {
    b[20] = 0x2f;
    view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  } else {
    const w = width - 1;
    const h = height - 1;
    b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
    b.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  }
  return b;
}

function bmp(width: number, height: number, header: 12 | 40 = 40): Uint8Array {
  const b = new Uint8Array(40);
  b.set(latin1('BM'), 0);
  const view = new DataView(b.buffer);
  view.setInt32(14, header, true);
  if (header === 12) {
    view.setUint16(18, width, true);
    view.setUint16(20, height, true);
  } else {
    view.setInt32(18, width, true);
    view.setInt32(22, height, true);
  }
  return b;
}

describe('imageSize', () => {
  it('reads the larger dimension from PNG, GIF, JPEG, WebP, ICO and BMP headers', () => {
    expect(imageSize(png(180, 90), 'image/png')).toBe(180);
    expect(imageSize(png(16, 32), 'image/png')).toBe(32);
    expect(imageSize(IMAGE_SAMPLES.gif, 'image/gif')).toBe(1);
    expect(imageSize(latin1('GIF89a\x20\x00\x40\x00'), 'image/gif')).toBe(64);
    expect(imageSize(jpeg(200, 100), 'image/jpeg')).toBe(200);
    expect(imageSize(webp('VP8 ', 300, 200), 'image/webp')).toBe(300);
    expect(imageSize(webp('VP8L', 48, 96), 'image/webp')).toBe(96);
    expect(imageSize(webp('VP8X', 1024, 512), 'image/webp')).toBe(1024);
    expect(imageSize(ico(16, 32, 48), 'image/x-icon')).toBe(48);
    expect(imageSize(ico(256), 'image/x-icon')).toBe(256);
    expect(imageSize(bmp(64, 128), 'image/bmp')).toBe(128);
    expect(imageSize(bmp(64, -128), 'image/bmp')).toBe(128); // top-down bitmaps have a negative height
    expect(imageSize(bmp(24, 12, 12), 'image/bmp')).toBe(24);
  });

  it('returns null for SVG, AVIF, truncated or zero-sized data', () => {
    expect(imageSize(IMAGE_SAMPLES.svg, 'image/svg+xml')).toBeNull();
    expect(imageSize(IMAGE_SAMPLES.avif, 'image/avif')).toBeNull();
    expect(imageSize(IMAGE_SAMPLES.png, 'image/png')).toBeNull(); // 16 bytes: no IHDR payload
    expect(imageSize(png(0, 0), 'image/png')).toBeNull();
    expect(imageSize(latin1('GIF89a'), 'image/gif')).toBeNull();
    expect(imageSize(IMAGE_SAMPLES.jpeg, 'image/jpeg')).toBeNull(); // no SOF marker
    expect(imageSize(IMAGE_SAMPLES.webp, 'image/webp')).toBeNull(); // too short
    expect(imageSize(concatBytes(latin1('RIFF'), new Uint8Array(4), latin1('WEBP'), latin1('ALPH'), new Uint8Array(16)), 'image/webp')).toBeNull();
    expect(imageSize(new Uint8Array([0, 0, 1, 0, 0, 0]), 'image/x-icon')).toBeNull();
    expect(imageSize(IMAGE_SAMPLES.bmp, 'image/bmp')).toBeNull(); // zero width/height
  });

  it('skips JPEG segments before the frame header and stops on garbage', () => {
    const b = jpeg(640, 480);
    // A bogus segment length (< 2) aborts the scan.
    const broken = new Uint8Array(b);
    broken[4] = 0;
    broken[5] = 1;
    expect(imageSize(broken, 'image/jpeg')).toBeNull();
    // A fill byte (0xFF 0xFF) before a marker is tolerated.
    const padded = concatBytes([0xff, 0xd8, 0xff], b.subarray(2));
    expect(imageSize(padded, 'image/jpeg')).toBe(640);
  });
});
