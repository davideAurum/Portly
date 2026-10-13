/**
 * Build configuration of hybrid mode: the origin of the Portly server on this PC that the Pages
 * build may use instead of its in-browser backend (`PORTLY_STATIC_SERVER` at build time, e.g.
 * `http://127.0.0.1:5757`). `''` turns hybrid mode off; the server build always has `''`.
 */
import { STATIC_BUILD } from '../capabilities.ts';

/** Origin of the local Portly server (no trailing slash), or `''` when hybrid mode is off. */
export const LOCAL_SERVER_ORIGIN: string = __PORTLY_LOCAL_SERVER__;

/** True when this Pages build may look for, pair with and use the Portly server on this PC. */
export const HYBRID_ENABLED: boolean = STATIC_BUILD && LOCAL_SERVER_ORIGIN !== '';
