import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UploadResponse } from '@homebase/shared';
import { IMAGE_SAMPLES } from '../../lib/__fixtures__/images.ts';
import { isUuidV4, newId } from '../../lib/ids.ts';
import { IMAGE_CACHE_CONTROL, IMAGE_CSP } from '../../security/headers.ts';
import { coreTestbed, fileForm, type CoreTestbed } from './__fixtures__/setup.ts';
import { UPLOAD_GC_INITIAL_DELAY_MS, UPLOAD_GC_INTERVAL_MS } from './index.ts';
import { MAX_UPLOAD_BYTES, deleteOrphanUploads, referencedUploadIds } from './uploads.ts';

describe('core: uploads', () => {
  let t: CoreTestbed;
  beforeEach(() => {
    t = coreTestbed();
  });
  afterEach(() => t.close());

  const upload = (form: FormData) => t.json<UploadResponse & { error?: { code: string } }>('POST', '/api/uploads', { body: form });

  it.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['avif', 'image/avif'],
    ['ico', 'image/x-icon'],
    ['bmp', 'image/bmp'],
    ['svg', 'image/svg+xml'],
  ] as const)('stores a %s and serves it with the sniffed type and sandbox headers', async (sample, type) => {
    const res = await upload(fileForm(IMAGE_SAMPLES[sample], `pic.${sample}`, 'application/octet-stream'));
    expect(res.status).toBe(201);
    expect(isUuidV4(res.body.id)).toBe(true);
    expect(res.body.url).toBe(`/api/uploads/${res.body.id}`);

    // Loaded by <img> / CSS: no X-Homebase header, Sec-Fetch-Site same-origin.
    const got = await t.req('GET', res.body.url, { headers: { 'X-Homebase': null } });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe(type);
    expect(got.headers.get('content-security-policy')).toBe(IMAGE_CSP);
    expect(got.headers.get('cache-control')).toBe(IMAGE_CACHE_CONTROL);
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await got.arrayBuffer())).toEqual(IMAGE_SAMPLES[sample]);
  });

  it('ignores the declared part type and file name (content type comes from the bytes)', async () => {
    const res = await upload(fileForm(IMAGE_SAMPLES.png, 'evil.html', 'text/html'));
    expect(res.status).toBe(201);
    expect((await t.req('GET', res.body.url)).headers.get('content-type')).toBe('image/png');
    expect(t.ctx.db.get<{ content_type: string }>('SELECT content_type FROM uploads')?.content_type).toBe('image/png');
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
      expect(res.body.error?.code).toBe('validation_failed');
    }
    expect(t.ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM uploads')?.n).toBe(0);
  });

  it('requires exactly one file part named "file"', async () => {
    expect((await upload(fileForm(IMAGE_SAMPLES.png, 'x.png', 'image/png', 'image'))).status).toBe(400);
    const two = fileForm(IMAGE_SAMPLES.png);
    two.append('file', new Blob([IMAGE_SAMPLES.gif]), 'b.gif');
    expect((await upload(two)).status).toBe(400);
    const text = new FormData();
    text.append('file', 'just a string');
    expect((await upload(text)).status).toBe(400);
    expect((await upload(fileForm(new Uint8Array(0)))).status).toBe(400);
  });

  it('enforces the 10 MB limit (413) and the multipart content type (400)', async () => {
    // Raw multipart bytes (a FormData body stream cancelled mid-way trips an internal Node quirk).
    const boundary = 'homebase-test-boundary';
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const file = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    IMAGE_SAMPLES.png.copy(file);
    const res = await t.req('POST', '/api/uploads', {
      body: new Uint8Array(Buffer.concat([head, file, tail])),
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.status).toBe(413);
    expect((await t.req('POST', '/api/uploads', { body: { file: 'x' } })).status).toBe(400);
  });

  it('GET: unknown or malformed ids 404; cross-site loads are refused', async () => {
    const { body } = await upload(fileForm(IMAGE_SAMPLES.png));
    expect((await t.req('GET', '/api/uploads/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await t.req('GET', '/api/uploads/not-a-uuid')).status).toBe(404);
    expect((await t.req('GET', body.url, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect((await t.req('GET', body.url, { headers: { 'Sec-Fetch-Site': 'none', 'X-Homebase': null } })).status).toBe(200);
  });

  it('never serves a stored row whose bytes do not match its recorded type', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    t.ctx.db.run('INSERT INTO uploads (id, content_type, bytes, created_at) VALUES (?, ?, ?, 1)', [id, 'image/png', Buffer.from('<html>')]);
    expect((await t.req('GET', `/api/uploads/${id}`)).status).toBe(404);
  });
});

describe('core: orphaned uploads job', () => {
  let t: CoreTestbed;
  beforeEach(() => {
    t = coreTestbed();
  });
  afterEach(() => t.close());

  const HOUR = 3_600_000;
  const insert = (id: string, ageMs: number) =>
    t.ctx.db.run('INSERT INTO uploads (id, content_type, bytes, created_at) VALUES (?, ?, ?, ?)', [id, 'image/png', IMAGE_SAMPLES.png, Date.now() - ageMs]);
  const remaining = () => t.ctx.db.all<{ id: string }>('SELECT id FROM uploads ORDER BY id').map((r) => r.id);
  const layout = (items: unknown[]) => JSON.stringify({ version: 1, items });

  it('registers a daily job that deletes uploads older than 24 h referenced by neither settings nor layouts', async () => {
    const job = t.ctx.scheduler.jobs().find((j) => j.name === 'core:uploads-gc');
    expect(job).toMatchObject({ intervalMs: UPLOAD_GC_INTERVAL_MS, dueAt: UPLOAD_GC_INITIAL_DELAY_MS });
    expect(UPLOAD_GC_INTERVAL_MS).toBe(24 * HOUR);

    const [background, widgetConfig, frame, otherProfile, orphanOld, orphanNew] = Array.from({ length: 6 }, () => newId()).sort();
    for (const id of [background, widgetConfig, frame, otherProfile, orphanOld]) insert(id!, 25 * HOUR);
    insert(orphanNew!, HOUR); // uploaded but not saved yet: kept until it is a day old

    // Merge patch: `null` removes the default gradient background's keys.
    t.ctx.settings.patch({ appearance: { background: { type: 'image', uploadId: background, blur: 4, dim: 0.2, angle: null, stops: null } } });
    expect(t.ctx.settings.get('appearance').background).toMatchObject({ type: 'image', uploadId: background });
    const widget = (id: string, config: unknown, frameValue: unknown = { showHeader: true, transparent: false }) => ({ id, type: 'clock', x: 0, y: 0, w: 4, h: 3, config, frame: frameValue });
    t.ctx.db.run('INSERT INTO profiles (id, name, sort, layout, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)', [
      'p1',
      'Home',
      0,
      layout([widget('w1', { image: { uploadId: widgetConfig!.toUpperCase() } }), widget('w2', {}, { title: `/api/uploads/${frame}`, showHeader: true, transparent: false })]),
    ]);
    t.ctx.db.run('INSERT INTO profiles (id, name, sort, layout, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)', ['p2', 'Work', 1, layout([widget('w3', { photos: [otherProfile] })])]);

    await t.ctx.scheduler.advance(UPLOAD_GC_INITIAL_DELAY_MS);
    expect(remaining()).toEqual([background, widgetConfig, frame, otherProfile, orphanNew].sort());

    // A background that is replaced becomes an orphan and goes with the next daily run.
    t.ctx.settings.patch({ appearance: { background: { type: 'color', color: '#112233', uploadId: null, blur: null, dim: null } } });
    await t.ctx.scheduler.advance(UPLOAD_GC_INTERVAL_MS);
    expect(remaining()).toEqual([widgetConfig, frame, otherProfile, orphanNew].sort());
  });

  it('deleteOrphanUploads returns the count and honours the minimum age', () => {
    const [a, b] = [newId(), newId()];
    insert(a, 2 * HOUR);
    insert(b, 2 * HOUR);
    t.ctx.db.run('INSERT INTO profiles (id, name, sort, layout, theme, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)', ['p1', 'Home', 0, layout([]), JSON.stringify({ uploadId: b })]);
    expect(deleteOrphanUploads(t.ctx.db, Date.now())).toBe(0);
    expect(deleteOrphanUploads(t.ctx.db, Date.now(), HOUR)).toBe(1);
    expect(remaining()).toEqual([b]);
    expect([...referencedUploadIds(t.ctx.db)]).toContain(b);
  });
});
