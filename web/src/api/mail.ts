/**
 * Mail (§7 Mail, §10.8): `GET /api/mail/summary` per widget configuration and the message actions
 * (read/unread, archive, trash) as optimistic mutations. Summaries live under
 * `qk.mail.summary()` (+ the widget's parameters) — never persisted to localStorage (§5; the
 * `mail` root is excluded by the persister). Account changes invalidate `['mail']` (§7a).
 */
import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { MailAccountSummary } from '@homebase/shared';
import { toast, toastError, toastUndo } from '../ui/toast.ts';
import { apiGet, apiPath, apiPost, isApiError } from './client.ts';
import { qk } from './keys.ts';

export const MAIL_STALE_TIME_MS = 60_000;
export const MAIL_REFETCH_INTERVAL_MS = 5 * 60_000;

export interface MailSummaryParams {
  maxMessages: number;
  unreadOnly: boolean;
  accountIds: 'all' | readonly string[];
}

/** Query key of one widget's summary (prefix `qk.mail.summary()`). */
export function mailSummaryKey(params: MailSummaryParams) {
  const accountIds = params.accountIds === 'all' ? 'all' : [...params.accountIds].sort().join(',');
  return [...qk.mail.summary(), { maxMessages: params.maxMessages, unreadOnly: params.unreadOnly, accountIds }] as const;
}

export function mailSummaryPath(params: MailSummaryParams): string {
  const search = new URLSearchParams({ maxMessages: String(params.maxMessages), unreadOnly: String(params.unreadOnly) });
  if (params.accountIds !== 'all') search.set('accountIds', params.accountIds.join(','));
  return `/api/mail/summary?${search}`;
}

export function fetchMailSummary(params: MailSummaryParams, signal?: AbortSignal): Promise<MailAccountSummary[]> {
  return apiGet<MailAccountSummary[]>(mailSummaryPath(params), { signal });
}

export function useMailSummary(params: MailSummaryParams, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: mailSummaryKey(params),
    queryFn: ({ signal }) => fetchMailSummary(params, signal),
    staleTime: MAIL_STALE_TIME_MS,
    refetchInterval: MAIL_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    enabled: options.enabled ?? true,
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type MailActionKind = 'read' | 'unread' | 'archive' | 'trash';

export interface MailActionInput {
  accountId: string;
  messageId: string;
  action: MailActionKind;
}

export function postMailAction({ accountId, messageId, action }: MailActionInput): Promise<void> {
  const base = apiPath`/api/mail/${accountId}/messages/${messageId}`;
  if (action === 'read' || action === 'unread') return apiPost<void>(`${base}/read`, { read: action === 'read' });
  return apiPost<void>(`${base}/${action}`);
}

/** The summaries with `input` applied (pure; exported for tests). */
export function applyMailAction(summaries: readonly MailAccountSummary[], input: MailActionInput): MailAccountSummary[] {
  return summaries.map((summary) => {
    if (summary.accountId !== input.accountId) return summary;
    const target = summary.messages.find((m) => m.id === input.messageId);
    if (!target) return summary;
    if (input.action === 'read' || input.action === 'unread') {
      const unread = input.action === 'unread';
      if (target.unread === unread) return summary;
      return {
        ...summary,
        unread: Math.max(0, summary.unread + (unread ? 1 : -1)),
        messages: summary.messages.map((m) => (m.id === input.messageId ? { ...m, unread } : m)),
      };
    }
    return {
      ...summary,
      unread: Math.max(0, summary.unread - (target.unread ? 1 : 0)),
      messages: summary.messages.filter((m) => m.id !== input.messageId),
    };
  });
}

type Snapshot = [QueryKey, MailAccountSummary[] | undefined][];

function applyEverywhere(client: QueryClient, input: MailActionInput): void {
  client.setQueriesData<MailAccountSummary[]>({ queryKey: qk.mail.summary() }, (data) => (data ? applyMailAction(data, input) : data));
}

const DONE_MESSAGES: Readonly<Record<MailActionKind, string>> = Object.freeze({
  read: 'Marked as read',
  unread: 'Marked as unread',
  archive: 'Archived',
  trash: 'Moved to trash',
});

const FAILED_MESSAGES: Readonly<Record<MailActionKind, string>> = Object.freeze({
  read: 'The message could not be marked as read.',
  unread: 'The message could not be marked as unread.',
  archive: 'The message could not be archived.',
  trash: 'The message could not be moved to trash.',
});

/**
 * Optimistic mail actions (§10.7 #8): every mail summary in the cache is updated at once, rolled
 * back on failure; read/unread get a toast with Undo (the opposite action), archive/trash a plain
 * toast. A 404/409 means the list was out of date: the summaries are refetched.
 */
type MailActionVariables = MailActionInput & { silent?: boolean };

export function useMailActions() {
  const client = useQueryClient();
  // Undo runs the opposite action through the same mutation (toasts outlive the render).
  const mutateRef = useRef<((variables: MailActionVariables) => void) | null>(null);

  const mutation = useMutation<void, unknown, MailActionVariables, { snapshot: Snapshot }>({
    mutationFn: ({ silent: _silent, ...input }) => postMailAction(input),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: qk.mail.summary() });
      const snapshot = client.getQueriesData<MailAccountSummary[]>({ queryKey: qk.mail.summary() });
      applyEverywhere(client, input);
      return { snapshot };
    },
    onSuccess: (_data, { silent, ...input }) => {
      if (silent) return;
      if (input.action === 'read' || input.action === 'unread') {
        const undo: MailActionInput = { ...input, action: input.action === 'read' ? 'unread' : 'read' };
        toastUndo(DONE_MESSAGES[input.action], { onUndo: () => mutateRef.current?.({ ...undo, silent: true }) });
      } else {
        toast.success(DONE_MESSAGES[input.action]);
      }
    },
    onError: (error, input, context) => {
      for (const [key, data] of context?.snapshot ?? []) client.setQueryData(key, data);
      if (isApiError(error, 'conflict') || isApiError(error, 'not_found')) {
        toast.error('This message changed since the list was loaded. The list has been refreshed.');
      } else {
        toastError(error, FAILED_MESSAGES[input.action]);
      }
    },
    onSettled: () => client.invalidateQueries({ queryKey: qk.mail.summary() }),
  });

  const { mutate } = mutation;
  useEffect(() => {
    mutateRef.current = mutate;
  }, [mutate]);

  const run = useCallback((input: MailActionInput) => mutate(input), [mutate]);
  return { run, isPending: mutation.isPending };
}
