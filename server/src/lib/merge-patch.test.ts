import { describe, expect, it } from 'vitest';
import { applyMergePatch } from './merge-patch.ts';
import { assertSafeJson, findUnsafeJson, isPlainObject, jsonByteLength } from './safe-json.ts';

describe('applyMergePatch (RFC 7396)', () => {
  // Examples from RFC 7396 Appendix A.
  const cases: [unknown, unknown, unknown][] = [
    [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
    [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
    [{ a: 'b' }, { a: null }, {}],
    [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
    [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
    [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
    [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
    [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
    [['a', 'b'], ['c', 'd'], ['c', 'd']],
    [{ a: 'b' }, ['c'], ['c']],
    [{ a: 'foo' }, null, null],
    [{ a: 'foo' }, 'bar', 'bar'],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [[1, 2], { a: 'b', c: null }, { a: 'b' }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ];

  it.each(cases)('merges %j with %j', (target, patch, expected) => {
    expect(applyMergePatch(structuredClone(target), patch)).toEqual(expected);
  });

  it('never aliases arrays from the patch', () => {
    const patch = { list: [{ x: 1 }] };
    const result = applyMergePatch({}, patch) as { list: { x: number }[] };
    result.list[0]!.x = 2;
    expect(patch.list[0]!.x).toBe(1);
  });

  it('rejects forbidden keys even when the caller skipped the safety check', () => {
    const hostile = JSON.parse('{"a":{"__proto__":{"polluted":true}}}') as unknown;
    expect(() => applyMergePatch({ a: {} }, hostile)).toThrow(/forbidden key/);
    expect(() => applyMergePatch({}, JSON.parse('{"constructor":{"prototype":{"polluted":1}}}'))).toThrow(/forbidden key/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('safe-json', () => {
  it('finds forbidden keys at any depth, including inside arrays', () => {
    expect(findUnsafeJson(JSON.parse('{"__proto__":{"x":1}}'))).toEqual({ reason: 'forbidden_key', path: '__proto__' });
    expect(findUnsafeJson(JSON.parse('{"a":[{"b":{"constructor":1}}]}'))).toEqual({ reason: 'forbidden_key', path: 'a.0.b.constructor' });
    expect(findUnsafeJson({ a: { prototype: 1 } })?.path).toBe('a.prototype');
    expect(findUnsafeJson({ a: [1, 'two', null, { ok: true }] })).toBeNull();
    // Values equal to forbidden words are fine; only keys matter.
    expect(findUnsafeJson({ name: '__proto__', list: ['constructor'] })).toBeNull();
  });

  it('rejects excessive nesting without recursion', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(findUnsafeJson(deep)?.reason).toBe('too_deep');
    expect(() => assertSafeJson(deep)).toThrow(/nested too deeply/);
    let ok: unknown = 1;
    for (let i = 0; i < 20; i++) ok = { child: ok };
    expect(() => assertSafeJson(ok)).not.toThrow();
  });

  it('assertSafeJson throws a 400 HttpError', () => {
    expect(() => assertSafeJson(JSON.parse('{"__proto__":1}'), 'Settings patch')).toThrow(
      expect.objectContaining({ status: 400, code: 'bad_request', message: 'Settings patch contains a forbidden key (__proto__)' }),
    );
  });

  it('isPlainObject / jsonByteLength', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(jsonByteLength({ a: 'é' })).toBe(Buffer.byteLength('{"a":"é"}'));
    expect(jsonByteLength(undefined)).toBe(0);
  });
});
