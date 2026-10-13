/**
 * Shell tests (grid, seeding, header) use the real widget definitions — type, title, icon,
 * sizes and config schema — with stand-in components, so they neither depend on nor break with
 * the widgets' own implementations (which render real data and make their own API calls).
 *
 *   vi.mock('../widgets/registry.ts', async (importOriginal) => {
 *     const { stubWidgetRegistry } = await import('../test/stubWidgets.tsx');
 *     return stubWidgetRegistry(await importOriginal());
 *   });
 */
import type { ComponentType } from 'react';
import type * as Registry from '../widgets/registry.ts';
import type { AnyWidgetDefinition, WidgetProps, WidgetSettingsProps } from '../widgets/types.ts';

type RegistryModule = typeof Registry;

/** Text every stand-in widget renders: `Stub widget: <type>`. */
export function stubWidgetText(type: string): string {
  return `Stub widget: ${type}`;
}

function makeStub(type: string): ComponentType<WidgetProps<unknown>> {
  function StubWidget() {
    return <p>{stubWidgetText(type)}</p>;
  }
  StubWidget.displayName = `StubWidget(${type})`;
  return StubWidget;
}

function StubSettings(_props: WidgetSettingsProps<unknown>) {
  return <p>Widget-specific settings</p>;
}

export interface StubOverrides {
  /** Replace a stand-in with a custom test component (e.g. one that calls setConfig). */
  components?: Record<string, ComponentType<WidgetProps<never>>>;
}

export function stubWidgetRegistry(actual: RegistryModule, overrides: StubOverrides = {}): RegistryModule {
  const definitions: AnyWidgetDefinition[] = actual.WIDGET_DEFINITIONS.map((definition) => ({
    ...definition,
    Component: (overrides.components?.[definition.type] ?? makeStub(definition.type)) as AnyWidgetDefinition['Component'],
    Settings: StubSettings as unknown as AnyWidgetDefinition['Settings'],
  }));
  const byType = new Map(definitions.map((d) => [d.type, d]));
  return {
    ...actual,
    WIDGET_DEFINITIONS: Object.freeze(definitions),
    getWidgetDefinition: (type: string) => byType.get(type),
    isRegisteredWidgetType: ((type: string) => byType.has(type)) as RegistryModule['isRegisteredWidgetType'],
  };
}
