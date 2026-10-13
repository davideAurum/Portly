import { describe, expect, it } from 'vitest';
import { IMAGE_SAMPLES, concatBytes, latin1, utf8 } from './__fixtures__/images.ts';
import { isSvgDocument, sniffImageType } from './imageSniff.ts';

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

  it('works on views into a larger buffer (non-zero byteOffset)', () => {
    const padded = concatBytes([1, 2, 3], IMAGE_SAMPLES.bmp);
    expect(sniffImageType(padded.subarray(3))).toBe('image/bmp');
    const avif = concatBytes([9], IMAGE_SAMPLES.avif);
    expect(sniffImageType(avif.subarray(1))).toBe('image/avif');
  });

  it('rejects everything else', () => {
    for (const [label, sample] of [
      ['empty', new Uint8Array(0)],
      ['html', utf8('<html><script>alert(1)</script></html>')],
      ['xml html', utf8('<?xml version="1.0"?><html/>')],
      ['BMP text', utf8('BMP is not a bitmap')],
      ['wave', latin1('RIFF\x00\x00\x00\x00WAVEfmt ')],
      ['isom', concatBytes([0, 0, 0, 0x14], latin1('ftypisom'), new Uint8Array(8))],
      ['ico zero images', new Uint8Array([0, 0, 1, 0, 0, 0])],
      ['pdf', utf8('%PDF-1.7')],
      ['GIF90a', utf8('GIF90a')],
      ['short png', IMAGE_SAMPLES.png.subarray(0, 7)],
      ['bmp unknown header', (() => {
        const b = new Uint8Array(30);
        b.set(latin1('BM'), 0);
        new DataView(b.buffer).setUint32(14, 41, true);
        return b;
      })()],
    ] as const) {
      expect(sniffImageType(sample), label).toBeNull();
    }
  });
});

describe('isSvgDocument', () => {
  it('accepts a BOM, XML declaration, comments and whitespace before <svg', () => {
    const doc = '﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by hand -->\n  <svg viewBox="0 0 1 1"></svg>';
    expect(isSvgDocument(utf8(doc))).toBe(true);
    expect(isSvgDocument(utf8('<svg>'))).toBe(true);
    expect(isSvgDocument(utf8('<svg/>'))).toBe(true);
    expect(isSvgDocument(utf8('<svg\nxmlns="x">'))).toBe(true);
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
      '',
    ]) {
      expect(isSvgDocument(utf8(doc)), doc).toBe(false);
    }
  });

  it('only scans the first 64 KB for the root element', () => {
    const late = utf8(`${' '.repeat(64 * 1024)}<svg/>`);
    expect(isSvgDocument(late)).toBe(false);
    const early = utf8(`${' '.repeat(64 * 1024 - 10)}<svg/>`);
    expect(isSvgDocument(early)).toBe(true);
  });
});
