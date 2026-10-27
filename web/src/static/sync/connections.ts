/**
 * The sync connections of this browser (docs/design/launchpad-sync.md section 6.10): Microsoft
 * connections with the Launch pad sync service switched on, and the GitHub repository and token.
 * Exactly one is used; the scheduler syncs with nothing while there are more, and the account and
 * GitHub routes refuse to set up a second one.
 */
import type { StaticContext } from '../context.ts';
import { hasGitHubSync } from '../providers/githubSync.ts';
import { StaticApiError } from '../respond.ts';
import { getAccounts, type StoredAccount } from '../slices.ts';

export interface SyncConnections {
  /** Microsoft connections with the service on. */
  accounts: StoredAccount[];
  /** The GitHub repository and token are saved. */
  github: boolean;
}

export function syncConnections(ctx: StaticContext): SyncConnections {
  const accounts = getAccounts(ctx).filter((a) => a.capabilities.includes('launchpadSync') && a.enabledCapabilities.includes('launchpadSync'));
  return { accounts, github: hasGitHubSync(ctx) };
}

/** How the page names the connection that already syncs (for a refusal). */
function describe(connections: SyncConnections, exceptAccountId: string | null): string | null {
  if (connections.github) return 'GitHub';
  const other = connections.accounts.find((a) => a.id !== exceptAccountId);
  return other ? other.label : null;
}

/**
 * The sync connection other than `exceptAccountId` (or GitHub, when `github` is false), named for
 * the user; null when there is none.
 */
export function otherSyncConnection(ctx: StaticContext, except: { accountId?: string; github?: boolean }): string | null {
  const connections = syncConnections(ctx);
  if (except.github) return describe({ accounts: connections.accounts, github: false }, null);
  return describe(connections, except.accountId ?? null);
}

/** 409 `conflict`: launch pad sync already uses another connection in this browser. */
export function secondSyncConnection(name: string): StaticApiError {
  return new StaticApiError('conflict', `Launch pad sync already uses ${name} in this browser. Turn it off there first: a browser syncs through one connection.`, {
    reason: 'sync_connection_in_use',
  });
}
