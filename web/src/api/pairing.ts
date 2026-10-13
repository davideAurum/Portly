/**
 * Paired browsers (hybrid mode): the configured Pages address and the pairings
 * (`GET /api/pairings`) and revoking one (`DELETE /api/pairings/:id`), from Homebase's own page or
 * the paired Pages site; approving a pairing request (`POST /api/pairings`, then back to the Pages
 * site with the token in the fragment) only on Homebase's own page. The list is never persisted:
 * it must always show what the server trusts now.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  PairingCreateResponseSchema,
  PairingSummarySchema,
  PairingsResponseSchema,
  parsePairingReturn,
  type PairingCreateResponse,
  type PairingsResponse,
} from '@homebase/shared';
import { assignLocation, safeHref } from '../lib/openUrl.ts';
import { toastError } from '../ui/toast.ts';
import { apiDelete, apiGet, apiPath, apiPost, isApiError } from './client.ts';
import { qk } from './keys.ts';

// Tolerant readers: unknown extra fields from a newer server are dropped, not fatal.
const PairingsReader = z.object({ ...PairingsResponseSchema.shape, pairings: z.array(z.object(PairingSummarySchema.shape)) });
const PairingCreateReader = z.object(PairingCreateResponseSchema.shape);

export async function fetchPairings(signal?: AbortSignal): Promise<PairingsResponse> {
  return PairingsReader.parse(await apiGet<unknown>('/api/pairings', { signal }));
}

export function usePairings() {
  return useQuery({
    queryKey: qk.pairings(),
    queryFn: ({ signal }) => fetchPairings(signal),
    meta: { persist: false },
  });
}

/** `POST /api/pairings`: pairs the browser that asked with `nonce`; the server answers where to send it back. */
export async function createPairing(nonce: string): Promise<PairingCreateResponse> {
  return PairingCreateReader.parse(await apiPost<unknown>('/api/pairings', { nonce }));
}

/** The server's redirect after an approval was not a pairing answer for the Pages address it reported. */
export class PairingRedirectError extends Error {
  override name = 'PairingRedirectError';
}

/**
 * `redirectUrl` (normalized) when it is exactly `<pagesUrl>#/paired?…` with a well-formed answer
 * for `nonce` — an http(s) URL under the Pages address `GET /api/pairings` reported — else null.
 */
export function pairingRedirectTarget(redirectUrl: unknown, pagesUrl: string, nonce: string): string | null {
  const href = safeHref(redirectUrl, { allowAppRoutes: false });
  const base = safeHref(pagesUrl, { allowAppRoutes: false });
  if (href === undefined || base === undefined || !base.endsWith('/')) return null;
  const hashAt = href.indexOf('#');
  if (hashAt === -1 || href.slice(0, hashAt) !== base) return null;
  const answer = parsePairingReturn(href.slice(hashAt));
  return answer !== null && answer.nonce === nonce ? href : null;
}

/**
 * Approves a pairing request: creates the pairing, then sends this tab back to the Pages site
 * (same tab, like the OAuth start) — only to a redirect that {@link pairingRedirectTarget} accepts.
 */
export async function approvePairing(nonce: string, pagesUrl: string): Promise<void> {
  const { redirectUrl } = await createPairing(nonce);
  const target = pairingRedirectTarget(redirectUrl, pagesUrl, nonce);
  if (target === null || !assignLocation(target)) {
    throw new PairingRedirectError('Homebase answered with an unexpected address, so this page did not open it.');
  }
}

export function useApprovePairing() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ nonce, pagesUrl }: { nonce: string; pagesUrl: string }) => approvePairing(nonce, pagesUrl),
    // The pairing may exist although this tab stays (e.g. a refused redirect): show it in the list.
    onError: () => client.invalidateQueries({ queryKey: qk.pairings() }),
  });
}

export function revokePairing(id: string): Promise<void> {
  return apiDelete(apiPath`/api/pairings/${id}`);
}

export function useRevokePairing() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        await revokePairing(id);
      } catch (error) {
        // Already gone (revoked in another tab, or replaced by a newer pairing): nothing left to do.
        if (!isApiError(error, 'not_found')) throw error;
      }
    },
    onError: (error) => toastError(error, 'The browser could not be unpaired.'),
    onSettled: () => client.invalidateQueries({ queryKey: qk.pairings() }),
  });
}
