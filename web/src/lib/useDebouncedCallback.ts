import { useCallback, useEffect, useMemo, useRef } from 'react';

export interface DebouncedCallback<A extends unknown[]> {
  (...args: A): void;
  /** Runs a pending call now. */
  flush(): void;
  /** Drops a pending call. */
  cancel(): void;
  pending(): boolean;
}

/**
 * Debounces `fn` by `delayMs`. The latest `fn` is always used; a pending call is flushed when the
 * component unmounts (so edits are not lost when navigating away).
 */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delayMs: number): DebouncedCallback<A> {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastArgs = useRef<A | null>(null);

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const args = lastArgs.current;
    lastArgs.current = null;
    if (args) fnRef.current(...args);
  }, []);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    lastArgs.current = null;
  }, []);

  useEffect(() => flush, [flush]);

  return useMemo(() => {
    const debounced = ((...args: A) => {
      lastArgs.current = args;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delayMs);
    }) as DebouncedCallback<A>;
    debounced.flush = flush;
    debounced.cancel = cancel;
    debounced.pending = () => lastArgs.current !== null;
    return debounced;
  }, [cancel, delayMs, flush]);
}
