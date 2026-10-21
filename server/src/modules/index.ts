/**
 * Static list of all modules (§6). Each module registers into its own sub-app; the sub-app is
 * mounted only when `register()` completed. A module whose `register()` throws is logged and every
 * route under its prefixes answers 503 `module_unavailable` — the rest of the app keeps working.
 * Those 503 answers are declared `paired()` so the Pages site (hybrid mode) sees the outage too.
 */
import { Hono } from 'hono';
import type { AppContext, AppEnv, ModuleStatus, RegisterModule } from '../context.ts';
import { moduleUnavailable } from '../lib/errors.ts';
import { errorFields } from '../lib/logger.ts';
import { paired } from '../lib/routes.ts';
import * as accounts from './accounts/index.ts';
import * as bookmarks from './bookmarks/index.ts';
import * as calendar from './calendar/index.ts';
import * as core from './core/index.ts';
import * as devices from './devices/index.ts';
import * as diagnostics from './diagnostics/index.ts';
import * as feeds from './feeds/index.ts';
import * as mail from './mail/index.ts';
import * as pairing from './pairing/index.ts';
import * as search from './search/index.ts';
import * as sports from './sports/index.ts';
import * as todoist from './todoist/index.ts';
import * as weather from './weather/index.ts';

export interface ModuleEntry {
  name: string;
  /** Route prefixes owned by the module (503 when the module failed to register). */
  prefixes: readonly string[];
  register: RegisterModule;
}

export const MODULES: readonly ModuleEntry[] = Object.freeze([
  { name: 'core', prefixes: core.prefixes, register: core.register },
  { name: 'accounts', prefixes: accounts.prefixes, register: accounts.register },
  { name: 'bookmarks', prefixes: bookmarks.prefixes, register: bookmarks.register },
  { name: 'search', prefixes: search.prefixes, register: search.register },
  { name: 'weather', prefixes: weather.prefixes, register: weather.register },
  { name: 'todoist', prefixes: todoist.prefixes, register: todoist.register },
  { name: 'calendar', prefixes: calendar.prefixes, register: calendar.register },
  { name: 'mail', prefixes: mail.prefixes, register: mail.register },
  { name: 'feeds', prefixes: feeds.prefixes, register: feeds.register },
  { name: 'sports', prefixes: sports.prefixes, register: sports.register },
  { name: 'pairing', prefixes: pairing.prefixes, register: pairing.register },
  { name: 'devices', prefixes: devices.prefixes, register: devices.register },
  { name: 'diagnostics', prefixes: diagnostics.prefixes, register: diagnostics.register },
]);

export type { ModuleStatus } from '../context.ts';

export function registerModules(
  app: Hono<AppEnv>,
  ctx: AppContext,
  modules: readonly ModuleEntry[] = MODULES,
): ModuleStatus[] {
  const statuses: ModuleStatus[] = [];
  for (const mod of modules) {
    const sub = new Hono<AppEnv>();
    try {
      mod.register(sub, ctx);
      app.route('/', sub);
      statuses.push({ name: mod.name, ok: true });
    } catch (err) {
      ctx.log.error('module failed to register; its routes answer 503', {
        module: mod.name,
        ...errorFields(err, { stack: true }),
      });
      const unavailable = moduleUnavailable(`The ${mod.name} module is unavailable`);
      for (const prefix of mod.prefixes) {
        app.all(prefix, paired(), unavailable);
        app.all(`${prefix}/*`, paired(), unavailable);
      }
      statuses.push({ name: mod.name, ok: false });
    }
  }
  return statuses;
}
