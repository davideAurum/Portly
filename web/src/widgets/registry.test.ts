import { describe, expect, it } from 'vitest';
import { WIDGET_TYPES } from '@portly/shared';
import { createDefaultLayout } from '../grid/defaultLayout.ts';
import { WIDGET_DEFINITIONS, getWidgetDefinition, parseWidgetConfig, stackSizingOf } from './registry.ts';

describe('widget registry', () => {
  it('registers exactly the known widget types', () => {
    expect(WIDGET_DEFINITIONS.map((d) => d.type).sort()).toEqual([...WIDGET_TYPES].sort());
    expect(getWidgetDefinition('stocks')).toBeUndefined();
  });

  it('every config schema defaults every field (parse({}) succeeds)', () => {
    for (const def of WIDGET_DEFINITIONS) {
      const parsed = def.configSchema.safeParse({});
      expect(parsed.success, def.type).toBe(true);
      expect(def.title.length).toBeGreaterThan(0);
      expect(def.defaultSize.w).toBeGreaterThanOrEqual(def.defaultSize.minW);
      expect(def.defaultSize.h).toBeGreaterThanOrEqual(def.defaultSize.minH);
      expect(def.defaultSize.w).toBeLessThanOrEqual(12);
    }
  });

  it('documents the §10.8 defaults', () => {
    const cfg = (type: string) => parseWidgetConfig(getWidgetDefinition(type)!, {});
    expect(cfg('search')).toEqual({ engineIds: 'all', showEngineSwitcher: true, autofocus: true, placeholder: 'Search the web' });
    expect(cfg('launchpad')).toEqual({
      groupIds: 'all',
      iconSize: 'm',
      showLabels: true,
      columns: 'auto',
      style: 'tiles',
      groupLayout: 'stack',
      groupColumns: 'auto',
      groupSpans: {},
      showGroupHeaders: true,
      listTitle: true,
      listDetail: 'domain',
      listDetailPlacement: 'inline',
      listIcons: true,
      listDensity: 'normal',
    });
    expect(cfg('calendar')).toEqual({ view: 'agenda', days: 7, calendarIds: 'visible', showDeclined: false });
    expect(cfg('mail')).toEqual({ accountIds: 'all', maxMessages: 10, unreadOnly: false, grouping: 'merged' });
    expect(cfg('todoist')).toEqual({ filter: '', showProject: true, showDue: true, sort: 'todoist' });
    expect(cfg('weather')).toEqual({ location: null, useDeviceLocation: false, show: { hourly: true, daily: true }, units: 'inherit' });
    expect(cfg('clock')).toEqual({ format: 'inherit', showSeconds: false, showDate: true, greeting: true, extraZones: [] });
  });

  it('sizes lists to their content in the narrow stacked layout (UX-3)', () => {
    expect(['launchpad', 'todoist', 'mail'].map((t) => stackSizingOf(t, {}))).toEqual(['content', 'content', 'content']);
    expect(stackSizingOf('calendar', {})).toBe('content');
    expect(stackSizingOf('calendar', { view: 'week' })).toBe('fixed');
    expect(['clock', 'weather', 'search', 'unknown'].map((t) => stackSizingOf(t, {}))).toEqual(['fixed', 'fixed', 'fixed', 'fixed']);
  });

  it('falls back to defaults for invalid stored config', () => {
    const mail = getWidgetDefinition('mail')!;
    expect(parseWidgetConfig(mail, { maxMessages: 500 })).toEqual(mail.configSchema.parse({}));
    expect(parseWidgetConfig(mail, 'garbage')).toEqual(mail.configSchema.parse({}));
    expect(parseWidgetConfig(mail, null)).toEqual(mail.configSchema.parse({}));
    expect(parseWidgetConfig(mail, { maxMessages: 15 })).toMatchObject({ maxMessages: 15 });
  });
});

describe('default layout', () => {
  const layout = createDefaultLayout();

  it('contains every widget type but feeds and sports once, within the 12-column grid', () => {
    expect(layout.items.map((i) => i.type).sort()).toEqual(WIDGET_TYPES.filter((t) => t !== 'feeds' && t !== 'sports').sort());
    for (const item of layout.items) {
      const def = getWidgetDefinition(item.type)!;
      expect(item.x + item.w, item.type).toBeLessThanOrEqual(12);
      expect(item.w, item.type).toBeGreaterThanOrEqual(def.defaultSize.minW);
      expect(item.h, item.type).toBeGreaterThanOrEqual(def.defaultSize.minH);
      if (def.defaultSize.maxH !== undefined) expect(item.h).toBeLessThanOrEqual(def.defaultSize.maxH);
    }
  });

  it('ends in one straight bottom edge (UX-8)', () => {
    const bottoms = new Set(layout.items.filter((i) => i.y === 8).map((i) => i.y + i.h));
    expect([...bottoms]).toEqual([15]);
  });

  it('has no overlapping widgets', () => {
    const cells = new Set<string>();
    for (const item of layout.items) {
      for (let x = item.x; x < item.x + item.w; x++) {
        for (let y = item.y; y < item.y + item.h; y++) {
          const key = `${x},${y}`;
          expect(cells.has(key), `${item.type} overlaps at ${key}`).toBe(false);
          cells.add(key);
        }
      }
    }
  });

  it('returns a fresh copy each time', () => {
    const a = createDefaultLayout();
    a.items.pop();
    expect(createDefaultLayout().items).toHaveLength(7);
  });
});
