import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { openDb, type Db } from '../db/open.ts';
import { createMemoryLogger } from '../lib/logger.ts';
import { DpapiError, createRawProtector, type KeyProtector } from './dpapi.ts';
import { KEY_VERSION, SECRET_ALG, VaultLockedError, createMemoryVault, openVault, type Vault } from './vault.ts';

const MAGIC = Buffer.from('FAKE-DPAPI:');

/** Stand-in for DPAPI: reversible, but the blob never equals the key. */
function fakeProtector(options: { failProtect?: boolean; failUnprotect?: boolean } = {}): KeyProtector & { calls: string[] } {
  const calls: string[] = [];
  return {
    alg: 'dpapi-cu',
    calls,
    async protect(data) {
      calls.push('protect');
      if (options.failProtect) throw new DpapiError('DPAPI Protect failed (exit 1)');
      return Buffer.concat([MAGIC, Buffer.from(data.map((b) => b ^ 0x5a))]);
    },
    async unprotect(blob) {
      calls.push('unprotect');
      if (options.failUnprotect) throw new DpapiError('DPAPI Unprotect failed (exit 1): CryptographicException');
      if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new DpapiError('DPAPI Unprotect failed (exit 1)');
      return Buffer.from(blob.subarray(MAGIC.length).map((b) => b ^ 0x5a));
    },
  };
}

