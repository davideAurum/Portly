// Stand-ins for the build-time constants web/vite.config.ts injects with `define`. The design-sync
// bundle is built by esbuild, not Vite, so they are set as globals before the UI kit loads.
// Values match the server build (not the Pages build), with no paired local server.
const g = globalThis as Record<string, unknown>;
g.__PORTLY_STATIC__ ??= false;
g.__PORTLY_LOCAL_SERVER__ ??= '';
g.__APP_VERSION__ ??= '0.2.0-alpha.1';
g.__APP_UPDATED__ ??= '';
