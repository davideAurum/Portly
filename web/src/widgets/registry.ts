/**
 * Widget registry (§10.3): every widget definition, in "Add widget" order.
 */
import { WIDGET_TYPES, type KnownWidgetType } from '@portly/shared';
import { getCapabilities, isWidgetTypeAvailable, unavailableWidgetTypes, type Capabilities } from '../capabilities.ts';
import { definition as calendar } from './calendar/index.ts';
import { definition as clock } from './clock/index.ts';
import { definition as feeds } from './feeds/index.ts';
import { definition as launchpad } from './launchpad/index.ts';
import { definition as mail } from './mail/index.ts';
import { definition as search } from './search/index.ts';
import { definition as sports } from './sports/index.ts';
import { definition as todoist } from './todoist/index.ts';
import type { AnyWidgetDefinition, StackSizing, WidgetDefinition } from './types.ts';
import { definition as weather } from './weather/index.ts';

/** In "Add widget" order. */
export const WIDGET_DEFINITIONS: readonly AnyWidgetDefinition[] = Object.freeze([
  search,
  launchpad,
  calendar,
  mail,
  todoist,
  weather,
  feeds,
  sports,
  clock,
]);

const byType = new Map<string, AnyWidgetDefinition>(WIDGET_DEFINITIONS.map((d) => [d.type, d]));

if (byType.size !== WIDGET_TYPES.length || !WIDGET_TYPES.every((t) => byType.has(t))) {
  throw new Error('Widget registry is out of sync with WIDGET_TYPES');
}

const availableCache = new WeakMap<Capabilities, readonly AnyWidgetDefinition[]>();

/**
 * The widgets this page load can run (all of them on the server backend; the in-browser backend
 * has no calendar, mail or feeds, see `capabilities.ts`), in registry order. "Add widget" and the
 * default layout use this list; `getWidgetDefinition` still knows every type so persisted layouts
 * keep their titles. Read at render time; the same array for the same capabilities.
 */
export function availableWidgetDefinitions(caps: Capabilities = getCapabilities()): readonly AnyWidgetDefinition[] {
  const cached = availableCache.get(caps);
  if (cached !== undefined) return cached;
  const unavailable = unavailableWidgetTypes(caps);
  const definitions = Object.freeze(WIDGET_DEFINITIONS.filter((d) => !unavailable.has(d.type)));
  availableCache.set(caps, definitions);
  return definitions;
}

export function getWidgetDefinition(type: string): AnyWidgetDefinition | undefined {
  return byType.get(type);
}

export function isRegisteredWidgetType(type: string): type is KnownWidgetType {
  return byType.has(type);
}

/** How an instance is sized in the narrow stacked layout (see `WidgetDefinition.stackSizing`). */
export function stackSizingOf(type: string, config: unknown): StackSizing {
  const definition = getWidgetDefinition(type);
  const sizing = definition?.stackSizing;
  if (!definition || sizing === undefined) return 'fixed';
  return typeof sizing === 'function' ? sizing(parseWidgetConfig(definition, config)) : sizing;
}

/** Parses a stored config with the widget's schema; invalid/old config falls back to defaults. */
export function parseWidgetConfig<C>(definition: WidgetDefinition<C>, raw: unknown): C {
  const parsed = definition.configSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  return definition.configSchema.parse({});
}

/** How long the first render may wait for widget chunks (they come from the HTTP cache). */
export const WIDGET_PRELOAD_CAP_MS = 150;

/**
 * Loads the code of the given widget types, waiting at most `capMs`. Widgets whose chunk is in by
 * then render on the first frame without a Suspense skeleton; the rest suspend as usual.
 */
export async function preloadWidgets(types: Iterable<string>, capMs: number = WIDGET_PRELOAD_CAP_MS): Promise<void> {
  // Types this page load cannot show (calendar/mail/feeds on the in-browser backend) render a notice: never load their code.
  const loads = [...new Set(types)]
    .filter((type) => isWidgetTypeAvailable(type))
    .map((type) => getWidgetDefinition(type)?.Component.preload?.().catch(() => undefined));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, capMs);
  });
  try {
    await Promise.race([Promise.all(loads).then(() => undefined), cap]);
  } finally {
    clearTimeout(timer);
  }
}
