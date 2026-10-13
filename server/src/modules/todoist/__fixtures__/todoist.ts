/**
 * Todoist test fixtures: upstream objects in the unified API v1 shape (as documented at
 * developer.todoist.com/api/v1: Sync-style task items with a `due` object whose `date` is a date,
 * a floating date-time or a UTC date-time), cursor pages, and a testbed that mounts only the
 * todoist module.
 */
import fs from 'node:fs';
import { createApp } from '../../../app.ts';
import { createTestContext, type TestContext, type TestContextOverrides } from '../../../testing/test-context.ts';
import { testRequest, type TestRequestOptions } from '../../../testing/test-request.ts';
import * as todoist from '../index.ts';

/** A plausible personal API token (40 hex chars). */
export const TOKEN = '0123456789abcdef0123456789abcdef01234567';
export const OTHER_TOKEN = 'fedcba9876543210fedcba9876543210fedcba98';

export const API = 'https://api.todoist.com/api/v1';

let seq = 0;

export function upstreamTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    user_id: '2671355',
    id: `6X7rM8997g3RQm${String(seq).padStart(2, '0')}`,
    project_id: '6Jf8VQXxpwv56VQ7',
    section_id: null,
    parent_id: null,
    added_by_uid: '2671355',
    assigned_by_uid: null,
    responsible_uid: null,
    labels: [],
    deadline: null,
    duration: null,
    checked: false,
    is_deleted: false,
    added_at: '2026-09-20T08:00:00.000000Z',
    completed_at: null,
    updated_at: '2026-09-20T08:00:00.000000Z',
    due: null,
    priority: 1,
    child_order: seq,
    content: `Task ${seq}`,
    description: '',
    note_count: 0,
    day_order: -1,
    is_collapsed: false,
    ...overrides,
  };
}

export function upstreamDue(date: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { date, timezone: null, string: date, lang: 'en', is_recurring: false, ...overrides };
}

export function upstreamProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    id: `6Jf8VQXxpwv5${String(seq).padStart(4, '0')}`,
    name: `Project ${seq}`,
    color: 'charcoal',
    parent_id: null,
    child_order: seq,
    is_collapsed: false,
    is_shared: false,
    is_favorite: false,
    is_archived: false,
    is_deleted: false,
    inbox_project: false,
    view_style: 'list',
    description: '',
    ...overrides,
  };
}

export function page(results: unknown[], nextCursor: string | null = null): { results: unknown[]; next_cursor: string | null } {
  return { results, next_cursor: nextCursor };
}

export interface TodoistTestbed {
  ctx: TestContext;
  req(method: string, path: string, options?: TestRequestOptions): Promise<Response>;
  json<T = unknown>(method: string, path: string, options?: TestRequestOptions): Promise<{ status: number; body: T; res: Response; text: string }>;
  close(): void;
}

export function todoistTestbed(overrides: TestContextOverrides = {}): TodoistTestbed {
  const ctx = createTestContext(overrides);
  const { app } = createApp(ctx, { modules: [{ name: 'todoist', prefixes: todoist.prefixes, register: todoist.register }], webDist: null });
  const req = (method: string, path: string, options?: TestRequestOptions): Promise<Response> => testRequest(app, method, path, options);
  return {
    ctx,
    req,
    async json<T>(method: string, path: string, options?: TestRequestOptions) {
      const res = await req(method, path, options);
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, res, text };
    },
    close() {
      ctx.close();
      fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
    },
  };
}
