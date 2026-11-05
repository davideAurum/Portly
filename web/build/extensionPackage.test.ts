import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildExtensionPackage, createZip, listExtensionFiles } from './extensionPackage.ts';

const extensionDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

/** Reads a zip through its central directory, as Windows' ZipFile does. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = inflateRawSync(zip.subarray(start, start + zip.readUInt32LE(local + 18)));
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    files.set(name, data);
    at += 46 + nameLength;
  }
  return files;
}

describe('extension package', () => {
  it('holds the extension without its tests and tools, byte for byte', () => {
    const { zip, info } = buildExtensionPackage(extensionDir);
    const files = readZip(zip);
    const names = [...files.keys()];
    expect(names).toContain('manifest.json');
    expect(names).toContain('background.js');
    expect(names).toContain('icons/icon-128.png');
    expect(names.some((name) => name.startsWith('test/') || name.startsWith('tools/'))).toBe(false);
    expect(files.get('manifest.json')?.equals(readFileSync(path.join(extensionDir, 'manifest.json')))).toBe(true);
    expect(files.get('icons/icon-128.png')?.equals(readFileSync(path.join(extensionDir, 'icons', 'icon-128.png')))).toBe(true);
    expect(names).toEqual([...names].sort());

    const manifest = JSON.parse(readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8')) as { version: string };
    expect(info).toEqual({
      name: 'portly-extension',
      version: manifest.version,
      package: 'portly-extension.zip',
      sha256: createHash('sha256').update(zip).digest('hex'),
      size: zip.length,
    });
  });

  it('is the same zip on every build', () => {
    expect(buildExtensionPackage(extensionDir).zip.equals(buildExtensionPackage(extensionDir).zip)).toBe(true);
  });

  it('lists files in a stable order and writes an empty archive', () => {
    const listed = listExtensionFiles(extensionDir).map((entry) => entry.name);
    expect(listed).toEqual([...listed].sort());
    expect(readZip(createZip([])).size).toBe(0);
  });
});
