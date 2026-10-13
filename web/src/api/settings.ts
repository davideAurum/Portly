/**
 * Settings queries and mutations (§7 Core). `PATCH /api/settings` takes an RFC 7396 merge patch
 * and returns the full Settings. Updates are applied optimistically to the cache (so theme and
 * format changes preview instantly) and rolled back if the server rejects them.
 */
import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { SettingsSchema, type Settings, type SettingsPatch } from '@homebase/shared';
import { applyMergePatch, canCombineMergePatches, combineMergePatches } from '../lib/mergePatch.ts';
import { useDebouncedCallback } from '../lib/useDebouncedCallback.ts';
import { toastError } from '../ui/toast.ts';
import { apiGet, apiPatch } from './client.ts';
import { qk } from './keys.ts';

export function fetchSettings(signal?: AbortSignal): Promise<Settings> {
  return apiGet<Settings>('/api/settings', { signal });
}

export function patchSettings(patch: SettingsPatch): Promise<Settings> {
  return apiPatch<Settings>('/api/settings', patch);
}

export function useSettings() {
  return useQuery({
    queryKey: qk.settings(),
    queryFn: ({ signal }) => fetchSettings(signal),
    staleTime: 60_000,
  });
}

/**
 * Applies `patch` to the cached settings (validated with SettingsSchema so the cache never holds
 * an invalid shape). Returns the previous value for rollback.
 */
export function applySettingsPatchToCache(client: QueryClient, patch: SettingsPatch): Settings | undefined {
  const previous = client.getQueryData<Settings>(qk.settings());
  if (!previous) return previous;
  const next = SettingsSchema.safeParse(applyMergePatch(previous, patch));
  if (next.success) client.setQueryData(qk.settings(), next.data);
  return previous;
}

interface MutationContext {
  previous: Settings | undefined;
}

/** `PATCH /api/settings` with an optimistic cache update and rollback + toast on failure. */
export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation<Settings, Error, SettingsPatch, MutationContext>({
    mutationFn: patchSettings,
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: qk.settings() });
      return { previous: applySettingsPatchToCache(client, patch) };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) client.setQueryData(qk.settings(), context.previous);
      toastError(error, 'Settings could not be saved.');
    },
    onSuccess: (settings) => {
      client.setQueryData(qk.settings(), settings);
    },
  });
}

export interface SettingsAutosave {
  /** Applies `patch` to the cache now and saves it (debounced). */
  save(patch: SettingsPatch): void;
  /** Sends any pending changes immediately. */
  flush(): void;
  /** True while a save is in flight or waiting. */
  saving: boolean;
}

/**
 * Live-preview autosave for continuous controls (sliders, color pickers): every change hits the
 * cache immediately; the network PATCH is debounced.
 *
 * Unsent patches wait in a queue and go out one request at a time, in order (a slider drag must
 * not arrive out of order). A new patch is folded into the last queued one only when that is
 * equivalent to sending both — a reset (`null`) followed by an edit is not, so both are sent.
 * Every server response replaces the cache and the still-queued edits are re-applied on top; a
 * failed save restores the last confirmed settings. The queue is drained by a plain async loop,
 * not per-call mutation callbacks, so edits made just before the page unmounts are still saved.
 */
export function useSettingsAutosave(delayMs = 400): SettingsAutosave {
  const client = useQueryClient();
  const queue = useRef<SettingsPatch[]>([]);
  /** Settings as the server last confirmed them (the cache before the first unsaved edit). */
  const confirmed = useRef<Settings | undefined>(undefined);
  const draining = useRef(false);
  const [saving, setSaving] = useState(false);

  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    try {
      while (queue.current.length > 0) {
        const patch = queue.current.shift()!;
        try {
          const saved = await patchSettings(patch);
          confirmed.current = saved;
          client.setQueryData(qk.settings(), saved);
        } catch (error) {
          if (confirmed.current) client.setQueryData(qk.settings(), confirmed.current);
          toastError(error, 'Settings could not be saved.');
        }
        // The cache now holds the server's view; keep the edits that are still queued on top.
        for (const queued of queue.current) applySettingsPatchToCache(client, queued);
      }
    } finally {
      draining.current = false;
      setSaving(false);
    }
  }, [client]);

  const debounced = useDebouncedCallback(() => void drain(), delayMs);

  const save = useCallback(
    (patch: SettingsPatch) => {
      // A settings refetch in flight would overwrite the optimistic value with the old one.
      void client.cancelQueries({ queryKey: qk.settings() });
      const before = applySettingsPatchToCache(client, patch);
      if (queue.current.length === 0 && !draining.current) confirmed.current = before;
      const last = queue.current.at(-1);
      if (last !== undefined && canCombineMergePatches(last, patch)) {
        queue.current[queue.current.length - 1] = combineMergePatches(last, patch) as SettingsPatch;
      } else {
        queue.current.push(patch);
      }
      setSaving(true);
      debounced();
    },
    [client, debounced],
  );

  return { save, flush: debounced.flush, saving };
}
