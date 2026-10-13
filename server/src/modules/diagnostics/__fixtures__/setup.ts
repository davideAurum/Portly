/**
 * Test setup for the diagnostics module: a test context (optionally with the Pages site
 * configured) plus an app that mounts only this module, request helpers and a paired Pages token.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../../app.ts';
import { createTestContext, type TestContext, type TestContextOverrides } from '../../../testing/test-context.ts';
import { TEST_PAGES_ENV, TEST_PAGES_ORIGIN, pagesHeaders, testRequest, type TestRequestOptions } from '../../../testing/test-request.ts';
import { prefixes, register, type DiagnosticsOptions } from '../index.ts';

export interface DiagnosticsTestbed {
  ctx: TestContext;
  req(method: string, path: string, options?: TestRequestOptions): Promise<Response>;
  json<T = unknown>(method: string, path: string, options?: TestRequestOptions): Promise<{ status: number; body: T; res: Response }>;
  /** Pairs a browser on the test Pages site; its request headers. */
  pair(): Record<string, string | null>;
  close(): void;
}

export interface DiagnosticsTestbedOptions extends TestContextOverrides {
  /** Configure the Pages site (`TEST_PAGES_ENV`); default true. */
  pages?: boolean;
  module?: DiagnosticsOptions;
}

export function diagnosticsTestbed(options: DiagnosticsTestbedOptions = {}): DiagnosticsTestbed {
  const { pages = true, module = { launcherLogPath: null }, ...overrides } = options;
  const ctx = createTestContext({ ...overrides, env: { ...(pages ? TEST_PAGES_ENV : {}), ...overrides.env } });
  const { app } = createApp(ctx, {
    modules: [{ name: 'diagnostics', prefixes, register: (a, c) => register(a, c, module) }],
    webDist: null,
  });
  const req = (method: string, path: string, opts?: TestRequestOptions): Promise<Response> => testRequest(app, method, path, opts);
  return {
    ctx,
    req,
    async json<T>(method: string, path: string, opts?: TestRequestOptions) {
      const res = await req(method, path, opts);
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, res };
    },
    pair() {
      const { token } = ctx.pairing.create({ label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN });
      return pagesHeaders(token);
    },
    close() {
      ctx.close();
      fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
    },
  };
}

/** Writes `lines` (newline-terminated) to `file`, creating its directory. */
export function writeLines(file: string, lines: readonly string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''), 'utf8');
}
