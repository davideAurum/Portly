/**
 * Profiles and widget layouts (§7 Core, §10.2).
 *
 * A profile row holds its layout as JSON (`profiles.layout`, validated with `LayoutSchema` on
 * read — invalid layouts read as empty). Layout mutations (positions, widget add/update/remove)
 * read, modify, validate and write the layout inside one `BEGIN IMMEDIATE` transaction, so the
 * client never overwrites a whole layout.
 *
 * Invariants:
 * - ≤ 50 profiles; ≤ 50 widgets per profile; widget ids are server-generated UUIDs.
 * - `settings.activeProfileId` points at an existing profile once one exists: creating the first
 *   profile (or one while the pointer dangles) activates it; deleting the active profile activates
 *   the first remaining one; the last profile cannot be deleted.
 * - Widget types this build does not know may be stored; their config is opaque JSON (checked
 *   only for forbidden keys and size). Frames are validated strictly.
 */
import {
  GRID_COLUMNS,
  LayoutSchema,
  MAX_PROFILES,
  MAX_WIDGETS_PER_PROFILE,
  WidgetInstanceSchema,
  emptyLayout,
  type Layout,
  type PositionsUpdate,
  type Profile,
  type ProfileCreate,
  type ProfileUpdate,
  type Settings,
  type WidgetCreate,
  type WidgetFrame,
  type WidgetFramePatch,
  type WidgetInstance,
  type WidgetUpdate,
} from '@portly/shared';
import type { Db } from '../../db/open.ts';
import { parseJsonColumn } from '../../db/helpers.ts';
import { HttpError } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import type { Logger } from '../../lib/logger.ts';
import { assertSafeJson, jsonByteLength } from '../../lib/safe-json.ts';
import type { SettingsService } from '../../lib/settings.ts';
import { validate } from '../../lib/validate.ts';

/** Serialized size cap of one widget's (opaque) config. */
export const MAX_WIDGET_CONFIG_BYTES = 64 * 1024;

/** Default size of a newly added widget (the user resizes in edit mode). */
const DEFAULT_WIDGET_SIZE: Readonly<Record<string, { w: number; h: number }>> = Object.freeze({
  search: { w: 8, h: 2 },
  launchpad: { w: 8, h: 6 },
  calendar: { w: 4, h: 8 },
  mail: { w: 4, h: 7 },
  todoist: { w: 4, h: 7 },
  weather: { w: 4, h: 5 },
  clock: { w: 4, h: 3 },
});
const FALLBACK_WIDGET_SIZE = { w: 4, h: 4 };

interface ProfileRow {
  id: string;
  name: string;
  sort: number;
  layout: string;
}

export interface ProfileService {
  list(): Profile[];
  get(id: string): Profile;
  exists(id: string): boolean;
  /** Id of the first profile in display order (the fallback active profile), or null. */
  firstId(): string | null;
  create(input: ProfileCreate): Profile;
  update(id: string, patch: ProfileUpdate): Profile;
  remove(id: string): void;
  activate(id: string): Settings;
  setPositions(id: string, update: PositionsUpdate): Profile;
  addWidget(id: string, input: WidgetCreate): WidgetInstance;
  updateWidget(id: string, instanceId: string, input: WidgetUpdate): WidgetInstance;
  removeWidget(id: string, instanceId: string): void;
}

export interface ProfileServiceDeps {
  db: Db;
  log: Logger;
  settings: SettingsService;
  now?: () => number;
}

function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'Profile not found');
}

function widgetNotFound(): HttpError {
  return new HttpError(404, 'not_found', 'Widget not found');
}

/** Checks an opaque widget config: JSON-safe (no forbidden keys, bounded depth) and ≤ 64 KB. */
export function assertWidgetConfig(config: unknown): void {
  assertSafeJson(config, 'Widget config');
  if (jsonByteLength(config) > MAX_WIDGET_CONFIG_BYTES) {
    throw new HttpError(422, 'validation_failed', `Widget config exceeds ${MAX_WIDGET_CONFIG_BYTES} bytes`);
  }
}

/** Applies a frame patch (`title: null` or blank removes the custom title). */
export function applyFramePatch(frame: WidgetFrame, patch: WidgetFramePatch | undefined): WidgetFrame {
  const next: WidgetFrame = { showHeader: frame.showHeader, transparent: frame.transparent };
  const title = patch?.title === undefined ? frame.title : patch.title;
  if (typeof title === 'string' && title.trim() !== '') next.title = title.trim();
  if (patch?.showHeader !== undefined) next.showHeader = patch.showHeader;
  if (patch?.transparent !== undefined) next.transparent = patch.transparent;
  return next;
}

