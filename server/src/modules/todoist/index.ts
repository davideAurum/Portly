/**
 * Todoist module (§4.6, §7 Todoist, §8 Todoist).
 *
 * Routes (all non-exempt JSON routes, declared `paired()`: the paired Pages site may use them too):
 * - `GET    /api/todoist/token`             → `{configured}` (the token is never returned)
 * - `PUT    /api/todoist/token {token}`      → `{configured: true}`; the token is sanity-checked, then
 *                                             validated upstream (`GET /projects?limit=1`) before it
 *                                             is stored in the vault as `todoist:token`
 * - `DELETE /api/todoist/token`             → `{configured: false}`
 * - `GET    /api/todoist/tasks?filter=`     → `Task[]` (absent/empty filter → `settings.todoist.defaultFilter`;
 *                                             cursor paging, at most {@link MAX_TASKS})
 * - `POST   /api/todoist/tasks {text}`      → 201 `Task` (quick add; `null` if Todoist's answer can't be mapped)
 * - `POST   /api/todoist/tasks/:id/close`   → 204 (recurring tasks advance to their next date upstream)
 * - `POST   /api/todoist/tasks/:id/reopen`  → 204
 * - `PATCH  /api/todoist/tasks/:id`         → `Task` (upstream `POST /tasks/{id}`; allowlisted fields only)
 * - `GET    /api/todoist/projects`          → `Project[]` (in-memory cache, 5 min)
 *
 * Errors: no token → 409 `not_configured`; token stored but vault locked → 409 `reauth_required`;
 * upstream failures as documented in `client.ts`. A 429 answer carries `Retry-After`.
 *
 * Diagnostics (§17, health key `todoist`, on demand so never stale): every call made with the
 * stored token records its outcome — ok; `token_rejected` (with Todoist's status and `error_tag`),
 * `rate_limited` (next attempt = the end of the cooldown), `http_5xx`, `parse_error` or a transport
 * code. Answers about one request only (400 invalid filter, 404 gone task) leave the subject alone;
 * a request refused by our own cooldown or a locked vault is a skipped check. Saving a token that
 * Todoist accepts records ok; removing it forgets the subject. Calls run in
 * `withLogContext({area: 'todoist', op})`.
 */
import type { Context, Hono } from 'hono';
import {
  QuickAddSchema,
  TaskUpdateSchema,
  TodoistFilterSchema,
  TodoistTokenUpdateSchema,
  type Project,
  type Task,
  type TaskUpdate,
  type TodoistTokenStatus,
} from '@portly/shared';
import type { AppContext, AppEnv } from '../../context.ts';
import { HttpError } from '../../lib/errors.ts';
import { outcomeFromError, type HealthSubject, type Outcome } from '../../lib/health.ts';
import { withLogContext } from '../../lib/log-context.ts';
import { paired } from '../../lib/routes.ts';
import { parseBody, validate } from '../../lib/validate.ts';
import { VaultLockedError } from '../../security/vault.ts';
import {
  TodoistRateLimitError,
  TodoistUpstreamError,
  createTodoistClient,
  unexpectedResponse,
  type TodoistClient,
  type UpstreamPurpose,
} from './client.ts';
import { TASK_ID_REGEX, mapProjects, mapTask, mapTasks } from './mapping.ts';
import { TOKEN_SECRET_ID, normalizeToken, requireToken } from './token.ts';

export { TOKEN_SECRET_ID } from './token.ts';

export const prefixes = ['/api/todoist'] as const;

/** The stored token's Todoist connection (key `todoist`): checked on demand, so never stale. */
export const TODOIST_HEALTH: HealthSubject = { key: 'todoist', area: 'todoist', label: 'Todoist', expectEveryMs: null };

/** Cap on tasks returned for one filter (§8: 200 per page, cursor paging). */
export const MAX_TASKS = 500;
export const MAX_PROJECTS = 1000;
export const PROJECTS_CACHE_KEY = 'todoist:projects';
export const PROJECTS_TTL_MS = 5 * 60 * 1000;
const MEMO_PREFIX = 'todoist:';

