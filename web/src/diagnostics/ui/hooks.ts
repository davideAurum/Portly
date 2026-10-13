/**
 * Hooks of the Diagnostics panels: this browser's events (live, from `clientLog.ts`), whether
 * verbose logging is on (for the settings navigation's badge), and a debounced value (the log
 * search field asks the server once the user pauses typing).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useDiagnosticsSummary } from '../../api/diagnostics.ts';
import { getCapabilities } from '../../capabilities.ts';
import { useNow } from '../../lib/useNow.ts';
import { getClientEvents, subscribeClientEvents, type ClientLogEntry } from '../clientLog.ts';

/** This browser's recorded events, oldest first; re-renders when any tab records, marks or clears one. */
export function useClientEvents(): readonly ClientLogEntry[] {
  return useSyncExternalStore(subscribeClientEvents, getClientEvents, getClientEvents);
}

/**
 * Whether the server logs verbosely now. Reads the diagnostics summary (fetched once when the
 * settings navigation mounts, then shared with the Diagnostics page, which keeps it fresh); false
 * on the in-browser backend, while it loads, when it fails, and once a timed verbose has ended.
 */
export function useVerboseLogging(): boolean {
  const server = getCapabilities().backend === 'server';
  const summary = useDiagnosticsSummary({ enabled: server, refetchInterval: false });
  const now = useNow(30_000);
  const level = summary.data?.logLevel;
  if (!server || level === undefined || !level.verbose) return false;
  return level.until === null || Date.parse(level.until) > now.getTime();
}

/** `value`, once it has not changed for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (Object.is(value, debounced)) return;
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, debounced, delayMs]);
  return debounced;
}
