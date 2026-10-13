/**
 * Image uploads of the static backend (§7 Core `POST /api/uploads`, `GET /api/uploads/:id`; §4.3),
 * a port of server/src/modules/core/uploads.ts over the blob store (kind `upload`) plus the
 * `uploads` metadata slice.
 *
 * - `POST`: exactly one multipart `file` part, non-empty, ≤ 10 MB (413). The content type comes
 *   from magic-byte sniffing only (png, gif, jpeg, webp, avif, ico, bmp, svg without DOCTYPE),
 *   never from the part's type or file name (422 otherwise). Answers 201 `{id, url}` and registers
 *   the blob with the asset registry so `<img src>` / CSS `url()` can resolve `/api/uploads/<id>`.
 * - `GET`: the bytes with the re-sniffed type; non-v4 ids, unknown ids and bytes that no longer
 *   sniff to the stored type are 404 (`Upload not found`).
 * - `ready`: heals the metadata slice against the blob store (by id, without reading every
 *   image), deletes orphans (older than 24 h and referenced by neither the settings JSON nor any
 *   profile layout — the server's daily job) and registers the referenced uploads as object URLs
 *   (see {@link syncUploadAssets}); uploads created in this tab are registered when stored.
 */
import { uploadUrl, type UploadResponse } from '@portly/shared';
import type { StaticContext } from '../context.ts';
import { isUuidV4 } from '../lib/ids.ts';
import { sniffImageType } from '../lib/imageSniff.ts';
import { readMultipartFile } from '../lib/validate.ts';
import { json, readFormData, StaticApiError } from '../respond.ts';
import type { StaticRouter } from '../router.ts';
import { SLICE, getIcons, getProfiles, getSettings, getUploads, type StoredUploadMeta } from '../slices.ts';
import { blobOf, type StoredBlob } from '../storage/types.ts';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Uploads younger than this are never collected (an upload is stored before it is referenced). */
export const ORPHAN_UPLOAD_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export const UNSUPPORTED_IMAGE_MESSAGE = 'Unsupported image type (png, gif, jpeg, webp, avif, ico, bmp or svg)';

const UUID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The server's image-route headers (sandboxed, privately cacheable, no type sniffing). */
const IMAGE_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'cache-control': 'private, max-age=86400',
  'x-content-type-options': 'nosniff',
});

/** Validates and stores an uploaded image; returns its id and URL. */
export async function storeUpload(ctx: StaticContext, bytes: Uint8Array): Promise<UploadResponse> {
  if (bytes.length > MAX_UPLOAD_BYTES) throw new StaticApiError('payload_too_large', `Images are limited to ${MAX_UPLOAD_BYTES} bytes`);
  const type = sniffImageType(bytes);
  if (!type) throw new StaticApiError('validation_failed', UNSUPPORTED_IMAGE_MESSAGE);
  const id = ctx.newId();
  const entry: StoredBlob = { id, kind: 'upload', type, bytes, width: null, createdAt: ctx.now() };
  // Bytes and metadata in one transaction: a failed write leaves neither behind.
  getUploads(ctx).push({ id, type, createdAt: entry.createdAt });
  await ctx.state.commitWith([SLICE.uploads], { putBlobs: [entry] });
  ctx.assets.registerBlob('uploads', id, blobOf(entry));
  return { id, url: uploadUrl(id) };
}

/** Reads an upload; unknown or malformed ids, and bytes that do not match the stored type → null. */
export async function readUpload(ctx: StaticContext, id: string): Promise<StoredBlob | null> {
  if (!isUuidV4(id)) return null;
  const blob = await ctx.state.getBlob(id.toLowerCase());
  if (!blob || blob.kind !== 'upload') return null;
  // Re-sniff on the way out too: bytes written by older code or by hand never change the served type.
  const type = sniffImageType(blob.bytes);
  if (!type || type !== blob.type) return null;
  return blob;
}

// ---------------------------------------------------------------------------
// Orphaned uploads
// ---------------------------------------------------------------------------

/**
 * Upload ids referenced anywhere they can be: the settings JSON (the appearance background's
 * `uploadId`; every namespace is scanned, which only ever keeps more) and every profile's layout
 * (widget configs and frames). Lower-cased.
 */
