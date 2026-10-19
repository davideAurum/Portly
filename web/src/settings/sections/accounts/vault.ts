/** The credential vault's lock as Settings → Accounts sees it. */
import { useHealth } from '../../../api/about.ts';
import { getCapabilities } from '../../../capabilities.ts';

/**
 * True while the server cannot read its vault: stored passwords and tokens cannot be used, and a
 * sign-in cannot store new ones. Never on the in-browser backend, which has no vault.
 */
export function useVaultLocked(): boolean {
  const health = useHealth();
  return getCapabilities().vault && health.data?.vault === 'locked';
}