function taskIdParam(c: Context<AppEnv>): string {
  const id = c.req.param('id');
  if (typeof id !== 'string' || !TASK_ID_REGEX.test(id)) throw new HttpError(404, 'not_found', 'Task not found');
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

export interface TodoistModuleOptions {
  /** Upstream client override (tests). */
  client?: TodoistClient;
}

export function register(app: Hono<AppEnv>, ctx: AppContext, options: TodoistModuleOptions = {}): void {
  const log = ctx.log.child({ module: 'todoist' });
  const client = options.client ?? createTodoistClient({ fetch: ctx.fetch, log });

  // Bumped whenever the token changes: cached (and in-flight) project lists of the previous
  // token live under another key, so a request racing a token change can't serve or cache them.
  let tokenGeneration = 0;
  const forgetCachedData = () => {
    tokenGeneration += 1;
    ctx.memo.delPrefix(MEMO_PREFIX);
    client.resetCooldown();
  };

  // A 429 (from Todoist or our cooldown) tells the browser when to try again.
  app.use('/api/todoist/*', async (c, next) => {
    await next();
    const err = c.error;
    if (err instanceof TodoistRateLimitError) c.header('Retry-After', String(err.retryAfterSeconds));
  });

  // ---- health ---------------------------------------------------------------

  /** The stored token; a locked vault is a skipped check of the `todoist` subject. */
  const storedToken = (): string => {
    try {
      return requireToken(ctx.vault);
    } catch (err) {
      if (err instanceof VaultLockedError) ctx.health.touch(TODOIST_HEALTH, { skipped: 'vault_locked' });
      throw err;
    }
  };

  const recordFailure = (err: unknown, ms: number): void => {
    if (err instanceof TodoistRateLimitError && err.httpStatus === null) {
      // Refused by our own cooldown: nothing was sent.
      ctx.health.touch(TODOIST_HEALTH, { skipped: 'backoff', nextAttemptAt: client.cooldownUntil() || null });
      return;
    }
    // About this request only (a filter Todoist cannot parse, a task deleted elsewhere): the
    // connection itself answered.
    if (err instanceof TodoistUpstreamError && (err.httpStatus === 400 || err.httpStatus === 404)) return;
    const extra: Partial<Outcome> = { ms };
    if (err instanceof TodoistRateLimitError) extra.nextAttemptAt = client.cooldownUntil() || null;
    if (err instanceof TodoistUpstreamError) {
      if (err.httpStatus < 300) extra.code = 'parse_error';
      if (err.errorTag !== null) extra.detail = { errorTag: err.errorTag };
    }
    ctx.health.record(TODOIST_HEALTH, outcomeFromError(err, extra));
  };

  /**
   * One Todoist operation with the stored token: logged under `op`, its outcome recorded on
   * `todoist` — unless the token changed meanwhile (the answer is about a token that is gone).
   */
  const tracked = <T>(op: UpstreamPurpose, fn: () => Promise<T>): Promise<T> =>
    withLogContext({ area: 'todoist', op }, async () => {
      const generation = tokenGeneration;
      const started = Date.now();
      try {
        const result = await fn();
        if (generation === tokenGeneration) ctx.health.record(TODOIST_HEALTH, { ok: true, ms: Date.now() - started });
        return result;
      } catch (err) {
        if (generation === tokenGeneration) recordFailure(err, Date.now() - started);
        throw err;
      }
    });

  // ---- token ----------------------------------------------------------------

  app.get('/api/todoist/token', paired(), (c) => {
    const body: TodoistTokenStatus = { configured: ctx.vault.has(TOKEN_SECRET_ID) };
    return c.json(body);
  });

  app.put('/api/todoist/token', paired(), async (c) => {
    const { token: raw } = await parseBody(c, TodoistTokenUpdateSchema);
    const token = normalizeToken(raw);
    if (ctx.vault.state === 'locked') throw new VaultLockedError();
    // A fresh token deserves a fresh attempt even if the old one was rate limited.
    client.resetCooldown();
    const started = Date.now();
    // A candidate token that fails says nothing about the stored one: only acceptance is recorded.
    await withLogContext({ area: 'todoist', op: 'validate' }, () =>
      client.request(token, { path: '/projects', query: { limit: '1' }, purpose: 'validate' }),
    );
    ctx.vault.put(TOKEN_SECRET_ID, token);
    forgetCachedData();
    ctx.health.record(TODOIST_HEALTH, { ok: true, ms: Date.now() - started });
    log.info('todoist token saved');
    const body: TodoistTokenStatus = { configured: true };
    return c.json(body);
  });

  app.delete('/api/todoist/token', paired(), (c) => {
    ctx.vault.delete(TOKEN_SECRET_ID);
    forgetCachedData();
    ctx.health.forget(TODOIST_HEALTH.key);
    log.info('todoist token removed');
    const body: TodoistTokenStatus = { configured: false };
    return c.json(body);
  });

  // ---- tasks ----------------------------------------------------------------

  app.get('/api/todoist/tasks', paired(), async (c) => {
    const raw = c.req.query('filter');
    const filter = raw !== undefined && raw.trim() !== '' ? validate(TodoistFilterSchema, raw, 'filter') : ctx.settings.get('todoist').defaultFilter;
    const token = storedToken();
    const { items, truncated } = await tracked('filter', () =>
      client.paged(token, { path: '/tasks/filter', query: { query: filter }, purpose: 'filter', maxItems: MAX_TASKS }),
    );
    const { tasks, skipped } = mapTasks(items);
    // Every widget poll would repeat it: collapsed to one line per 30 min while the count stays.
    if (skipped > 0) log.warn('todoist tasks skipped (unexpected shape)', { skipped, repeatKey: 'todoist tasks skipped', repeatSig: String(skipped) });
    if (truncated) log.debug('todoist task list truncated', { max: MAX_TASKS });
    return c.json(tasks satisfies Task[]);
  });

  app.post('/api/todoist/tasks', paired(), async (c) => {
    const { text } = await parseBody(c, QuickAddSchema);
    const token = storedToken();
    const data = await tracked('quick-add', () => client.request(token, { method: 'POST', path: '/tasks/quick', body: { text }, purpose: 'quick-add' }));
    const task = mapTask(data);
    if (!task) log.warn('todoist quick add returned an unexpected shape');
    return c.json(task satisfies Task | null, 201);
  });

  app.post('/api/todoist/tasks/:id/close', paired(), async (c) => {
    const id = taskIdParam(c);
    const token = storedToken();
    await tracked('task', () => client.request(token, { method: 'POST', path: `/tasks/${encodeURIComponent(id)}/close`, purpose: 'task' }));
    return c.body(null, 204);
  });

  app.post('/api/todoist/tasks/:id/reopen', paired(), async (c) => {
    const id = taskIdParam(c);
    const token = storedToken();
    await tracked('task', () => client.request(token, { method: 'POST', path: `/tasks/${encodeURIComponent(id)}/reopen`, purpose: 'task' }));
    return c.body(null, 204);
  });

  app.patch('/api/todoist/tasks/:id', paired(), async (c) => {
    const id = taskIdParam(c);
    const update = await parseBody(c, TaskUpdateSchema);
    const body = toUpstreamUpdate(update);
    if (Object.keys(body).length === 0) throw new HttpError(422, 'validation_failed', 'Nothing to update');
    const token = storedToken();
    const task = await tracked('update', async () => {
      // v1 updates are POSTs to the task (not PATCH).
      const data = await client.request(token, { method: 'POST', path: `/tasks/${encodeURIComponent(id)}`, body, purpose: 'update' });
      const mapped = mapTask(data);
      if (!mapped) throw unexpectedResponse();
      return mapped;
    });
    return c.json(task satisfies Task);
  });

  // ---- projects -------------------------------------------------------------

  app.get('/api/todoist/projects', paired(), async (c) => {
    const token = storedToken();
    const projects = await ctx.memo.getOrSet<Project[]>(`${PROJECTS_CACHE_KEY}:${tokenGeneration}`, PROJECTS_TTL_MS, () =>
      tracked('list', async () => {
        const { items } = await client.paged(token, { path: '/projects', purpose: 'list', maxItems: MAX_PROJECTS });
        return mapProjects(items);
      }),
    );
    return c.json(projects);
  });
}
