/**
 * Flight tracker client (§7 Flights). The FlightAware key is write-only: the server only reports
 * `{configured}`. Each tracked flight is one query; how often it refetches follows the flight
 * (`flightRefreshMs`), and the server keeps each answer as long, so extra tabs cost nothing.
 */
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { flightRefreshMs, type FlightStatus, type FlightsKeyStatus } from '@portly/shared';
import { apiDelete, apiGet, apiPut } from './client.ts';
import { qk } from './keys.ts';

export function fetchFlightsKey(signal?: AbortSignal): Promise<FlightsKeyStatus> {
  return apiGet<FlightsKeyStatus>('/api/flights/key', { signal });
}

export function useFlightsKey(enabled = true) {
  return useQuery({ queryKey: qk.flights.key(), queryFn: ({ signal }) => fetchFlightsKey(signal), staleTime: 60_000, enabled });
}

/** `PUT /api/flights/key`: checked with FlightAware (a free call) before it is stored. */
export function useSaveFlightsKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => apiPut<FlightsKeyStatus>('/api/flights/key', { key }),
    onSuccess: async (status) => {
      client.setQueryData(qk.flights.key(), status);
      await client.invalidateQueries({ queryKey: qk.flights.all() });
    },
  });
}

export function useRemoveFlightsKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiDelete<FlightsKeyStatus>('/api/flights/key'),
    onSuccess: async () => {
      client.setQueryData<FlightsKeyStatus>(qk.flights.key(), { configured: false });
      client.removeQueries({ queryKey: ['flights', 'status'] });
      await client.invalidateQueries({ queryKey: qk.flights.all() });
    },
  });
}

export function fetchFlightStatus(ident: string, date: string, signal?: AbortSignal): Promise<FlightStatus> {
  return apiGet<FlightStatus>(`/api/flights/status?${new URLSearchParams({ ident, date }).toString()}`, { signal });
}

/** How long to wait before asking again (never more often than once a minute). */
export function flightRefetchMs(data: FlightStatus | undefined, now = Date.now()): number {
  if (data === undefined) return 5 * 60_000;
  return Math.max(60_000, flightRefreshMs(data, now));
}

/** One query per flight; off until the key is known to be saved. */
export function useFlightStatuses(flights: readonly { ident: string; date: string }[], enabled: boolean) {
  return useQueries({
    queries: flights.map((f) => ({
      queryKey: qk.flights.status(f.ident, f.date),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchFlightStatus(f.ident, f.date, signal),
      enabled,
      staleTime: (query: { state: { data: FlightStatus | undefined } }) => flightRefetchMs(query.state.data),
      refetchInterval: (query: { state: { data: FlightStatus | undefined } }) => flightRefetchMs(query.state.data),
      refetchOnWindowFocus: true,
      // Travel plans stay out of localStorage.
      meta: { persist: false },
    })),
  });
}
