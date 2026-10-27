/**
 * Reading the synced launch pad file and its icon files in the browser (docs/design/launchpad-sync.md
 * section 8). The file is hostile input: anything that can write to the user's sync store can
 * change it. It is checked like an import file (handlers/transfer.ts `parseImportFile`): a size cap
 * first, UTF-8 with the BOM stripped, `JSON.parse`, `assertSafeJson` (no `__proto__`,
 * `constructor` or `prototype` keys, nesting at most 64 deep), then the strict versioned schema
 * from `@portly/shared` (`portly-sync` version 1) and the stamps against this PC's clock.
 *
 * A refused file is never merged or overwritten; the caller reports the problem code (never the
 * file's content). Icon bytes are sniffed, capped and checked against the SHA-256 the file lists;
 * the stored type comes from the bytes alone.
 */
import {
  MAX_EMBEDDED_IMAGE_BYTES,
  MAX_IMPORT_BYTES,
  SYNC_FILE_FORMAT,
  SYNC_FILE_VERSION,
  SyncFileSchema,
  syncStampProblem,
  type ImageContentType,
  type SyncIcon,
  type SyncLaunchpad,
} from '@portly/shared';
import { sniffImageType } from '../lib/imageSniff.ts';
import { assertSafeJson, isPlainObject } from '../lib/safeJson.ts';

/** Largest main file read (the import cap). */
export const MAX_SYNC_FILE_BYTES = MAX_IMPORT_BYTES;
/** Largest icon file read (an embedded image's cap). */
export const MAX_SYNC_ICON_BYTES = MAX_EMBEDDED_IMAGE_BYTES;

export type SyncFileProblem =
  /** Over {@link MAX_SYNC_FILE_BYTES}. */
  | 'too_large'
  /** Not UTF-8 JSON. */
  | 'not_json'
  /** A forbidden key or nesting too deep. */
  | 'unsafe_json'
  /** Not a launch pad sync file at all. */
  | 'not_sync_file'
  /** Written by a newer Portly: sync stops in this browser and the file is never overwritten. */
  | 'newer_version'
  /** Fails the schema (types, limits, unsafe URLs, counts). */
  | 'invalid'
  /** A stamp more than a year ahead of this PC's clock. */
  | 'stamp_ahead';

export type SyncFileRead = { ok: true; doc: SyncLaunchpad } | { ok: false; problem: SyncFileProblem };

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Parses and checks the main file's bytes; `now` is this PC's clock. Never throws. */
export function readSyncFile(bytes: Uint8Array, now: number): SyncFileRead {
  if (bytes.byteLength > MAX_SYNC_FILE_BYTES) return { ok: false, problem: 'too_large' };
  let raw: unknown;
  try {
    let text = UTF8.decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'not_json' };
  }
  try {
    assertSafeJson(raw, 'The synced launch pad');
  } catch {
    return { ok: false, problem: 'unsafe_json' };
  }
  if (!isPlainObject(raw) || raw.format !== SYNC_FILE_FORMAT) return { ok: false, problem: 'not_sync_file' };
  if (typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version > SYNC_FILE_VERSION) {
    return { ok: false, problem: 'newer_version' };
  }
  const parsed = SyncFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: 'invalid' };
  const { format: _format, version: _version, ...doc } = parsed.data;
  const stamps = syncStampProblem(doc, now);
  return stamps ? { ok: false, problem: stamps } : { ok: true, doc };
}

export type SyncIconProblem = 'too_large' | 'not_an_image' | 'checksum';

export type SyncIconRead = { ok: true; contentType: ImageContentType } | { ok: false; problem: SyncIconProblem };

/** Lower-case hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copy));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Checks an icon file's bytes against its entry: size, a supported image (sniffed), the listed SHA-256. */
export async function checkSyncIcon(bytes: Uint8Array, icon: SyncIcon): Promise<SyncIconRead> {
  if (bytes.byteLength > MAX_SYNC_ICON_BYTES) return { ok: false, problem: 'too_large' };
  const contentType = sniffImageType(bytes);
  if (!contentType) return { ok: false, problem: 'not_an_image' };
  if ((await sha256Hex(bytes)) !== icon.sha256) return { ok: false, problem: 'checksum' };
  return { ok: true, contentType };
}
