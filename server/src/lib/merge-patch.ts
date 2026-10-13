/**
 * RFC 7396 JSON Merge Patch (used by `PATCH /api/settings`, §7 Core).
 *
 * - An object patch merges key by key into the target (a non-object target becomes `{}`);
 * - `null` removes the key (for settings: the key falls back to its schema default);
 * - arrays and scalars replace the target value.
 *
 * Callers pass a `structuredClone` of the current value as `target` (it is modified in place and
 * returned) and must have checked the patch with `assertSafeJson` first; forbidden keys are
 * rejected here again as defense in depth.
 */
import { HttpError } from './errors.ts';
import { FORBIDDEN_KEYS, MAX_JSON_DEPTH, isPlainObject } from './safe-json.ts';

export function applyMergePatch(target: unknown, patch: unknown): unknown {
  return merge(target, patch, 0);
}

function merge(target: unknown, patch: unknown, depth: number): unknown {
  if (depth > MAX_JSON_DEPTH) throw new HttpError(400, 'bad_request', 'Patch is nested too deeply');
  if (!isPlainObject(patch)) {
    // Arrays and scalars replace; copy so the result never aliases the caller's patch.
    return patch !== null && typeof patch === 'object' ? structuredClone(patch) : patch;
  }
  const result: Record<string, unknown> = isPlainObject(target) ? target : {};
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_KEYS.has(key)) throw new HttpError(400, 'bad_request', `Patch contains a forbidden key (${key})`);
    const value = patch[key];
    if (value === null) {
      delete result[key];
      continue;
    }
    const current = Object.hasOwn(result, key) ? result[key] : undefined;
    result[key] = merge(current, value, depth + 1);
  }
  return result;
}
