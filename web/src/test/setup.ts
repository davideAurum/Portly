/**
 * Vitest setup for the web project (jsdom): jest-dom matchers, DOM cleanup and the browser APIs
 * jsdom lacks (matchMedia, ResizeObserver, pointer capture, scrollIntoView) that Radix and
 * react-grid-layout use. No test may reach the network: API calls go through
 * renderWithProviders' mocks. After every test it also restores the build's own capabilities
 * (`setCapabilitiesForTests(null)`), unplugs any local server controller and forgets the browser's
 * diagnostic events (`resetClientLogForTests`).
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// UI tests render lazily loaded widgets and Radix portals; under a parallel full-suite run
// jsdom is slow enough that the 1 s / 5 s defaults cause flaky timeouts.
configure({ asyncUtilTimeout: 4000 });
vi.setConfig({ testTimeout: 20_000 });

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

if (typeof globalThis.ResizeObserver !== 'function') {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
}

// Radix primitives call these on pointer interactions; jsdom does not implement them.
const elementProto = Element.prototype as Element & {
  hasPointerCapture?: (id: number) => boolean;
  releasePointerCapture?: (id: number) => void;
  setPointerCapture?: (id: number) => void;
};
elementProto.hasPointerCapture ??= () => false;
elementProto.releasePointerCapture ??= () => {};
elementProto.setPointerCapture ??= () => {};
if (typeof Element.prototype.scrollIntoView !== 'function') Element.prototype.scrollIntoView = () => {};

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  document.documentElement.removeAttribute('style');
  for (const attr of ['data-theme', 'data-font', 'data-density']) document.documentElement.removeAttribute(attr);
  // Imported here, not at the top: what this file imports is loaded before the test file's
  // `vi.mock` calls run, so in a suite that mocks a module these depend on they would keep the
  // real one. (Tests set capabilities through `setCapabilitiesForTests`, not `vi.mock`.)
  const [{ setCapabilitiesForTests }, { resetLocalServerStoreForTests }, clientLog] = await Promise.all([
    import('../capabilities.ts'),
    import('../localServer/store.ts'),
    import('../diagnostics/clientLog.ts'),
  ]);
  setCapabilitiesForTests(null);
  resetLocalServerStoreForTests();
  try {
    clientLog.resetClientLogForTests();
  } catch {
    // A suite that mocks clientLog.ts without this export has no real event ring to reset.
  }
});
