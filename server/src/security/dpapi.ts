/**
 * Master-key protection (§4.6) — `KeyProtector`.
 *
 * Windows: DPAPI (CurrentUser) through Windows PowerShell spawned **by absolute path**
 * (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`) with
 * `-NoProfile -NonInteractive -EncodedCommand <script>` and `windowsHide: true`, never through a
 * shell. The script is a constant (it holds no secrets): it loads System.Security, reads base64
 * from stdin, calls `ProtectedData.Protect/Unprotect(..., CurrentUser)`, writes base64 to stdout
 * and exits non-zero on error. Key bytes travel only over stdin/stdout.
 *
 * Non-Windows: identity ("raw" key file protected by file mode 0600).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export type KeyProtectionAlg = 'dpapi-cu' | 'raw';

export interface KeyProtector {
  readonly alg: KeyProtectionAlg;
  protect(data: Buffer): Promise<Buffer>;
  unprotect(blob: Buffer): Promise<Buffer>;
}

export class DpapiError extends Error {
  override name = 'DpapiError';
  /**
   * False only when DPAPI itself refused the data (a `CryptographicException`: a blob from another
   * user or machine, or a corrupted blob). True for everything that says nothing about the data —
   * PowerShell could not start, timed out, failed before DPAPI answered (e.g. a language-mode or
   * assembly-loading policy) or produced unexpected output: the key file is not known to be bad,
   * so the vault locks for this run without moving the file aside.
   */
  readonly transient: boolean;
  constructor(message: string, options: { transient?: boolean } = {}) {
    super(message);
    this.transient = options.transient ?? false;
  }
}

export type DpapiOperation = 'Protect' | 'Unprotect';

export const DPAPI_TIMEOUT_MS = 20_000;
/** Inputs are 32-byte keys or their DPAPI blobs (a few hundred bytes); anything bigger is a bug. */
const MAX_INPUT_BYTES = 64 * 1024;
/** Upper bound on what the child may write to stdout/stderr before it is killed. */
const MAX_OUTPUT_BYTES = 1024 * 1024;
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

/** Absolute path of Windows PowerShell 5.1 (never resolved through PATH). */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.SystemRoot?.trim() ?? '';
  // Only a plain absolute drive path is trusted (no quotes, no UNC/relative/odd forms).
  const systemRoot = /^[A-Za-z]:\\[^"<>|?*\r\n]*$/.test(candidate) ? candidate : 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * The constant PowerShell script for `operation` (reads base64 on stdin, writes base64 to stdout).
 * On failure it writes only the type name of the innermost exception to stderr (PowerShell wraps
 * .NET exceptions in `MethodInvocationException`; the inner `CryptographicException` is what
 * tells a refused blob apart from an environment problem).
 */
export function dpapiScript(operation: DpapiOperation): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try {',
    '  Add-Type -AssemblyName System.Security',
    '  $inputB64 = [Console]::In.ReadToEnd().Trim()',
    '  $bytes = [Convert]::FromBase64String($inputB64)',
    `  $out = [System.Security.Cryptography.ProtectedData]::${operation}($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '  [Console]::Out.Write([Convert]::ToBase64String($out))',
    '  exit 0',
    '} catch {',
    '  [Console]::Error.Write($_.Exception.GetBaseException().GetType().FullName)',
    '  exit 1',
    '}',
  ].join('\n');
}

/** Exception type DPAPI raises when it refuses the data (the only non-transient failure). */
const DPAPI_REFUSAL = /(^|\.)CryptographicException$/;

/** `-EncodedCommand` takes base64 of the UTF-16LE script. */
export function encodeCommand(source: string): string {
  return Buffer.from(source, 'utf16le').toString('base64');
}

export function powershellArgs(operation: DpapiOperation): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(dpapiScript(operation))];
}

export interface DpapiProtectorOptions {
  /** Executable to run (default: {@link powershellPath}). Tests substitute a fake helper. */
  command?: string;
  /** Arguments per operation (default: {@link powershellArgs}). */
  argsFor?: (operation: DpapiOperation) => string[];
  timeoutMs?: number;
}

function runProtectedData(operation: DpapiOperation, input: Buffer, options: DpapiProtectorOptions): Promise<Buffer> {
  if (input.length === 0 || input.length > MAX_INPUT_BYTES) {
    return Promise.reject(new DpapiError(`DPAPI ${operation}: input must be 1-${MAX_INPUT_BYTES} bytes`));
  }
  const command = options.command ?? powershellPath();
  const args = (options.argsFor ?? powershellArgs)(operation);
  const timeoutMs = options.timeoutMs ?? DPAPI_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;

    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

    const finish = (err: Error | null, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        reject(err);
      } else {
        resolve(value ?? Buffer.alloc(0));
      }
    };
    const timer = setTimeout(() => finish(new DpapiError(`DPAPI ${operation} timed out`, { transient: true })), timeoutMs);

    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        finish(new DpapiError(`DPAPI ${operation} produced too much output`, { transient: true }));
        return;
      }
      sink.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (err) =>
      finish(new DpapiError(`DPAPI ${operation} could not start PowerShell: ${err.message}`, { transient: true })),
    );
    child.on('close', (code) => {
      if (code !== 0) {
        // Report only the exception type (stderr may be CLIXML-wrapped; it never holds key bytes).
        const detail = /[A-Za-z0-9_.]*Exception/.exec(Buffer.concat(stderr).toString('utf8'))?.[0] ?? '';
        finish(
          new DpapiError(`DPAPI ${operation} failed (exit ${code ?? 'signal'})${detail ? `: ${detail}` : ''}`, {
            transient: !DPAPI_REFUSAL.test(detail),
          }),
        );
        return;
      }
      const text = Buffer.concat(stdout).toString('ascii').trim();
      if (!BASE64_REGEX.test(text)) {
        finish(new DpapiError(`DPAPI ${operation} returned malformed output`, { transient: true }));
        return;
      }
      finish(null, Buffer.from(text, 'base64'));
    });
    // EPIPE etc. surface through 'close'/'error'.
    child.stdin.on('error', () => {});
    child.stdin.end(input.toString('base64'));
  });
}

/** DPAPI CurrentUser protector (Windows only). */
export function createDpapiProtector(options: DpapiProtectorOptions = {}): KeyProtector {
  return {
    alg: 'dpapi-cu',
    protect: (data) => runProtectedData('Protect', data, options),
    unprotect: (blob) => runProtectedData('Unprotect', blob, options),
  };
}

/** Identity protector (non-Windows raw key file). */
export function createRawProtector(): KeyProtector {
  return {
    alg: 'raw',
    protect: async (data) => Buffer.from(data),
    unprotect: async (blob) => Buffer.from(blob),
  };
}

/** Platform default: DPAPI on Windows, raw elsewhere. */
export function defaultKeyProtector(): KeyProtector {
  return process.platform === 'win32' ? createDpapiProtector() : createRawProtector();
}
