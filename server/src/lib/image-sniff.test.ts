import { describe, expect, it } from 'vitest';
import { IMAGE_SAMPLES } from './__fixtures__/images.ts';
import { isSvgDocument, sniffImageType } from './image-sniff.ts';

describe('sniffImageType', () => {
  it('recognizes every supported format by magic bytes', () => {
    expect(sniffImageType(IMAGE_SAMPLES.png)).toBe('image/png');
    expect(sniffImageType(IMAGE_SAMPLES.jpeg)).toBe('image/jpeg');
    expect(sniffImageType(IMAGE_SAMPLES.gif)).toBe('image/gif');
    expect(sniffImageType(IMAGE_SAMPLES.webp)).toBe('image/webp');
    expect(sniffImageType(IMAGE_SAMPLES.avif)).toBe('image/avif');
    expect(sniffImageType(IMAGE_SAMPLES.avifCompatible)).toBe('image/avif');
    expect(sniffImageType(IMAGE_SAMPLES.ico)).toBe('image/x-icon');
    expect(sniffImageType(IMAGE_SAMPLES.bmp)).toBe('image/bmp');
    expect(sniffImageType(IMAGE_SAMPLES.svg)).toBe('image/svg+xml');
  });

  it('rejects everything else', () => {
    for (const sample of [
      Buffer.alloc(0),
      Buffer.from('<html><script>alert(1)</script></html>'),
      Buffer.from('<?xml version="1.0"?><html/>'),
      Buffer.from('BMP is not a bitmap'),
      Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'latin1'),
      Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypisom'), Buffer.alloc(8)]),
      Buffer.from([0, 0, 1, 0, 0, 0]), // ICO with zero images
      Buffer.from('%PDF-1.7'),
      Buffer.from('GIF90a'),
    ]) {
      expect(sniffImageType(sample), sample.toString('latin1')).toBeNull();
    }
  });
});

describe('isSvgDocument', () => {
  it('accepts a BOM, XML declaration, comments and whitespace before <svg', () => {
    const doc = '﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by hand -->\n  <svg viewBox="0 0 1 1"></svg>';
    expect(isSvgDocument(Buffer.from(doc))).toBe(true);
    expect(isSvgDocument(Buffer.from('<svg>'))).toBe(true);
    expect(isSvgDocument(Buffer.from('<svg/>'))).toBe(true);
  });

  it('rejects DOCTYPEs, other roots, look-alikes and unterminated prologs', () => {
    for (const doc of [
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>',
      '<html><svg/></html>',
      '<svgfoo/>',
      '<SVG/>',
      '<!-- never closed <svg/>',
      '<?xml version="1.0"',
      'plain text <svg/>',
    ]) {
      expect(isSvgDocument(Buffer.from(doc)), doc).toBe(false);
    }
  });
});