interface SecretRow {
  id: string;
  key_version: number;
  alg: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

describe('openVault (persistent vault, §4.6)', () => {
  let dir: string;
  let keyFile: string;
  let db: Db;
  let log: ReturnType<typeof createMemoryLogger>;

  const open = (protector: KeyProtector = fakeProtector(), now = () => 1_758_000_000_000): Promise<Vault> =>
    openVault({ config: { paths: { vaultKey: keyFile } }, db, log, protector, now });
  const row = (id: string): SecretRow | undefined =>
    db.get<SecretRow>('SELECT id, key_version, alg, iv, tag, ciphertext FROM secrets WHERE id = ?', [id]);
  const quarantined = (): string[] => fs.readdirSync(dir).filter((n) => n.startsWith('vault.key.unreadable-'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-vault-'));
    keyFile = path.join(dir, 'vault.key');
    db = openDb(':memory:');
    migrate(db);
    log = createMemoryLogger();
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a DPAPI-protected key and the canary on first start', async () => {
    const protector = fakeProtector();
    const vault = await open(protector);
    expect(vault.state).toBe('ready');
    expect(protector.calls).toEqual(['protect']);
    const file = JSON.parse(fs.readFileSync(keyFile, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(['alg', 'blob', 'v']);
    expect(file).toMatchObject({ v: 1, alg: 'dpapi-cu' });
    expect(Buffer.from(String(file.blob), 'base64').subarray(0, MAGIC.length)).toEqual(MAGIC);
    expect(fs.readdirSync(dir)).toEqual(['vault.key']); // no temp files left behind
    expect(row('canary')).toBeDefined();
    expect(vault.list()).toEqual([]);
    expect(db.get<{ secure_delete: number }>('PRAGMA secure_delete')?.secure_delete).toBe(1);
  });

  it('round-trips secrets with AES-256-GCM, fresh IVs and 16-byte tags; plaintext never stored', async () => {
    const vault = await open();
    const secret = JSON.stringify({ refreshToken: 'rt-very-secret-value' });
    vault.put('account:a1', secret);
    vault.put('todoist:token', 'tok-123');
    expect(vault.get('account:a1')).toBe(secret);
    expect(vault.get('account:missing')).toBeNull();
    expect(vault.has('account:a1')).toBe(true);
    expect(vault.list()).toEqual(['account:a1', 'todoist:token']);
    expect(vault.list('account:')).toEqual(['account:a1']);

    const stored = row('account:a1');
    expect(stored).toMatchObject({ alg: SECRET_ALG, key_version: KEY_VERSION });
    expect(stored?.iv).toHaveLength(12);
    expect(stored?.tag).toHaveLength(16);
    expect(stored?.ciphertext.toString('utf8')).not.toContain('rt-very-secret');
    const dump = JSON.stringify(db.all('SELECT * FROM secrets')) + fs.readFileSync(keyFile, 'utf8');
    expect(dump).not.toContain('rt-very-secret');

    vault.put('account:a1', secret);
    const again = row('account:a1');
    expect(again?.iv.equals(stored!.iv)).toBe(false);
    expect(again?.ciphertext.equals(stored!.ciphertext)).toBe(false);

    vault.delete('account:a1');
    expect(vault.has('account:a1')).toBe(false);
    expect(vault.get('account:a1')).toBeNull();
  });

  it('reopens with the same key file (restart) and reads earlier secrets', async () => {
    (await open()).put('ics:cal-1', 'https://example.com/private/feed.ics');
    const protector = fakeProtector();
    const reopened = await open(protector);
    expect(protector.calls).toEqual(['unprotect']);
    expect(reopened.state).toBe('ready');
    expect(reopened.get('ics:cal-1')).toBe('https://example.com/private/feed.ics');
  });

  it('detects tampering: a modified ciphertext, tag or IV reads as missing and is logged', async () => {
    const vault = await open();
    vault.put('account:a', 'alpha');
    vault.put('account:b', 'bravo');
    vault.put('account:c', 'charlie');
    const flip = (column: 'ciphertext' | 'tag' | 'iv', id: string): void => {
      const value = Buffer.from(row(id)![column]);
      value[0] = (value[0] ?? 0) ^ 0x01;
      db.run(`UPDATE secrets SET ${column} = ? WHERE id = ?`, [value, id]);
    };
    flip('ciphertext', 'account:a');
    flip('tag', 'account:b');
    flip('iv', 'account:c');
    expect(vault.get('account:a')).toBeNull();
    expect(vault.get('account:b')).toBeNull();
    expect(vault.get('account:c')).toBeNull();
    expect(log.lines.filter((l) => l.level === 'error' && l.message.includes('failed authentication')).map((l) => l.fields?.secretId)).toEqual([
      'account:a',
      'account:b',
      'account:c',
    ]);
    // Log lines never include the values.
    expect(JSON.stringify(log.lines)).not.toMatch(/alpha|bravo|charlie/);
  });

  it('binds ciphertexts to their id and key version (AAD)', async () => {
    const vault = await open();
    vault.put('account:victim', 'secret-of-victim');
    // Copy the row under another id: the AAD `${id}|v1` no longer matches.
    db.run(
      "INSERT INTO secrets (id, key_version, alg, iv, tag, ciphertext, updated_at) SELECT 'account:attacker', key_version, alg, iv, tag, ciphertext, updated_at FROM secrets WHERE id = 'account:victim'",
    );
    expect(vault.get('account:attacker')).toBeNull();
    db.run("UPDATE secrets SET key_version = 2 WHERE id = 'account:victim'");
    expect(vault.get('account:victim')).toBeNull();
    db.run("UPDATE secrets SET key_version = 1, alg = 'aes-128-gcm' WHERE id = 'account:victim'");
    expect(vault.get('account:victim')).toBeNull();
    db.run("UPDATE secrets SET alg = 'aes-256-gcm', tag = ? WHERE id = 'account:victim'", [Buffer.alloc(12)]);
    expect(vault.get('account:victim')).toBeNull();
  });

  const expectLocked = (vault: Vault): void => {
    expect(vault.state).toBe('locked');
    expect(() => vault.get('account:a')).toThrow(VaultLockedError);
    expect(() => vault.put('account:a', 'x')).toThrow(VaultLockedError);
    try {
      vault.get('account:a');
    } catch (err) {
      expect(err).toMatchObject({ status: 409, code: 'reauth_required' });
    }
  };

  it('locks (and quarantines the file) when the key file is corrupted — never regenerates', async () => {
    const first = await open();
    first.put('account:a', 'alpha');
    fs.writeFileSync(keyFile, '{not json');
    const vault = await open();
    expectLocked(vault);
    expect(fs.existsSync(keyFile)).toBe(false);
    expect(quarantined()).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, quarantined()[0]!), 'utf8')).toBe('{not json');
    // Key-free operations keep working while locked.
    expect(vault.has('account:a')).toBe(true);
    expect(vault.list()).toEqual(['account:a']);
    vault.delete('account:a');
    expect(vault.has('account:a')).toBe(false);

    // Next start: the key is missing while secrets (the canary) exist → still locked, no new key.
    const again = await open();
    expectLocked(again);
    expect(fs.existsSync(keyFile)).toBe(false);
  });

  it('locks when the key file is missing but secrets exist', async () => {
    (await open()).put('account:a', 'alpha');
    fs.rmSync(keyFile);
    const protector = fakeProtector();
    const vault = await open(protector);
    expectLocked(vault);
    expect(protector.calls).toEqual([]);
    expect(fs.existsSync(keyFile)).toBe(false);
    expect(log.lines.some((l) => l.level === 'error' && l.message.includes('key file is missing'))).toBe(true);
  });

  it('locks when the canary does not decrypt (key file from another vault)', async () => {
    (await open()).put('account:a', 'alpha');
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-vault-other-'));
    const otherDb = openDb(':memory:');
    migrate(otherDb);
    await openVault({ config: { paths: { vaultKey: path.join(otherDir, 'vault.key') } }, db: otherDb, log, protector: fakeProtector() });
    fs.copyFileSync(path.join(otherDir, 'vault.key'), keyFile);
    otherDb.close();
    fs.rmSync(otherDir, { recursive: true, force: true });

    const vault = await open();
    expectLocked(vault);
    expect(quarantined()).toHaveLength(1);
  });

  it('locks when DPAPI cannot unprotect the key', async () => {
    (await open()).put('account:a', 'alpha');
    const vault = await open(fakeProtector({ failUnprotect: true }));
    expectLocked(vault);
    expect(quarantined()).toHaveLength(1);
    expect(JSON.stringify(log.lines)).toContain('CryptographicException');
  });

  it('locks without moving the key file when DPAPI is unreachable (timeout / PowerShell missing)', async () => {
    (await open()).put('account:a', 'alpha');
    const unreachable: KeyProtector = {
      alg: 'dpapi-cu',
      protect: async () => Promise.reject(new DpapiError('DPAPI Protect timed out', { transient: true })),
      unprotect: async () => Promise.reject(new DpapiError('DPAPI Unprotect timed out', { transient: true })),
    };
    expectLocked(await open(unreachable));
    expect(fs.existsSync(keyFile)).toBe(true);
    expect(quarantined()).toEqual([]);
    // The next start with DPAPI available unlocks with the same key.
    const vault = await open();
    expect(vault.state).toBe('ready');
    expect(vault.get('account:a')).toBe('alpha');
  });

  it('locks on a key file with the wrong protection algorithm or format', async () => {
    await open();
    fs.writeFileSync(keyFile, JSON.stringify({ v: 1, alg: 'raw', blob: Buffer.alloc(32).toString('base64') }));
    expectLocked(await open());
    fs.writeFileSync(keyFile, JSON.stringify({ v: 2, alg: 'dpapi-cu', blob: 'AAAA' }));
    expectLocked(await open());
    fs.writeFileSync(keyFile, JSON.stringify({ v: 1, alg: 'dpapi-cu', blob: 'AAAA', extra: true }));
    expectLocked(await open());
    expect(quarantined()).toHaveLength(3);
  });

  it('recreates a missing canary when another secret proves the key; locks when none does', async () => {
    (await open()).put('account:a', 'alpha');
    db.run("DELETE FROM secrets WHERE id = 'canary'");
    const vault = await open();
    expect(vault.state).toBe('ready');
    expect(vault.get('account:a')).toBe('alpha');
    expect(row('canary')).toBeDefined();

    db.run("DELETE FROM secrets WHERE id = 'canary'");
    db.run("UPDATE secrets SET ciphertext = ? WHERE id = 'account:a'", [Buffer.from('garbage')]);
    expectLocked(await open());
  });

  it('reuses an existing key when the database has no secrets yet', async () => {
    await open();
    db.run('DELETE FROM secrets');
    const protector = fakeProtector();
    const vault = await open(protector);
    expect(vault.state).toBe('ready');
    expect(protector.calls).toEqual(['unprotect']);
    expect(row('canary')).toBeDefined();
  });

  it('stays locked (without a key file) when a first key cannot be protected', async () => {
    const vault = await open(fakeProtector({ failProtect: true }));
    expectLocked(vault);
    expect(fs.existsSync(keyFile)).toBe(false);
  });

  it('reset() deletes every secret, writes a new key and unlocks', async () => {
    (await open()).put('account:a', 'alpha');
    fs.writeFileSync(keyFile, 'garbage');
    const vault = await open();
    expectLocked(vault);

    await Promise.all([vault.reset(), vault.reset()]);
    expect(vault.state).toBe('ready');
    expect(vault.list()).toEqual([]);
    expect(db.all<{ id: string }>('SELECT id FROM secrets').map((r) => r.id)).toEqual(['canary']);
    vault.put('todoist:token', 'fresh');
    expect(vault.get('todoist:token')).toBe('fresh');

    const reopened = await open();
    expect(reopened.state).toBe('ready');
    expect(reopened.get('todoist:token')).toBe('fresh');
  });

  it('reset() failing to protect the new key leaves the vault as it was', async () => {
    const vault = await open(fakeProtector());
    vault.put('account:a', 'alpha');
    const broken = await openVault({ config: { paths: { vaultKey: keyFile } }, db, log, protector: { ...fakeProtector(), protect: async () => Promise.reject(new DpapiError('nope')) } });
    await expect(broken.reset()).rejects.toThrow(DpapiError);
    expect(broken.state).toBe('ready');
    expect(broken.get('account:a')).toBe('alpha');
  });

  it('reset() failing to replace the secrets leaves the key file and the secrets untouched', async () => {
    const vault = await open();
    vault.put('account:a', 'alpha');
    const keyBefore = fs.readFileSync(keyFile, 'utf8');
    db.exec("CREATE TRIGGER fail_secret_insert BEFORE INSERT ON secrets BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await expect(vault.reset()).rejects.toThrow(/disk full/);
    db.exec('DROP TRIGGER fail_secret_insert');

    expect(fs.readFileSync(keyFile, 'utf8')).toBe(keyBefore);
    expect(fs.readdirSync(dir)).toEqual(['vault.key']); // the staged key was discarded
    expect(vault.state).toBe('ready');
    expect(vault.get('account:a')).toBe('alpha');
    // After a restart the old key still opens the old secrets.
    const reopened = await open();
    expect(reopened.state).toBe('ready');
    expect(reopened.get('account:a')).toBe('alpha');
  });

  it('reset() that cannot store the new key locks instead of writing unreadable secrets', async () => {
    const vault = await open();
    vault.put('account:a', 'alpha');
    fs.rmSync(keyFile);
    fs.mkdirSync(keyFile); // the rename over `vault.key` fails
    await expect(vault.reset()).rejects.toThrow();
    expectLocked(vault);
    expect(fs.readdirSync(dir)).toEqual(['vault.key']);
    expect(log.lines.some((l) => l.level === 'error' && l.message.includes('new key could not be stored'))).toBe(true);
  });

  it('removes staged key files left over by an interrupted write, never the key itself', async () => {
    (await open()).put('account:a', 'alpha');
    fs.writeFileSync(`${keyFile}.tmp-1234-abcdef`, '{"v":1,"alg":"dpapi-cu","blob":"AAAA"}');
    fs.writeFileSync(path.join(dir, 'vault.key.unreadable-20260101T000000000Z'), 'kept');
    const vault = await open();
    expect(vault.state).toBe('ready');
    expect(vault.get('account:a')).toBe('alpha');
    expect(fs.readdirSync(dir).sort()).toEqual(['vault.key', 'vault.key.unreadable-20260101T000000000Z']);
  });

  it.skipIf(process.platform !== 'win32')(
    'real DPAPI end to end: first start creates a protected key, a restart reads the secrets',
    async () => {
      const first = await openVault({ config: { paths: { vaultKey: keyFile } }, db, log });
      expect(first.state).toBe('ready');
      first.put('todoist:token', 'tok-real-dpapi');
      const file = JSON.parse(fs.readFileSync(keyFile, 'utf8')) as { alg: string; blob: string };
      expect(file.alg).toBe('dpapi-cu');
      expect(Buffer.from(file.blob, 'base64').length).toBeGreaterThan(32);
      const reopened = await openVault({ config: { paths: { vaultKey: keyFile } }, db, log });
      expect(reopened.state).toBe('ready');
      expect(reopened.get('todoist:token')).toBe('tok-real-dpapi');
    },
    60_000,
  );

  it('validates secret ids and reserves the canary id', async () => {
    const vault = await open();
    expect(() => vault.put('bad id', 'x')).toThrow(TypeError);
    expect(() => vault.put('ACCOUNT:x', 'x')).toThrow(TypeError);
    expect(() => vault.put('canary', 'x')).toThrow(/reserved/);
    expect(() => vault.delete('canary')).toThrow(/reserved/);
    expect(() => vault.put('account:x', 42 as unknown as string)).toThrow(TypeError);
    expect(() => vault.get('../etc')).toThrow(TypeError);
  });

  it.skipIf(process.platform === 'win32')('raw protector: key file is written with mode 0600', async () => {
    const vault = await open(createRawProtector());
    expect(vault.state).toBe('ready');
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(keyFile, 'utf8'))).toMatchObject({ v: 1, alg: 'raw' });
  });
});

describe('createMemoryVault', () => {
  it('encrypts with the fixed test key, supports locking and reset', async () => {
    const vault = createMemoryVault({ 'todoist:token': 't0k', 'account:a': '{"password":"pw"}' });
    expect(vault.get('todoist:token')).toBe('t0k');
    expect(vault.list()).toEqual(['account:a', 'todoist:token']);
    vault.setState('locked');
    expect(vault.state).toBe('locked');
    expect(() => vault.get('todoist:token')).toThrow(VaultLockedError);
    expect(vault.has('todoist:token')).toBe(true);
    vault.setState('ready');
    expect(vault.get('account:a')).toBe('{"password":"pw"}');
    await vault.reset();
    expect(vault.list()).toEqual([]);
    expect(vault.state).toBe('ready');
  });

  it('can start locked', () => {
    const vault = createMemoryVault({ 'account:a': 'x' }, 'locked');
    expect(vault.state).toBe('locked');
    expect(vault.has('account:a')).toBe(true);
    expect(() => vault.put('account:b', 'y')).toThrow(VaultLockedError);
  });
});
