/**
 * The pinned extension ID: tools/extension-id.mjs against an independent implementation (WebCrypto
 * + a lookup table), the manifest key itself, the README record, the CLI, and a guard that no
 * private key ever lands in the extension folder.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PINNED_EXTENSION_ID as LIB_PINNED_EXTENSION_ID, isStaleExtensionId } from '../lib/launcher.js';
import {
  decodeManifestKey,
  extensionIdFromDer,
  extensionIdFromKey,
  extensionOrigin,
  readExtensionId,
} from '../tools/extension-id.mjs';
import { EXTENSION_DIR, OLD_PATH_EXTENSION_ID, PINNED_EXTENSION_ID, readExtensionFile } from './helpers.mjs';

const manifest = JSON.parse(readExtensionFile('manifest.json'));

/** Independent reference: WebCrypto SHA-256, nibbles through a lookup table. */
async function referenceId(base64Key) {
  const der = Uint8Array.from(atob(base64Key), (ch) => ch.charCodeAt(0));
  const digest = new Uint8Array(await webcrypto.subtle.digest('SHA-256', der));
  const letters = 'abcdefghijklmnop';
  let id = '';
  for (const byte of digest.subarray(0, 16)) id += letters[byte >> 4] + letters[byte & 0x0f];
  return id;
}

describe('extension ID algorithm', () => {
  it('matches the known vector for the pinned manifest key (cross-checked with .NET SHA-256)', async () => {
    assert.equal(extensionIdFromKey(manifest.key), PINNED_EXTENSION_ID);
    assert.equal(await referenceId(manifest.key), PINNED_EXTENSION_ID);
  });

  it("matches Chromium's own vectors (components/crx_file/id_util_unittest.cc)", () => {
    // crx_file::id_util::GenerateId hashes its input exactly as GenerateIdFromPublicKey hashes
    // the DER key, so these pin the hash → a-p mapping to the browser's implementation.
    assert.equal(extensionIdFromDer(Buffer.from('test', 'latin1')), 'jpignaibiiemhngfjkcpokkamffknabf');
    assert.equal(extensionIdFromDer(Buffer.from('_', 'latin1')), 'ncocknphbhhlhkikpnnlmbcnbgdempcd');
  });

  it('reproduces the ID Chrome derives from an unpacked folder path', () => {
    // Unpacked without a "key", Chrome on Windows hashes the folder path as UTF-16LE. For
    // example it gives daklamd… for C:\Users\you\Coding\Homebase\extension (the folder's name before
    // the rename to Portly) — same hash, same mapping.
    const der = Buffer.from('C:\\Users\\you\\Coding\\Homebase\\extension', 'utf16le');
    assert.equal(extensionIdFromDer(der), OLD_PATH_EXTENSION_ID);
  });

  it("lib/launcher.js's PINNED_EXTENSION_ID is the manifest key's ID", () => {
    assert.equal(LIB_PINNED_EXTENSION_ID, extensionIdFromKey(manifest.key));
    assert.equal(LIB_PINNED_EXTENSION_ID, 'nbaolbakegefnefgojdokagajincnfjj');
  });

  it('isStaleExtensionId flags only a real ID other than the pinned one', () => {
    assert.equal(isStaleExtensionId(OLD_PATH_EXTENSION_ID), true);
    for (const id of [PINNED_EXTENSION_ID, 'unknown', '', null, undefined, 42, PINNED_EXTENSION_ID.toUpperCase()]) {
      assert.equal(isStaleExtensionId(id), false, String(id));
    }
  });

  it('agrees with the independent implementation for fresh RSA keys', async () => {
    for (let i = 0; i < 3; i += 1) {
      const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
      const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      const id = extensionIdFromKey(key);
      assert.match(id, /^[a-p]{32}$/);
      assert.equal(id, await referenceId(key));
    }
  });

  it('agrees for arbitrary bytes too (the algorithm hashes the DER, whatever it holds)', async () => {
    const key = Buffer.from('Portly new tab').toString('base64');
    assert.equal(extensionIdFromKey(key), await referenceId(key));
    assert.equal(extensionIdFromDer(Buffer.from('Portly new tab')), await referenceId(key));
  });

  it('tolerates whitespace and PEM armour like Chrome, and rejects non-base64', () => {
    const wrapped = `-----BEGIN PUBLIC KEY-----\n${manifest.key.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;
    assert.equal(extensionIdFromKey(wrapped), PINNED_EXTENSION_ID);
    assert.deepEqual(decodeManifestKey(` ${manifest.key} `), Buffer.from(manifest.key, 'base64'));
    for (const bad of ['', '   ', 'not base64!', 'abc', 42, null]) {
      assert.throws(() => decodeManifestKey(bad), TypeError, String(bad));
    }
  });

  it('builds the allowed_origins entry with the trailing slash', () => {
    assert.equal(extensionOrigin(PINNED_EXTENSION_ID), `chrome-extension://${PINNED_EXTENSION_ID}/`);
    assert.throws(() => extensionOrigin('daklamdnkmbdeegnkhmpeccgggbgiolz'), TypeError);
    assert.throws(() => extensionOrigin('abc'), TypeError);
  });
});

