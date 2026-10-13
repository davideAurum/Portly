/**
 * Config export / import (§7 Core). Export downloads the server's allowlisted export file;
 * import is two-step — `POST /api/import/preview` (multipart, ≤ 25 MB) returns a summary the
 * user reviews, then `POST /api/import/commit {previewId}` applies it (the server backs up first).
 */
import { MAX_IMPORT_BYTES, type ImportPreviewResponse } from '@homebase/shared';
import { saveBlob } from '../lib/download.ts';
import { apiGet, apiPost } from './client.ts';
import { UPLOAD_FIELD } from './uploads.ts';

/** `homebase-export-2026-09-25.json` */
export function exportFilename(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `homebase-export-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

/** Fetches the export and saves it as a JSON file. */
export async function downloadExport(): Promise<void> {
  const data = await apiGet<unknown>('/api/export');
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  saveBlob(new Blob([text], { type: 'application/json' }), exportFilename());
}

/** A reason the file cannot be imported, or null. */
export function checkImportFile(file: File): string | null {
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_IMPORT_BYTES) return 'Export files must be 25 MB or smaller.';
  if (!/\.json$/i.test(file.name) && file.type !== 'application/json') return 'Choose a Homebase export file (.json).';
  return null;
}

export function previewImport(file: File): Promise<ImportPreviewResponse> {
  const form = new FormData();
  form.append(UPLOAD_FIELD, file, file.name);
  return apiPost<ImportPreviewResponse>('/api/import/preview', form);
}

export function commitImport(previewId: string): Promise<unknown> {
  return apiPost<unknown>('/api/import/commit', { previewId });
}
