/**
 * Row mapping helpers (§5 / §7a conventions): DB snake_case ↔ API camelCase, INT 0/1 ↔ boolean,
 * epoch ms ↔ ISO strings, JSON TEXT columns validated with zod on read.
 */
import type { z } from 'zod';
import type { Logger } from '../lib/logger.ts';

export function toBool(value: unknown): boolean {
  return value === 1 || value === 1n || value === true;
}

export function fromBool(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

/** Epoch ms → ISO string (null-safe). */
export function msToIso(value: unknown): string | null {
  if (typeof value === 'bigint') return new Date(Number(value)).toISOString();
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

/** Epoch ms → ISO string; throws when the column is unexpectedly null. */
export function msToIsoStrict(value: unknown): string {
  const iso = msToIso(value);
  if (iso === null) throw new TypeError('Expected an epoch-ms timestamp');
  return iso;
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

export function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return fallback;
}

/**
 * Parses a JSON TEXT column with `schema`. Invalid JSON or schema failures return `fallback`
 * (and are logged when a logger is given) — stored data never crashes a request.
 */
export function parseJsonColumn<S extends z.ZodType>(
  schema: S,
  text: unknown,
  fallback: z.output<S>,
  log?: Logger,
  what = 'json column',
): z.output<S> {
  if (typeof text !== 'string') return fallback;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    log?.warn('invalid JSON in database column', { column: what });
    return fallback;
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    log?.warn('database column failed validation', { column: what, issues: result.error.issues.length });
    return fallback;
  }
  return result.data;
}

/** Converts `snake_case` keys to `camelCase` (shallow). */
export function camelize<T extends Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase())] = value;
  }
  return out as T;
}
