/**
 * Pure layout helpers for the dashboard grid (§10.2): conversion between stored widget
 * instances and react-grid-layout items, position diffs (only changed layouts are saved),
 * stacking order for narrow screens, and keyboard move/resize for the drag handle.
 */
import { cloneLayout, getCompactor, moveElement, type Layout as GridLayout, type LayoutItem } from 'react-grid-layout';
import { GRID_COLUMNS, MAX_GRID_ROW, MAX_WIDGET_HEIGHT, type WidgetInstance, type WidgetPosition } from '@homebase/shared';
import { getWidgetDefinition } from '../widgets/registry.ts';

export const ROW_HEIGHT = 40;
export const GRID_GAP = 12;

/** Min/max size for a widget type (unknown types: 1×1 minimum). */
export function sizeLimits(type: string): { minW: number; minH: number; maxW: number; maxH: number } {
  const size = getWidgetDefinition(type)?.defaultSize;
  const minW = Math.min(GRID_COLUMNS, size?.minW ?? 1);
  const minH = Math.min(MAX_WIDGET_HEIGHT, size?.minH ?? 1);
  return {
    minW,
    minH,
    maxW: Math.max(minW, Math.min(GRID_COLUMNS, size?.maxW ?? GRID_COLUMNS)),
    maxH: Math.max(minH, Math.min(MAX_WIDGET_HEIGHT, size?.maxH ?? MAX_WIDGET_HEIGHT)),
  };
}

export function toGridItems(items: readonly WidgetInstance[]): LayoutItem[] {
  return items.map((item) => ({ i: item.id, x: item.x, y: item.y, w: item.w, h: item.h, ...sizeLimits(item.type) }));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Grid items → the `PUT /positions` payload (integers, within the 12-column grid). */
export function toPositions(layout: GridLayout): WidgetPosition[] {
  return layout.map((l) => {
    const w = clampInt(l.w, 1, GRID_COLUMNS);
    return {
      id: l.i,
      x: clampInt(l.x, 0, GRID_COLUMNS - w),
      y: clampInt(l.y, 0, MAX_GRID_ROW),
      w,
      h: clampInt(l.h, 1, MAX_WIDGET_HEIGHT),
    };
  });
}

/** True when the grid layout differs from the stored positions (ignoring unknown ids). */
export function positionsChanged(items: readonly WidgetInstance[], positions: readonly WidgetPosition[]): boolean {
  const byId = new Map(items.map((i) => [i.id, i]));
  return positions.some((p) => {
    const item = byId.get(p.id);
    return item !== undefined && (item.x !== p.x || item.y !== p.y || item.w !== p.w || item.h !== p.h);
  });
}

/** Reading order used when widgets stack full-width on narrow screens: (y, x). */
export function stackOrder<T extends { x: number; y: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x);
}

function overlapsX(a: LayoutItem, b: LayoutItem): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w;
}

export type MoveKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export function isMoveKey(key: string): key is MoveKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
}

const compactor = getCompactor('vertical');

/**
 * Keyboard editing for the drag handle: arrows move a widget (left/right by one column; up/down
 * swap with the neighbour above/below), Shift+arrows resize it. Returns the new compacted
 * positions, or null when nothing changes.
 */
export function keyboardEdit(items: readonly WidgetInstance[], id: string, key: MoveKey, resize: boolean): WidgetPosition[] | null {
  const layout = cloneLayout(toGridItems(items)) as LayoutItem[];
  const item = layout.find((l) => l.i === id);
  if (!item) return null;
  const before = toPositions(compactor.compact(cloneLayout(layout), GRID_COLUMNS));

  let next: GridLayout = layout;
  if (resize) {
    const limits = { minW: item.minW ?? 1, maxW: item.maxW ?? GRID_COLUMNS, minH: item.minH ?? 1, maxH: item.maxH ?? MAX_WIDGET_HEIGHT };
    if (key === 'ArrowLeft') item.w = Math.max(limits.minW, item.w - 1);
    if (key === 'ArrowRight') item.w = Math.min(limits.maxW, GRID_COLUMNS - item.x, item.w + 1);
    if (key === 'ArrowUp') item.h = Math.max(limits.minH, item.h - 1);
    if (key === 'ArrowDown') item.h = Math.min(limits.maxH, item.h + 1);
  } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const x = key === 'ArrowLeft' ? item.x - 1 : item.x + 1;
    if (x < 0 || x + item.w > GRID_COLUMNS) return null;
    next = moveElement(layout, item, x, undefined, true, false, 'vertical', GRID_COLUMNS);
  } else {
    const others = layout.filter((l) => l.i !== id && overlapsX(l, item));
    if (key === 'ArrowUp') {
      const above = others.filter((l) => l.y + l.h <= item.y).sort((a, b) => b.y + b.h - (a.y + a.h))[0];
      if (!above) return null;
      next = moveElement(layout, item, undefined, above.y, true, false, 'vertical', GRID_COLUMNS);
    } else {
      const below = others.filter((l) => l.y >= item.y + item.h).sort((a, b) => a.y - b.y)[0];
      if (!below) return null;
      next = moveElement(layout, item, undefined, below.y + below.h, true, false, 'vertical', GRID_COLUMNS);
    }
  }

  const after = toPositions(compactor.compact(next, GRID_COLUMNS));
  const changed = after.some((p) => {
    const old = before.find((b) => b.id === p.id);
    return !old || old.x !== p.x || old.y !== p.y || old.w !== p.w || old.h !== p.h;
  });
  return changed ? after : null;
}
