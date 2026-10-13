/**
 * RFC 7396 JSON Merge Patch, as the server applies it to settings (§7 Core): objects merge,
 * arrays and scalars replace, `null` removes the key (the schema then restores its default).
 * Used for optimistic cache updates; prototype-polluting keys are ignored.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return structuredClone(patch);
  const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (value === null) delete result[key];
    else result[key] = applyMergePatch(result[key], value);
  }
  return result;
}

/**
 * Whether {@link combineMergePatches}(a, b) is equivalent to applying `a` then `b`. It is not when
 * `b` merges an object into a key that `a` resets (`null`) or replaces with a non-object: applied
 * in order, `b` lands on the reset value; combined, it would merge into the original value and
 * the reset would be lost.
 */
export function canCombineMergePatches(a: unknown, b: unknown): boolean {
  if (!isPlainObject(b)) return true;
  if (!isPlainObject(a)) return false;
  return Object.entries(b).every(
    ([key, value]) => FORBIDDEN_KEYS.has(key) || !Object.hasOwn(a, key) || canCombineMergePatches(a[key], value),
  );
}

/**
 * Deep-merges two merge patches so that applying the result equals applying `a` then `b` (check
 * {@link canCombineMergePatches} first).
 */
export function combineMergePatches(a: unknown, b: unknown): unknown {
  if (!isPlainObject(a) || !isPlainObject(b)) return structuredClone(b);
  const result: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    result[key] = key in result && isPlainObject(value) && isPlainObject(result[key]) ? combineMergePatches(result[key], value) : value;
  }
  return result;
}
