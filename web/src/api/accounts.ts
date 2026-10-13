/**
 * Accounts, OAuth clients and OAuth start (§7 Accounts, §4.7). Account create/delete/reconnect
 * invalidates ['accounts'], ['calendar'] and ['mail'] (§7a). Secrets are sent once and never
 * read back.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_OAUTH_RETURN_TO,
  type Account,
  type AccountCreateResult,
  type AccountTestResult,
  type AccountUpdate,
  type CaldavAccountCreate,
  type ImapAccountCreate,
  type OAuthClientInfo,
  type OAuthClientUpdate,
  type OAuthProvider,
  type OAuthStart,
  type OAuthStartResponse,
  type YahooAccountCreate,
} from '@portly/shared';
import { assignLocation, isAppRoute } from '../lib/openUrl.ts';
import { toastError } from '../ui/toast.ts';
import { apiDelete, apiGet, apiPatch, apiPath, apiPost, apiPut } from './client.ts';
import { invalidateAccountData, qk } from './keys.ts';

export function fetchAccounts(signal?: AbortSignal): Promise<Account[]> {
  return apiGet<Account[]>('/api/accounts', { signal });
}

export function useAccounts(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.accounts(),
    queryFn: ({ signal }) => fetchAccounts(signal),
    staleTime: 60_000,
    enabled: options.enabled ?? true,
  });
}

/** One account by id (the account list is only fetched when an id is given). */
export function useAccount(accountId: string | undefined): Account | undefined {
  const accounts = useAccounts({ enabled: accountId !== undefined });
  return accountId === undefined ? undefined : accounts.data?.find((a) => a.id === accountId);
}

export function useUpdateAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: AccountUpdate & { id: string }) => apiPatch<Account>(apiPath`/api/accounts/${id}`, body),
    onMutate: async ({ id, ...body }) => {
      await client.cancelQueries({ queryKey: qk.accounts() });
      const previous = client.getQueryData<Account[]>(qk.accounts());
      if (previous) {
        client.setQueryData<Account[]>(
          qk.accounts(),
          previous.map((a) => (a.id === id ? { ...a, ...body, color: body.color === undefined ? a.color : body.color } : a)),
        );
      }
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) client.setQueryData(qk.accounts(), context.previous);
      toastError(error, 'The account could not be updated.');
    },
    // Enabled capabilities change what calendar/mail show.
    onSettled: () => invalidateAccountData(client),
  });
}

export function useDeleteAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(apiPath`/api/accounts/${id}`),
    onError: (error) => toastError(error, 'The account could not be removed.'),
    onSettled: () => invalidateAccountData(client),
  });
}

export function testAccount(id: string): Promise<AccountTestResult> {
  return apiPost<AccountTestResult>(apiPath`/api/accounts/${id}/test`);
}

export function useTestAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: testAccount,
    onSettled: () => client.invalidateQueries({ queryKey: qk.accounts() }),
  });
}

// ---------------------------------------------------------------------------
// App-password / server accounts
// ---------------------------------------------------------------------------

export type AccountCreateKind = 'yahoo' | 'caldav' | 'imap';

export interface AccountCreatePayloads {
  yahoo: YahooAccountCreate;
  caldav: CaldavAccountCreate;
  imap: ImapAccountCreate;
}

export function createAccount<K extends AccountCreateKind>(kind: K, body: AccountCreatePayloads[K]): Promise<AccountCreateResult> {
  return apiPost<AccountCreateResult>(apiPath`/api/accounts/${kind}`, body);
}

export function useCreateAccount<K extends AccountCreateKind>(kind: K) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: AccountCreatePayloads[K]) => createAccount(kind, body),
    onSuccess: () => invalidateAccountData(client),
  });
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export function useOAuthClient(provider: OAuthProvider) {
  return useQuery({
    queryKey: qk.oauthClients.detail(provider),
    queryFn: ({ signal }) => apiGet<OAuthClientInfo>(apiPath`/api/oauth-clients/${provider}`, { signal }),
    staleTime: 5 * 60_000,
  });
}

export function useSaveOAuthClient(provider: OAuthProvider) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: OAuthClientUpdate) => apiPut<unknown>(apiPath`/api/oauth-clients/${provider}`, body),
    onSettled: () => client.invalidateQueries({ queryKey: qk.oauthClients.detail(provider) }),
  });
}

/** The hash route to come back to after OAuth: the current one when valid, else Accounts. */
export function currentReturnTo(): string {
  const hash = window.location.hash;
  if (hash === '' || hash === '#') return '#/';
  return isAppRoute(hash) ? hash : DEFAULT_OAUTH_RETURN_TO;
}

/**
 * Starts the OAuth flow in the same tab (§4.7): `POST /api/oauth/:provider/start` then
 * `location.assign(authorizeUrl)` — only if the server returned an http(s) URL.
 */
export async function startOAuth(provider: OAuthProvider, options: OAuthStart = {}): Promise<void> {
  const body: OAuthStart = { returnTo: options.returnTo ?? currentReturnTo() };
  if (options.accountId !== undefined) body.accountId = options.accountId;
  const { authorizeUrl } = await apiPost<OAuthStartResponse>(apiPath`/api/oauth/${provider}/start`, body);
  if (!assignLocation(authorizeUrl)) throw new Error('The server returned an invalid sign-in URL.');
}

export function useStartOAuth() {
  return useMutation({
    mutationFn: ({ provider, ...options }: OAuthStart & { provider: OAuthProvider }) => startOAuth(provider, options),
    onError: (error) => toastError(error, 'Could not start the sign-in.'),
  });
}
