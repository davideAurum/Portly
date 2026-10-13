/**
 * Todoist unified API v1 → Homebase contracts (§7a todoist.ts, §8 Todoist).
 *
 * Upstream objects are parsed leniently (unknown fields ignored) and mapped one by one: a
 * malformed task or project is skipped rather than failing the whole list. Strings are capped at
 * ingest, colors are mapped from Todoist's named palette to hex, and every task id we hand out
 * matches {@link TASK_ID_REGEX} so it can be used in our own routes.
 *
 * Due dates (`due.date`) come in three shapes:
 * - `YYYY-MM-DD`                 full-day
 * - `YYYY-MM-DDTHH:MM:SS`        floating date-time (same wall time in every zone)
 * - `YYYY-MM-DDTHH:MM:SSZ`       fixed date-time in UTC (`due.timezone` names the user's zone)
 * A separate `due.datetime` (REST-style) is honoured when present.
 */
import { z } from 'zod';
import { todoistColorToHex, type Project, type Task, type TaskDue, type TodoistPriority } from '@homebase/shared';

/** Task/project ids we accept in paths and return to the client (Todoist ids are opaque alphanumeric strings). */
export const TASK_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export const MAX_CONTENT_CHARS = 2000;
export const MAX_DESCRIPTION_CHARS = 16_000;
export const MAX_LABELS = 50;
export const MAX_LABEL_CHARS = 100;
export const MAX_PROJECT_NAME_CHARS = 200;
export const MAX_DUE_STRING_CHARS = 200;

export const TODOIST_TASK_URL = 'https://app.todoist.com/app/task/';

const Id = z.union([z.string(), z.number().int().nonnegative()]).transform((v) => String(v));

const UpstreamDueSchema = z.looseObject({
  date: z.string(),
  datetime: z.string().nullish(),
  string: z.string().nullish(),
  timezone: z.string().nullish(),
  is_recurring: z.boolean().nullish(),
});

const UpstreamTaskSchema = z.looseObject({
  id: Id,
  content: z.string(),
  description: z.string().nullish(),
  project_id: Id.nullish(),
  due: UpstreamDueSchema.nullish(),
  priority: z.number().nullish(),
  labels: z.array(z.unknown()).nullish(),
  checked: z.boolean().nullish(),
  is_deleted: z.boolean().nullish(),
});

const UpstreamProjectSchema = z.looseObject({
  id: Id,
  name: z.string(),
  color: z.unknown().optional(),
  is_deleted: z.boolean().nullish(),
  is_archived: z.boolean().nullish(),
});

/** One page of a cursor-paged v1 list: `{results, next_cursor}`. */
export const UpstreamPageSchema = z.looseObject({
  results: z.array(z.unknown()),
  next_cursor: z.string().nullish(),
});
export type UpstreamPage = z.output<typeof UpstreamPageSchema>;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function isRealDate(ymd: string): boolean {
  const m = DATE_ONLY.exec(ymd);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** `YYYY-MM-DD` of an instant in an IANA zone, or null when the zone is unknown. */
export function dateInZone(instant: string, timeZone: string): string | null {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const y = get('year');
    const m = get('month');
    const d = get('day');
    return y && m && d ? `${y}-${m}-${d}` : null;
  } catch {
    return null;
  }
}

/** Maps a v1 due object; null when absent or unparseable. */
export function mapDue(raw: unknown): TaskDue | null {
  const parsed = UpstreamDueSchema.safeParse(raw);
  if (!parsed.success) return null;
  const due = parsed.data;
  const value = due.date.trim();

  let date: string;
  let datetime: string | null = null;
  const explicit = typeof due.datetime === 'string' ? due.datetime.trim() : '';
  if (DATE_ONLY.test(value)) {
    date = value;
    if (explicit && DATE_TIME.test(explicit) && !Number.isNaN(Date.parse(explicit))) datetime = explicit;
  } else {
    const m = DATE_TIME.exec(value);
    if (!m || Number.isNaN(Date.parse(value))) return null;
    date = m[1] as string;
    datetime = value;
  }
  if (!isRealDate(date)) return null;

  // A fixed (UTC/offset) time belongs to the calendar day of the task's own zone.
  if (datetime !== null && /(?:Z|[+-]\d{2}:?\d{2})$/.test(datetime)) {
    const local = due.timezone ? dateInZone(datetime, due.timezone) : null;
    date = local ?? date;
  }

  return {
    date,
    datetime,
    string: cap((due.string ?? '').trim(), MAX_DUE_STRING_CHARS),
    isRecurring: due.is_recurring === true,
  };
}

function mapPriority(value: number | null | undefined): TodoistPriority {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  const rounded = Math.round(value);
  return (rounded < 1 ? 1 : rounded > 4 ? 4 : rounded) as TodoistPriority;
}

function mapLabels(values: readonly unknown[] | null | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const label = value.trim();
    if (label === '' || out.includes(label)) continue;
    out.push(cap(label, MAX_LABEL_CHARS));
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

export function taskUrl(id: string): string {
  return `${TODOIST_TASK_URL}${encodeURIComponent(id)}`;
}

/** Maps one v1 task; null for malformed, completed or deleted tasks. */
export function mapTask(raw: unknown): Task | null {
  const parsed = UpstreamTaskSchema.safeParse(raw);
  if (!parsed.success) return null;
  const t = parsed.data;
  if (!TASK_ID_REGEX.test(t.id) || t.checked === true || t.is_deleted === true) return null;
  return {
    id: t.id,
    content: cap(t.content, MAX_CONTENT_CHARS),
    description: cap(t.description ?? '', MAX_DESCRIPTION_CHARS),
    // Only ids we could use ourselves (a malformed one would just never match a project chip).
    projectId: t.project_id && TASK_ID_REGEX.test(t.project_id) ? t.project_id : '',
    due: t.due ? mapDue(t.due) : null,
    priority: mapPriority(t.priority),
    labels: mapLabels(t.labels),
    url: taskUrl(t.id),
  };
}

/** Maps a list, dropping entries that cannot be mapped; `skipped` counts them. */
export function mapTasks(raw: readonly unknown[]): { tasks: Task[]; skipped: number } {
  const tasks: Task[] = [];
  let skipped = 0;
  for (const item of raw) {
    const task = mapTask(item);
    if (task) tasks.push(task);
    else skipped++;
  }
  return { tasks, skipped };
}

/** Maps one v1 project; null for malformed, deleted or archived projects. */
export function mapProject(raw: unknown): Project | null {
  const parsed = UpstreamProjectSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  if (p.is_deleted === true || p.is_archived === true || !TASK_ID_REGEX.test(p.id)) return null;
  return { id: p.id, name: cap(p.name, MAX_PROJECT_NAME_CHARS), color: todoistColorToHex(p.color) };
}

export function mapProjects(raw: readonly unknown[]): Project[] {
  const out: Project[] = [];
  for (const item of raw) {
    const project = mapProject(item);
    if (project) out.push(project);
  }
  return out;
}