/** Same layout with fresh widget ids (used for created, copied and imported layouts). */
export function withFreshWidgetIds(layout: Layout, mapConfig: (config: unknown) => unknown = (c) => c): Layout {
  return {
    version: 1,
    items: layout.items.map((item) => ({ ...item, id: newId(), config: mapConfig(item.config) })),
  };
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** First free w×h slot scanning rows top to bottom, left to right (below everything if none). */
export function findFreeSlot(items: readonly WidgetInstance[], w: number, h: number): { x: number; y: number } {
  const bottom = items.reduce((max, i) => Math.max(max, i.y + i.h), 0);
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + w <= GRID_COLUMNS; x++) {
      const candidate = { x, y, w, h };
      if (!items.some((item) => overlaps(candidate, item))) return { x, y };
    }
  }
  return { x: 0, y: bottom };
}

export function createProfileService(deps: ProfileServiceDeps): ProfileService {
  const { db, log, settings } = deps;
  const now = deps.now ?? Date.now;

  /** Profiles whose stored layout was reported invalid (warned once per process, not per read). */
  const warnedLayouts = new Set<string>();
  const layoutLog = (id: string): Logger | undefined => {
    if (warnedLayouts.has(id)) return undefined;
    return {
      debug: (message, fields) => log.debug(message, fields),
      info: (message, fields) => log.info(message, fields),
      error: (message, fields) => log.error(message, fields),
      child: (bindings) => log.child(bindings),
      warn: (message, fields) => {
        warnedLayouts.add(id);
        log.warn(`${message} (reported once; the empty layout is used until the profile is edited)`, { ...fields, profileId: id });
      },
    };
  };

  const toProfile = (row: ProfileRow): Profile => ({
    id: row.id,
    name: row.name,
    sort: Number(row.sort),
    layout: parseJsonColumn(LayoutSchema, row.layout, emptyLayout(), layoutLog(row.id), 'profiles.layout'),
  });

  const readRow = (id: string): ProfileRow | undefined =>
    db.get<ProfileRow>('SELECT id, name, sort, layout FROM profiles WHERE id = ?', [id]);

  const mustGet = (id: string): Profile => {
    const row = readRow(id);
    if (!row) throw notFound();
    return toProfile(row);
  };

  const writeLayout = (id: string, layout: Layout): void => {
    const valid = validate(LayoutSchema, layout, 'layout');
    db.run('UPDATE profiles SET layout = ?, updated_at = ? WHERE id = ?', [JSON.stringify(valid), now(), id]);
  };

  /** Read-modify-write of one profile's layout inside a transaction. */
  const mutateLayout = <T>(id: string, fn: (layout: Layout) => { layout: Layout; result: T }): T =>
    db.tx(() => {
      const profile = mustGet(id);
      const { layout, result } = fn(structuredClone(profile.layout));
      writeLayout(id, layout);
      return result;
    });

  const firstProfileId = (): string | null =>
    db.get<{ id: string }>('SELECT id FROM profiles ORDER BY sort, created_at, id LIMIT 1')?.id ?? null;

  const service: ProfileService = {
    list() {
      return db.all<ProfileRow>('SELECT id, name, sort, layout FROM profiles ORDER BY sort, created_at, id').map(toProfile);
    },

    get: mustGet,

    exists(id) {
      return readRow(id) !== undefined;
    },

    firstId: firstProfileId,

    create(input) {
      if (input.copyFromId !== undefined && input.layout !== undefined) {
        throw new HttpError(422, 'validation_failed', 'Pass either copyFromId or layout, not both');
      }
      if (input.layout) for (const item of input.layout.items) assertWidgetConfig(item.config);
      return db.tx(() => {
        const count = Number(db.get<{ n: number }>('SELECT count(*) AS n FROM profiles')?.n ?? 0);
        if (count >= MAX_PROFILES) throw new HttpError(409, 'conflict', `At most ${MAX_PROFILES} profiles are allowed`);
        let source: Layout = emptyLayout();
        if (input.copyFromId !== undefined) source = mustGet(input.copyFromId).layout;
        else if (input.layout) source = input.layout;
        const layout = validate(LayoutSchema, withFreshWidgetIds(source), 'layout');

        const id = newId();
        const sort = Number(db.get<{ s: number | null }>('SELECT max(sort) AS s FROM profiles')?.s ?? -1) + 1;
        const ts = now();
        db.run('INSERT INTO profiles (id, name, sort, layout, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
          id,
          input.name,
          sort,
          JSON.stringify(layout),
          ts,
          ts,
        ]);
        const active = settings.get('activeProfileId');
        if (active === null || !service.exists(active)) settings.set('activeProfileId', id);
        return { id, name: input.name, sort, layout };
      });
    },

    update(id, patch) {
      return db.tx(() => {
        const current = mustGet(id);
        const name = patch.name ?? current.name;
        const sort = patch.sort ?? current.sort;
        db.run('UPDATE profiles SET name = ?, sort = ?, updated_at = ? WHERE id = ?', [name, sort, now(), id]);
        return { ...current, name, sort };
      });
    },

    remove(id) {
      db.tx(() => {
        mustGet(id);
        const count = Number(db.get<{ n: number }>('SELECT count(*) AS n FROM profiles')?.n ?? 0);
        if (count <= 1) throw new HttpError(409, 'conflict', 'The last profile cannot be deleted');
        db.run('DELETE FROM profiles WHERE id = ?', [id]);
        const active = settings.get('activeProfileId');
        if (active === id || active === null || !service.exists(active)) settings.set('activeProfileId', firstProfileId());
      });
    },

    activate(id) {
      return db.tx(() => {
        mustGet(id);
        settings.set('activeProfileId', id);
        return settings.getAll();
      });
    },

    setPositions(id, update) {
      return db.tx(() => {
        const profile = mustGet(id);
        const byId = new Map(update.items.map((p) => [p.id, p]));
        const unknown = update.items.filter((p) => !profile.layout.items.some((i) => i.id === p.id)).length;
        if (unknown > 0) log.debug('positions update names unknown widgets; ignored', { profileId: id, unknown });
        const layout: Layout = {
          version: 1,
          items: profile.layout.items.map((item) => {
            const pos = byId.get(item.id);
            return pos ? { ...item, x: pos.x, y: pos.y, w: pos.w, h: pos.h } : item;
          }),
        };
        writeLayout(id, layout);
        return { ...profile, layout: validate(LayoutSchema, layout, 'layout') };
      });
    },

    addWidget(id, input) {
      const config = input.config === undefined ? {} : input.config;
      assertWidgetConfig(config);
      return mutateLayout(id, (layout) => {
        if (layout.items.length >= MAX_WIDGETS_PER_PROFILE) {
          throw new HttpError(409, 'conflict', `At most ${MAX_WIDGETS_PER_PROFILE} widgets per profile are allowed`);
        }
        const size = DEFAULT_WIDGET_SIZE[input.type] ?? FALLBACK_WIDGET_SIZE;
        const slot = findFreeSlot(layout.items, size.w, size.h);
        const instance = validate(
          WidgetInstanceSchema,
          {
            id: newId(),
            type: input.type,
            ...slot,
            ...size,
            config,
            frame: applyFramePatch({ showHeader: true, transparent: false }, input.frame),
          },
          'widget',
        );
        return { layout: { version: 1, items: [...layout.items, instance] }, result: instance };
      });
    },

    updateWidget(id, instanceId, input) {
      if (input.config !== undefined) assertWidgetConfig(input.config);
      return mutateLayout(id, (layout) => {
        const index = layout.items.findIndex((i) => i.id === instanceId);
        const current = layout.items[index];
        if (!current) throw widgetNotFound();
        const next = validate(
          WidgetInstanceSchema,
          {
            ...current,
            config: input.config === undefined ? current.config : input.config,
            frame: applyFramePatch(current.frame, input.frame),
          },
          'widget',
        );
        const items = [...layout.items];
        items[index] = next;
        return { layout: { version: 1, items }, result: next };
      });
    },

    removeWidget(id, instanceId) {
      mutateLayout(id, (layout) => {
        if (!layout.items.some((i) => i.id === instanceId)) throw widgetNotFound();
        return { layout: { version: 1, items: layout.items.filter((i) => i.id !== instanceId) }, result: undefined };
      });
    },
  };
  return service;
}
