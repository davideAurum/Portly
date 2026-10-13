/**
 * `React.lazy` with a `preload()` (§10.3, §10.1 instant paint).
 *
 * A plain `lazy(() => import(…))` suspends on its first render even when the chunk is already in
 * the browser cache, because an `import()` promise never resolves synchronously — so every new
 * tab would first commit the Suspense skeleton of every widget, however warm the persisted query
 * cache. `lazyWithPreload` keeps the chunk split, but once `preload()` has finished, the lazy
 * factory hands React a thenable that resolves synchronously, and React renders the component
 * without suspending. main.tsx preloads the active profile's widgets before the first render.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export type PreloadableComponent<T extends ComponentType<any>> = LazyExoticComponent<T> & {
  /** Loads the chunk (once); resolves when the next render can use it without suspending. */
  preload(): Promise<void>;
};

export function lazyWithPreload<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>): PreloadableComponent<T> {
  let loaded: { default: T } | null = null;
  let pending: Promise<{ default: T }> | null = null;

  const load = (): Promise<{ default: T }> => {
    pending ??= factory().then(
      (module) => {
        loaded = module;
        return module;
      },
      (error: unknown) => {
        // A failed chunk load (e.g. offline dev server) can be retried by the next render.
        pending = null;
        throw error;
      },
    );
    return pending;
  };

  const Component = lazy(() => {
    const module = loaded;
    if (module) {
      // Resolves synchronously: React.lazy marks the component resolved before it would suspend.
      const thenable = { then: (resolve: (value: { default: T }) => void) => resolve(module) };
      return thenable as unknown as Promise<{ default: T }>;
    }
    return load();
  });

  return Object.assign(Component, { preload: () => load().then(() => undefined) });
}
