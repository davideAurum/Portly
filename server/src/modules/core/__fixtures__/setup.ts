/**
 * Test setup for the core module: a test context plus an app that mounts only the core module
 * (isolated from the other modules' state), and small request helpers.
 */
import fs from 'node:fs';
import { createApp } from '../../../app.ts';
import { createTestContext, type TestContext, type TestContextOverrides } from '../../../testing/test-context.ts';
import { testRequest, type TestRequestOptions } from '../../../testing/test-request.ts';
import * as core from '../index.ts';

export interface CoreTestbed {
  ctx: TestContext;
  req(method: string, path: string, options?: TestRequestOptions): Promise<Response>;
  json<T = unknown>(method: string, path: string, options?: TestRequestOptions): Promise<{ status: number; body: T; res: Response }>;
  close(): void;
}

export function coreTestbed(overrides: TestContextOverrides = {}): CoreTestbed {
  const ctx = createTestContext(overrides);
  const { app } = createApp(ctx, { modules: [{ name: 'core', prefixes: core.prefixes, register: core.register }], webDist: null });
  const req = (method: string, path: string, options?: TestRequestOptions): Promise<Response> => testRequest(app, method, path, options);
  return {
    ctx,
    req,
    async json<T>(method: string, path: string, options?: TestRequestOptions) {
      const res = await req(method, path, options);
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, res };
    },
    close() {
      ctx.close();
      fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
    },
  };
}

/** Multipart body with one file part. */
export function fileForm(content: Uint8Array | string, name = 'file.bin', type = 'application/octet-stream', field = 'file'): FormData {
  const form = new FormData();
  form.append(field, new Blob([content], { type }), name);
  return form;
}
