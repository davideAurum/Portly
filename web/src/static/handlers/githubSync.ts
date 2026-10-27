/**
 * Static backend: the private GitHub repository and token for launch pad sync
 * (docs/design/launchpad-sync-github.md). Browser backend only: the server has no such route, and
 * Settings → Accounts offers GitHub only when the page's data lives in this browser.
 *
 * - `GET /api/sync/github` → `{configured}` (never the token or the repository);
 * - `PUT /api/sync/github` `{repository, token}` → checked with GitHub (`validateGitHubSync`), then
 *   saved;
 * - `DELETE /api/sync/github` → removes both. The repository stays on GitHub.
 *
 * Launch pad sync (`sync/scheduler.ts`) picks them up at its next check, when they are this
 * browser's only sync connection.
 */
import { z } from 'zod';
import { parseJsonBody } from '../lib/validate.ts';
import { clearGitHubSync, hasGitHubSync, normalizeGitHubToken, normalizeRepository, storeGitHubSync, validateGitHubSync } from '../providers/githubSync.ts';
import { json } from '../respond.ts';
import type { StaticRouter } from '../router.ts';

export interface GitHubSyncStatus {
  configured: boolean;
}

const GitHubSyncUpdateSchema = z.object({
  repository: z.string().trim().min(1).max(200),
  token: z.string().trim().min(1).max(300),
});

export function register(router: StaticRouter): void {
  router.get('/api/sync/github', (ctx) => {
    const body: GitHubSyncStatus = { configured: hasGitHubSync(ctx) };
    return json(body);
  });

  router.put('/api/sync/github', async (ctx, { req }) => {
    const raw = await parseJsonBody(req, GitHubSyncUpdateSchema);
    const repository = normalizeRepository(raw.repository);
    const token = normalizeGitHubToken(raw.token);
    await validateGitHubSync(token, repository, { signal: req.signal });
    await storeGitHubSync(ctx, token, repository);
    const body: GitHubSyncStatus = { configured: true };
    return json(body);
  });

  router.delete('/api/sync/github', async (ctx) => {
    await clearGitHubSync(ctx);
    const body: GitHubSyncStatus = { configured: false };
    return json(body);
  });
}
