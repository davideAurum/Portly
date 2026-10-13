/**
 * Static image uploads: sniffing, limits, serving and the orphan collection at startup
 * (uploads.test.ts on the server side, over the blob store and the uploads slice).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadResponse } from '@homebase/shared';
import { IMAGE_SAMPLES } from '../lib/__fixtures__/images.ts';
import { isUuidV4 } from '../lib/ids.ts';
import { getUploads } from '../slices.ts';
import { createTestBackend, fileForm, type TestBackend } from '../test/harness.ts';
import * as profiles from './profiles.ts';
import * as settings from './settings.ts';
import { MAX_UPLOAD_BYTES, ORPHAN_UPLOAD_MIN_AGE_MS, deleteOrphanUploads, referencedUploadIds } from './uploads.ts';
import * as uploads from './uploads.ts';

const MODULES = [settings, profiles, uploads];
const HOUR = 3_600_000;

type UploadResult = UploadResponse & { error?: { code: string; message: string } };

describe('static core: uploads', () => {
  let t: TestBackend;
  beforeEach(async () => {
    t = await createTestBackend(MODULES);
  });
  afterEach(() => t.close());

  const upload = (form: FormData) => t.json<UploadResult>('POST', '/api/uploads', form);

  it.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['avif', 'image/avif'],
    ['ico', 'image/x-icon'],
    ['bmp', 'image/bmp'],
    ['svg', 'image/svg+xml'],
  ] as const)('stores a %s, registers its object URL and serves it with the sniffed type', async (sample, type) => {
    const res = await upload(fileForm(IMAGE_SAMPLES[sample], `pic.${sample}`, 'application/octet-stream'));
    expect(res.status).toBe(201);
    expect(isUuidV4(res.body.id)).toBe(true);
    expect(res.body.url).toBe(`/api/uploads/${res.body.id}`);
    expect(t.ctx.assets.resolve('uploads', res.body.id)).toBe(t.objectUrls.at(-1));
    expect(getUploads(t.ctx)).toEqual([{ id: res.body.id, type, createdAt: t.ctx.now() }]);
    expect(await t.storage.getJson('slice:uploads')).toEqual(getUploads(t.ctx));

    const got = await t.fetch(res.body.url);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe(type);
    expect(got.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(got.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(IMAGE_SAMPLES[sample]);
  });

  it('ignores the declared part type and file name (content type comes from the bytes)', async () => {
    const res = await upload(fileForm(IMAGE_SAMPLES.png, 'evil.html', 'text/html'));
    expect(res.status).toBe(201);
    expect((await t.fetch(res.body.url)).headers.get('content-type')).toBe('image/png');
    expect((await t.ctx.state.getBlob(res.body.id))?.type).toBe('image/png');
  });

  it('refuses non-images, SVGs with a DOCTYPE and HTML disguised as images', async () => {
    for (const [content, type] of [
      ['<html><script>alert(1)</script></html>', 'image/png'],
      ['<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'],
      ['GIF90a not really', 'image/gif'],
      ['%PDF-1.7', 'application/pdf'],
    ] as const) {
      const res = await upload(fileForm(content, 'x', type));
      expect(res.status, content).toBe(422);
      expect(res.body.error).toEqual({ code: 'validation_failed', message: 'Unsupported image type (png, gif, jpeg, webp, avif, ico, bmp or svg)' });
    }
    expect(getUploads(t.ctx)).toEqual([]);
    expect(await t.ctx.state.listBlobs()).toEqual([]);
    expect(t.objectUrls).toEqual([]);
  });

  it('requires exactly one non-empty file part named "file"', async () => {
    const wrongField = await upload(fileForm(IMAGE_SAMPLES.png, 'x.png', 'image/png', 'image'));
    expect(wrongField.status).toBe(400);
    expect(wrongField.body.error?.message).toBe('Missing "file" file');
    const two = fileForm(IMAGE_SAMPLES.png);
    two.append('file', new Blob([new Uint8Array(IMAGE_SAMPLES.gif)]), 'b.gif');
    expect((await upload(two)).body.error?.message).toBe('Send exactly one "file" file');
    const text = new FormData();
    text.append('file', 'just a string');
    expect((await upload(text)).body.error?.message).toBe('"file" must be a file');
    const empty = await upload(fileForm(new Uint8Array(0)));
    expect(empty.status).toBe(400);
    expect(empty.body.error?.message).toBe('The file is empty');
  });

  it('enforces the 10 MB limit (413) and the multipart body (400)', async () => {
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(IMAGE_SAMPLES.png);
    const res = await upload(fileForm(big, 'big.png', 'image/png'));
    expect(res.status).toBe(413);
    expect(res.body.error).toEqual({ code: 'payload_too_large', message: `File exceeds ${MAX_UPLOAD_BYTES} bytes` });
    expect((await t.call('POST', '/api/uploads', { file: 'x' })).status).toBe(400);
    expect(getUploads(t.ctx)).toEqual([]);
  });

  it('GET: unknown or malformed ids 404; ids are matched case-insensitively', async () => {
    const { body } = await upload(fileForm(IMAGE_SAMPLES.png));
    const missing = await t.json<{ error: { code: string; message: string } }>('GET', '/api/uploads/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toEqual({ code: 'not_found', message: 'Upload not found' });
    expect((await t.fetch('/api/uploads/not-a-uuid')).status).toBe(404);
    expect((await t.fetch(`/api/uploads/${body.id.toUpperCase()}`)).status).toBe(200);
  });

  it('never serves stored bytes that do not match the recorded type, nor custom icons', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    await t.ctx.state.putBlob({ id, kind: 'upload', type: 'image/png', bytes: new TextEncoder().encode('<html>'), width: null, createdAt: 1 });
    expect((await t.fetch(`/api/uploads/${id}`)).status).toBe(404);
    const icon = '11111111-2222-4333-8444-555555555556';
    await t.ctx.state.putBlob({ id: icon, kind: 'icon', type: 'image/png', bytes: IMAGE_SAMPLES.png, width: 16, createdAt: 1 });
    expect((await t.fetch(`/api/uploads/${icon}`)).status).toBe(404);
  });
});

describe('static core: orphaned uploads', () => {
  let t: TestBackend;
  beforeEach(async () => {
    t = await createTestBackend(MODULES);
  });
  afterEach(() => t.close());

  const upload = async (bytes: Uint8Array = IMAGE_SAMPLES.png): Promise<string> => (await t.json<UploadResponse>('POST', '/api/uploads', fileForm(bytes))).body.id;
  const widget = (id: string, config: unknown, frame: unknown = { showHeader: true, transparent: false }) => ({ id, type: 'clock', x: 0, y: 0, w: 4, h: 3, config, frame });
  const remaining = async (backend: TestBackend) => (await backend.ctx.state.listBlobs()).map((b) => b.id).sort();

  it('ready() deletes uploads older than 24 h referenced by neither settings nor layouts, registers the referenced ones', async () => {
    const start = t.ctx.now();
    const [background, widgetConfig, frame, otherProfile, orphanOld] = [await upload(), await upload(), await upload(), await upload(), await upload()];
    t.tick(ORPHAN_UPLOAD_MIN_AGE_MS);
    const orphanNew = await upload(); // uploaded but not saved yet: kept until it is a day old

    // Merge patch: `null` removes the default gradient background's keys.
    const patched = await t.json<{ appearance: { background: unknown } }>('PATCH', '/api/settings', {
      appearance: { background: { type: 'image', uploadId: background, blur: 4, dim: 0.2, angle: null, stops: null } },
    });
    expect(patched.body.appearance.background).toMatchObject({ type: 'image', uploadId: background });
    await t.call('POST', '/api/profiles', {
      name: 'Home',
      layout: { version: 1, items: [widget('w1', { image: { uploadId: widgetConfig.toUpperCase() } }), widget('w2', {}, { title: `/api/uploads/${frame}`, showHeader: true, transparent: false })] },
    });
    await t.call('POST', '/api/profiles', { name: 'Work', layout: { version: 1, items: [widget('w3', { photos: [otherProfile] })] } });
    // (Widget and profile ids are UUIDs too and are collected as well — the scan only ever keeps more.)
    const referenced = referencedUploadIds(t.ctx);
    for (const id of [background, widgetConfig, frame, otherProfile]) expect(referenced.has(id)).toBe(true);
    expect(referenced.has(orphanOld)).toBe(false);
    expect(referenced.has(orphanNew)).toBe(false);

    // The next page load (25 h after the first uploads) collects the old orphan only.
    const second = await createTestBackend(MODULES, { storage: t.storage, startAt: start + 25 * HOUR });
    expect(await remaining(second)).toEqual([background, widgetConfig, frame, otherProfile, orphanNew].sort());
    expect(getUploads(second.ctx).map((u) => u.id).sort()).toEqual([background, widgetConfig, frame, otherProfile, orphanNew].sort());
    expect(await second.storage.getJson('slice:uploads')).toEqual(getUploads(second.ctx));
    for (const id of [background, widgetConfig, frame, otherProfile]) expect(second.ctx.assets.resolve('uploads', id)).toBeDefined();
    // Nothing shows an unreferenced upload, so its bytes are not read into an object URL (it is
    // still stored and served until it is a day old).
    expect(second.ctx.assets.resolve('uploads', orphanNew)).toBeUndefined();
    expect((await second.fetch(`/api/uploads/${orphanNew}`)).status).toBe(200);
    expect(second.objectUrls).toHaveLength(4);
    expect(second.ctx.assets.resolve('uploads', orphanOld)).toBeUndefined();
    expect((await second.fetch(`/api/uploads/${orphanOld}`)).status).toBe(404);
    expect((await second.fetch(`/api/uploads/${background}`)).status).toBe(200);

    // A background that is replaced becomes an orphan and goes with the next start a day later.
    await second.call('PATCH', '/api/settings', { appearance: { background: { type: 'color', color: '#112233', uploadId: null, blur: null, dim: null } } });
    second.close();
    const third = await createTestBackend(MODULES, { storage: t.storage, startAt: start + 49 * HOUR });
    expect(await remaining(third)).toEqual([widgetConfig, frame, otherProfile].sort());
    third.close();
  });

  it('deleteOrphanUploads returns the count and honours the minimum age', async () => {
    const [a, b] = [await upload(), await upload(IMAGE_SAMPLES.gif)];
    await t.call('POST', '/api/profiles', { name: 'Home', layout: { version: 1, items: [widget('w1', { uploadId: b })] } });
    t.tick(2 * HOUR);
    expect(await deleteOrphanUploads(t.ctx)).toBe(0);
    expect(await deleteOrphanUploads(t.ctx, HOUR)).toBe(1);
    expect(await remaining(t)).toEqual([b]);
    expect(getUploads(t.ctx).map((u) => u.id)).toEqual([b]);
    expect(t.ctx.assets.resolve('uploads', a)).toBeUndefined();
    expect([...referencedUploadIds(t.ctx)]).toContain(b);
  });

  it('ready() reads only the bytes of the images it registers', async () => {
    const shown = await upload();
    await upload(IMAGE_SAMPLES.gif);
    await t.call('PATCH', '/api/settings', { appearance: { background: { type: 'image', uploadId: shown, blur: 0, dim: 0, angle: null, stops: null } } });
    const listBlobs = vi.spyOn(t.storage, 'listBlobs');
    const getBlob = vi.spyOn(t.storage, 'getBlob');
    const second = await createTestBackend(MODULES, { storage: t.storage, startAt: t.ctx.now() + 1000 });
    expect(listBlobs).not.toHaveBeenCalled();
    expect(getBlob.mock.calls.map(([id]) => id)).toEqual([shown]);
    expect(second.ctx.assets.blobIds('uploads')).toEqual([shown]);
    second.close();
  });

  it('ready() heals the metadata slice against the blob store', async () => {
    const stray = '22222222-3333-4444-8555-666666666666';
    await t.ctx.state.putBlob({ id: stray, kind: 'upload', type: 'image/gif', bytes: IMAGE_SAMPLES.gif, width: null, createdAt: t.ctx.now() });
    const gone = await upload();
    await t.ctx.state.deleteBlob(gone);
    const second = await createTestBackend(MODULES, { storage: t.storage, startAt: t.ctx.now() + 1000 });
    expect(getUploads(second.ctx).map((u) => u.id)).toEqual([stray]);
    expect((await second.fetch(`/api/uploads/${stray}`)).headers.get('content-type')).toBe('image/gif');
    expect((await second.fetch(`/api/uploads/${gone}`)).status).toBe(404);
    second.close();
  });
});
