import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DpapiError,
  createDpapiProtector,
  createRawProtector,
  dpapiScript,
  encodeCommand,
  powershellArgs,
  powershellPath,
  type DpapiOperation,
} from './dpapi.ts';

/**
 * A stand-in for powershell.exe speaking the same stdin/stdout protocol (base64 in, base64 out),
 * so the process plumbing is tested on every platform without DPAPI.
 */
function fakeHelper(behavior: 'xor' | 'fail' | 'policy' | 'garbage' | 'hang' | 'flood'): (op: DpapiOperation) => string[] {
  const source = `
    const behavior = ${JSON.stringify(behavior)};
    let input = '';
    process.stdin.setEncoding('ascii');
    process.stdin.on('data', (d) => { input += d; });
    process.stdin.on('end', () => {
      if (behavior === 'hang') { setInterval(() => {}, 1000); return; }
      if (behavior === 'fail') { process.stderr.write('System.Security.Cryptography.CryptographicException'); process.exit(1); }
      if (behavior === 'policy') { process.stderr.write('System.Management.Automation.PSInvalidOperationException'); process.exit(1); }
      if (behavior === 'garbage') { process.stdout.write('not base64 !!'); process.exit(0); }
      if (behavior === 'flood') { process.stdout.write('A'.repeat(2 * 1024 * 1024)); process.exit(0); }
      const bytes = Buffer.from(input.trim(), 'base64').map((b) => b ^ 0x42);
      process.stdout.write(Buffer.from(bytes).toString('base64'));
    });`;
  return () => ['-e', source];
}

/**
 * Tests that start processes. Each start takes about 0.1 s on a quiet PC but seconds on a busy
 * one: next to a CPU hog the stand-in helper tests took over 5 s and real PowerShell about 8 s.
 */
const SPAWN_TEST_TIMEOUT_MS = 30_000;
const REAL_DPAPI_TEST_TIMEOUT_MS = 120_000;
/** The helper's own timeout for the real-DPAPI test: well above the 20 s the server allows. */
const REAL_DPAPI_TIMEOUT_MS = 60_000;

