/**
 * Client-side default layout (§10.2): every widget type except feeds and sports, which are empty
 * until the user adds a feed or a team and so are left to "Add widget". Shown while there are no
 * profiles, and used to seed the first "Home" profile (see seed.ts). Built for this page load's
 * capabilities: the in-browser backend has no mail widget, and leaves the calendar (Outlook.com only,
 * after a one-time app registration) to "Add widget".
 */
import type { KnownWidgetType, Layout, WidgetFrame, WidgetInstance } from '@portly/shared';
import { getCapabilities } from '../capabilities.ts';

export const DEFAULT_PROFILE_NAME = 'Home';

function item(
  type: KnownWidgetType,
  x: number,
  y: number,
  w: number,
  h: number,
  frame: Partial<WidgetFrame> = {},
): WidgetInstance {
  return {
    id: `default-${type}`,
    type,
    x,
    y,
    w,
    h,
    config: {},
    frame: { showHeader: true, transparent: false, ...frame },
  };
}

/**
 * A fresh copy of the default layout. `makeId` replaces the placeholder ids (`default-<type>`)
 * when the layout is persisted.
 */
export function createDefaultLayout(makeId?: (type: KnownWidgetType) => string): Layout {
  const caps = getCapabilities();
  const items =
    caps.mail
      ? [
          item('search', 0, 0, 8, 2, { showHeader: false }),
          item('clock', 8, 0, 4, 3, { showHeader: false }),
          item('launchpad', 0, 2, 8, 6),
          item('weather', 8, 3, 4, 5),
          item('calendar', 0, 8, 4, 7),
          item('todoist', 4, 8, 4, 7),
          item('mail', 8, 8, 4, 7),
        ]
      : // In-browser backend: no mail widget; the calendar is added once Outlook.com is set up.
        [
          item('search', 0, 0, 8, 2, { showHeader: false }),
          item('clock', 8, 0, 4, 3, { showHeader: false }),
          item('launchpad', 0, 2, 8, 6),
          item('weather', 8, 3, 4, 5),
          item('todoist', 0, 8, 6, 7),
        ];
  return {
    version: 1,
    items: makeId ? items.map((i) => ({ ...i, id: makeId(i.type as KnownWidgetType) })) : items,
  };
}
