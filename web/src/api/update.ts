/**
 * Updating Portly (shared/src/update.ts, design/update-button.md): the newest release and how an
 * update run went (`GET /api/update`, which only asks GitHub at most hourly), asking again, and
 * starting one (`POST /api/update`, from Portly's own page only: the server refuses the Pages site).
 * Never persisted: an old answer must not offer an update or show a run. While a run is going the
 * query follows it, and a page that gets no answer keeps asking, because the server is meant to be
 * away for part of it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  UpdateRunSchema,
  UpdateStartResponseSchema,
  UpdateStatusResponseSchema,
  isUpdateRunActive,
  type UpdateRun,
  type UpdateStatusResponse,
} from '@portly/shared';
import { toastError } from '../ui/toast.ts';
import { apiGet, apiPost } from './client.ts';
import { qk } from './keys.ts';

// Tolerant readers: unknown extra fields from a newer server are dropped, not fatal.
const StatusReader = z.object({ ...UpdateStatusResponseSchema.shape, run: z.object(UpdateRunSchema.shape).nullable() });
const StartReader = z.object({ ...UpdateStartResponseSchema.shape, run: z.object(UpdateRunSchema.shape) });

/** How often a page asks while an update is going. */
export const UPDATE_POLL_MS = 2_000;

export async function fetchUpdateStatus(options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<UpdateStatusResponse> {
  const path = options.refresh === true ? '/api/update?refresh=1' : '/api/update';
  return StatusReader.parse(await apiGet<unknown>(path, { signal: options.signal }));
}

export function useUpdateStatus() {
  return useQuery({
    queryKey: qk.update(),
    queryFn: ({ signal }) => fetchUpdateStatus({ signal }),
    meta: { persist: false },
    retry: false,
    refetchInterval: (query) => {
      const run = query.state.data?.run ?? null;
      return run !== null && isUpdateRunActive(run) ? UPDATE_POLL_MS : false;
    },
    refetchIntervalInBackground: true,
  });
}

/** **Check again**: past the server's hourly cache, at most once a minute. */
export function useCheckForUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetchUpdateStatus({ refresh: true }),
    onSuccess: (status) => queryClient.setQueryData(qk.update(), status),
    onError: (error) => toastError(error),
  });
}

/** `POST /api/update`: the version the user was shown. The answer's run starts the following. */
export function useStartUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (version: string): Promise<UpdateRun> =>
      StartReader.parse(await apiPost<unknown>('/api/update', { version })).run,
    onSuccess: (run) => {
      queryClient.setQueryData<UpdateStatusResponse>(qk.update(), (status) => (status === undefined ? status : { ...status, run }));
    },
    onError: (error) => {
      toastError(error);
      // The newest release may have moved on: the card offers what is true now.
      void queryClient.invalidateQueries({ queryKey: qk.update() });
    },
  });
}
