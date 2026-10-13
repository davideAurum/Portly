/**
 * Profiles and widget layouts of the static backend (§7 Core), a port of
 * server/src/modules/core/profiles.ts over the `profiles` slice:
 *
 * - `GET /api/profiles` → `Profile[]` in display order (sort, createdAt, id); `[]` on first run so
 *   the web's seed runs. Stored layouts are re-validated on read; an invalid one reads as empty.
 * - `POST /api/profiles {name, copyFromId?, layout?}` → 201 `Profile` with fresh widget ids,
 *   `sort = max + 1`; activates itself when the active pointer is null or dangling; 409 at 50.
 * - `PATCH /api/profiles/:id {name?, sort?}` → `Profile` · `DELETE` → 204 (the last profile cannot
 *   be deleted; deleting the active one re-points `activeProfileId` to the first remaining).
 * - `POST /api/profiles/:id/activate` → full `Settings`.
 * - `PUT /api/profiles/:id/positions {items}` → `Profile`: only x/y/w/h of listed ids change,
 *   unknown ids are ignored, overlaps are not checked.
 * - `POST /api/profiles/:id/widgets {type, config?, frame?}` → 201 `WidgetInstance` placed in the
 *   first free slot with the type's default size; 409 at 50 widgets. Types the in-browser backend
 *   cannot run (`BROWSER_UNAVAILABLE_WIDGET_TYPES`) are refused with 422.
 * - `PATCH /api/profiles/:id/widgets/:instanceId {config?, frame?}` → `WidgetInstance`: config is
 *   replaced (checked only for forbidden keys and the 64 KB cap, never against the widget's own
 *   schema), the frame is merged (a null or blank title removes it) · `DELETE` → 204.
 *
 * Path ids longer than 512 characters are 404, like the server's `IdParam`. The pure layout
 * helpers (`findFreeSlot`, `applyFramePatch`, `withFreshWidgetIds`, …) are verbatim ports and are
 * shared with the import/export handlers.
 */
import {
  GRID_COLUMNS,
  LayoutSchema,
  MAX_PROFILES,
  MAX_WIDGETS_PER_PROFILE,
  PositionsUpdateSchema,
  ProfileCreateSchema,
  ProfileUpdateSchema,
  WidgetCreateSchema,
  WidgetInstanceSchema,
  WidgetUpdateSchema,
  emptyLayout,
  type Layout,
  type Profile,
  type WidgetFrame,
  type WidgetFramePatch,
  type WidgetInstance,
} from '@portly/shared';
import { BROWSER_UNAVAILABLE_WIDGET_TYPES } from '../../capabilities.ts';
import type { StaticContext } from '../context.ts';
import { assertSafeJson, jsonByteLength } from '../lib/safeJson.ts';
import { parseJsonBody, validate } from '../lib/validate.ts';
import { json, noContent, StaticApiError } from '../respond.ts';
import type { StaticRouter } from '../router.ts';
import { SLICE, getProfiles, getSettings, setSettings, type StoredProfile } from '../slices.ts';

/** Serialized size cap of one widget's (opaque) config. */
export const MAX_WIDGET_CONFIG_BYTES = 64 * 1024;

/** Default size of a newly added widget (the user resizes in edit mode). */
export const DEFAULT_WIDGET_SIZE: Readonly<Record<string, { w: number; h: number }>> = Object.freeze({
  search: { w: 8, h: 2 },
  launchpad: { w: 8, h: 6 },
  calendar: { w: 4, h: 8 },
  mail: { w: 4, h: 7 },
  todoist: { w: 4, h: 7 },
  weather: { w: 4, h: 5 },
  clock: { w: 4, h: 3 },
});
export const FALLBACK_WIDGET_SIZE: Readonly<{ w: number; h: number }> = Object.freeze({ w: 4, h: 4 });

/** Longest path id the server accepts (`IdParam`); anything longer is 404. */
const MAX_ID_LENGTH = 512;

// ---------------------------------------------------------------------------
// Pure layout helpers (ports of the server's)
// ---------------------------------------------------------------------------

