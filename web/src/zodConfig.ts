/**
 * Global zod configuration for the browser. Must be the FIRST import of `main.tsx` so it runs
 * before any `@homebase/shared` contract or widget `configSchema` is constructed.
 *
 * §4.3: the page CSP has no 'unsafe-eval'. zod 4 otherwise probes `new Function('')` when the
 * first `z.object()` is built; the throw is caught, but the browser still reports a CSP violation.
 * `jitless` skips that probe and zod's eval-based fast path (the config lives on `globalThis`,
 * so it covers every zod copy).
 */
import { z } from 'zod';

z.config({ jitless: true });
