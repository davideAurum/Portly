/**
 * Todoist module of the static backend (port of server/src/modules/todoist/index.ts): the browser
 * talks to api.todoist.com/api/v1 directly with the personal API token kept in the `todoist-token`
 * slice (this browser only; never exported, never returned).
 *
 * Routes:
 * - `GET    /api/todoist/token`             → `{configured}` (the token is never returned)
 * - `PUT    /api/todoist/token {token}`      → `{configured: true}`; the token is sanity-checked, then
 *                                             validated upstream (`GET /projects?limit=1`) before it
 *                                             is stored
 * - `DELETE /api/todoist/token`             → `{configured: false}`
 * - `GET    /api/todoist/tasks?filter=`     → `Task[]` (absent/empty filter → `settings.todoist.defaultFilter`;
 *                                             cursor paging, at most {@link MAX_TASKS})
 * - `POST   /api/todoist/tasks {text}`      → 201 `Task` (quick add; `null` if Todoist's answer can't be mapped)
 * - `POST   /api/todoist/tasks/:id/close`   → 204 (recurring tasks advance to their next date upstream;
 *                                             Todoist v1 answers 200 `{}`, which is treated as success)
 * - `POST   /api/todoist/tasks/:id/reopen`  → 204
 * - `PATCH  /api/todoist/tasks/:id`         → `Task` (upstream `POST /tasks/{id}`; allowlisted fields only)
 * - `GET    /api/todoist/projects`          → `Project[]` (in-memory cache, 5 min, keyed by the token generation;
 *                                             the shared upstream call never takes one request's AbortSignal)
 *
 * Errors: no token → 409 `not_configured` `{reason: 'no_token'}`; upstream failures as documented in
 * providers/todoistClient.ts. A 429 answer carries `Retry-After`. There is no vault, so
 * `reauth_required` is never emitted.
 */
import {
  QuickAddSchema,
  TaskUpdateSchema,
  TodoistFilterSchema,
  TodoistTokenUpdateSchema,
  type Project,
  type Task,
  type TaskUpdate,
  type TodoistTokenStatus,
} from '@homebase/shared';
import type { StaticContext } from '../context.ts';
import { createMemoryCache, type MemoryCache } from '../lib/cache.ts';
import { parseJsonBody, validate } from '../lib/validate.ts';
import { createTodoistClient, type TodoistClient } from '../providers/todoistClient.ts';
import { TASK_ID_REGEX, mapProjects, mapTask, mapTasks } from '../providers/todoistMapping.ts';
import { clearToken, hasToken, normalizeToken, requireToken, storeToken } from '../providers/todoistToken.ts';
import { StaticApiError, json, noContent } from '../respond.ts';
import type { StaticRouter } from '../router.ts';
import { getSettings, getTodoistToken } from '../slices.ts';

/** Cap on tasks returned for one filter (§8: 200 per page, cursor paging). */
export const MAX_TASKS = 500;
export const MAX_PROJECTS = 1000;
export const PROJECTS_CACHE_KEY = 'todoist:projects';
export const PROJECTS_TTL_MS = 5 * 60 * 1000;
const MEMO_PREFIX = 'todoist:';

export interface TodoistModuleState {
  client: TodoistClient;
  /** Project lists, keyed `todoist:projects:<token generation>`. */
  cache: MemoryCache;
}

const states = new WeakMap<StaticContext, TodoistModuleState>();

/** The backend's client (cooldown) and projects cache (one per context; exposed for tests). */
export function todoistState(ctx: StaticContext): TodoistModuleState {
  let state = states.get(ctx);
  if (!state) {
    state = { client: createTodoistClient({ now: ctx.now }), cache: createMemoryCache({ now: ctx.now }) };
    states.set(ctx, state);
  }
  return state;
}

function taskIdParam(params: Readonly<Record<string, string>>): string {
  const id = params.id;
  if (typeof id !== 'string' || !TASK_ID_REGEX.test(id)) throw new StaticApiError('not_found', 'Task not found');
  return id;
}

/** The static PATCH field allowlist: our camelCase fields → Todoist's update body. */
export function toUpstreamUpdate(update: TaskUpdate): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (update.content !== undefined) body.content = update.content;
  if (update.description !== undefined) body.description = update.description;
  if (update.priority !== undefined) body.priority = update.priority;
  if (update.dueString !== undefined) {
    // Todoist removes the due date for the special value "no date".
    body.due_string = update.dueString === null || update.dueString === '' ? 'no date' : update.dueString;
  }
  if (update.labels !== undefined) body.labels = [...new Set(update.labels)];
  return body;
}

/**
 * The token changed: cached (and in-flight) project lists of the previous token live under another
 * generation key (bumped by the token store), so a request racing a token change can't serve or
 * cache them; the rate-limit cooldown belongs to the old token too.
 */
