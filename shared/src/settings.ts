/**
 * Settings (§7a settings.ts). Namespaces are composed with `.prefault({})` so that
 * `SettingsSchema.parse({})` yields complete defaults. Every level is `.strict()`.
 * Feature namespaces live in the feature's own contract file and are imported here.
 */
import { z } from 'zod';
import { EntityId } from './core.ts';
import { BookmarksSettingsSchema } from './bookmarks.ts';
import { CalendarSettingsSchema } from './calendar.ts';
import { SearchSettingsSchema } from './search.ts';
import { ThemeSchema } from './theme.ts';
import { TodoistSettingsSchema } from './todoist.ts';
import { PrecipUnitSchema, TemperatureUnitSchema, WeatherSettingsSchema, WindUnitSchema } from './weather.ts';

export const TIME_FORMATS = ['system', '12h', '24h'] as const;
export const WEEK_START_DAYS = [0, 1, 6] as const;

/** `'system'` or a BCP 47 language tag (e.g. `en-US`, `de`, `zh-Hant-TW`). */
export const LocaleSchema = z
  .string()
  .max(35)
  .regex(/^(system|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/, { message: "Must be 'system' or a BCP 47 language tag" });

export const GeneralSettingsSchema = z
  .object({
    userName: z.string().trim().max(64).optional(),
    locale: LocaleSchema.default('system'),
    timeFormat: z.enum(TIME_FORMATS).default('system'),
    /** 0 = Sunday, 1 = Monday, 6 = Saturday. */
    weekStartsOn: z.union([z.literal(0), z.literal(1), z.literal(6)]).default(1),
    temperatureUnit: TemperatureUnitSchema.default('C'),
    windUnit: WindUnitSchema.default('kmh'),
    precipUnit: PrecipUnitSchema.default('mm'),
    /** Launch pad / search results open in a new tab (otherwise the current tab). */
    openLinksInNewTab: z.boolean().default(false),
  })
  .strict();
export type GeneralSettings = z.output<typeof GeneralSettingsSchema>;

export const SettingsSchema = z
  .object({
    general: GeneralSettingsSchema.prefault({}),
    appearance: ThemeSchema.prefault({}),
    search: SearchSettingsSchema.prefault({}),
    bookmarks: BookmarksSettingsSchema.prefault({}),
    weather: WeatherSettingsSchema.prefault({}),
    calendar: CalendarSettingsSchema.prefault({}),
    todoist: TodoistSettingsSchema.prefault({}),
    activeProfileId: EntityId.nullable().default(null),
  })
  .strict();

export type Settings = z.output<typeof SettingsSchema>;
export type SettingsInput = z.input<typeof SettingsSchema>;
export type SettingsNamespace = keyof Settings;

/** Namespaces in storage order (one `settings` row each). */
export const SETTINGS_NAMESPACES = [
  'general',
  'appearance',
  'search',
  'bookmarks',
  'weather',
  'calendar',
  'todoist',
  'activeProfileId',
] as const satisfies readonly SettingsNamespace[];

export function isSettingsNamespace(value: unknown): value is SettingsNamespace {
  return typeof value === 'string' && (SETTINGS_NAMESPACES as readonly string[]).includes(value);
}

/** Schema of one namespace (used to validate a stored row in isolation). */
export function settingsNamespaceSchema<K extends SettingsNamespace>(ns: K): (typeof SettingsSchema.shape)[K] {
  return SettingsSchema.shape[ns];
}

/** Complete default settings (a fresh object every call). */
export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

/**
 * RFC 7396 JSON Merge Patch body for `PATCH /api/settings`: objects merge, arrays replace,
 * `null` resets the key to its default.
 */
export type MergePatch<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K] | null
    : T[K] extends object
      ? MergePatch<T[K]> | null
      : T[K] | null;
};
export type SettingsPatch = MergePatch<Settings>;
