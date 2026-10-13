/**
 * Reading one file from a `multipart/form-data` request (uploads, imports). The gate (§4.2) has
 * already checked the content type and wraps the body in a streamed byte limit; this helper maps
 * parse failures to 400, an over-limit file to 413 and never trusts the client's file type.
 */
import type { Context } from 'hono';
import { HttpError, isPayloadTooLarge } from './errors.ts';

export interface UploadedFile {
  bytes: Buffer;
  /** Client-supplied file name (display/logging only; never used for paths or types). */
  name: string;
}

export interface ReadFileOptions {
  /** Form field holding the file (default `file`). */
  field?: string;
  /** Maximum file size in bytes. */
  maxBytes: number;
}

export async function readMultipartFile(c: Context, options: ReadFileOptions): Promise<UploadedFile> {
  const field = options.field ?? 'file';
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (err) {
    if (isPayloadTooLarge(err)) throw err;
    throw new HttpError(400, 'bad_request', 'Malformed multipart body');
  }
  const entries = form.getAll(field);
  if (entries.length !== 1) {
    throw new HttpError(400, 'bad_request', entries.length === 0 ? `Missing "${field}" file` : `Send exactly one "${field}" file`);
  }
  const entry = entries[0];
  if (typeof entry === 'string' || entry === undefined) throw new HttpError(400, 'bad_request', `"${field}" must be a file`);
  if (entry.size > options.maxBytes) {
    throw new HttpError(413, 'payload_too_large', `File exceeds ${options.maxBytes} bytes`);
  }
  const bytes = Buffer.from(await entry.arrayBuffer());
  if (bytes.length === 0) throw new HttpError(400, 'bad_request', 'The file is empty');
  return { bytes, name: entry.name.slice(0, 200) };
}
