/**
 * `GET` / `PATCH /api/settings` of the static backend (§7 Core), mirroring the server's
 * SettingsService.patch (server/src/lib/settings.ts) and the route's `activeProfileId` special
 * case (server/src/modules/core/index.ts):
 *
 * 1. the body is any JSON (an empty body is `{}`; malformed → 400);
 * 2. `activeProfileId` is checked BEFORE merging: a string must name an existing profile (422
 *    `activeProfileId must reference an existing profile`), and `null` is rewritten to the first
 *    profile in display order (null only while there are no profiles) — the pointer never dangles;
 * 3. the patch must be a plain object (400 `A settings patch must be a JSON object`) without
 *    forbidden keys or excessive nesting (400);
 * 4. RFC 7396 merge into a `structuredClone` of the current settings (objects merge, arrays and
 *    scalars replace, `null` deletes the key so the schema default comes back);
 * 5. the result must pass the strict `SettingsSchema` (422 `Invalid settings` + details), then it
 *    is stored and returned in full. Nothing is written on any failure.
 */
import { SettingsSchema, type Settings } from '@portly/shared';
import type { StaticContext } from '../context.ts';
import { applyMergePatch } from '../lib/mergePatch.ts';
import { assertSafeJson, isPlainObject } from '../lib/safeJson.ts';
import { validate } from '../lib/validate.ts';
import { json, StaticApiError } from '../respond.ts';
import type { StaticRouter } from '../router.ts';
import { SLICE, getSettings, setSettings } from '../slices.ts';
import { firstProfileId, profileExists } from './profiles.ts';

/** The body as the server's `parseBody(c, z.unknown())` reads it: empty → `{}`, malformed → 400. */
async function readPatchBody(req: Request): Promise<unknown> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new StaticApiError('bad_request', 'Could not read request body');
  }
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StaticApiError('bad_request', 'Malformed JSON body');
  }
}

/** Steps 3–5 above (the SettingsService.patch port); also used by other handlers that patch settings. */
export async function patchSettings(ctx: StaticContext, patch: unknown): Promise<Settings> {
  if (!isPlainObject(patch)) throw new StaticApiError('bad_request', 'A settings patch must be a JSON object');
  assertSafeJson(patch, 'Settings patch');
  const merged = applyMergePatch(structuredClone(getSettings(ctx)), patch);
  const next = validate(SettingsSchema, merged, 'settings');
  setSettings(ctx, next);
  await ctx.state.commit(SLICE.settings);
  return next;
}

export function register(router: StaticRouter): void {
  router.get('/api/settings', (ctx) => json(getSettings(ctx)));

  router.patch('/api/settings', async (ctx, { req }) => {
    const patch = await readPatchBody(req);
    if (isPlainObject(patch) && Object.hasOwn(patch, 'activeProfileId')) {
      const requested = patch.activeProfileId;
      if (typeof requested === 'string' && !profileExists(ctx, requested)) {
        throw new StaticApiError('validation_failed', 'activeProfileId must reference an existing profile');
      }
      // `null` resets to the default, which is the first profile once any exists.
      if (requested === null) patch.activeProfileId = firstProfileId(ctx);
    }
    return json(await patchSettings(ctx, patch));
  });
}
