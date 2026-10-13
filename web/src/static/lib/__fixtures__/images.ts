/**
 * Minimal byte samples for every supported image format (headers only; enough for sniffing), as
 * Uint8Arrays for the browser-side libraries (port of server/src/lib/__fixtures__/images.ts).
 * Shared by the image-sniffing, image-size, upload and import tests.
 */

/** One byte per character (ISO-8859-1), like `Buffer.from(text, 'latin1')`. */
export function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** UTF-8 bytes of `text`. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function concatBytes(...parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export const IMAGE_SAMPLES = {
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]),
  gif: latin1('GIF89a\x01\x00\x01\x00\x00\x00\x00'),
  webp: concatBytes(latin1('RIFF'), [26, 0, 0, 0], latin1('WEBPVP8 ')),
  avif: concatBytes([0, 0, 0, 0x1c], latin1('ftypavif'), [0, 0, 0, 0], latin1('avifmif1miaf')),
  avifCompatible: concatBytes([0, 0, 0, 0x18], latin1('ftypmif1'), [0, 0, 0, 0], latin1('mif1avif')),
  ico: concatBytes([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0], new Uint8Array(8)),
  bmp: (() => {
    const b = new Uint8Array(30);
    b.set(latin1('BM'), 0);
    new DataView(b.buffer).setUint32(14, 40, true);
    return b;
  })(),
  svg: utf8('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
} as const;
