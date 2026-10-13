import { describe, expect, it } from 'vitest';
import { StaticApiError } from '../respond.ts';
import { FORBIDDEN_KEYS, MAX_JSON_DEPTH, assertSafeJson, findUnsafeJson, isPlainObject, jsonByteLength } from './safeJson.ts';

describe('safeJson', () => {
  it('finds forbidden keys at any depth, including inside arrays', () => {
    expect(findUnsafeJson(JSON.parse('{"__proto__":{"x":1}}'))).toEqual({ reason: 'forbidden_key', path: '__proto__' });
    expect(findUnsafeJson(JSON.parse('{"a":[{"b":{"constructor":1}}]}'))).toEqual({ reason: 'forbidden_key', path: 'a.0.b.constructor' });
    expect(findUnsafeJson({ a: { prototype: 1 } })?.path).toBe('a.prototype');
    expect(findUnsafeJson({ a: [1, 'two', null, { ok: true }] })).toBeNull();
    // Values equal to forbidden words are fine; only keys matter.
    expect(findUnsafeJson({ name: '__proto__', list: ['constructor'] })).toBeNull();
    expect([...FORBIDDEN_KEYS].sort()).toEqual(['__proto__', 'constructor', 'prototype']);
  });

  it('rejects excessive nesting without recursion', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(findUnsafeJson(deep)?.reason).toBe('too_deep');
    expect(() => assertSafeJson(deep)).toThrow(/nested too deeply/);
    let ok: unknown = 1;
    for (let i = 0; i < 20; i++) ok = { child: ok };
    expect(() => assertSafeJson(ok)).not.toThrow();
    // Exactly MAX_JSON_DEPTH containers are fine; one more is not.
    let edge: unknown = 1;
    for (let i = 0; i < MAX_JSON_DEPTH; i++) edge = { c: edge };
    expect(findUnsafeJson(edge)).toBeNull();
    expect(findUnsafeJson({ c: edge })?.reason).toBe('too_deep');
    expect(findUnsafeJson([], 0)).toEqual({ reason: 'too_deep', path: '(root)' });
  });

  it('assertSafeJson throws a 400 StaticApiError with the server message', () => {
    let caught: unknown;
    try {
      assertSafeJson(JSON.parse('{"__proto__":1}'), 'Settings patch');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StaticApiError);
    expect(caught).toMatchObject({ code: 'bad_request', message: 'Settings patch contains a forbidden key (__proto__)' });
    expect((caught as StaticApiError).toResponse().status).toBe(400);
    expect(() => assertSafeJson({ ok: 1 })).not.toThrow();
    expect(() => assertSafeJson('scalar')).not.toThrow();
    expect(() => assertSafeJson(null)).not.toThrow();
  });

  it('isPlainObject / jsonByteLength', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    // `{"a":"é"}` is 9 characters but 10 UTF-8 bytes.
    expect(jsonByteLength({ a: 'é' })).toBe(10);
    expect(jsonByteLength({ a: '😀' })).toBe(12);
    expect(jsonByteLength(undefined)).toBe(0);
    expect(jsonByteLength(() => 1)).toBe(0);
    expect(jsonByteLength([1, 2])).toBe(5);
  });
});
