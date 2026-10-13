/**
 * Core routes of the static backend: health and about. (Settings, profiles, uploads and
 * export/import are added by the core-data handlers.)
 */
import type { AboutResponse, HealthResponse } from '@homebase/shared';
import type { StaticContext } from '../context.ts';
import { json } from '../respond.ts';
import type { StaticRouter } from '../router.ts';

export function register(router: StaticRouter): void {
  router.get('/api/health', (ctx) => json({ ok: true, version: ctx.version, vault: 'ready' } satisfies HealthResponse));

  router.get('/api/about', (ctx) =>
    json({
      version: ctx.version,
      dataDir: ctx.state.storage.kind === 'indexeddb' ? 'This browser (IndexedDB)' : 'This browser (memory only — nothing is saved)',
      logPath: 'Browser console',
      vault: 'ready',
    } satisfies AboutResponse),
  );
}

export async function ready(_ctx: StaticContext): Promise<void> {
  // Nothing to seed for health/about.
}
