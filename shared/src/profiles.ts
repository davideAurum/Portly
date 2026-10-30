/**
 * Profiles and widget layouts (§7a profiles.ts, §7 Core profile routes, §10.2 grid).
 * A profile is a named layout; a layout is a list of widget instances on a 12-column grid.
 */
import { z } from 'zod';
import { EntityId, RecordKey, label } from './core.ts';

export const GRID_COLUMNS = 12;
export const MAX_GRID_ROW = 1000;
export const MAX_WIDGET_HEIGHT = 100;
export const MAX_WIDGETS_PER_PROFILE = 50;
export const MAX_PROFILES = 50;

/** The widget types this build ships (the registry may contain only these). */
export const WIDGET_TYPES = ['search', 'launchpad', 'calendar', 'mail', 'todoist', 'weather', 'clock', 'feeds', 'sports', 'notes'] as const;
export type KnownWidgetType = (typeof WIDGET_TYPES)[number];

export function isKnownWidgetType(value: unknown): value is KnownWidgetType {
  return typeof value === 'string' && (WIDGET_TYPES as readonly string[]).includes(value);
}

/**
 * Widget type as stored: any short machine key, so layouts (and imports) holding a type this
 * build does not know still parse — unknown types render a placeholder / are dropped on import.
 */
export const WidgetTypeSchema = RecordKey;

export const WidgetFrameSchema = z
  .object({
    title: z.string().trim().max(80).optional(),
    showHeader: z.boolean().default(true),
    transparent: z.boolean().default(false),
  })
  .strict();
export type WidgetFrame = z.output<typeof WidgetFrameSchema>;
export type WidgetFrameInput = z.input<typeof WidgetFrameSchema>;

/** Partial frame used by create/update payloads. */
export const WidgetFramePatchSchema = z
  .object({
    title: z.string().trim().max(80).nullable().optional(),
    showHeader: z.boolean().optional(),
    transparent: z.boolean().optional(),
  })
  .strict();
export type WidgetFramePatch = z.output<typeof WidgetFramePatchSchema>;

const GridX = z.number().int().min(0).max(GRID_COLUMNS - 1);
const GridY = z.number().int().min(0).max(MAX_GRID_ROW);
const GridW = z.number().int().min(1).max(GRID_COLUMNS);
const GridH = z.number().int().min(1).max(MAX_WIDGET_HEIGHT);

export const WidgetPositionSchema = z
  .object({
    id: EntityId,
    x: GridX,
    y: GridY,
    w: GridW,
    h: GridH,
  })
  .strict()
  .refine((p) => p.x + p.w <= GRID_COLUMNS, { message: `x + w must be ≤ ${GRID_COLUMNS}`, path: ['w'] });
export type WidgetPosition = z.output<typeof WidgetPositionSchema>;

export const WidgetInstanceSchema = z
  .object({
    id: EntityId,
    type: WidgetTypeSchema,
    x: GridX,
    y: GridY,
    w: GridW,
    h: GridH,
    /** Widget-specific; parsed by the widget's `configSchema` on every read (invalid → defaults). */
    config: z.unknown(),
    frame: WidgetFrameSchema.prefault({}),
  })
  .strict()
  .refine((p) => p.x + p.w <= GRID_COLUMNS, { message: `x + w must be ≤ ${GRID_COLUMNS}`, path: ['w'] });

export type WidgetInstance = z.output<typeof WidgetInstanceSchema>;
export type WidgetInstanceInput = z.input<typeof WidgetInstanceSchema>;

function uniqueIds(items: readonly { id: string }[]): boolean {
  return new Set(items.map((i) => i.id)).size === items.length;
}

export const LayoutSchema = z
  .object({
    version: z.literal(1),
    items: z.array(WidgetInstanceSchema).max(MAX_WIDGETS_PER_PROFILE),
  })
  .strict()
  .refine((l) => uniqueIds(l.items), { message: 'Widget ids must be unique', path: ['items'] });

export type Layout = z.output<typeof LayoutSchema>;
export type LayoutInput = z.input<typeof LayoutSchema>;

export function emptyLayout(): Layout {
  return { version: 1, items: [] };
}

export const ProfileNameSchema = label(64);

export const ProfileSchema = z
  .object({
    id: EntityId,
    name: ProfileNameSchema,
    sort: z.number().int(),
    layout: LayoutSchema,
  })
  .strict();

export type Profile = z.output<typeof ProfileSchema>;

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

/** `POST /api/profiles` — new empty profile, a copy of another profile, or an explicit layout. */
export const ProfileCreateSchema = z
  .object({
    name: ProfileNameSchema,
    copyFromId: EntityId.optional(),
    layout: LayoutSchema.optional(),
  })
  .strict();
export type ProfileCreate = z.output<typeof ProfileCreateSchema>;

/** `PATCH /api/profiles/:id` (name/sort). */
export const ProfileUpdateSchema = z
  .object({
    name: ProfileNameSchema.optional(),
    sort: z.number().int().optional(),
  })
  .strict();
export type ProfileUpdate = z.output<typeof ProfileUpdateSchema>;

/** `PUT /api/profiles/:id/positions {items:[{id,x,y,w,h}]}` */
export const PositionsUpdateSchema = z
  .object({
    items: z.array(WidgetPositionSchema).max(MAX_WIDGETS_PER_PROFILE),
  })
  .strict()
  .refine((p) => uniqueIds(p.items), { message: 'Widget ids must be unique', path: ['items'] });
export type PositionsUpdate = z.output<typeof PositionsUpdateSchema>;

/** `POST /api/profiles/:id/widgets {type, config?, frame?}` — the server picks the position. */
export const WidgetCreateSchema = z
  .object({
    type: WidgetTypeSchema,
    config: z.unknown().optional(),
    frame: WidgetFramePatchSchema.optional(),
  })
  .strict();
export type WidgetCreate = z.output<typeof WidgetCreateSchema>;

/** `PATCH /api/profiles/:id/widgets/:instanceId {config?, frame?}` — config replaces, frame merges. */
export const WidgetUpdateSchema = z
  .object({
    config: z.unknown().optional(),
    frame: WidgetFramePatchSchema.optional(),
  })
  .strict();
export type WidgetUpdate = z.output<typeof WidgetUpdateSchema>;
