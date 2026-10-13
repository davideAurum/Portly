/**
 * Vitest setup for the `static` project (node environment): a global IndexedDB from
 * fake-indexeddb, and zod in jitless mode like the browser (`web/src/zodConfig.ts`). Tests that
 * need an isolated database pass `new IDBFactory()` to `IndexedDbStorage.open`. After every test
 * it restores the build's own capabilities (the Pages build on its browser backend), unplugs any
 * local server controller and forgets the browser's diagnostic events (`resetClientLogForTests`).
 */
import 'fake-indexeddb/auto';
import '../../zodConfig.ts';
import { afterEach } from 'vitest';

afterEach(async () => {
  // Imported here, not at the top, for the same reason as in `web/src/test/setup.ts`: a suite
  // that mocks `capabilities.ts` must not find modules already bound to the real one.
  const [{ setCapabilitiesForTests }, { resetLocalServerStoreForTests }, clientLog] = await Promise.all([
    import('../../capabilities.ts'),
    import('../../localServer/store.ts'),
    import('../../diagnostics/clientLog.ts'),
  ]);
  setCapabilitiesForTests(null);
  resetLocalServerStoreForTests();
  try {
    clientLog.resetClientLogForTests();
  } catch {
    // A suite that mocks clientLog.ts without this export has no real event ring to reset.
  }
});
