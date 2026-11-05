import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * The new-tab extension as a download for the Pages site: `portly-extension.zip` (the extension
 * folder without its tests and tools, as in a release package) and `portly-extension.json`, which
 * names the zip and its SHA-256 for scripts/get-extension.ps1. The zip is byte-for-byte the same
 * for the same files (sorted names, fixed timestamps), so a rebuild of an unchanged extension
 * publishes nothing new.
 */
export const EXTENSION_PACKAGE = 'portly-extension.zip';
export const EXTENSION_PACKAGE_INFO = 'portly-extension.json';

export interface ExtensionPackageInfo {
  name: 'portly-extension';
  version: string;
  package: typeof EXTENSION_PACKAGE;
  sha256: string;
  size: number;
}

export interface ZipEntry {
  /** Path inside the zip, with `/` separators. */
  name: string;
  data: Buffer;
}

/** Folders of extension/ that stay out of the download (scripts/build-release.ps1 skips the same). */
const EXCLUDED_DIRS = new Set(['test', 'tools']);

/** The extension's files, sorted by path. */
export function listExtensionFiles(extensionDir: string): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix === '' ? item.name : `${prefix}/${item.name}`;
      if (item.isDirectory()) {
        if (prefix === '' && EXCLUDED_DIRS.has(item.name)) continue;
        walk(path.join(dir, item.name), name);
      } else if (item.isFile()) {
        entries.push({ name, data: readFileSync(path.join(dir, item.name)) });
      }
    }
  };
  walk(extensionDir, '');
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// MS-DOS date of 1980-01-01 00:00, the earliest a zip can record: every entry gets it.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
// General purpose flag bit 11: names are UTF-8.
const UTF8_FLAG = 0x0800;

/** A zip archive (deflate, no directory entries) of the given files, in the given order. */
export function createZip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8_FLAG, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    // Extra field, comment, disk number, internal and external attributes: all 0.
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + compressed.length;
  }
  const centralDir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDir, end]);
}

/** The zip of extension/ and its description. */
export function buildExtensionPackage(extensionDir: string): { zip: Buffer; info: ExtensionPackageInfo } {
  const manifest = JSON.parse(readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`${path.join(extensionDir, 'manifest.json')} has no version`);
  }
  const zip = createZip(listExtensionFiles(extensionDir));
  return {
    zip,
    info: {
      name: 'portly-extension',
      version: manifest.version,
      package: EXTENSION_PACKAGE,
      sha256: createHash('sha256').update(zip).digest('hex'),
      size: zip.length,
    },
  };
}
