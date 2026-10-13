/**
 * Todoist API client (§7 Todoist). The token is write-only: the server only reports
 * `{configured}`. Task queries are keyed by their filter (`qk.todoist.tasks(filter)`); every
 * mutation refreshes the whole `['todoist', 'tasks']` family so all widgets stay in sync.
 *
 * Completing a task is optimistic (§10.7 #8, see {@link useTaskActions}).
 */
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Project, Task, TaskUpdate, TodoistTokenStatus } from '@portly/shared';
import { apiDelete, apiGet, apiPatch, apiPath, apiPost, apiPut } from './client.ts';
import { qk } from './keys.ts';

/** §10.7: todoist 30 s. */
export const TODOIST_TASKS_STALE_MS = 30_000;
export const TODOIST_TASKS_REFRESH_MS = 5 * 60_000;
/** Matches the server's 5 min project cache. */
export const TODOIST_PROJECTS_STALE_MS = 5 * 60_000;

const TASKS_ROOT = ['todoist', 'tasks'] as const;

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export function fetchTodoistToken(signal?: AbortSignal): Promise<TodoistTokenStatus> {
  return apiGet<TodoistTokenStatus>('/api/todoist/token', { signal });
}

/**
 * `{configured}` only (never the token): persisted, so a new tab knows at once that Todoist is
 * not connected and shows the "Connect Todoist" state instead of a skeleton and a 409.
 */
export function useTodoistToken() {
  return useQuery({
    queryKey: qk.todoist.token(),
    queryFn: ({ signal }) => fetchTodoistToken(signal),
    staleTime: 60_000,
  });
}

/** `PUT /api/todoist/token` — validated by the server against Todoist before it is stored. */
export function useSaveTodoistToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => apiPut<TodoistTokenStatus>('/api/todoist/token', { token }),
    onSuccess: async (status) => {
      client.setQueryData(qk.todoist.token(), status);
      // Everything cached so far belonged to the previous token (or to "not configured").
      await client.invalidateQueries({ queryKey: qk.todoist.all() });
    },
  });
}

export function useRemoveTodoistToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiDelete<TodoistTokenStatus>('/api/todoist/token'),
    onSuccess: async () => {
      client.setQueryData<TodoistTokenStatus>(qk.todoist.token(), { configured: false });
      client.removeQueries({ queryKey: TASKS_ROOT });
      client.removeQueries({ queryKey: qk.todoist.projects() });
      await client.invalidateQueries({ queryKey: qk.todoist.all() });
    },
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function fetchTodoistTasks(filter: string, signal?: AbortSignal): Promise<Task[]> {
  return apiGet<Task[]>(`/api/todoist/tasks?filter=${encodeURIComponent(filter)}`, { signal });
}

/** Tasks for a filter; disabled while `filter` is null (e.g. the default filter is not known yet). */
export function useTodoistTasks(filter: string | null) {
  return useQuery({
    queryKey: qk.todoist.tasks(filter ?? ''),
    queryFn: ({ signal }) => fetchTodoistTasks(filter ?? '', signal),
    enabled: filter !== null,
    staleTime: TODOIST_TASKS_STALE_MS,
    // A dashboard left open keeps up with changes made elsewhere (paused while the tab is hidden).
    refetchInterval: TODOIST_TASKS_REFRESH_MS,
  });
}

export function fetchTodoistProjects(signal?: AbortSignal): Promise<Project[]> {
  return apiGet<Project[]>('/api/todoist/projects', { signal });
}

