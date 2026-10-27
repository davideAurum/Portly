/**
 * Handler modules of the static backend. Each module exports `register(router)` and optionally
 * `ready(ctx)` (first-run seeding, asset registration, orphan cleanup). Listed in the server's
 * route order so unknown-route and method errors read the same; `unavailable` goes last because
 * it only stubs the server-only features. A `ready()` that fails is logged and recorded as this
 * browser's `backend` event (ARCHITECTURE §17: the module and the error's name).
 */
import { recordClientEvent } from '../../diagnostics/clientLog.ts';
import type { StaticContext } from '../context.ts';
import type { StaticRouter } from '../router.ts';
import * as accounts from './accounts.ts';
import * as bookmarks from './bookmarks.ts';
import * as calendar from './calendar.ts';
import * as core from './core.ts';
import * as githubSync from './githubSync.ts';
import * as profiles from './profiles.ts';
import * as search from './search.ts';
import * as settings from './settings.ts';
import * as sports from './sports.ts';
import * as todoist from './todoist.ts';
import * as transfer from './transfer.ts';
import * as unavailable from './unavailable.ts';
import * as uploads from './uploads.ts';
import * as weather from './weather.ts';

export interface HandlerModule {
  /** Adds the module's routes. */
  register(router: StaticRouter): void;
  /** Runs once after the persisted state is loaded (seeding, registering image object URLs). */
  ready?(ctx: StaticContext): Promise<void> | void;
}

export const MODULES: readonly HandlerModule[] = Object.freeze([
  core,
  settings,
  profiles,
  uploads,
  transfer,
  bookmarks,
  search,
  weather,
  sports,
  todoist,
  githubSync,
  accounts,
  calendar,
  unavailable,
]);

/** Module names for diagnostic events (`ready <name>`). */
const MODULE_NAMES: ReadonlyMap<HandlerModule, string> = new Map<HandlerModule, string>([
  [core, 'core'],
  [settings, 'settings'],
  [profiles, 'profiles'],
  [uploads, 'uploads'],
  [transfer, 'transfer'],
  [bookmarks, 'bookmarks'],
  [search, 'search'],
  [weather, 'weather'],
  [sports, 'sports'],
  [todoist, 'todoist'],
  [githubSync, 'githubSync'],
  [accounts, 'accounts'],
  [calendar, 'calendar'],
  [unavailable, 'unavailable'],
]);

function errorName(err: unknown): string {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  return typeof name === 'string' ? name : typeof err;
}

export function registerRoutes(router: StaticRouter): void {
  for (const module of MODULES) module.register(router);
}

/**
 * Runs every module's `ready()` in order. Seeding, healing, orphan cleanup and object-URL
 * registration are best effort: one module failing (a full disk, a record it cannot read) is
 * logged and must not keep the backend — and with it the whole app — from starting.
 */
export async function onBackendReady(ctx: StaticContext, modules: readonly HandlerModule[] = MODULES): Promise<void> {
  for (const module of modules) {
    try {
      await module.ready?.(ctx);
    } catch (err) {
      console.error('[Portly] A part of the in-browser backend could not finish starting', err);
      recordClientEvent('error', 'backend', 'a part of the in-browser backend could not finish starting', { errName: errorName(err), op: `ready ${MODULE_NAMES.get(module) ?? 'module'}` });
    }
  }
}
