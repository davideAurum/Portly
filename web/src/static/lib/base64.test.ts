import { describe, expect, it } from 'vitest';
import { StaticApiError } from '../respond.ts';
import { decodeBase64, encodeBase64 } from './base64.ts';

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  // getRandomValues caps each call at 65536 bytes.
  for (let offset = 0; offset < length; offset += 65536) globalThis.crypto.getRandomValues(out.subarray(offset, offset + 65536));
  return out;
}

describe('base64', () => {
  it('encodes the RFC 4648 test vectors with padding', () => {
    const text = (s: string) => new TextEncoder().encode(s);
    expect(encodeBase64(text(''))).toBe('');
    expect(encodeBase64(text('f'))).toBe('Zg==');
    expect(encodeBase64(text('fo'))).toBe('Zm8=');
    expect(encodeBase64(text('foo'))).toBe('Zm9v');
    expect(encodeBase64(text('foob'))).toBe('Zm9vYg==');
    expect(encodeBase64(text('fooba'))).toBe('Zm9vYmE=');
    expect(encodeBase64(text('foobar'))).toBe('Zm9vYmFy');
    expect(encodeBase64(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('+/+/');
  });

  it('decodes the vectors and every byte value', () => {
    expect(decodeBase64('')).toEqual(new Uint8Array(0));
    expect(new TextDecoder().decode(decodeBase64('Zm9vYmE='))).toBe('fooba');
    expect(decodeBase64('+/+/')).toEqual(new Uint8Array([0xfb, 0xff, 0xbf]));
    const all = new Uint8Array(256).map((_, i) => i);
    expect(decodeBase64(encodeBase64(all))).toEqual(all);
    // Matches the platform encoder on something small.
    expect(encodeBase64(all)).toBe(btoa(String.fromCharCode(...all)));
  });

  it('round-trips 1 MB and 10 MB payloads across chunk boundaries', () => {
    for (const size of [1024 * 1024 + 7, 10 * 1024 * 1024]) {
      const bytes = randomBytes(size);
      const encoded = encodeBase64(bytes);
      expect(encoded.length).toBe(Math.ceil(size / 3) * 4);
      const decoded = decodeBase64(encoded);
      expect(decoded.length).toBe(size);
      // Spot-check instead of a 10 MB deep-equal.
      for (const i of [0, 1, 2, 24575, 24576, 24577, 32767, 32768, size - 2, size - 1]) expect(decoded[i], `byte ${i}`).toBe(bytes[i]);
      expect(decoded.subarray(size - 1000)).toEqual(bytes.subarray(size - 1000));
    }
  });

  it('round-trips lengths around the chunk sizes exactly', () => {
    for (const size of [1, 2, 3, 4, 24575, 24576, 24577, 49152, 49153]) {
      const bytes = randomBytes(size);
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    }
  });

  it('rejects malformed input with 400 bad_request', () => {
    for (const bad of ['TWF', 'TW@u', 'TWFu=', 'TQ=A', 'TW Fu', 'TWFu\n', '====', 'A===', 'TQ==TQ==', '-_-_']) {
      let caught: unknown;
      try {
        decodeBase64(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught, bad).toBeInstanceOf(StaticApiError);
      expect(caught).toMatchObject({ code: 'bad_request', message: 'Invalid base64 data' });
    }
    expect(() => decodeBase64(42 as unknown as string)).toThrow(StaticApiError);
  });
});
