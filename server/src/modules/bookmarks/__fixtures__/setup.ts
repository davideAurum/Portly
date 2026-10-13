/**
 * Test setup for the bookmarks module: a test context plus an app mounting only this module (with
 * an injectable `%LOCALAPPDATA%` root), request helpers, and small image/page fixtures.
 */
import fs from 'node:fs';
import { createApp } from '../../../app.ts';
import { createTestContext, type TestContext, type TestContextOverrides } from '../../../testing/test-context.ts';
import { testRequest, type TestRequestOptions } from '../../../testing/test-request.ts';
import type { FaviconService } from '../favicons.ts';
import { createBookmarksModule, prefixes } from '../index.ts';

export interface BookmarksTestbed {
  ctx: TestContext;
  favicons: FaviconService;
  req(method: string, path: string, options?: TestRequestOptions): Promise<Response>;
  json<T = unknown>(method: string, path: string, options?: TestRequestOptions): Promise<{ status: number; body: T; res: Response }>;
  close(): void;
}

export interface BookmarksTestbedOptions extends TestContextOverrides {
  localAppData?: string | null;
  siteMetaIconBudgetMs?: number;
  refreshIconBudgetMs?: number;
}

export function bookmarksTestbed(options: BookmarksTestbedOptions = {}): BookmarksTestbed {
  const { localAppData = null, siteMetaIconBudgetMs, refreshIconBudgetMs, ...overrides } = options;
  const ctx = createTestContext(overrides);
  let favicons: FaviconService | null = null;
  const register = createBookmarksModule({
    localAppData,
    siteMetaIconBudgetMs,
    refreshIconBudgetMs,
    onFavicons: (s) => (favicons = s),
  });
  const { app } = createApp(ctx, { modules: [{ name: 'bookmarks', prefixes, register }], webDist: null });
  const req = (method: string, path: string, opts?: TestRequestOptions): Promise<Response> => testRequest(app, method, path, opts);
  return {
    ctx,
    get favicons() {
      if (!favicons) throw new Error('favicon service not registered');
      return favicons;
    },
    req,
    async json<T>(method: string, path: string, opts?: TestRequestOptions) {
      const res = await req(method, path, opts);
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, res };
    },
    close() {
      ctx.close();
      fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
    },
  };
}

/** Multipart body with one file part (plus optional text fields). */
export function fileForm(content: Uint8Array | string, name = 'file.bin', fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'application/octet-stream' }), name);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

/** PNG header bytes (signature + IHDR) declaring `w`×`h`. */
export function png(w: number, h = w): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/** ICO with one directory entry per size. */
export function ico(...sizes: number[]): Buffer {
  const b = Buffer.alloc(6 + sizes.length * 16 + 8);
  b.writeUInt16LE(0, 0);
  b.writeUInt16LE(1, 2);
  b.writeUInt16LE(sizes.length, 4);
  sizes.forEach((s, i) => {
    b[6 + i * 16] = s >= 256 ? 0 : s;
    b[6 + i * 16 + 1] = s >= 256 ? 0 : s;
  });
  return b;
}

export const SVG_ICON = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>');

export function html(head: string, body = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

export const IMAGE_HEADERS = { 'content-type': 'image/png' } as const;
export const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' } as const;
