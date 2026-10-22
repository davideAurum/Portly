/**
 * Peer names (§20): the name to suggest for a PC that asks to be connected, from Tailscale on this
 * PC. A browser cannot tell a web page the computer's name, but a Tailscale Serve proxy sets
 * `X-Forwarded-For` to the sender's tailnet address (and replaces a forged one, as the real check
 * showed), and `tailscale whois --json <address>` on this PC answers with that node's `Hostinfo
 * .Hostname` (the Windows computer name), its tailnet machine name (`ComputedName`) and its
 * MagicDNS name (`Name`). The first of those that is a usable device label (shared
 * `DeviceLabelSchema`, cut to its length) is the suggestion; anything else answers null.
 *
 * The suggestion is a convenience, never trust: the other PC may change it, the approval on the
 * main PC stays the login, and a forged `X-Forwarded-For` through a proxy that passes it on can
 * only change the suggested text, and a flood of forged addresses costs at most
 * {@link PEER_NAME_MAX_IN_FLIGHT} processes at a time (further addresses get no suggestion while
 * those run). Only tailnet addresses (100.64.0.0/10, fd7a:115c:a1e0::/48) are looked up, never
 * anything else, and `tailscale.exe` is spawned by its absolute path in `%ProgramFiles%\Tailscale`
 * with an argument array (no shell), hidden, with a timeout. Without the program there (another
 * proxy, Tailscale not installed) every lookup answers null. Answers are cached a few minutes per
 * address so a page that asks repeatedly starts no new process.
 *
 * Logs never carry the name or the address: `peer name lookup failed {reason}` at debug only.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { join } from 'node:path';
import { DEVICE_LABEL_MAX, DeviceLabelSchema } from '@portly/shared';
import type { Logger } from './logger.ts';

export interface PeerNames {
  /** The name to suggest for the PC at `address`, or null when there is none to give. */
  lookup(address: string): Promise<string | null>;
}

/** Runs `tailscale whois --json <address>` and resolves with its stdout, or rejects. */
export type TailscaleRunner = (address: string) => Promise<string>;

export interface PeerNamesOptions {
  log: Logger;
  /** Replaces the real `tailscale.exe` (tests). */
  run?: TailscaleRunner;
  /** The clock for the cache (tests). */
  now?: () => number;
  /** Where `tailscale.exe` is (default: {@link tailscaleExecutable}); null = not installed (tests). */
  executable?: string | null;
}

/** How long one address's answer (a name or none) is kept. */
export const PEER_NAME_CACHE_MS = 5 * 60 * 1000;
/** Addresses kept in the cache at most (a flood of distinct forged addresses stays bounded). */
export const PEER_NAME_CACHE_MAX = 64;
/** Lookups (processes) running at once at most; a further address gets null until one settles. */
export const PEER_NAME_MAX_IN_FLIGHT = 4;
/** The `tailscale whois` call is local and quick; anything slower is treated as no answer. */
export const TAILSCALE_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

/** Where the Tailscale installer puts the CLI on Windows; null when it is not there. */
export function tailscaleExecutable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return null;
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const path = join(programFiles, 'Tailscale', 'tailscale.exe');
  return existsSync(path) ? path : null;
}

/** True for an address Tailscale gives its nodes: 100.64.0.0/10 or fd7a:115c:a1e0::/48. */
export function isTailnetAddress(address: string): boolean {
  if (isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 100 && b !== undefined && b >= 64 && b <= 127;
  }
  if (isIPv6(address)) return address.toLowerCase().startsWith('fd7a:115c:a1e0:');
  return false;
}

/**
 * The name in a `tailscale whois --json` answer: the computer name, else the tailnet machine
 * name, else the MagicDNS name's first label; null when none is a usable label.
 */
export function peerNameFromWhois(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.Node)) return null;
  const node = parsed.Node;
  const hostinfo = isRecord(node.Hostinfo) ? node.Hostinfo : {};
  const candidates = [hostinfo.Hostname, node.ComputedName, magicDnsLabel(node.Name)];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    // Cut to the label's length without leaving half of a surrogate pair behind.
    const label = DeviceLabelSchema.safeParse(candidate.trim().slice(0, DEVICE_LABEL_MAX).replace(/[\uD800-\uDBFF]$/u, ''));
    if (label.success) return label.data;
  }
  return null;
}

function magicDnsLabel(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const first = name.split('.')[0];
  return first === undefined || first === '' ? null : first;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The real runner: `tailscale.exe whois --json <address>` by absolute path, hidden, with a timeout. */
export function createTailscaleRunner(executable: string, timeoutMs = TAILSCALE_TIMEOUT_MS): TailscaleRunner {
  return (address) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(executable, ['whois', '--json', address], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (error: Error | null, output = ''): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) {
          child.kill();
          reject(error);
        } else {
          resolve(output);
        }
      };
      const timer = setTimeout(() => finish(new Error('timed out')), timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) finish(new Error('output too large'));
        else chunks.push(chunk);
      });
      child.on('error', (error) => finish(error));
      child.on('close', (code) => {
        if (code === 0) finish(null, Buffer.concat(chunks).toString('utf8'));
        else finish(new Error(`exit code ${code ?? 'null'}`));
      });
    });
}

export function createPeerNames(options: PeerNamesOptions): PeerNames {
  const { log } = options;
  const now = options.now ?? (() => Date.now());
  let run = options.run ?? null;
  if (run === null) {
    const executable = options.executable === undefined ? tailscaleExecutable() : options.executable;
    if (executable !== null) run = createTailscaleRunner(executable);
    else log.info('Tailscale is not installed here: no name suggestions for PCs that ask to connect');
  }
  const runner = run;
  const cache = new Map<string, { value: string | null; expiresAt: number }>();
  const inFlight = new Map<string, Promise<string | null>>();

  const resolveName = async (address: string): Promise<string | null> => {
    if (runner === null) return null;
    try {
      return peerNameFromWhois(await runner(address));
    } catch (error) {
      log.debug('peer name lookup failed', { reason: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };

  return {
    async lookup(address) {
      const key = address.trim().toLowerCase();
      if (!isTailnetAddress(key)) return null;
      const cached = cache.get(key);
      if (cached !== undefined && cached.expiresAt > now()) return cached.value;
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
      if (inFlight.size >= PEER_NAME_MAX_IN_FLIGHT) {
        log.debug('peer name lookup skipped', { reason: 'too many in flight' });
        return null;
      }
      const promise = resolveName(key).then((value) => {
        inFlight.delete(key);
        if (cache.size >= PEER_NAME_CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.delete(key);
        cache.set(key, { value, expiresAt: now() + PEER_NAME_CACHE_MS });
        return value;
      });
      inFlight.set(key, promise);
      return promise;
    },
  };
}
