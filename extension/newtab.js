// @ts-check
/** New-tab entry point: wires the controller to the real browser APIs (ARCHITECTURE §11). */
import { createLauncher } from './lib/launcher.js';
import { createNewTabPage } from './lib/newtab-page.js';

const runtime = globalThis.chrome?.runtime;

const page = createNewTabPage({
  document,
  location: window.location,
  storage: globalThis.chrome?.storage?.local ?? null,
  fetch: window.fetch.bind(window),
  launcher: createLauncher(runtime),
  // The promise form (MV3): it rejects when no service worker listens, which the page tolerates.
  sendMessage: typeof runtime?.sendMessage === 'function' ? (message) => runtime.sendMessage(message) : null,
  extensionId: runtime?.id ?? null,
  hash: window.location.hash,
});

void page.start();
