/**
 * Test bed for the calendar module: a test context (fake accounts, fake transport, manual
 * scheduler) with only the calendar module mounted, an in-process expand runner, a controllable
 * clock and the server zone fixed to UTC.
 */
import fs from 'node:fs';
import { createApp } from '../../../app.ts';
import type { Logger } from '../../../lib/logger.ts';
import type { FakeAccountSeed, FakeAccountService } from '../../../testing/fake-accounts.ts';
import type { FakeFetchRoute } from '../../../testing/fake-fetch.ts';
import { createTestContext, type TestContext } from '../../../testing/test-context.ts';
import { testRequest, type TestRequestOptions } from '../../../testing/test-request.ts';
import { expandCalendar } from '../ical/expand.ts';
import type { ExpandRunner } from '../ical/run.ts';
import { prefixes, setupCalendar, type CalendarModule, type CalendarModuleOptions } from '../index.ts';

/** 2026-09-25 12:00 UTC: synced window 2026-08-26 … 2027-09-25 (server zone UTC). */
export const T0 = Date.parse('2026-09-25T12:00:00.000Z');

export const inProcessExpand: ExpandRunner = async (job) => expandCalendar(job);

export interface CalendarTestbed {
  ctx: TestContext;
  accounts: FakeAccountService;
  module: CalendarModule;
  clock: { now: number };
  /** Adds (or replaces) a fake account and its `accounts` row (calendars reference it). */
  addAccount(seed: FakeAccountSeed): void;
  req(method: string, path: string, options?: TestRequestOptions): Promise<Response>;
  json<T = unknown>(method: string, path: string, options?: TestRequestOptions): Promise<{ status: number; body: T }>;
  close(): void;
}

export function calendarTestbed(
  options: { accounts?: FakeAccountSeed[]; fetchRoutes?: FakeFetchRoute[]; secrets?: Record<string, string>; module?: CalendarModuleOptions; log?: Logger } = {},
): CalendarTestbed {
  const ctx = createTestContext({ accounts: options.accounts ?? [], fetchRoutes: options.fetchRoutes ?? [], secrets: options.secrets, log: options.log });
  const clock = { now: T0 };
  let module: CalendarModule | null = null;
  const { app } = createApp(ctx, {
    webDist: null,
    modules: [
      {
        name: 'calendar',
        prefixes,
        register: (a, c) => {
          module = setupCalendar(a, c, { runExpand: inProcessExpand, now: () => clock.now, timeZone: () => 'UTC', ...options.module });
        },
      },
    ],
  });
  const req = (method: string, path: string, opts?: TestRequestOptions) => testRequest(app, method, path, opts);
  const insertRow = (seed: FakeAccountSeed) =>
    ctx.db.run(
      `INSERT INTO accounts (id, kind, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      [seed.id, seed.kind, seed.label ?? seed.kind, T0, T0],
    );
  for (const seed of options.accounts ?? []) insertRow(seed);
  return {
    ctx,
    accounts: ctx.accounts as FakeAccountService,
    module: module!,
    clock,
    addAccount(seed) {
      insertRow(seed);
      (ctx.accounts as FakeAccountService).add(seed);
    },
    req,
    async json<T>(method: string, path: string, opts?: TestRequestOptions) {
      const res = await req(method, path, opts);
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
    },
    close() {
      ctx.close();
      fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
    },
  };
}