export function referencedUploadIds(ctx: StaticContext): Set<string> {
  const ids = new Set<string>();
  const collect = (value: unknown): void => {
    const text = JSON.stringify(value);
    if (text === undefined) return;
    for (const match of text.toLowerCase().matchAll(UUID_TOKEN)) ids.add(match[0]);
  };
  collect(getSettings(ctx));
  for (const profile of getProfiles(ctx)) collect(profile.layout);
  return ids;
}

/**
 * Deletes uploads older than `minAgeMs` that nothing references (see {@link referencedUploadIds})
 * and revokes their object URLs; returns how many were deleted.
 */
export async function deleteOrphanUploads(ctx: StaticContext, minAgeMs = ORPHAN_UPLOAD_MIN_AGE_MS): Promise<number> {
  const referenced = referencedUploadIds(ctx);
  const cutoff = ctx.now() - minAgeMs;
  const uploads = getUploads(ctx);
  const orphans = uploads.filter((meta) => meta.createdAt < cutoff && !referenced.has(meta.id.toLowerCase())).map((meta) => meta.id);
  if (orphans.length === 0) return 0;
  // Metadata and bytes go in one transaction, with no await between reading the slice and
  // committing it (a reload from another tab cannot slip in between).
  const gone = new Set(orphans);
  ctx.state.set(SLICE.uploads, uploads.filter((meta) => !gone.has(meta.id)));
  await ctx.state.commitWith([SLICE.uploads], { deleteBlobs: orphans });
  for (const id of orphans) ctx.assets.revoke('uploads', id);
  return orphans.length;
}

/**
 * Brings the asset registry in line with the uploads slice: registers an object URL for every
 * upload the settings or a layout references that has none yet (reading only those blobs), and
 * revokes the URLs of uploads that no longer exist. Commit-free, so it is safe to run whenever
 * another tab changed uploads, settings or profiles.
 */
export async function syncUploadAssets(ctx: StaticContext): Promise<void> {
  const existing = new Set(getUploads(ctx).map((meta) => meta.id));
  for (const id of ctx.assets.blobIds('uploads')) if (!existing.has(id)) ctx.assets.revoke('uploads', id);
  const referenced = referencedUploadIds(ctx);
  for (const id of existing) {
    if (ctx.assets.has('uploads', id) || !referenced.has(id.toLowerCase())) continue;
    const blob = await ctx.state.getBlob(id);
    // Re-checked after the await: the upload may have been deleted meanwhile.
    if (blob?.kind === 'upload' && !ctx.assets.has('uploads', id) && getUploads(ctx).some((meta) => meta.id === id)) {
      ctx.assets.registerBlob('uploads', id, blobOf(blob));
    }
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export function register(router: StaticRouter): void {
  router.post('/api/uploads', async (ctx, { req }) => {
    const { bytes } = await readMultipartFile(await readFormData(req), undefined, MAX_UPLOAD_BYTES);
    return json(await storeUpload(ctx, bytes), 201);
  });

  router.get('/api/uploads/:id', async (ctx, { params }) => {
    const upload = await readUpload(ctx, params.id ?? '');
    if (!upload) throw new StaticApiError('not_found', 'Upload not found');
    return new Response(blobOf(upload), { status: 200, headers: { 'content-type': upload.type, ...IMAGE_HEADERS } });
  });
}

export async function ready(ctx: StaticContext): Promise<void> {
  // Heal the metadata: entries without bytes are dropped, bytes without an entry are adopted.
  // Only ids are listed; a blob's bytes are read only when no metadata names it (rare).
  const blobIds = new Set(await ctx.state.listBlobIds());
  const knownIds = new Set([...getUploads(ctx), ...getIcons(ctx)].map((meta) => meta.id));
  const adopted: StoredUploadMeta[] = [];
  for (const id of blobIds) {
    if (knownIds.has(id)) continue;
    const blob = await ctx.state.getBlob(id);
    if (blob?.kind === 'upload') adopted.push({ id, type: blob.type, createdAt: blob.createdAt });
  }
  // No await from here to the commit (see deleteOrphanUploads).
  const uploads = getUploads(ctx);
  const kept = uploads.filter((meta) => blobIds.has(meta.id));
  const keptIds = new Set(kept.map((meta) => meta.id));
  const healed = [...kept, ...adopted.filter((meta) => !keptIds.has(meta.id))];
  if (kept.length !== uploads.length || healed.length !== kept.length) {
    ctx.state.set(SLICE.uploads, healed);
    await ctx.state.commit(SLICE.uploads);
  }

  await deleteOrphanUploads(ctx);
  await syncUploadAssets(ctx);
}
