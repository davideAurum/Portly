#!/usr/bin/env node
/**
 * Computes the extension ID that Chrome and Edge assign to this extension. The manifest's "key"
 * (base64 DER SubjectPublicKeyInfo of an RSA public key) pins the ID, so it no longer depends on
 * the folder the unpacked extension is loaded from:
 *
 *   ID = first 16 bytes of SHA-256(DER key), as 32 hex digits, each digit 0-f mapped to a-p.
 *
 * The private key is not needed to load an unpacked extension and is not kept anywhere.
 *
 *   node extension/tools/extension-id.mjs                  print the ID (from extension/manifest.json)
 *   node extension/tools/extension-id.mjs --origin         print chrome-extension://<ID>/ (native host allowed_origins)
 *   node extension/tools/extension-id.mjs --json           print {"id": ..., "origin": ...}
 *   node extension/tools/extension-id.mjs <manifest.json>  use another manifest
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_MANIFEST_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json');

/**
 * Decodes the manifest "key" (base64; whitespace and PEM armour lines are tolerated, as Chrome
 * does) into DER bytes. Throws a TypeError for anything that is not non-empty base64.
 * @param {string} key
 * @returns {Buffer}
 */
export function decodeManifestKey(key) {
  if (typeof key !== 'string') throw new TypeError('The manifest "key" must be a string.');
  const body = key
    .replace(/-----(BEGIN|END) [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  if (body === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0) {
    throw new TypeError('The manifest "key" is not valid base64.');
  }
  return Buffer.from(body, 'base64');
}

/**
 * The extension ID for a DER-encoded public key.
 * @param {Uint8Array} der
 * @returns {string} 32 letters a-p
 */
export function extensionIdFromDer(der) {
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  let id = '';
  for (const digit of hex) id += String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(digit, 16));
  return id;
}

/**
 * The extension ID for a manifest "key" value.
 * @param {string} key base64 DER SubjectPublicKeyInfo
 */
export function extensionIdFromKey(key) {
  return extensionIdFromDer(decodeManifestKey(key));
}

/** `chrome-extension://<id>/` — the exact form native-messaging allowed_origins expects. */
export function extensionOrigin(id) {
  if (!/^[a-p]{32}$/.test(id)) throw new TypeError(`Not an extension ID: ${id}`);
  return `chrome-extension://${id}/`;
}

/**
 * Reads a manifest and returns its pinned ID.
 * @param {string} [manifestPath]
 * @returns {{ id: string, origin: string }}
 */
export function readExtensionId(manifestPath = DEFAULT_MANIFEST_PATH) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.key !== 'string') {
    throw new Error(`${manifestPath} has no "key", so its ID depends on the folder it is loaded from.`);
  }
  const id = extensionIdFromKey(manifest.key);
  return { id, origin: extensionOrigin(id) };
}

function main(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const unknown = [...flags].filter((flag) => flag !== '--origin' && flag !== '--json');
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  if (unknown.length > 0 || positional.length > 1) {
    process.stderr.write('Usage: node extension/tools/extension-id.mjs [--origin | --json] [manifest.json]\n');
    return 2;
  }
  const manifestPath = positional[0] ? path.resolve(positional[0]) : DEFAULT_MANIFEST_PATH;
  let result;
  try {
    result = readExtensionId(manifestPath);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (flags.has('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (flags.has('--origin')) process.stdout.write(`${result.origin}\n`);
  else process.stdout.write(`${result.id}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
