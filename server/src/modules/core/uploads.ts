/**
 * Image uploads (§7 Core `POST /api/uploads`, `GET /api/uploads/:id`; §4.3).
 *
 * Uploads are stored in the `uploads` table under random UUIDv4 ids. The stored content type
 * comes from magic-byte sniffing (png, gif, jpeg, webp, avif, ico, bmp; svg only with an `<svg`
 * root element) — never from the multipart part's type or the file name. `GET` is an `image`
 * route: the security-headers middleware adds the sandbox CSP and `Cache-Control: private,
 * max-age=86400`.
 */
import { uploadUrl, type ImageContentType, type UploadResponse } from '@homebase/shared';
import type { Db } from '../../db/open.ts';
import { HttpError } from '../../lib/errors.ts';
import { isUuidV4, newId } from '../../lib/ids.ts';
import { sniffImageType } from '../../lib/image-sniff.ts';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface StoredUpload {
  contentType: ImageContentType;
  bytes: Buffer;
}

/** Validates and stores an uploaded image; returns its id and URL. */
export function storeUpload(db: Db, bytes: Buffer, now: number): UploadResponse {
  if (bytes.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'payload_too_large', `Images are limited to ${MAX_UPLOAD_BYTES} bytes`);
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw new HttpError(422, 'validation_failed', 'Unsupported image type (png, gif, jpeg, webp, avif, ico, bmp or svg)');
  }
  const id = newId();
  db.run('INSERT INTO uploads (id, content_type, bytes, created_at) VALUES (?, ?, ?, ?)', [id, contentType, bytes, now]);
  return { id, url: uploadUrl(id) };
}

/** Reads an upload; unknown or malformed ids → null. */
export function readUpload(db: Db, id: string): StoredUpload | null {
  if (!isUuidV4(id)) return null;
  const row = db.get<{ content_type: string; bytes: Buffer }>('SELECT content_type, bytes FROM uploads WHERE id = ?', [id.toLowerCase()]);
  if (!row) return null;
  // Re-sniff on the way out too: rows written by older code or by hand never change the served type.
  const contentType = sniffImageType(row.bytes);
  if (!contentType || contentType !== row.content_type) return null;
  return { contentType, bytes: row.bytes };
}

// ---------------------------------------------------------------------------
// Orphaned uploads
// ---------------------------------------------------------------------------

/** Uploads younger than this are never collected (an upload is stored before it is referenced). */
export const ORPHAN_UPLOAD_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const UUID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * Upload ids referenced anywhere they can be: the stored settings JSON (the appearance
 * background's `uploadId`; every namespace is scanned, which only ever keeps more) and every
 * profile's layout (widget configs and frames) and reserved theme JSON. Lower-cased.
 */
export function referencedUploadIds(db: Db): Set<string> {
  const ids = new Set<string>();
  const collect = (text: string | null | undefined): void => {
    if (!text) return;
    for (const match of text.toLowerCase().matchAll(UUID_TOKEN)) ids.add(match[0]);
  };
  for (const row of db.all<{ value: string }>('SELECT value FROM settings')) collect(row.value);
  for (const row of db.all<{ layout: string; theme: string | null }>('SELECT layout, theme FROM profiles')) {
    collect(row.layout);
    collect(row.theme);
  }
  return ids;
}

/**
 * Deletes uploads older than `minAgeMs` that nothing references (see {@link referencedUploadIds});
 * returns how many were deleted. One transaction, so a reference cannot appear in between.
 */
export function deleteOrphanUploads(db: Db, now: number, minAgeMs = ORPHAN_UPLOAD_MIN_AGE_MS): number {
  return db.tx(() => {
    const referenced = referencedUploadIds(db);
    let deleted = 0;
    for (const { id } of db.all<{ id: string }>('SELECT id FROM uploads WHERE created_at < ?', [now - minAgeMs])) {
      if (referenced.has(id.toLowerCase())) continue;
      deleted += db.run('DELETE FROM uploads WHERE id = ?', [id]).changes;
    }
    return deleted;
  });
}
