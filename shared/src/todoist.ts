/**
 * Todoist contracts (§7a todoist.ts): tasks, projects, request payloads and the `todoist`
 * settings namespace. Todoist ids are opaque strings.
 */
import { z } from 'zod';

export const TODOIST_PRIORITIES = [1, 2, 3, 4] as const;
/** Todoist API priority: 4 = p1 (urgent) … 1 = p4 (normal). */
export type TodoistPriority = (typeof TODOIST_PRIORITIES)[number];
export const TodoistPrioritySchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export interface TaskDue {
  /** `YYYY-MM-DD` (or the date part of a floating date-time). */
  date: string;
  /** ISO date-time when the task has a time, else null. */
  datetime: string | null;
  /** Human-readable due string as typed ("every monday"). */
  string: string;
  isRecurring: boolean;
}

export interface Task {
  id: string;
  content: string;
  description: string;
  projectId: string;
  due: TaskDue | null;
  priority: TodoistPriority;
  labels: string[];
  url: string;
}

export interface Project {
  id: string;
  name: string;
  /** Hex color mapped from the Todoist color name at ingest (see {@link TODOIST_COLORS}); null if unknown. */
  color: string | null;
}

/** Todoist color names → hex (normalized at ingest per §4.5). */
export const TODOIST_COLORS: Readonly<Record<string, string>> = Object.freeze({
  berry_red: '#b8255f',
  red: '#db4035',
  orange: '#ff9933',
  yellow: '#fad000',
  olive_green: '#afb83b',
  lime_green: '#7ecc49',
  green: '#299438',
  mint_green: '#6accbc',
  teal: '#158fad',
  sky_blue: '#14aaf5',
  light_blue: '#96c3eb',
  blue: '#4073ff',
  grape: '#884dff',
  violet: '#af38eb',
  lavender: '#eb96eb',
  magenta: '#e05194',
  salmon: '#ff8d85',
  charcoal: '#808080',
  grey: '#b8b8b8',
  taupe: '#ccac93',
});

export function todoistColorToHex(name: unknown): string | null {
  return typeof name === 'string' ? (TODOIST_COLORS[name] ?? null) : null;
}

export const DEFAULT_TODOIST_FILTER = 'today | overdue';

export const TodoistFilterSchema = z.string().trim().min(1).max(1024);

/** `settings.todoist` */
export const TodoistSettingsSchema = z
  .object({
    defaultFilter: TodoistFilterSchema.default(DEFAULT_TODOIST_FILTER),
  })
  .strict();
export type TodoistSettings = z.output<typeof TodoistSettingsSchema>;

/** `GET /api/todoist/token` → `{configured}` (the token itself is never returned). */
export interface TodoistTokenStatus {
  configured: boolean;
}

/** `PUT /api/todoist/token {token}` (validated upstream before it is stored). */
export const TodoistTokenUpdateSchema = z
  .object({
    token: z.string().trim().min(1).max(200),
  })
  .strict();
export type TodoistTokenUpdate = z.output<typeof TodoistTokenUpdateSchema>;

/** `GET /api/todoist/tasks?filter=` (absent → `settings.todoist.defaultFilter`). */
export const TasksQuerySchema = z.object({
  filter: TodoistFilterSchema.optional(),
});
export type TasksQuery = z.output<typeof TasksQuerySchema>;

/** `POST /api/todoist/tasks {text}` — Todoist quick add (natural language). */
export const QuickAddSchema = z
  .object({
    text: z.string().trim().min(1).max(1000),
  })
  .strict();
export type QuickAdd = z.output<typeof QuickAddSchema>;

/** `PATCH /api/todoist/tasks/:id` */
export const TaskUpdateSchema = z
  .object({
    content: z.string().trim().min(1).max(1000).optional(),
    description: z.string().max(16_000).optional(),
    priority: TodoistPrioritySchema.optional(),
    /** Natural-language due ("tomorrow 5pm"); null clears the due date. */
    dueString: z.string().trim().max(200).nullable().optional(),
    labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  })
  .strict();
export type TaskUpdate = z.output<typeof TaskUpdateSchema>;
