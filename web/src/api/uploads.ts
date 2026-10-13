/**
 * Image uploads (§7 Core `POST /api/uploads`, multipart ≤ 10 MB). The server sniffs the content
 * type from magic bytes; the client pre-checks type and size only to give fast feedback.
 */
import { UploadResponseSchema, uploadUrl, type UploadResponse } from '@homebase/shared';
import { apiPost } from './client.ts';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** What the file picker offers (the server accepts the same set, verified by magic bytes). */
export const UPLOAD_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp,image/x-icon,image/svg+xml';

/** Multipart field name for uploaded files (uploads and imports). */
export const UPLOAD_FIELD = 'file';

/** A reason the file cannot be uploaded, or null when it looks acceptable. */
export function checkImageFile(file: File): string | null {
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) return 'Images must be 10 MB or smaller.';
  if (file.type !== '' && !file.type.startsWith('image/')) return 'Choose an image file (PNG, JPEG, WebP, GIF, AVIF or SVG).';
  return null;
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
