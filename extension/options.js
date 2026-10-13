// @ts-check
/** Options page entry point: wires the controller to chrome.storage.local, fetch and the launcher. */
import { createLauncher } from './lib/launcher.js';
import { createOptionsPage } from './lib/options-page.js';

const storage = globalThis.chrome?.storage?.local;
if (!storage) throw new Error('chrome.storage.local is unavailable — open this page from the extension.');
const runtime = globalThis.chrome?.runtime;

const page = createOptionsPage({
  document,
  storage,
  fetch: window.fetch.bind(window),
  launcher: createLauncher(runtime),
  extensionId: runtime?.id ?? null,
});
void page.init();