function forgetCachedData(ctx: StaticContext): void {
  const { client, cache } = todoistState(ctx);
  cache.delPrefix(MEMO_PREFIX);
  client.resetCooldown();
}

export function register(router: StaticRouter): void {
  // ---- token ----------------------------------------------------------------

  router.get('/api/todoist/token', (ctx) => {
    const body: TodoistTokenStatus = { configured: hasToken(ctx) };
    return json(body);
  });

  router.put('/api/todoist/token', async (ctx, { req }) => {
    const { token: raw } = await parseJsonBody(req, TodoistTokenUpdateSchema);
    const token = normalizeToken(raw);
    const { client } = todoistState(ctx);
    // A fresh token deserves a fresh attempt even if the old one was rate limited.
    client.resetCooldown();
    await client.request(token, { path: '/projects', query: { limit: '1' }, purpose: 'validate', signal: req.signal });
    await storeToken(ctx, token);
    forgetCachedData(ctx);
    const body: TodoistTokenStatus = { configured: true };
    return json(body);
  });

  router.delete('/api/todoist/token', async (ctx) => {
    await clearToken(ctx);
    forgetCachedData(ctx);
    const body: TodoistTokenStatus = { configured: false };
    return json(body);
  });

  // ---- tasks ----------------------------------------------------------------

  router.get('/api/todoist/tasks', async (ctx, { url, req }) => {
    const raw = url.searchParams.get('filter');
    const filter = raw !== null && raw.trim() !== '' ? validate(TodoistFilterSchema, raw, 'filter') : getSettings(ctx).todoist.defaultFilter;
    const token = requireToken(ctx);
    const { client } = todoistState(ctx);
    const { items } = await client.paged(token, { path: '/tasks/filter', query: { query: filter }, purpose: 'filter', maxItems: MAX_TASKS, signal: req.signal });
    const { tasks } = mapTasks(items);
    return json(tasks satisfies Task[]);
  });

  router.post('/api/todoist/tasks', async (ctx, { req }) => {
    const { text } = await parseJsonBody(req, QuickAddSchema);
    const token = requireToken(ctx);
    const { client } = todoistState(ctx);
    const data = await client.request(token, { method: 'POST', path: '/tasks/quick', body: { text }, purpose: 'quick-add', signal: req.signal });
    const task = mapTask(data);
    return json(task satisfies Task | null, 201);
  });

  router.post('/api/todoist/tasks/:id/close', async (ctx, { req, params }) => {
    const id = taskIdParam(params);
    const token = requireToken(ctx);
    const { client } = todoistState(ctx);
    await client.request(token, { method: 'POST', path: `/tasks/${encodeURIComponent(id)}/close`, purpose: 'task', signal: req.signal });
    return noContent();
  });

  router.post('/api/todoist/tasks/:id/reopen', async (ctx, { req, params }) => {
    const id = taskIdParam(params);
    const token = requireToken(ctx);
    const { client } = todoistState(ctx);
    await client.request(token, { method: 'POST', path: `/tasks/${encodeURIComponent(id)}/reopen`, purpose: 'task', signal: req.signal });
    return noContent();
  });

  router.patch('/api/todoist/tasks/:id', async (ctx, { req, params }) => {
    const id = taskIdParam(params);
    const update = await parseJsonBody(req, TaskUpdateSchema);
    const body = toUpstreamUpdate(update);
    if (Object.keys(body).length === 0) throw new StaticApiError('validation_failed', 'Nothing to update');
    const token = requireToken(ctx);
    const { client } = todoistState(ctx);
    // v1 updates are POSTs to the task (not PATCH).
    const data = await client.request(token, { method: 'POST', path: `/tasks/${encodeURIComponent(id)}`, body, purpose: 'update', signal: req.signal });
    const task = mapTask(data);
    if (!task) throw new StaticApiError('provider_error', 'Todoist returned an unexpected response.');
    return json(task satisfies Task);
  });

  // ---- projects -------------------------------------------------------------

  router.get('/api/todoist/projects', async (ctx) => {
    const token = requireToken(ctx);
    const { client, cache } = todoistState(ctx);
    const generation = getTodoistToken(ctx).generation;
    // Single flight: concurrent requests share this call, so it runs without any one caller's
    // signal (under the client's own deadline), as on the server.
    const projects = await cache.getOrSet<Project[]>(`${PROJECTS_CACHE_KEY}:${generation}`, PROJECTS_TTL_MS, async () => {
      const { items } = await client.paged(token, { path: '/projects', purpose: 'list', maxItems: MAX_PROJECTS });
      return mapProjects(items);
    });
    return json(projects);
  });
}
