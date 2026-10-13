/**
 * Server health and About information (§7 Core). Health is polled so the shell can show the
 * vault-locked and server-unreachable banners; it is never persisted (a stale "locked" must not
 * flash on the next load).
 */
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { AboutResponseSchema, HealthResponseSchema, type AboutResponse, type HealthResponse } from '@portly/shared';
import { apiGet } from './client.ts';
import { qk } from './keys.ts';

// Tolerant readers: unknown extra fields from a newer server are dropped, not fatal.
const HealthReader = z.object(HealthResponseSchema.shape);
const AboutReader = z.object(AboutResponseSchema.shape);

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return HealthReader.parse(await apiGet<unknown>('/api/health', { signal }));
}

export async function fetchAbout(signal?: AbortSignal): Promise<AboutResponse> {
  return AboutReader.parse(await apiGet<unknown>('/api/about', { signal }));
}

export function useHealth() {
  return useQuery({
    queryKey: qk.health(),
    queryFn: ({ signal }) => fetchHealth(signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
    meta: { persist: false },
  });
}

export function useAbout() {
  return useQuery({
    queryKey: qk.about(),
    queryFn: ({ signal }) => fetchAbout(signal),
    staleTime: 60_000,
    meta: { persist: false },
  });
}
