/**
 * Test data for launch pad sync: a small synced launch pad, builders for rows, and hostile or
 * broken variants of the file (fictional content only).
 */
import { emptyLaunchpad, type SyncBookmark, type SyncGroup, type SyncLaunchpad } from '@portly/shared';

/** 2026-10-01T00:00:00Z: stamps in the fixtures count from here. */
export const T = Date.UTC(2026, 9, 1);
export const EPOCH = 'epoch-0001';

export function group(id: string, at: number, extra: Partial<SyncGroup> = {}): SyncGroup {
  return { id, name: `Group ${id}`, sort: 0, color: null, collapsed: false, updatedAt: at, placedAt: at, ...extra };
}

export function bookmark(id: string, groupId: string, at: number, extra: Partial<SyncBookmark> = {}): SyncBookmark {
  return {
    id,
    groupId,
    title: `Site ${id}`,
    url: `https://${id}.example/`,
    sort: 0,
    iconMode: 'auto',
    iconId: null,
    letterColor: null,
    updatedAt: at,
    placedAt: at,
    ...extra,
  };
}

export const ICON_ID = '7b1e3c3a-5f0e-4c11-9d7a-2f4f8f0b6a10';

/** Two groups, three bookmarks (one with a custom icon), a removed bookmark and both pointers. */
export function sampleLaunchpad(): SyncLaunchpad {
  return {
    ...emptyLaunchpad(EPOCH),
    groups: [group('g-work', T, { name: 'Work', color: '#112233' }), group('g-none', T + 1, { name: 'No group', sort: 1 })],
    bookmarks: [
      bookmark('b-mail', 'g-work', T + 2, { title: 'Mail' }),
      bookmark('b-wiki', 'g-work', T + 3, { title: 'Wiki', sort: 1, iconMode: 'custom', iconId: ICON_ID }),
      bookmark('b-news', 'g-none', T + 4, { title: 'News', iconMode: 'letter', letterColor: '#abcdef' }),
      bookmark('b-gone', 'g-work', T + 5, { title: 'Old' }),
    ],
    deleted: [{ kind: 'bookmark', id: 'b-gone', at: T + 6 }],
    icons: [{ id: ICON_ID, contentType: 'image/png', sha256: '0'.repeat(64), width: 16 }],
    pointers: { defaultGroupId: { value: 'g-work', at: T + 7 }, ungroupedGroupId: { value: 'g-none', at: T + 8 } },
  };
}

const encoder = new TextEncoder();

export function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

/** The sample as a raw object, to break on purpose. */
export function sampleRaw(): Record<string, unknown> {
  return { format: 'portly-sync', version: 1, ...structuredClone(sampleLaunchpad()) } as Record<string, unknown>;
}

/** JSON nested `depth` arrays deep. */
export function deeplyNested(depth: number): string {
  return `{"format":"portly-sync","version":1,"epoch":"${EPOCH}","x":${'['.repeat(depth)}${']'.repeat(depth)}}`;
}
