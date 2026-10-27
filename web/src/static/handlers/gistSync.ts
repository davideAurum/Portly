/**
 * Static backend: the GitHub token for launch pad sync through gists
 * (docs/design/launchpad-sync-gist.md). Browser backend only: the server has no such route, and
 * Settings → Accounts offers GitHub only when the page's data lives in this browser.
 *
 * - `GET /api/sync/gist/token` → `{configured}` (never the token);
 * - `PUT /api/sync/gist/token` `{token}` → checked with GitHub (`validateGistToken`), then saved;
 * - `DELETE /api/sync/gist/token` → removes the token and the remembered gist ids.
 *
 * The sync engine is not wired up yet: saving the token syncs nothing so far.
 */
import { z } from 'zod';
import { parseJsonBody } from '../lib/validate.ts';
import { clearGistToken, hasGistToken, normalizeGistToken, storeGistToken, validateGistToken } from '../providers/gistToken.ts';
import { json } from '../respond.ts';
import type { StaticRouter } from '../router.ts';

export interface GistTokenStatus {
  configured: boolean;
}

const GistTokenUpdateSchema = z.object({ token: z.string().trim().min(1).max(300) });

export function register(router: StaticRouter): void {
  router.get('/api/sync/gist/token', (ctx) => {
    const body: GistTokenStatus = { configured: hasGistToken(ctx) };
    return json(body);
  });

  router.put('/api/sync/gist/token', async (ctx, { req }) => {
    const { token: raw } = await parseJsonBody(req, GistTokenUpdateSchema);
    const token = normalizeGistToken(raw);
    await validateGistToken(token, { signal: req.signal });
    await storeGistToken(ctx, token);
    const body: GistTokenStatus = { configured: true };
    return json(body);
  });

  router.delete('/api/sync/gist/token', async (ctx) => {
    await clearGistToken(ctx);
    const body: GistTokenStatus = { configured: false };
    return json(body);
  });
}
