/**
 * Guards for untrusted JSON (request bodies, import files, widget configs) — the browser port of
 * server/src/lib/safe-json.ts with identical semantics and messages.
 *
 * `JSON.parse` turns `{"__proto__": …}` into an *own* property named `__proto__`, which becomes
 * a prototype-pollution vector as soon as some code merges or copies it naively. Every JSON value
 * that is merged, stored opaquely or re-served is therefore checked for the keys `__proto__`,
 * `constructor` and `prototype` at any depth (§7 Core), and for excessive nesting. Violations are
 * `StaticApiError('bad_request', …)`; the dispatch loop turns them into the 400 response.
 */
import { StaticApiError } from '../respond.ts';

export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Deepest object/array nesting accepted in untrusted JSON. */
export const MAX_JSON_DEPTH = 64;

export interface UnsafeJson {
  reason: 'forbidden_key' | 'too_deep';
  /** Dotted path of the offending key / container (e.g. `general.__proto__`). */
  path: string;
}

/** True for `{}`-style objects (Object.prototype or null prototype), false for arrays and class instances. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Finds the first forbidden key or over-deep container in `value` (iterative, so hostile
 * nesting cannot overflow the stack). Returns null when the value is safe.
 */
export function findUnsafeJson(value: unknown, maxDepth = MAX_JSON_DEPTH): UnsafeJson | null {
  const stack: { value: unknown; depth: number; path: string }[] = [{ value, depth: 0, path: '' }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || item.value === null || typeof item.value !== 'object') continue;
    if (item.depth >= maxDepth) return { reason: 'too_deep', path: item.path || '(root)' };
    if (Array.isArray(item.value)) {
      item.value.forEach((child, index) => {
        stack.push({ value: child, depth: item.depth + 1, path: item.path ? `${item.path}.${index}` : String(index) });
      });
      continue;
    }
    for (const key of Object.keys(item.value)) {
      const path = item.path ? `${item.path}.${key}` : key;
      if (FORBIDDEN_KEYS.has(key)) return { reason: 'forbidden_key', path };
      stack.push({ value: (item.value as Record<string, unknown>)[key], depth: item.depth + 1, path });
    }
  }
  return null;
}

/** Throws 400 `bad_request` when `value` holds a forbidden key or is nested too deeply. */
export function assertSafeJson(value: unknown, what = 'Request body'): void {
  const problem = findUnsafeJson(value);
  if (!problem) return;
  const message =
    problem.reason === 'forbidden_key'
      ? `${what} contains a forbidden key (${problem.path})`
      : `${what} is nested too deeply (${problem.path})`;
  throw new StaticApiError('bad_request', message);
}

const UTF8 = new TextEncoder();

/** Serialized size of a JSON value in bytes (UTF-8); 0 for values JSON cannot represent. */
export function jsonByteLength(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : UTF8.encode(text).length;
}
