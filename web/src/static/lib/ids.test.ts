import { describe, expect, it } from 'vitest';
import { UUID_REGEX, UUID_V4_REGEX, isUuid, isUuidV4, newToken, toBase64Url } from './ids.ts';

describe('ids', () => {
  it('isUuid accepts versions 1–8 of any case, isUuidV4 only version 4', () => {
    const v4 = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const v1 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const v7 = '018f3f2a-7c6e-7a1b-9c3d-4e5f6a7b8c9d';
    expect(isUuid(v4)).toBe(true);
    expect(isUuid(v1)).toBe(true);
    expect(isUuid(v7)).toBe(true);
    expect(isUuid(v4.toUpperCase())).toBe(true);
    expect(isUuidV4(v4)).toBe(true);
    expect(isUuidV4(v4.toUpperCase())).toBe(true);
    expect(isUuidV4(v1)).toBe(false);
    expect(isUuidV4(v7)).toBe(false);
  });

  it('rejects the nil UUID, bad variants, non-strings and look-alikes', () => {
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(isUuid('3f2504e0-4f89-41d3-ca0c-0305e82c3301')).toBe(false); // variant nibble c
    expect(isUuid('3f2504e04f8941d39a0c0305e82c3301')).toBe(false); // no dashes
    expect(isUuid(' 3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuidV4(undefined)).toBe(false);
    expect(UUID_REGEX.test('3f2504e0-4f89-91d3-9a0c-0305e82c3301')).toBe(false); // version 9
    expect(UUID_V4_REGEX.test('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    // The deterministic test ids of the harness are valid v4 ids.
    expect(isUuidV4('00000000-0000-4000-8000-000000000001')).toBe(true);
    // crypto.randomUUID output always passes both checks.
    for (let i = 0; i < 20; i++) expect(isUuidV4(globalThis.crypto.randomUUID())).toBe(true);
  });

  it('newToken makes 32-character base64url tokens from 24 bytes, unique and URL-safe', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const token = newToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      tokens.add(token);
    }
    expect(tokens.size).toBe(50);
    expect(newToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken(0)).toBe('');
    expect(() => newToken(-1)).toThrow(RangeError);
    expect(() => newToken(1.5)).toThrow(RangeError);
  });

  it('toBase64Url swaps the alphabet and strips padding', () => {
    expect(toBase64Url('+/+/==')).toBe('-_-_');
    expect(toBase64Url('TQ==')).toBe('TQ');
    expect(toBase64Url('TWFu')).toBe('TWFu');
  });
});