export function useTodoistProjects(enabled = true) {
  return useQuery({
    queryKey: qk.todoist.projects(),
    queryFn: ({ signal }) => fetchTodoistProjects(signal),
    enabled,
    staleTime: TODOIST_PROJECTS_STALE_MS,
  });
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

export type TaskListSnapshot = [readonly unknown[], Task[] | undefined][];

/** Removes a task from every cached task list; returns the lists as they were. */
export function removeTaskFromCache(client: QueryClient, taskId: string): TaskListSnapshot {
  const snapshot = client.getQueriesData<Task[]>({ queryKey: TASKS_ROOT });
  for (const [key, list] of snapshot) {
    if (list?.some((t) => t.id === taskId)) client.setQueryData<Task[]>(key, list.filter((t) => t.id !== taskId));
  }
  return snapshot;
}

/**
 * Puts a removed task back into every cached list it was taken from, at its former place among
 * the tasks that are still listed. Only this task comes back: restoring the whole snapshot would
 * also resurrect tasks completed (or changed) since it was taken.
 */
export function reinsertTask(client: QueryClient, snapshot: TaskListSnapshot, taskId: string): void {
  for (const [key, before] of snapshot) {
    const index = before?.findIndex((t) => t.id === taskId) ?? -1;
    if (!before || index === -1) continue;
    const current = client.getQueryData<Task[]>(key);
    if (!current || current.some((t) => t.id === taskId)) continue;
    // After the nearest earlier task that is still in the list (else at the top).
    let at = 0;
    for (let i = index - 1; i >= 0; i--) {
      const anchor = current.findIndex((t) => t.id === before[i]!.id);
      if (anchor !== -1) {
        at = anchor + 1;
        break;
      }
    }
    client.setQueryData<Task[]>(key, [...current.slice(0, at), before[index]!, ...current.slice(at)]);
  }
}

export function invalidateTasks(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: TASKS_ROOT });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function quickAddTask(text: string): Promise<Task | null> {
  return apiPost<Task | null>('/api/todoist/tasks', { text });
}

export function closeTask(id: string): Promise<void> {
  return apiPost<void>(apiPath`/api/todoist/tasks/${id}/close`);
}

export function reopenTask(id: string): Promise<void> {
  return apiPost<void>(apiPath`/api/todoist/tasks/${id}/reopen`);
}

export function updateTask(id: string, update: TaskUpdate): Promise<Task> {
  return apiPatch<Task>(apiPath`/api/todoist/tasks/${id}`, update);
}

/** Quick add (natural language). Lists are refetched afterwards so the parsed task shows up. */
export function useQuickAddTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: quickAddTask,
    onSettled: () => invalidateTasks(client),
  });
}

export interface CompletionResult {
  /** Lists as they were before the task was removed (null for recurring tasks, which stay). */
  snapshot: TaskListSnapshot | null;
  /** Settles when the task lists have been refetched after the completion. */
  refreshed: Promise<void>;
}

/**
 * Task completion with Undo. Plain async functions (not per-call `mutate` callbacks) so every
 * completion gets its own result even when several run at once.
 *
 * - `complete(task)`: a normal task vanishes from every cached list at once and comes back if the
 *   server refuses; a recurring task stays until the refetch shows its next date. Resolves when
 *   Todoist confirmed; `refreshed` settles once the lists were refetched.
 * - `undo(task, result)`: the task reappears at once, the server reopens it, the lists refresh.
 */
export function useTaskActions() {
  const client = useQueryClient();
  return useMemo(
    () => ({
      async complete(task: Task): Promise<CompletionResult> {
        let snapshot: TaskListSnapshot | null = null;
        if (!task.due?.isRecurring) {
          await client.cancelQueries({ queryKey: TASKS_ROOT });
          snapshot = removeTaskFromCache(client, task.id);
        }
        try {
          await closeTask(task.id);
        } catch (error) {
          if (snapshot) reinsertTask(client, snapshot, task.id);
          void invalidateTasks(client);
          throw error;
        }
        return { snapshot, refreshed: invalidateTasks(client).catch(() => {}) };
      },
      async undo(task: Task, result: Pick<CompletionResult, 'snapshot'>): Promise<void> {
        if (result.snapshot) {
          await client.cancelQueries({ queryKey: TASKS_ROOT });
          reinsertTask(client, result.snapshot, task.id);
        }
        try {
          await reopenTask(task.id);
        } catch (error) {
          if (result.snapshot) removeTaskFromCache(client, task.id);
          throw error;
        } finally {
          void invalidateTasks(client);
        }
      },
    }),
    [client],
  );
}

export function useUpdateTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: TaskUpdate }) => updateTask(id, update),
    onSettled: () => invalidateTasks(client),
  });
}
