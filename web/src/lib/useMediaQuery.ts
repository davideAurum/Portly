import { useCallback, useSyncExternalStore } from 'react';

/** Live `matchMedia(query).matches`. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Below 768 px widgets stack full-width and edit mode is disabled (§10.2). */
export const NARROW_QUERY = '(max-width: 767px)';

export function useIsNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY);
}
