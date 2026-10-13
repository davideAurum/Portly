import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Three projects: server (node env; server + shared tests), web (jsdom env; UI) and static
// (node env; the browser-only build's in-browser backend, which uses only platform APIs Node 24
// also has — Request/Response/Blob/BroadcastChannel/URL.createObjectURL — plus fake-indexeddb.
// It runs under node rather than jsdom because jsdom's Blob does not survive structured cloning).
// No live network in tests: server code receives fakes through createTestContext().
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/src/**/*.test.ts', 'shared/src/**/*.test.ts'],
          restoreMocks: true,
        },
      },
      {
        plugins: [react()],
        define: {
          __APP_VERSION__: JSON.stringify('0.0.0-test'),
          __APP_UPDATED__: JSON.stringify('2026-01-15T14:30:00Z'),
          // UI tests call `setCapabilitiesForTests` (src/capabilities.ts) when they need the Pages build.
          __HOMEBASE_STATIC__: 'false',
          __HOMEBASE_LOCAL_SERVER__: JSON.stringify(''),
        },
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['web/src/**/*.test.{ts,tsx}'],
          exclude: ['web/src/static/**'],
          setupFiles: ['web/src/test/setup.ts'],
          restoreMocks: true,
        },
      },
      {
        define: {
          __APP_VERSION__: JSON.stringify('0.0.0-test'),
          __APP_UPDATED__: JSON.stringify('2026-01-15T14:30:00Z'),
          __HOMEBASE_STATIC__: 'true',
          __HOMEBASE_LOCAL_SERVER__: JSON.stringify(''),
        },
        test: {
          name: 'static',
          environment: 'node',
          include: ['web/src/static/**/*.test.ts'],
          setupFiles: ['web/src/static/test/setup.ts'],
          restoreMocks: true,
        },
      },
    ],
  },
});
