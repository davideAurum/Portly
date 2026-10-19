/**
 * Byte builders for background-image tests: just enough structure (headers, frame blocks,
 * chunks, boxes) for the header-only inspection in `backgroundImage.ts`. Nothing here decodes.
 */
import { concatBytes, latin1, utf8 } from '../../static/lib/__fixtures__/images.ts';

export { concatBytes, latin1 };

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u24le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** A baseline JPEG header (SOI, APP0, SOF0) of `width` x `height`. */
export function jpeg(width: number, height: number): Uint8Array {
  return concatBytes(
    [0xff, 0xd8],
    [0xff, 0xe0, 0, 16],
    latin1('JFIF\0'),
    [1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, 0xc0, 0, 17, 8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 3],
    new Uint8Array(9),
    [0xff, 0xd9],
  );
}

function pngChunk(type: string, data: number[] | Uint8Array): Uint8Array {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  // The CRC is left zero: nothing here checks it.
  return concatBytes(u32be(bytes.length), latin1(type), bytes, [0, 0, 0, 0]);
}

/** A PNG of `width` x `height`; `frames` adds an APNG `acTL` chunk, before the image data unless `actlAfterData`. */
export function png(width: number, height: number, options: { frames?: number; actlAfterData?: boolean } = {}): Uint8Array {
  const ihdr = pngChunk('IHDR', [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]);
  const actl = options.frames === undefined ? new Uint8Array(0) : pngChunk('acTL', [...u32be(options.frames), ...u32be(0)]);
  const idat = pngChunk('IDAT', [0x78, 0x9c, 0, 0]);
  return concatBytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ihdr,
    options.actlAfterData ? idat : actl,
    options.actlAfterData ? actl : idat,
    pngChunk('IEND', []),
  );
}

/**
 * A GIF89a of `frames` image blocks, each behind a graphic control extension, with a NETSCAPE2.0
 * loop extension first. Image data holds bytes that look like block introducers (0x21, 0x2c), so
 * only a proper walk counts the frames right. `localColorTable` gives every frame one.
 */
export function gif(frames: number, options: { globalColorTable?: boolean; localColorTable?: boolean } = {}): Uint8Array {
  const global = options.globalColorTable ?? true;
  const parts: (number[] | Uint8Array)[] = [latin1('GIF89a'), [...u16le(10), ...u16le(10), global ? 0x80 : 0, 0, 0]];
  if (global) parts.push(new Uint8Array(6));
  parts.push([0x21, 0xff, 11], latin1('NETSCAPE2.0'), [3, 1, 0, 0, 0]);
  for (let i = 0; i < frames; i++) {
    parts.push([0x21, 0xf9, 4, 0, 10, 0, 0, 0]);
    parts.push([0x2c, 0, 0, 0, 0, ...u16le(10), ...u16le(10), options.localColorTable ? 0x81 : 0]);
    if (options.localColorTable) parts.push(new Uint8Array(12));
    parts.push([2, 4, 0x2c, 0x21, 0x2c, 0x3b, 0]);
  }
  parts.push([0x3b]);
  return concatBytes(...parts);
}

function riffChunk(fourcc: string, data: number[] | Uint8Array): Uint8Array {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return concatBytes(latin1(fourcc), u32le(bytes.length), bytes, bytes.length % 2 === 1 ? [0] : []);
}

/** An extended WebP (VP8X) of `width` x `height` with `frames` ANMF chunks (0: a still image). */
export function webp(width: number, height: number, frames = 0): Uint8Array {
  const chunks: Uint8Array[] = [riffChunk('VP8X', [frames > 0 ? 0x02 : 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)])];
  if (frames > 0) chunks.push(riffChunk('ANIM', [0, 0, 0, 0, 0, 0]));
  // An odd-sized frame checks the padding byte.
  for (let i = 0; i < frames; i++) chunks.push(riffChunk('ANMF', new Uint8Array(17)));
  if (frames === 0) chunks.push(riffChunk('VP8 ', new Uint8Array(10)));
  const body = concatBytes(latin1('WEBP'), ...chunks);
  return concatBytes(latin1('RIFF'), u32le(body.length), body);
}

function box(type: string, ...content: (number[] | Uint8Array)[]): Uint8Array {
  const body = concatBytes(...content);
  return concatBytes(u32be(body.length + 8), latin1(type), body);
}

/** An AVIF with `brand` as its major brand and one `ispe` property per entry of `sizes` (none: no size). */
export function avif(sizes: [number, number][], brand: 'avif' | 'avis' = 'avif'): Uint8Array {
  const ispes = sizes.map(([w, h]) => box('ispe', [0, 0, 0, 0], u32be(w), u32be(h)));
  const meta = box('meta', [0, 0, 0, 0], box('hdlr', new Uint8Array(24)), box('iprp', box('ipco', box('pixi', [0, 0, 0, 0, 0]), ...ispes)));
  return concatBytes(box('ftyp', latin1(brand), [0, 0, 0, 0], latin1('mif1miaf')), meta, box('mdat', new Uint8Array(8)));
}

export function svg(attributes = 'width="40" height="30"'): Uint8Array {
  return utf8(`<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><rect width="40" height="30"/></svg>`);
}

/** A BMP header (BITMAPINFOHEADER) of `width` x `height`. */
export function bmp(width: number, height: number): Uint8Array {
  return concatBytes(latin1('BM'), new Uint8Array(12), u32le(40), u32le(width), u32le(height), new Uint8Array(30));
}

/** A `File` holding `bytes` (copied into a fresh buffer). */
export function fileOf(bytes: Uint8Array, name: string, type = ''): File {
  return new File([new Uint8Array(bytes)], name, { type });
}
