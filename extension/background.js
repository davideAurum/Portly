// @ts-check
/**
 * Service worker (module). When the browser starts — and when the extension is installed,
 * updated or reloaded — it checks whether Portly answers and, if not, asks the Portly
 * launcher (native messaging host com.portly.launcher) to start it, so Portly is usually
 * ready by the time the first new tab opens. A new tab that opens the Pages site asks for the
 * same warm-up with a {type: 'portly:warm-up'} message (at most once a minute). See
 * lib/warm-up.js.
 *
 * Clicking the toolbar button opens Portly in a new tab with the current page in its Add
 * bookmark dialog (lib/add-page.js).
 *
 * The listeners are registered synchronously at the top level, as MV3 requires.
 */
import { registerAddPage } from './lib/add-page.js';
import { registerWarmUp } from './lib/warm-up.js';

/** @param {'info' | 'warn'} level @param {string} message */
const log = (level, message) => console[level](`[Portly] ${message}`);

registerWarmUp(chrome, {
  fetch: (input, init) => fetch(input, init),
  log,
});
registerAddPage(chrome, { log });