describe('manifest key', () => {
  it('is the base64 DER SubjectPublicKeyInfo of a 2048-bit RSA public key', () => {
    assert.equal(typeof manifest.key, 'string');
    assert.match(manifest.key, /^[A-Za-z0-9+/]+={0,2}$/, 'one line of plain base64');
    const key = createPublicKey({ key: Buffer.from(manifest.key, 'base64'), format: 'der', type: 'spki' });
    assert.equal(key.type, 'public');
    assert.equal(key.asymmetricKeyType, 'rsa');
    assert.equal(key.asymmetricKeyDetails.modulusLength, 2048);
  });

  it('readExtensionId() reads extension/manifest.json by default', () => {
    assert.deepEqual(readExtensionId(), {
      id: PINNED_EXTENSION_ID,
      origin: `chrome-extension://${PINNED_EXTENSION_ID}/`,
    });
  });

  it('README.md records the pinned ID', () => {
    assert.ok(readExtensionFile('README.md').includes(PINNED_EXTENSION_ID));
  });

  it('no private key is kept in the extension folder', () => {
    const marker = ['PRIVATE', 'KEY'].join(' ');
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
        return entry.isDirectory() ? walk(url) : [url];
      });
    for (const file of walk(EXTENSION_DIR)) {
      const name = fileURLToPath(file);
      assert.doesNotMatch(name, /\.(pem|key|crx|p8|pfx)$/i, `${name} looks like key material`);
      assert.equal(fs.readFileSync(file, 'latin1').includes(marker), false, `${name} contains a private key`);
    }
  });
});

describe('tools/extension-id.mjs CLI', () => {
  const tool = fileURLToPath(new URL('tools/extension-id.mjs', EXTENSION_DIR));
  const run = (...args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', windowsHide: true });

  it('prints the ID, the origin, or both as JSON', () => {
    const plain = run();
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, `${PINNED_EXTENSION_ID}\n`);

    const origin = run('--origin');
    assert.equal(origin.stdout, `chrome-extension://${PINNED_EXTENSION_ID}/\n`);

    const json = run('--json', fileURLToPath(new URL('manifest.json', EXTENSION_DIR)));
    assert.deepEqual(JSON.parse(json.stdout), { id: PINNED_EXTENSION_ID, origin: `chrome-extension://${PINNED_EXTENSION_ID}/` });
  });

  it('fails clearly for bad arguments and manifests without a key', () => {
    assert.equal(run('--nope').status, 2);
    const missing = run(fileURLToPath(new URL('package.json', new URL('../', EXTENSION_DIR))));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /has no "key"/);
  });
});
