/**
 * Vault reset (§4.6): deletes every stored secret and creates a new key. Everything that depends
 * on a secret is refetched afterwards.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost } from './client.ts';
import { invalidateAccountData, qk } from './keys.ts';

export function resetVault(): Promise<unknown> {
  return apiPost<unknown>('/api/vault/reset');
}

export function useResetVault() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: resetVault,
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: qk.health() }),
        client.invalidateQueries({ queryKey: qk.about() }),
        client.invalidateQueries({ queryKey: qk.oauthClients.all() }),
        client.invalidateQueries({ queryKey: qk.todoist.all() }),
        invalidateAccountData(client),
      ]);
    },
  });
}
