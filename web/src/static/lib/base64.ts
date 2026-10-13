/**
 * Base64 for the static backend (export/import embed images as base64, up to 10 MB each). Both
 * directions work in bounded chunks: `String.fromCharCode(...bytes)` on a whole image would
 * overflow the argument list, and chunk sizes are multiples of 3 bytes / 4 characters so the
 * pieces concatenate without inner padding. Standard alphabet with `=` padding only, as produced by
 * the server's `Buffer.toString('base64')` and validated by zod's `z.base64()`; anything else is
 * `400 bad_request`.
 */
import { StaticApiError } from '../respond.ts';

/** Bytes per `btoa` call: a multiple of 3, so no chunk but the last ends in padding. */
const ENCODE_CHUNK_BYTES = 3 * 8192;
/** Characters per `atob` call: a multiple of 4, so every chunk decodes on its own. */
const DECODE_CHUNK_CHARS = 4 * 8192;
/** Bytes per `String.fromCharCode` spread (well under engine argument limits). */
const SPREAD_CHUNK = 8192;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function binaryString(bytes: Uint8Array): string {
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += SPREAD_CHUNK) {
    out += String.fromCharCode(...bytes.subarray(offset, offset + SPREAD_CHUNK));
  }
  return out;
}

/** Standard base64 (with padding) of `bytes`. */
export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += ENCODE_CHUNK_BYTES) {
    parts.push(btoa(binaryString(bytes.subarray(offset, offset + ENCODE_CHUNK_BYTES))));
  }
  return parts.join('');
}

function invalid(): StaticApiError {
  return new StaticApiError('bad_request', 'Invalid base64 data');
}

/** Bytes of standard base64 `text` (padding required, no whitespace); `400 bad_request` otherwise. */
export function decodeBase64(text: string): Uint8Array {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !BASE64_PATTERN.test(text)) throw invalid();
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let written = 0;
  for (let offset = 0; offset < text.length; offset += DECODE_CHUNK_CHARS) {
    let binary: string;
    try {
      binary = atob(text.slice(offset, offset + DECODE_CHUNK_CHARS));
    } catch {
      throw invalid();
    }
    for (let i = 0; i < binary.length; i++) out[written++] = binary.charCodeAt(i);
  }
  return out;
}
