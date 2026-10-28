/**
 * The launch pad merge (`@portly/shared` launchpadSync.ts, design section 6): the rules row by row,
 * then the properties the sync relies on, checked on random launch pads from a seeded generator:
 * commutative, idempotent, the same result in every merge order, and three simulated PCs that sync
 * through one file in random order all ending with the same launch pad.
 */
import { describe, expect, it } from 'vitest';
import {
  SYNC_TOMBSTONE_TTL_MS,
  emptyLaunchpad,
  forgetUnsynced,
  highestSyncStamp,
  liveLaunchpad,
  mergeLaunchpads,
  normalizeLaunchpad,
  pruneLaunchpad,
  serializeSyncFile,
  type SyncBookmark,
  type SyncGroup,
  type SyncLaunchpad,
} from '@portly/shared';
import { EPOCH, ICON_ID, T, bookmark, group, sampleLaunchpad } from './__fixtures__/launchpads.ts';

const DAY = 24 * 60 * 60 * 1000;
const text = (doc: SyncLaunchpad): string => serializeSyncFile(doc);
const doc = (parts: Partial<SyncLaunchpad>): SyncLaunchpad => ({ ...emptyLaunchpad(EPOCH), ...parts });

describe('merging rows', () => {
  it('keeps a rename from one PC and a move from another', () => {
    const base = bookmark('b1', 'g1', T);
    const renamed = { ...base, title: 'Renamed', updatedAt: T + 10 };
    const moved = { ...base, groupId: 'g2', sort: 4, placedAt: T + 5 };
    const merged = mergeLaunchpads(doc({ bookmarks: [renamed] }), doc({ bookmarks: [moved] }));
    expect(merged.bookmarks).toEqual([{ ...base, title: 'Renamed', updatedAt: T + 10, groupId: 'g2', sort: 4, placedAt: T + 5 }]);
  });

  it('settles equal stamps the same way from both sides', () => {
    const a = group('g1', T, { name: 'Alpha' });
    const b = group('g1', T, { name: 'Beta' });
    const ab = mergeLaunchpads(doc({ groups: [a] }), doc({ groups: [b] }));
    const ba = mergeLaunchpads(doc({ groups: [b] }), doc({ groups: [a] }));
    expect(ab).toEqual(ba);
    expect(ab.groups[0]!.name).toBe('Beta');
  });

  it('settles equal placement stamps the same way from both sides', () => {
    const a = bookmark('b1', 'g1', T, { groupId: 'g1', sort: 2 });
    const b = bookmark('b1', 'g2', T, { groupId: 'g2', sort: 1 });
    const ab = mergeLaunchpads(doc({ bookmarks: [a] }), doc({ bookmarks: [b] }));
    expect(ab).toEqual(mergeLaunchpads(doc({ bookmarks: [b] }), doc({ bookmarks: [a] })));
    expect(ab.bookmarks[0]).toMatchObject({ groupId: 'g2', sort: 1 });
  });

  it('removes a row whose two stamps are both at or before its tombstone, and keeps one changed after', () => {
    const tombstone = { kind: 'bookmark' as const, id: 'b1', at: T + 10 };
    const old = bookmark('b1', 'g1', T + 10);
    expect(liveLaunchpad(doc({ bookmarks: [old], deleted: [tombstone] })).bookmarks).toEqual([]);
    const edited = { ...old, title: 'Edited later', updatedAt: T + 11 };
    expect(liveLaunchpad(mergeLaunchpads(doc({ bookmarks: [edited] }), doc({ deleted: [tombstone] }))).bookmarks).toEqual([edited]);
    const movedLater = { ...old, sort: 3, placedAt: T + 12 };
    expect(liveLaunchpad(mergeLaunchpads(doc({ bookmarks: [movedLater] }), doc({ deleted: [tombstone] }))).bookmarks).toHaveLength(1);
  });

  it('keeps the removed row in the file with its tombstone, so a later edit elsewhere merges the same in any order', () => {
    // PC A moved the bookmark, PC B deleted it, PC C renamed it after the delete.
    const base = bookmark('b1', 'g1', T);
    const a = doc({ bookmarks: [{ ...base, sort: 9, placedAt: T + 5 }] });
    const b = doc({ deleted: [{ kind: 'bookmark', id: 'b1', at: T + 6 }] });
    const c = doc({ bookmarks: [{ ...base, title: 'Renamed', updatedAt: T + 7 }] });
    const results = [
      mergeLaunchpads(mergeLaunchpads(a, b), c),
      mergeLaunchpads(a, mergeLaunchpads(b, c)),
      mergeLaunchpads(mergeLaunchpads(c, b), a),
    ].map(text);
    expect(new Set(results).size).toBe(1);
    expect(liveLaunchpad(mergeLaunchpads(mergeLaunchpads(a, b), c)).bookmarks).toEqual([{ ...base, title: 'Renamed', updatedAt: T + 7, sort: 9, placedAt: T + 5 }]);
  });

  it('keeps the newest tombstone per row, every icon and the later pointer', () => {
    const merged = mergeLaunchpads(
      doc({ deleted: [{ kind: 'group', id: 'g1', at: T + 1 }], pointers: { defaultGroupId: { value: 'g1', at: T + 3 }, ungroupedGroupId: { value: null, at: 0 } } }),
      doc({
        deleted: [{ kind: 'group', id: 'g1', at: T + 2 }],
        icons: [{ id: ICON_ID, contentType: 'image/png', sha256: 'a'.repeat(64), width: null }],
        pointers: { defaultGroupId: { value: 'g2', at: T + 2 }, ungroupedGroupId: { value: 'g9', at: T + 1 } },
      }),
    );
    expect(merged.deleted).toEqual([{ kind: 'group', id: 'g1', at: T + 2 }]);
    expect(merged.icons.map((i) => i.id)).toEqual([ICON_ID]);
    expect(merged.pointers).toEqual({ defaultGroupId: { value: 'g1', at: T + 3 }, ungroupedGroupId: { value: 'g9', at: T + 1 } });
  });

  it('never renumbers, creates or repairs: a bookmark whose group is gone stays as it is', () => {
    const merged = mergeLaunchpads(doc({ groups: [group('g1', T)], bookmarks: [bookmark('b1', 'g1', T + 1, { sort: 7 })] }), doc({ deleted: [{ kind: 'group', id: 'g1', at: T + 2 }] }));
    expect(liveLaunchpad(merged)).toEqual({ groups: [], bookmarks: [bookmark('b1', 'g1', T + 1, { sort: 7 })] });
  });

  it('writes equal launch pads as equal text, whatever the order of rows and keys', () => {
    const sample = sampleLaunchpad();
    const shuffled: SyncLaunchpad = {
      ...sample,
      groups: [...sample.groups].reverse(),
      bookmarks: [...sample.bookmarks].reverse().map((b) => Object.fromEntries(Object.entries(b).reverse()) as SyncBookmark),
    };
    expect(text(shuffled)).toBe(text(sample));
    expect(highestSyncStamp(sample)).toBe(T + 8);
  });
});