/** Checks an opaque widget config: JSON-safe (no forbidden keys, bounded depth) and ≤ 64 KB. */
export function assertWidgetConfig(config: unknown): void {
  assertSafeJson(config, 'Widget config');
  if (jsonByteLength(config) > MAX_WIDGET_CONFIG_BYTES) {
    throw new StaticApiError('validation_failed', `Widget config exceeds ${MAX_WIDGET_CONFIG_BYTES} bytes`);
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
export function withFreshWidgetIds(layout: Layout, newId: () => string, mapConfig: (config: unknown) => unknown = (c) => c): Layout {
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

// ---------------------------------------------------------------------------
// Profile store (the `profiles` slice)
// ---------------------------------------------------------------------------

function notFound(): StaticApiError {
  return new StaticApiError('not_found', 'Profile not found');
}

function widgetNotFound(): StaticApiError {
  return new StaticApiError('not_found', 'Widget not found');
}

/** A path parameter as the server's `IdParam` accepts it (1–512 chars); otherwise 404. */
export function pathId(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.length > MAX_ID_LENGTH) throw new StaticApiError('not_found', 'Not found');
  return value;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The server's `ORDER BY sort, created_at, id`. */
export function byDisplayOrder(a: StoredProfile, b: StoredProfile): number {
  return a.sort - b.sort || a.createdAt - b.createdAt || compareStrings(a.id, b.id);
}

/** Stored rows in display order (a sorted copy; the slice itself is unordered). */
export function sortedProfiles(ctx: StaticContext): StoredProfile[] {
  return [...getProfiles(ctx)].sort(byDisplayOrder);
}

/** API shape of a stored row: timestamps stripped, layout re-validated (invalid → empty). */
export function toProfile(row: StoredProfile): Profile {
  const layout = LayoutSchema.safeParse(row.layout);
  return { id: row.id, name: row.name, sort: row.sort, layout: layout.success ? layout.data : emptyLayout() };
}

export function listProfiles(ctx: StaticContext): Profile[] {
  return sortedProfiles(ctx).map(toProfile);
}

export function profileExists(ctx: StaticContext, id: string): boolean {
  return getProfiles(ctx).some((p) => p.id === id);
}

/** Id of the first profile in display order (the fallback active profile), or null. */
export function firstProfileId(ctx: StaticContext): string | null {
  return sortedProfiles(ctx)[0]?.id ?? null;
}

function mustGetRow(ctx: StaticContext, id: string): StoredProfile {
  const row = getProfiles(ctx).find((p) => p.id === id);
  if (!row) throw notFound();
  return row;
}

/** Points `settings.activeProfileId` at `id`; returns whether the settings slice changed. */
function pointActiveTo(ctx: StaticContext, id: string | null): boolean {
  const settings = getSettings(ctx);
  if (settings.activeProfileId === id) return false;
  setSettings(ctx, { ...settings, activeProfileId: id });
  return true;
}

/** Read-modify-write of one profile's layout; nothing is written when `fn` throws. */
async function mutateLayout<T>(ctx: StaticContext, id: string, fn: (layout: Layout) => { layout: Layout; result: T }): Promise<T> {
  const row = mustGetRow(ctx, id);
  const { layout, result } = fn(structuredClone(toProfile(row).layout));
  row.layout = validate(LayoutSchema, layout, 'layout');
  row.updatedAt = ctx.now();
  await ctx.state.commit(SLICE.profiles);
  return result;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function register(router: StaticRouter): void {
  router.get('/api/profiles', (ctx) => json(listProfiles(ctx)));

  router.post('/api/profiles', async (ctx, { req }) => {
    const input = await parseJsonBody(req, ProfileCreateSchema);
    if (input.copyFromId !== undefined && input.layout !== undefined) {
      throw new StaticApiError('validation_failed', 'Pass either copyFromId or layout, not both');
    }
    if (input.layout) for (const item of input.layout.items) assertWidgetConfig(item.config);

    const rows = getProfiles(ctx);
    if (rows.length >= MAX_PROFILES) throw new StaticApiError('conflict', `At most ${MAX_PROFILES} profiles are allowed`);
    let source: Layout = emptyLayout();
    if (input.copyFromId !== undefined) source = toProfile(mustGetRow(ctx, input.copyFromId)).layout;
    else if (input.layout) source = input.layout;
    const layout = validate(LayoutSchema, withFreshWidgetIds(source, ctx.newId), 'layout');

    const id = ctx.newId();
    const sort = rows.reduce((max, p) => Math.max(max, p.sort), -1) + 1;
    const ts = ctx.now();
    rows.push({ id, name: input.name, sort, layout, createdAt: ts, updatedAt: ts });
    const active = getSettings(ctx).activeProfileId;
    const activated = active === null || !profileExists(ctx, active) ? pointActiveTo(ctx, id) : false;
    await ctx.state.commit(SLICE.profiles, ...(activated ? [SLICE.settings] : []));
    return json({ id, name: input.name, sort, layout } satisfies Profile, 201);
  });

  router.patch('/api/profiles/:id', async (ctx, { req, params }) => {
    const input = await parseJsonBody(req, ProfileUpdateSchema);
    const row = mustGetRow(ctx, pathId(params.id));
    row.name = input.name ?? row.name;
    row.sort = input.sort ?? row.sort;
    row.updatedAt = ctx.now();
    await ctx.state.commit(SLICE.profiles);
    return json(toProfile(row));
  });

  router.delete('/api/profiles/:id', async (ctx, { params }) => {
    const id = pathId(params.id);
    mustGetRow(ctx, id);
    const rows = getProfiles(ctx);
    if (rows.length <= 1) throw new StaticApiError('conflict', 'The last profile cannot be deleted');
    rows.splice(
      rows.findIndex((p) => p.id === id),
      1,
    );
    const active = getSettings(ctx).activeProfileId;
    const repointed = active === id || active === null || !profileExists(ctx, active) ? pointActiveTo(ctx, firstProfileId(ctx)) : false;
    await ctx.state.commit(SLICE.profiles, ...(repointed ? [SLICE.settings] : []));
    return noContent();
  });

  router.post('/api/profiles/:id/activate', async (ctx, { params }) => {
    const id = pathId(params.id);
    mustGetRow(ctx, id);
    if (pointActiveTo(ctx, id)) await ctx.state.commit(SLICE.settings);
    return json(getSettings(ctx));
  });

  router.put('/api/profiles/:id/positions', async (ctx, { req, params }) => {
    const input = await parseJsonBody(req, PositionsUpdateSchema);
    const row = mustGetRow(ctx, pathId(params.id));
    const profile = toProfile(row);
    const byId = new Map(input.items.map((p) => [p.id, p]));
    const layout: Layout = {
      version: 1,
      items: profile.layout.items.map((item) => {
        const pos = byId.get(item.id);
        return pos ? { ...item, x: pos.x, y: pos.y, w: pos.w, h: pos.h } : item;
      }),
    };
    row.layout = validate(LayoutSchema, layout, 'layout');
    row.updatedAt = ctx.now();
    await ctx.state.commit(SLICE.profiles);
    return json({ ...profile, layout: row.layout } satisfies Profile);
  });

  router.post('/api/profiles/:id/widgets', async (ctx, { req, params }) => {
    const input = await parseJsonBody(req, WidgetCreateSchema);
    const id = pathId(params.id);
    const config = input.config === undefined ? {} : input.config;
    assertWidgetConfig(config);
    const instance = await mutateLayout(ctx, id, (layout) => {
      if (BROWSER_UNAVAILABLE_WIDGET_TYPES.has(input.type)) {
        throw new StaticApiError('validation_failed', `Widget type "${input.type}" is not available in the browser-only build`);
      }
      if (layout.items.length >= MAX_WIDGETS_PER_PROFILE) {
        throw new StaticApiError('conflict', `At most ${MAX_WIDGETS_PER_PROFILE} widgets per profile are allowed`);
      }
      const size = DEFAULT_WIDGET_SIZE[input.type] ?? FALLBACK_WIDGET_SIZE;
      const slot = findFreeSlot(layout.items, size.w, size.h);
      const created = validate(
        WidgetInstanceSchema,
        {
          id: ctx.newId(),
          type: input.type,
          ...slot,
          ...size,
          config,
          frame: applyFramePatch({ showHeader: true, transparent: false }, input.frame),
        },
        'widget',
      );
      return { layout: { version: 1, items: [...layout.items, created] }, result: created };
    });
    return json(instance, 201);
  });

  router.patch('/api/profiles/:id/widgets/:instanceId', async (ctx, { req, params }) => {
    const input = await parseJsonBody(req, WidgetUpdateSchema);
    const id = pathId(params.id);
    const instanceId = pathId(params.instanceId);
    if (input.config !== undefined) assertWidgetConfig(input.config);
    const updated = await mutateLayout(ctx, id, (layout) => {
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
    return json(updated);
  });

  router.delete('/api/profiles/:id/widgets/:instanceId', async (ctx, { params }) => {
    const id = pathId(params.id);
    const instanceId = pathId(params.instanceId);
    await mutateLayout(ctx, id, (layout) => {
      if (!layout.items.some((i) => i.id === instanceId)) throw widgetNotFound();
      return { layout: { version: 1, items: layout.items.filter((i) => i.id !== instanceId) }, result: undefined };
    });
    return noContent();
  });
}
