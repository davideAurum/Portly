import { describe, expect, it } from 'vitest';
import { widget } from '../test/fixtures.ts';
import { getWidgetDefinition } from '../widgets/registry.ts';
import { keyboardEdit, positionsChanged, sizeLimits, stackOrder, toGridItems, toPositions } from './layout.ts';

// Unknown widget types (1×1 minimum) keep these tests independent of the widgets' own sizes.
const a = widget('a', 'x-a', 0, 0, 4, 3);
const b = widget('b', 'x-b', 0, 3, 4, 5);
const c = widget('c', 'x-c', 4, 0, 4, 4);

function pos(positions: ReturnType<typeof keyboardEdit>, id: string) {
  return positions?.find((p) => p.id === id);
}

describe('grid layout helpers', () => {
  it('limits sizes by the widget definition; unknown types get a 1×1 minimum', () => {
    const clock = getWidgetDefinition('clock')!.defaultSize;
    expect(sizeLimits('clock')).toMatchObject({ minW: clock.minW, minH: clock.minH });
    expect(sizeLimits('stocks')).toEqual({ minW: 1, minH: 1, maxW: 12, maxH: 100 });
    expect(toGridItems([a])[0]).toMatchObject({ i: 'a', x: 0, y: 0, w: 4, h: 3, minW: 1, minH: 1 });
  });

  it('converts grid items to valid PUT /positions payloads', () => {
    expect(toPositions([{ i: 'a', x: 10.4, y: -1, w: 4, h: 0 }])).toEqual([{ id: 'a', x: 8, y: 0, w: 4, h: 1 }]);
    expect(positionsChanged([a, b], [{ id: 'a', x: 0, y: 0, w: 4, h: 3 }])).toBe(false);
    expect(positionsChanged([a, b], [{ id: 'b', x: 0, y: 4, w: 4, h: 5 }])).toBe(true);
    expect(positionsChanged([a], [{ id: 'gone', x: 1, y: 1, w: 1, h: 1 }])).toBe(false);
  });

  it('stacks in reading order (y, then x)', () => {
    expect(stackOrder([b, c, a]).map((i) => i.id)).toEqual(['a', 'c', 'b']);
  });

  it('moves with the arrow keys: one column sideways, past the neighbour vertically', () => {
    expect(keyboardEdit([a, b, c], 'a', 'ArrowLeft', false)).toBeNull();
    expect(pos(keyboardEdit([a, b], 'a', 'ArrowRight', false), 'a')).toMatchObject({ x: 1, y: 0 });
    expect(keyboardEdit([widget('r', 'x', 8, 0, 4, 2)], 'r', 'ArrowRight', false)).toBeNull();

    const up = keyboardEdit([a, b], 'b', 'ArrowUp', false);
    expect(pos(up, 'b')).toMatchObject({ x: 0, y: 0 });
    expect(pos(up, 'a')).toMatchObject({ x: 0, y: 5 });

    const down = keyboardEdit([a, b], 'a', 'ArrowDown', false);
    expect(pos(down, 'b')).toMatchObject({ y: 0 });
    expect(pos(down, 'a')).toMatchObject({ y: 5 });
    // Nothing above the top widget / below the lowest one in its columns.
    expect(keyboardEdit([a, b], 'a', 'ArrowUp', false)).toBeNull();
    expect(keyboardEdit([a, b], 'b', 'ArrowDown', false)).toBeNull();
  });

  it('resizes with Shift+arrows within the size limits and the 12 columns', () => {
    expect(pos(keyboardEdit([a], 'a', 'ArrowRight', true), 'a')).toMatchObject({ w: 5 });
    expect(pos(keyboardEdit([a], 'a', 'ArrowDown', true), 'a')).toMatchObject({ h: 4 });
    const tiny = widget('t', 'x', 0, 0, 1, 1);
    expect(keyboardEdit([tiny], 't', 'ArrowLeft', true)).toBeNull();
    expect(keyboardEdit([tiny], 't', 'ArrowUp', true)).toBeNull();
    expect(keyboardEdit([widget('f', 'x', 0, 0, 12, 2)], 'f', 'ArrowRight', true)).toBeNull();
  });
});
