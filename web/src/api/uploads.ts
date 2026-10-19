/**
 * Image uploads (§7 Core `POST /api/uploads`, multipart ≤ 10 MB). The server sniffs the content
 * type from magic bytes; the client pre-checks type and size only to give fast feedback.
 */
import { UploadResponseSchema, uploadUrl, type UploadResponse } from '@portly/shared';
import { apiPost, apiResponse } from './client.ts';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** What the file picker offers (the server accepts the same set, verified by magic bytes). */
export const UPLOAD_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp,image/x-icon,image/svg+xml';

/** Multipart field name for uploaded files (uploads and imports). */
export const UPLOAD_FIELD = 'file';

/**
 * A reason the file cannot be uploaded, or null when it looks acceptable. `maxBytes` is larger
 * for a file the browser shrinks before uploading it (the Appearance background).
 */
export function checkImageFile(file: File, maxBytes = MAX_UPLOAD_BYTES): string | null {
  if (file.size === 0) return 'The file is empty.';
  if (file.size > maxBytes) return `Images must be ${Math.round(maxBytes / (1024 * 1024))} MB or smaller.`;
  if (file.type !== '' && !file.type.startsWith('image/')) return 'Choose an image file (PNG, JPEG, WebP, GIF, AVIF or SVG).';
  return null;
}

/** A failure to prepare an image before its upload, with a message meant for the user. */
export class ImagePrepareError extends Error {
  override name = 'ImagePrepareError';
}

export async function uploadImage(file: File, signal?: AbortSignal): Promise<UploadResponse> {
  const form = new FormData();
  form.append(UPLOAD_FIELD, file, file.name);
  const response = await apiPost<unknown>('/api/uploads', form, { signal });
  const parsed = UploadResponseSchema.safeParse(response);
  if (!parsed.success) throw new Error('Unexpected upload response');
  // The URL is always derived from the id (§4.5), never taken from the response.
  return { id: parsed.data.id, url: uploadUrl(parsed.data.id) };
}

/** The stored bytes of an upload, from this page load's backend (like any API call). */
export async function fetchUpload(uploadId: string, signal?: AbortSignal): Promise<Blob> {
  const res = await apiResponse(uploadUrl(uploadId), { signal, headers: { Accept: 'image/*' } });
  return res.blob();
}
