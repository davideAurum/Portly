/** One sync backend: where the launch pad file and its icons are kept. */
export interface SyncStore {
  readonly kind: 'onedrive' | 'github';
  /** The main file, or null when it does not exist yet. */
  readMain(signal: AbortSignal): Promise<SyncFileVersion | null>;
  /** Writes the main file only while it is still at `ifVersion` (null: only while it is missing). */
  writeMain(text: string, ifVersion: string | null, signal: AbortSignal): Promise<SyncWriteResult>;
  readIcon(id: string, signal: AbortSignal): Promise<Blob | null>;
  /** Create-only: an icon id is never written twice. */
  writeIcon(id: string, data: Blob, signal: AbortSignal): Promise<void>;
  deleteIcon(id: string, signal: AbortSignal): Promise<void>;
}

export interface SyncFileVersion {
  readonly text: string;
  readonly version: string;
}

export type SyncWriteResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: 'conflict' };

export type SyncStoreErrorCode = 'reauth_required' | 'network_error' | 'rate_limited' | 'too_large' | 'unavailable';

export class SyncStoreError extends Error {
  readonly code: SyncStoreErrorCode;
  readonly retryAfterMs: number | null;
  constructor(code: SyncStoreErrorCode, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'SyncStoreError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export const SYNC_MAX_MAIN_BYTES = 25 * 1024 * 1024;
export const SYNC_MAX_ICON_BYTES = 10 * 1024 * 1024;
