/**
 * Static backend: launch pad sync's state for the Accounts page, Settings → Bookmarks and the
 * import preview (docs/design/launchpad-sync.md section 10). Browser backend only.
 *
 * - `GET /api/sync/launchpad` → {@link LaunchpadSyncInfo}: the sync connection in use (one
 *   Microsoft connection with the service on, or GitHub; null when there is none or more than one,
 *   design 6.10), the status of the last round and when things moved. Never a file's content, the
 *   repository name or a token.
 * - `POST /api/sync/launchpad/now` `{choice?}` → syncs now (waits for another tab's round, ignores
 *   backoff); `choice` answers the first-sync question (6.6). Then the same answer as `GET`.
 */
import { z } from 'zod';
import type { LaunchpadSyncConnection, LaunchpadSyncInfo } from '../../api/launchpadSync.ts';
import type { StaticContext } from '../context.ts';
import { parseJsonBody } from '../lib/validate.ts';
import { json, StaticApiError } from '../respond.ts';
import type { StaticRouter } from '../router.ts';
import { getLaunchpadSync } from '../slices.ts';
import { syncSources } from '../sync/scheduler.ts';

const SyncNowSchema = z.object({ choice: z.enum(['use_synced', 'replace_synced']).optional() }).strict();

const iso = (ms: number | null): string | null => (ms === null || ms <= 0 ? null : new Date(ms).toISOString());

/**
 * What the page shows about launch pad sync in this browser. The stored state is the last
 * check's, so it is read against the connections set up now: a connection no round has used yet
 * is "not synced yet", whatever another one left.
 */
export async function launchpadSyncInfo(ctx: StaticContext): Promise<LaunchpadSyncInfo> {
  const sources = await syncSources(ctx);
  const source = sources.length === 1 ? sources[0]! : null;
  let connection: LaunchpadSyncConnection | null = null;
  if (source) connection = source.kind === 'github' ? { kind: 'github' } : { kind: 'microsoft', accountId: source.account.id, label: source.account.label };
  const state = getLaunchpadSync(ctx);
  const current = source !== null && state.sourceId === source.id;
  let status = state.status;
  if (sources.length === 0) status = 'off';
  else if (sources.length > 1) status = 'several_sources';
  else if (!current) status = status === 'paused_reauth' ? status : 'off';
  else if (status === 'off' || status === 'several_sources') status = state.syncedAt !== null ? 'up_to_date' : 'off';
  return {
    connection,
    connections: sources.length,
    status,
    problem: current ? state.problem : null,
    running: ctx.launchpadSync?.running() ?? false,
    waiting: state.waiting,
    syncedAt: current ? iso(state.syncedAt) : null,
    receivedAt: current ? iso(state.receivedAt) : null,
    sentAt: current ? iso(state.sentAt) : null,
    retryAt: current && state.retryAt > ctx.now() ? iso(state.retryAt) : null,
  };
}

export function register(router: StaticRouter): void {
  // Another tab's changes are already reloaded here (StaticState); reloading again could undo a
  // round's changes this tab holds in memory.
  router.get('/api/sync/launchpad', async (ctx) => json(await launchpadSyncInfo(ctx)));

  router.post('/api/sync/launchpad/now', async (ctx, { req }) => {
    const { choice } = await parseJsonBody(req, SyncNowSchema);
    const sync = ctx.launchpadSync;
    if (!sync) throw new StaticApiError('not_configured', 'Launch pad sync is not running on this page.');
    await sync.syncNow(choice);
    return json(await launchpadSyncInfo(ctx));
  });
}
