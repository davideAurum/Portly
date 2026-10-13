/// <reference types="vite/client" />

/** App version (root package.json), injected by Vite `define`. */
declare const __APP_VERSION__: string;

/** Date this version was last updated (`YYYY-MM-DD`, last commit date), injected by Vite `define`. */
declare const __APP_UPDATED__: string;

/**
 * True in the browser-only (Pages) build (`vite build --mode static`): the API is answered by the
 * in-browser static backend (`src/static/`), or by the Portly server on this PC in hybrid mode.
 * Injected by Vite `define`; UI code reads `getCapabilities()` from `src/capabilities.ts` instead,
 * so tests can drive it with `setCapabilitiesForTests`.
 */
declare const __PORTLY_STATIC__: boolean;

/**
 * Origin of the Portly server on this PC that the Pages build may use instead of its in-browser
 * backend (hybrid mode), e.g. `http://127.0.0.1:5757`; `''` turns hybrid mode off and is always
 * `''` in the server build. Injected by Vite `define`; read it through `src/localServer/config.ts`.
 */
declare const __PORTLY_LOCAL_SERVER__: string;
