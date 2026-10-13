/**
 * Widget contract (§10.3). Each `widgets/<type>/index.ts` exports `definition: WidgetDefinition<C>`.
 * `configSchema` must default every field so that `configSchema.parse({})` succeeds; the config is
 * parsed on every read (invalid/old config → defaults).
 */
import type { ComponentType, LazyExoticComponent } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { z } from 'zod';

export interface WidgetSize {
  w: number;
  h: number;
  minW: number;
  minH: number;
  maxW?: number;
  maxH?: number;
}

export interface WidgetProps<C> {
  instanceId: string;
  config: C;
  /** Merges `patch` into the stored config (PATCH /api/profiles/:id/widgets/:instanceId). */
  setConfig(patch: Partial<C>): Promise<void>;
  /** Current grid size in cells. */
  size: { w: number; h: number };
  editMode: boolean;
}

export interface WidgetSettingsProps<C> {
  value: C;
  onChange(next: C): void;
}

export interface WidgetDefinition<C> {
  type: string;
  title: string;
  description: string;
  icon: LucideIcon;
  defaultSize: WidgetSize;
  /** zod schema with every field defaulted. */
  configSchema: z.ZodType<C>;
  /**
   * `lazyWithPreload(() => import('./Widget.tsx'))` (a React.lazy with `preload()`, see
   * lazyWidget.ts) so a new tab can load the active profile's widgets before its first render.
   */
  Component: LazyExoticComponent<ComponentType<WidgetProps<C>>> & { preload?: () => Promise<void> };
  Settings?: LazyExoticComponent<ComponentType<WidgetSettingsProps<C>>>;
  /**
   * Height in the narrow (< 768 px) stacked layout: 'fixed' (default) keeps the grid rows'
   * height (clock, weather and search pick their layout tier from it); 'content' sizes the card
   * to its content up to 70 % of the viewport, so a list is not a small scroll box inside a
   * scrolling page.
   */
  stackSizing?: StackSizing | ((config: C) => StackSizing);
}

export type StackSizing = 'fixed' | 'content';

/**
 * A definition of any widget type. The registry is heterogeneous and `WidgetDefinition<C>` is
 * invariant in `C`, so `any` is the only sound top type here; consumers parse config with the
 * definition's own `configSchema` before use.
 */
export type AnyWidgetDefinition = WidgetDefinition<any>;
