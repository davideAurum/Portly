/**
 * Minimal byte samples for every supported image format (headers only; enough for sniffing).
 * Shared by the image-sniffing, upload and import tests.
 */
export const IMAGE_SAMPLES = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]),
  gif: Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1'),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([26, 0, 0, 0]), Buffer.from('WEBPVP8 ')]),
  avif: Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.from([0, 0, 0, 0]), Buffer.from('avifmif1miaf')]),
  avifCompatible: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmif1'), Buffer.from([0, 0, 0, 0]), Buffer.from('mif1avif')]),
  ico: Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0]), Buffer.alloc(8)]),
  bmp: (() => {
    const b = Buffer.alloc(30);
    b.write('BM', 0, 'latin1');
    b.writeUInt32LE(40, 14);
    return b;
  })(),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
} as const;