describe('expiry and the horizon', () => {
  it('drops tombstones older than 90 days with the rows they removed, and raises the horizon', () => {
    const now = T + SYNC_TOMBSTONE_TTL_MS + DAY;
    const pruned = pruneLaunchpad(
      doc({
        groups: [group('g1', T)],
        bookmarks: [bookmark('old', 'g1', T), bookmark('recent', 'g1', T), bookmark('alive', 'g1', T + 3 * DAY, { iconMode: 'custom', iconId: ICON_ID })],
        deleted: [
          { kind: 'bookmark', id: 'old', at: T + 1 },
          { kind: 'bookmark', id: 'recent', at: T + 2 * DAY },
          { kind: 'bookmark', id: 'alive', at: T + 2 },
        ],
        icons: [
          { id: ICON_ID, contentType: 'image/png', sha256: 'a'.repeat(64), width: null },
          { id: '0b1e3c3a-5f0e-4c11-9d7a-2f4f8f0b6a10', contentType: 'image/png', sha256: 'b'.repeat(64), width: null },
        ],
      }),
      now,
    );
    expect(pruned.bookmarks.map((b) => b.id).sort()).toEqual(['alive', 'recent']);
    expect(pruned.deleted).toEqual([{ kind: 'bookmark', id: 'recent', at: T + 2 * DAY }]);
    expect(pruned.horizon).toBe(T + 2);
    // An icon no row names any more goes; the one a live bookmark uses stays.
    expect(pruned.icons.map((i) => i.id)).toEqual([ICON_ID]);
  });

  it('forgets rows the file no longer knows unless they changed after the last sync', () => {
    const lastSynced = T + 100;
    const local = doc({
      groups: [group('g1', T), group('g-offline', T + 200)],
      bookmarks: [bookmark('kept', 'g1', T), bookmark('gone', 'g1', T + 50), bookmark('offline', 'g1', T + 50, { placedAt: T + 150 })],
      deleted: [{ kind: 'bookmark', id: 'x', at: T + 10 }],
    });
    const file = doc({ groups: [group('g1', T)], bookmarks: [bookmark('kept', 'g1', T)] });
    const forgotten = forgetUnsynced(local, file, lastSynced);
    expect(forgotten.groups.map((g) => g.id)).toEqual(['g1', 'g-offline']);
    expect(forgotten.bookmarks.map((b) => b.id)).toEqual(['kept', 'offline']);
    expect(forgotten.deleted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Properties on random launch pads
// ---------------------------------------------------------------------------

/** mulberry32: a small seeded generator, so a failure names its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** One simulated browser: its launch pad (live rows and tombstones, as a browser's own data gives it) and its clock. */
class Pc {
  doc: SyncLaunchpad = emptyLaunchpad(EPOCH);
  clock = 0;
  /** This PC's wall clock runs this far off. */
  readonly skew: number;
  constructor(skew: number) {
    this.skew = skew;
  }

  stamp(wall: number): number {
    this.clock = Math.max(wall + this.skew, this.clock + 1);
    return this.clock;
  }

  /** After a merge: keeps what is alive (as applying it to the bookmarks slice does) and raises the clock. */
  adopt(merged: SyncLaunchpad): void {
    const live = liveLaunchpad(merged);
    this.doc = { ...merged, groups: live.groups, bookmarks: live.bookmarks };
    this.clock = Math.max(this.clock, highestSyncStamp(merged));
  }
}

function pickOne<T>(random: () => number, list: readonly T[]): T | undefined {
  return list.length === 0 ? undefined : list[Math.floor(random() * list.length)];
}

const TITLES = ['Mail', 'Wiki', 'News', 'Docs', 'Maps'];
const COLORS = [null, '#112233', '#aabbcc'];

/** One random user action on `pc` at wall time `wall`. */
function act(pc: Pc, random: () => number, wall: number, ids: { next: number }): void {
  const d = pc.doc;
  const roll = random();
  const g = pickOne(random, d.groups);
  const b = pickOne(random, d.bookmarks);
  const id = (prefix: string) => `${prefix}${ids.next++}`;
  if (roll < 0.15 || !g) {
    const at = pc.stamp(wall);
    d.groups = [...d.groups, group(id('g'), at, { name: pickOne(random, TITLES)!, sort: d.groups.length })];
  } else if (roll < 0.25) {
    const at = pc.stamp(wall);
    d.groups = d.groups.map((x) => (x === g ? { ...x, name: `${x.name}!`, color: pickOne(random, COLORS)!, updatedAt: at } : x));
  } else if (roll < 0.3) {
    // Delete a group and the bookmarks this PC has in it, with tombstones.
    const at = pc.stamp(wall);
    const gone = d.bookmarks.filter((x) => x.groupId === g.id);
    d.groups = d.groups.filter((x) => x !== g);
    d.bookmarks = d.bookmarks.filter((x) => x.groupId !== g.id);
    d.deleted = [...d.deleted, { kind: 'group', id: g.id, at }, ...gone.map((x) => ({ kind: 'bookmark' as const, id: x.id, at }))];
  } else if (roll < 0.55 || !b) {
    const at = pc.stamp(wall);
    const custom = random() < 0.2;
    d.bookmarks = [
      ...d.bookmarks,
      bookmark(id('b'), g.id, at, { title: pickOne(random, TITLES)!, sort: Math.floor(random() * 5), ...(custom ? { iconMode: 'custom', iconId: ICON_ID } : {}) }),
    ];
    if (custom) d.icons = [{ id: ICON_ID, contentType: 'image/png', sha256: 'c'.repeat(64), width: 32 }];
  } else if (roll < 0.7) {
    const at = pc.stamp(wall);
    d.bookmarks = d.bookmarks.map((x) => (x === b ? { ...x, title: `${x.title}*`, updatedAt: at } : x));
  } else if (roll < 0.85) {
    const at = pc.stamp(wall);
    d.bookmarks = d.bookmarks.map((x) => (x === b ? { ...x, groupId: g.id, sort: Math.floor(random() * 5), placedAt: at } : x));
  } else if (roll < 0.95) {
    const at = pc.stamp(wall);
    d.bookmarks = d.bookmarks.filter((x) => x !== b);
    d.deleted = [...d.deleted, { kind: 'bookmark', id: b.id, at }];
  } else {
    const at = pc.stamp(wall);
    const name = random() < 0.5 ? 'defaultGroupId' : 'ungroupedGroupId';
    d.pointers = { ...d.pointers, [name]: { value: random() < 0.2 ? null : g.id, at } };
  }
}

/** Three PCs with clocks off by up to minutes, each doing `steps` random things without syncing. */
function divergedPcs(seed: number, steps: number): Pc[] {
  const random = rng(seed);
  const shared = new Pc(0);
  const ids = { next: 0 };
  for (let i = 0; i < 6; i++) act(shared, random, T + i * 1000, ids);
  // Clocks a few seconds apart in whole seconds, so stamps from different PCs often collide.
  const pcs = [new Pc(0), new Pc(3000), new Pc(-5000)];
  for (const pc of pcs) pc.adopt(normalizeLaunchpad(shared.doc));
  for (let i = 0; i < steps; i++) act(pickOne(random, pcs)!, random, T + 10_000 + i * 1000, ids);
  return pcs;
}

const SEEDS = Array.from({ length: 120 }, (_, i) => i + 1);

describe('merge properties', () => {
  it.each(SEEDS)('is commutative and idempotent (seed %i)', (seed) => {
    const [a, b] = divergedPcs(seed, 30).map((pc) => pc.doc) as [SyncLaunchpad, SyncLaunchpad];
    const ab = mergeLaunchpads(a, b);
    expect(text(mergeLaunchpads(b, a))).toBe(text(ab));
    expect(text(mergeLaunchpads(ab, ab))).toBe(text(ab));
    expect(text(mergeLaunchpads(ab, b))).toBe(text(ab));
    expect(text(mergeLaunchpads(a, ab))).toBe(text(ab));
  });

  it.each(SEEDS)('gives the same launch pad in every merge order of three PCs (seed %i)', (seed) => {
    const [a, b, c] = divergedPcs(seed, 40).map((pc) => pc.doc) as [SyncLaunchpad, SyncLaunchpad, SyncLaunchpad];
    const orders = [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ] as const;
    const results = new Set(orders.map(([x, y, z]) => text(mergeLaunchpads(mergeLaunchpads(x, y), z))));
    results.add(text(mergeLaunchpads(a, mergeLaunchpads(b, c))));
    expect(results.size).toBe(1);
  });

  it.each(SEEDS)('converges: three PCs syncing through one file in random order end up the same (seed %i)', (seed) => {
    const random = rng(seed * 7919);
    const ids = { next: 1000 };
    const pcs = [new Pc(0), new Pc(2000), new Pc(-3000)];
    let file: SyncLaunchpad = emptyLaunchpad(EPOCH);
    const sync = (pc: Pc): void => {
      const merged = mergeLaunchpads(pc.doc, file);
      file = merged;
      pc.adopt(merged);
    };
    for (let step = 0; step < 80; step++) {
      const pc = pickOne(random, pcs)!;
      if (random() < 0.3) sync(pc);
      else act(pc, random, T + step * 1000, ids);
    }
    // Everyone syncs, in a random order, twice: the second round changes nothing.
    for (let round = 0; round < 2; round++) for (const pc of [...pcs].sort(() => random() - 0.5)) sync(pc);
    const live = (d: SyncLaunchpad) => text({ ...d, ...liveLaunchpad(d) });
    const expected = live(file);
    for (const pc of pcs) expect(live(pc.doc)).toBe(expected);
    // And the file is a fixed point: merging any PC into it again changes nothing.
    for (const pc of pcs) expect(text(mergeLaunchpads(pc.doc, file))).toBe(text(file));
  });
});

describe('the shape of what the merge returns', () => {
  it('sorts rows by id and keeps both stamps', () => {
    const merged = mergeLaunchpads(doc({ groups: [group('b', T), group('a', T + 1)] }), emptyLaunchpad(EPOCH));
    expect(merged.groups.map((g: SyncGroup) => [g.id, g.updatedAt, g.placedAt])).toEqual([
      ['a', T + 1, T + 1],
      ['b', T, T],
    ]);
  });
});
