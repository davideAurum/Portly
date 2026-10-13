/**
 * RFC 7396 JSON Merge Patch with the SERVER's semantics (port of server/src/lib/merge-patch.ts),
 * used by the static `PATCH /api/settings` (§7 Core):
 *
 * - an object patch merges key by key into the target (a non-object target becomes `{}`);
 * - `null` removes the key (for settings: the key falls back to its schema default);
 * - arrays and scalars replace the target value;
 * - a forbidden key (`__proto__`, `constructor`, `prototype`) or nesting deeper than
 *   {@link MAX_JSON_DEPTH} is `400 bad_request`, exactly like the server. (The UI's own
 *   web/src/lib/mergePatch.ts silently drops forbidden keys and must not be used by the backend.)
 *
 * Callers pass a `structuredClone` of the current value as `target` (it is modified in place and
 * returned) and should have checked the patch with `assertSafeJson` first; forbidden keys are
 * rejected here again as defense in depth.
 */
import { StaticApiError } from '../respond.ts';
import { FORBIDDEN_KEYS, MAX_JSON_DEPTH, isPlainObject } from './safeJson.ts';

export function applyMergePatch(target: unknown, patch: unknown): unknown {
  return merge(target, patch, 0);
}

function merge(target: unknown, patch: unknown, depth: number): unknown {
  if (depth > MAX_JSON_DEPTH) throw new StaticApiError('bad_request', 'Patch is nested too deeply');
  if (!isPlainObject(patch)) {
    // Arrays and scalars replace; copy so the result never aliases the caller's patch.
    return patch !== null && typeof patch === 'object' ? structuredClone(patch) : patch;
  }
  const result: Record<string, unknown> = isPlainObject(target) ? target : {};
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_KEYS.has(key)) throw new StaticApiError('bad_request', `Patch contains a forbidden key (${key})`);
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