describe('DPAPI protector', () => {
  it('runs Windows PowerShell by absolute path, never via PATH', () => {
    expect(powershellPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(path.win32.isAbsolute(powershellPath({}))).toBe(true);
    for (const bogus of ['', 'Windows', '"C:\\x" & calc', '\\\\server\\share', 'C:/Windows']) {
      expect(powershellPath({ SystemRoot: bogus })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    }
  });

  it('passes a constant, secret-free script via -EncodedCommand; key bytes use stdin/stdout only', () => {
    const args = powershellArgs('Protect');
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const decoded = Buffer.from(args[4]!, 'base64').toString('utf16le');
    expect(decoded).toBe(dpapiScript('Protect'));
    expect(encodeCommand('x')).toBe(Buffer.from('x', 'utf16le').toString('base64'));
    for (const op of ['Protect', 'Unprotect'] as const) {
      const script = dpapiScript(op);
      expect(script).toContain('[Console]::In.ReadToEnd()');
      expect(script).toContain(`ProtectedData]::${op}(`);
      expect(script).toContain('DataProtectionScope]::CurrentUser');
      expect(script).toContain('Add-Type -AssemblyName System.Security');
    }
  });

  it('round-trips through the helper process over stdin/stdout', async () => {
    const protector = createDpapiProtector({ command: process.execPath, argsFor: fakeHelper('xor') });
    const key = randomBytes(32);
    const blob = await protector.protect(key);
    expect(blob.equals(key)).toBe(false);
    expect((await protector.unprotect(blob)).equals(key)).toBe(true);
  }, SPAWN_TEST_TIMEOUT_MS);

  it('reports failures as DpapiError with only the exception type', async () => {
    const failing = createDpapiProtector({ command: process.execPath, argsFor: fakeHelper('fail') });
    await expect(failing.unprotect(randomBytes(64))).rejects.toThrow(
      new DpapiError('DPAPI Unprotect failed (exit 1): System.Security.Cryptography.CryptographicException'),
    );
    const missing = createDpapiProtector({ command: path.join(process.cwd(), 'no-such-powershell.exe') });
    await expect(missing.protect(randomBytes(32))).rejects.toMatchObject({ message: expect.stringMatching(/could not start PowerShell/), transient: true });
    // A real DPAPI refusal is not transient (the blob is bad).
    await expect(failing.unprotect(randomBytes(64))).rejects.toMatchObject({ transient: false });
  }, SPAWN_TEST_TIMEOUT_MS);

  it('treats failures that never reached DPAPI as transient (the key file is not known to be bad)', async () => {
    // e.g. Constrained Language Mode / WDAC refusing the .NET call: not a verdict on the blob.
    const policy = createDpapiProtector({ command: process.execPath, argsFor: fakeHelper('policy') });
    await expect(policy.unprotect(randomBytes(64))).rejects.toMatchObject({
      message: 'DPAPI Unprotect failed (exit 1): System.Management.Automation.PSInvalidOperationException',
      transient: true,
    });
    const garbage = createDpapiProtector({ command: process.execPath, argsFor: fakeHelper('garbage') });
    await expect(garbage.protect(randomBytes(32))).rejects.toMatchObject({ message: expect.stringMatching(/malformed output/), transient: true });
    const flood = createDpapiProtector({ command: process.execPath, argsFor: fakeHelper('flood') });
    await expect(flood.protect(randomBytes(32))).rejects.toMatchObject({ message: expect.stringMatching(/too much output/), transient: true });
  }, SPAWN_TEST_TIMEOUT_MS);

  it('reports the innermost exception type (PowerShell wraps .NET exceptions)', () => {
    for (const op of ['Protect', 'Unprotect'] as const) {
      expect(dpapiScript(op)).toContain('$_.Exception.GetBaseException().GetType().FullName');
    }
  });

  it('times out and kills a hanging helper (transient failure)', async () => {
    const hanging = createDpapiProtector({ command: process.execPath, argsFor: fakeHelper('hang'), timeoutMs: 300 });
    await expect(hanging.protect(randomBytes(32))).rejects.toMatchObject({ message: 'DPAPI Protect timed out', transient: true });
  }, SPAWN_TEST_TIMEOUT_MS);

  it('refuses empty or oversized input without spawning', async () => {
    const protector = createDpapiProtector({ command: path.join(process.cwd(), 'never-run.exe') });
    await expect(protector.protect(Buffer.alloc(0))).rejects.toThrow(/input must be/);
    await expect(protector.unprotect(Buffer.alloc(65 * 1024))).rejects.toThrow(/input must be/);
  });

  it('raw protector is the identity (non-Windows key files rely on mode 0600)', async () => {
    const raw = createRawProtector();
    const key = randomBytes(32);
    expect(raw.alg).toBe('raw');
    expect((await raw.unprotect(await raw.protect(key))).equals(key)).toBe(true);
  });

  // Real DPAPI (CurrentUser) through powershell.exe — Windows only.
  it.skipIf(process.platform !== 'win32')(
    'real DPAPI: protects and unprotects a 32-byte key; foreign blobs fail',
    async () => {
      const dpapi = createDpapiProtector({ timeoutMs: REAL_DPAPI_TIMEOUT_MS });
      const key = randomBytes(32);
      const blob = await dpapi.protect(key);
      expect(blob.length).toBeGreaterThan(key.length);
      expect(blob.includes(key)).toBe(false);
      expect((await dpapi.unprotect(blob)).equals(key)).toBe(true);
      const refused = await dpapi.unprotect(randomBytes(200)).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(DpapiError);
      // DPAPI's own refusal is reported by type and is not transient (the vault quarantines the file).
      expect(refused).toMatchObject({ message: expect.stringMatching(/CryptographicException$/), transient: false });
    },
    REAL_DPAPI_TEST_TIMEOUT_MS,
  );
});
