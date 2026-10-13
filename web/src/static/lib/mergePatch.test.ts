import { describe, expect, it } from 'vitest';
import { StaticApiError } from '../respond.ts';
import { applyMergePatch } from './mergePatch.ts';

describe('applyMergePatch (RFC 7396, server semantics)', () => {
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

  it('modifies the target in place and returns it', () => {
    const target = { a: 1, b: { c: 2 } };
    const result = applyMergePatch(target, { b: { d: 3 } });
    expect(result).toBe(target);
    expect(target).toEqual({ a: 1, b: { c: 2, d: 3 } });
  });

  it('never aliases arrays or objects from the patch', () => {
    const patch = { list: [{ x: 1 }] };
    const result = applyMergePatch({}, patch) as { list: { x: number }[] };
    result.list[0]!.x = 2;
    expect(patch.list[0]!.x).toBe(1);
    // A non-object target replaced by an object patch is a fresh object too.
    const nested = { inner: 1 };
    const out = applyMergePatch({ a: 5 }, { a: nested }) as { a: { inner: number } };
    expect(out.a).not.toBe(nested);
    expect(out.a).toEqual({ inner: 1 });
  });

  it('deletes nested nulls like the server (defaultLocationPatch case)', () => {
    const current = { weather: { defaultLocation: { name: 'Old', lat: 1, lon: 2, admin1: 'X', country: 'Y', timezone: 'Z' } } };
    const patch = { weather: { defaultLocation: { name: 'New', lat: 3, lon: 4, admin1: null, country: null, timezone: null } } };
    expect(applyMergePatch(structuredClone(current), patch)).toEqual({ weather: { defaultLocation: { name: 'New', lat: 3, lon: 4 } } });
  });

  it('rejects forbidden keys with 400 even when the caller skipped the safety check', () => {
    const hostile = JSON.parse('{"a":{"__proto__":{"polluted":true}}}') as unknown;
    expect(() => applyMergePatch({ a: {} }, hostile)).toThrow(/forbidden key/);
    expect(() => applyMergePatch({}, JSON.parse('{"constructor":{"prototype":{"polluted":1}}}'))).toThrow(/forbidden key/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    let caught: unknown;
    try {
      applyMergePatch({}, JSON.parse('{"prototype":1}'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StaticApiError);
    expect(caught).toMatchObject({ code: 'bad_request', message: 'Patch contains a forbidden key (prototype)' });
  });

  it('rejects patches nested deeper than 64 levels with 400', () => {
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 66; i++) deep = { k: deep };
    let caught: unknown;
    try {
      applyMergePatch({}, deep);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StaticApiError);
    expect(caught).toMatchObject({ code: 'bad_request', message: 'Patch is nested too deeply' });
    let fine: unknown = { leaf: 1 };
    for (let i = 0; i < 20; i++) fine = { k: fine };
    expect(() => applyMergePatch({}, fine)).not.toThrow();
  });
});
