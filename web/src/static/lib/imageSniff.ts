/**
 * Image type detection from magic bytes (§4.3), the browser port of server/src/lib/image-sniff.ts.
 * Stored/served content types always come from here — never from a client `Content-Type`, a file
 * name or a remote server's headers.
 *
 * Recognized: png, gif, jpeg, webp, avif, ico, bmp, and svg only when (after an optional BOM,
 * XML declaration, comments and whitespace) the root element is `<svg`. SVG documents with a
 * DOCTYPE are refused (no entity declarations).
 *
 * Port notes: the server read signature bytes with `Buffer.toString('latin1')`; here each byte is
 * mapped to one code unit directly (the Encoding Standard's `latin1` label is windows-1252, so
 * `new TextDecoder('latin1')` would not be byte-exact). The SVG scan decodes UTF-8 with TextDecoder,
 * keeping the BOM so the explicit strip below behaves like the server.
 */
import type { ImageContentType } from '@portly/shared';

/** How much of an SVG is scanned for its root element. */
const SVG_SCAN_BYTES = 64 * 1024;

const UTF8 = new TextDecoder('utf-8', { ignoreBOM: true });

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

/** Bytes `start..end` (clamped) as one character per byte, like Buffer's `latin1`. */
function ascii(bytes: Uint8Array, start: number, end: number): string {
  const slice = bytes.subarray(start, Math.min(end, bytes.length));
  let out = '';
  for (let i = 0; i < slice.length; i++) out += String.fromCharCode(slice[i] ?? 0);
  return out;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const ICO = [0x00, 0x00, 0x01, 0x00];
const BMP_DIB_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

function isGif(bytes: Uint8Array): boolean {
  const head = ascii(bytes, 0, 6);
  return head === 'GIF87a' || head === 'GIF89a';
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP';
}

/** ISO-BMFF `ftyp` box whose major or a compatible brand is `avif`/`avis`. */
function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== 'ftyp') return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxSize = view.getUint32(0);
  if (boxSize < 16 || boxSize > bytes.length || boxSize % 4 !== 0) return false;
  const brands = new Set<string>([ascii(bytes, 8, 12)]);
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) brands.add(ascii(bytes, offset, offset + 4));
  return brands.has('avif') || brands.has('avis');
}

function isIco(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, ICO) || bytes.length < 22) return false;
  const count = (bytes[4] ?? 0) | ((bytes[5] ?? 0) << 8);
  return count > 0;
}

function isBmp(bytes: Uint8Array): boolean {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return BMP_DIB_HEADER_SIZES.has(view.getUint32(14, true));
}

/** True when the document's root element is `<svg` (see module docs). */
export function isSvgDocument(bytes: Uint8Array): boolean {
  let text = UTF8.decode(bytes.subarray(0, Math.min(bytes.length, SVG_SCAN_BYTES)));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let rest = text;
  for (;;) {
    rest = rest.replace(/^[\s]+/, '');
    if (rest.startsWith('<?')) {
      const end = rest.indexOf('?>');
      if (end === -1) return false;
      rest = rest.slice(end + 2);
      continue;
    }
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->', 4);
      if (end === -1) return false;
      rest = rest.slice(end + 3);
      continue;
    }
    break;
  }
  // DOCTYPEs (and with them entity declarations) are refused outright.
  if (/^<!/.test(rest)) return false;
  return /^<svg[\s>/]/.test(rest);
}

/** Content type of `bytes` by magic number, or null when it is not a supported image. */
export function sniffImageType(bytes: Uint8Array): ImageContentType | null {
  if (bytes.length === 0) return null;
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (isGif(bytes)) return 'image/gif';
  if (isWebp(bytes)) return 'image/webp';
  if (isAvif(bytes)) return 'image/avif';
  if (isIco(bytes)) return 'image/x-icon';
  if (isBmp(bytes)) return 'image/bmp';
  if (isSvgDocument(bytes)) return 'image/svg+xml';
  return null;
}
