/**
 * SettingsService (§6): one `settings` row per namespace (JSON), validated per namespace on
 * read (invalid/missing → defaults), cached in memory, with change notifications.
 *
 * `patch()` implements `PATCH /api/settings` (§7 Core): an RFC 7396 merge patch applied to a
 * `structuredClone` of the current settings (objects merge, arrays replace, `null` resets the key
 * to its default); `__proto__`/`constructor`/`prototype` keys at any depth → 400; the result is
 * validated with the strict `SettingsSchema` (→ 422) before anything is written.
 *
 * The cached settings are deeply frozen: values returned by `get`/`getAll` and passed to
 * listeners are shared, so an accidental mutation throws instead of silently diverging the cache
 * from the database.
 */
import { createHash } from 'node:crypto';
import {
  SETTINGS_NAMESPACES,
  SettingsSchema,
  settingsNamespaceSchema,
  type Settings,
  type SettingsNamespace,
} from '@homebase/shared';
import type { Db } from '../db/open.ts';
import { HttpError } from './errors.ts';
import { errorFields, type Logger } from './logger.ts';
import { applyMergePatch } from './merge-patch.ts';
import { assertSafeJson, isPlainObject } from './safe-json.ts';
import { validate } from './validate.ts';

export type SettingsListener<K extends SettingsNamespace> = (value: Settings[K], previous: Settings[K]) => void;

export interface SettingsService {
  /** Current value of a namespace (defaults applied; deeply frozen — clone before editing). */
  get<K extends keyof Settings>(ns: K): Settings[K];
  /** Complete settings (defaults applied; deeply frozen — clone before editing). */
  getAll(): Settings;
  /** Calls `cb` after `ns` changes. Returns an unsubscribe function. */
  onChange<K extends keyof Settings>(ns: K, cb: SettingsListener<K>): () => void;
  /**
   * Validates `next` (SettingsSchema; HttpError 422 `validation_failed` when invalid), persists
   * changed namespaces in one transaction, notifies.
   */
  replace(next: unknown): Settings;
  /** Replaces one namespace (validated → 422), persists and notifies. */
  set<K extends keyof Settings>(ns: K, value: unknown): Settings[K];
  /**
   * Applies an RFC 7396 merge patch (see module docs). Throws HttpError 400 for a non-object
   * patch or forbidden keys and 422 when the result fails validation; nothing is written then.
   */
  patch(patch: unknown): Settings;
  /** Drops the in-memory cache (after an import replaced the table). */
  reload(): void;
}

export interface SettingsServiceOptions {
  db: Db;
  log: Logger;
  now?: () => number;
}

/** Freezes `value` and everything reachable from it (settings are plain JSON data). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function createSettingsService(options: SettingsServiceOptions): SettingsService {
  const { db, log } = options;
  const now = options.now ?? Date.now;
  const listeners = new Map<SettingsNamespace, Set<SettingsListener<SettingsNamespace>>>();
  let current: Settings | null = null;
  /**
   * Namespaces whose stored row could not be read (defaults are used). They are written with the
   * next settings write, so a corrupt row heals instead of warning at every start; until then it
   * stays as it is (a newer version's settings are not overwritten just by starting).
   */
  const corrupt = new Set<SettingsNamespace>();
  const warned = new Set<SettingsNamespace>();
  const describe = (text: string) => ({ length: text.length, sha1: createHash('sha1').update(text).digest('hex').slice(0, 12) });

  const load = (): Settings => {
    const rows = db.all<{ namespace: string; value: string }>('SELECT namespace, value FROM settings');
    const stored = new Map(rows.map((r) => [r.namespace, r.value]));
    const assembled: Record<string, unknown> = {};
    for (const ns of SETTINGS_NAMESPACES) {
      const text = stored.get(ns);
      const schema = settingsNamespaceSchema(ns);
      if (text === undefined) {
        assembled[ns] = schema.parse(undefined);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        corrupt.add(ns);
        if (!warned.has(ns)) log.warn('stored settings namespace is not valid JSON; using defaults', { namespace: ns, ...describe(text), ...errorFields(err) });
        warned.add(ns);
        assembled[ns] = schema.parse(undefined);
        continue;
      }
      const result = schema.safeParse(parsed);
      if (result.success) {
        assembled[ns] = result.data;
        corrupt.delete(ns);
      } else {
        corrupt.add(ns);
        if (!warned.has(ns)) {
          log.warn('stored settings namespace failed validation; using defaults', {
            namespace: ns,
            issues: result.error.issues.length,
            ...describe(text),
          });
        }
        warned.add(ns);
        assembled[ns] = schema.parse(undefined);
      }
    }
    return deepFreeze(SettingsSchema.parse(assembled));
  };

  const ensure = (): Settings => {
    current ??= load();
    return current;
  };

  const notify = (previous: Settings, next: Settings, changed: SettingsNamespace[]): void => {
    for (const ns of changed) {
      for (const cb of listeners.get(ns) ?? []) {
        try {
          cb(next[ns], previous[ns]);
        } catch (err) {
          log.error('settings listener failed', { namespace: ns, ...errorFields(err) });
        }
      }
    }
  };

  const persist = (next: Settings): SettingsNamespace[] => {
    const previous = ensure();
    const changed = SETTINGS_NAMESPACES.filter((ns) => JSON.stringify(previous[ns]) !== JSON.stringify(next[ns]));
    const writes = SETTINGS_NAMESPACES.filter((ns) => changed.includes(ns) || corrupt.has(ns));
    if (writes.length === 0) return [];
    const ts = now();
    db.tx(() => {
      for (const ns of writes) {
        db.run(
          'INSERT INTO settings (namespace, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (namespace) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
          [ns, JSON.stringify(next[ns]), ts],
        );
      }
    });
    for (const ns of writes) corrupt.delete(ns);
    current = next;
    return changed;
  };

  const service: SettingsService = {
    get(ns) {
      return ensure()[ns];
    },
    getAll() {
      return ensure();
    },
    onChange(ns, cb) {
      let set = listeners.get(ns);
      if (!set) {
        set = new Set();
        listeners.set(ns, set);
      }
      const listener = cb as unknown as SettingsListener<SettingsNamespace>;
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    replace(nextInput) {
      const next = deepFreeze(validate(SettingsSchema, nextInput, 'settings'));
      const previous = ensure();
      const changed = persist(next);
      notify(previous, next, changed);
      return next;
    },
    set(ns, value) {
      const all = { ...ensure(), [ns]: value };
      return service.replace(all)[ns];
    },
    patch(patch) {
      if (!isPlainObject(patch)) throw new HttpError(400, 'bad_request', 'A settings patch must be a JSON object');
      assertSafeJson(patch, 'Settings patch');
      const merged = applyMergePatch(structuredClone(ensure()), patch);
      return service.replace(validate(SettingsSchema, merged, 'settings'));
    },
    reload() {
      current = null;
    },
  };
  return service;
}
