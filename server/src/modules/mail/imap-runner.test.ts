/**
 * IMAP sessions run in a worker thread (DOS-1): imapflow's response tokenizer is super-linear on
 * runs of `[`, reachable from the greeting (before authentication and, for STARTTLS, before TLS).
 * These tests talk to a local hostile TCP "IMAP server" through the real imapflow client.
 */
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSilentLogger, createTestLogger } from '../../lib/logger.ts';
import { createImapProbe, imapHealthHints, mapImapError } from './providers/imap.ts';
import { ImapWorkerError, createWorkerImapRunner } from './providers/imap-runner.ts';
import {
  deserializeImapError,
  ImapAuthError,
  ImapOpError,
  serializeImapError,
  type ImapConnectionParams,
} from './providers/imap-session.ts';

let server: net.Server | null = null;
const sockets = new Set<net.Socket>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

function listen(onSocket: (socket: net.Socket) => void): Promise<number> {
  server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    onSocket(socket);
  });
  return new Promise<number>((resolve) => server?.listen(0, '127.0.0.1', () => resolve((server?.address() as net.AddressInfo).port)));
}

/** A server that answers every connection with `payload`, then hangs up. */
function hostileServer(payload: string): Promise<number> {
  return listen((socket) => {
    socket.write(payload);
    setTimeout(() => socket.destroy(), 200).unref();
  });
}

/** Longest gap between ticks of a 10 ms interval while `fn` runs (main-thread stall). */
async function maxEventLoopLag<T>(fn: () => Promise<T>): Promise<{ lag: number; result: PromiseSettledResult<T> }> {
  let last = performance.now();
  let lag = 0;
  const interval = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - last - 10);
    last = now;
  }, 10);
  const [result] = await Promise.allSettled([fn()]);
  clearInterval(interval);
  return { lag, result: result as PromiseSettledResult<T> };
}

// '* OK [[[[…' costs imapflow ~0.4 s per 60 k segment; four literal-chained segments ≈ 1.5 s of CPU.
const SEGMENT = '['.repeat(60_000);
const QUADRATIC_GREETING = `* OK ${SEGMENT} {0}\r\n${SEGMENT} {0}\r\n${SEGMENT} {0}\r\n${SEGMENT}\r\n`;

describe('IMAP sessions off the main thread', () => {
  it('a hostile pre-TLS greeting cannot stall the event loop (default runner = worker)', async () => {
    const port = await hostileServer(QUADRATIC_GREETING);
    const probe = createImapProbe({ log: createSilentLogger() });
    const { lag, result } = await maxEventLoopLag(() =>
      probe({
        kind: 'imap',
        label: 'x',
        email: null,
        config: { username: 'me', imap: { host: '127.0.0.1', port, security: 'starttls', webmailUrl: null } },
        secret: { password: 'p' },
      }),
    );
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toMatchObject({ code: 'provider_error' });
    // The parse burns ~1.5 s — on the worker. The main thread keeps ticking.
    expect(lag).toBeLessThan(400);
  }, 20_000);

  it('the worker is terminated at the wall-clock cap or when the caller aborts', async () => {
    // Accepts, never greets: imapflow would wait for its 15 s greeting timeout.
    const port = await listen(() => {});
    const params: ImapConnectionParams = { host: '127.0.0.1', port, security: 'tls', username: 'u', password: 'p' };

    const capped = createWorkerImapRunner({ timeoutMs: 500 });
    const started = performance.now();
    await expect(capped(params, { op: 'probe' }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'ETIMEOUT' });
    expect(performance.now() - started).toBeLessThan(5_000);

    const controller = new AbortController();
    const pending = createWorkerImapRunner()(params, { op: 'probe' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toMatchObject({ code: 'ETIMEOUT' });
  }, 20_000);
});

describe('progress and worker failures reach the parent', () => {
  const SCRIPTED = new URL('./__fixtures__/scripted-imap-worker.ts', import.meta.url);
  const params = (host: string): ImapConnectionParams => ({ host, port: 993, security: 'tls', username: 'u', password: 'p' });

  it('the real worker reports its phases: a silent server is stuck at the greeting', async () => {
    // Accepts, never greets (cleartext STARTTLS account: the TCP connection is up, no greeting).
    const port = await listen(() => {});
    const phases: string[] = [];
    const log = createTestLogger();
    const controller = new AbortController();
    const pending = createWorkerImapRunner()(
      { host: '127.0.0.1', port, security: 'starttls', username: 'u', password: 'p' },
      { op: 'probe' },
      { signal: controller.signal, log, onPhase: (phase) => phases.push(phase) },
    );
    await vi.waitFor(() => expect(phases).toContain('greeting'), { timeout: 10_000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ETIMEOUT' });
    expect(phases).toEqual(['connect', 'greeting']);
    const [cancelled] = log.lines().filter((l) => l.msg === 'imap session cancelled');
    expect(cancelled).toMatchObject({ level: 'debug', fields: { by: 'caller', op: 'probe', phase: 'greeting' } });
  }, 20_000);

  it('phase and connection-error messages are validated; connection errors carry codes and flags only', async () => {
    const phases: string[] = [];
    const connectionErrors: Error[] = [];
    const run = createWorkerImapRunner({ workerUrl: SCRIPTED });
    const failure = run(params('messages'), { op: 'probe' }, {
      signal: new AbortController().signal,
      onPhase: (phase) => phases.push(phase),
      onConnectionError: (err) => connectionErrors.push(err),
    });
    await expect(failure).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(phases).toEqual(['connect', 'login']);
    expect(connectionErrors).toHaveLength(1);
    expect({ ...connectionErrors[0] }).toEqual({ code: 'ECONNRESET', tlsFailed: true });
    expect(connectionErrors[0]?.message).toBe('IMAP connection error');
  }, 20_000);

  it.each<[string, string, Record<string, unknown>]>([
    ['crash', 'imap worker failed', { op: 'list', phase: 'greeting', errName: 'Error' }],
    ['exit', 'imap worker stopped unexpectedly', { op: 'list', phase: 'fetch', exitCode: 7 }],
  ])('a worker %s is logged by the parent (name/code only) and is not blamed on the server', async (host, msg, fields) => {
    const log = createTestLogger();
    const run = createWorkerImapRunner({ workerUrl: SCRIPTED });
    const job = { op: 'list' as const, maxMessages: 5, unreadOnly: false, folders: null };
    const err = await run(params(host), job, { signal: new AbortController().signal, log }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImapWorkerError);
    const [line] = log.lines().filter((l) => l.msg === msg);
    expect(line).toMatchObject({ level: 'warn', fields });
    expect(typeof line?.fields.ms).toBe('number');
    const text = JSON.stringify(log.lines());
    expect(text).not.toContain('server said');
    expect(text).not.toContain('someone');

    const mapped = mapImapError(err, 'imap.example.net', 'y1', false);
    expect(mapped).toMatchObject({ code: 'provider_error', message: expect.stringContaining('stopped unexpectedly') });
    expect(imapHealthHints(mapped)).toMatchObject({ code: 'worker_failed' });
  }, 20_000);

  it('a worker that cannot start is logged and rejected as ImapWorkerError(start)', async () => {
    const log = createTestLogger();
    const run = createWorkerImapRunner({ workerUrl: new URL('https://example.com/worker.js') });
    const err = await run(params('x'), { op: 'probe' }, { signal: new AbortController().signal, log }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ImapWorkerError', reason: 'start' });
    expect(log.lines().filter((l) => l.msg === 'imap worker could not start')[0]).toMatchObject({ level: 'warn', fields: { op: 'probe', errName: 'TypeError' } });
  });
});

describe('session errors cross the thread boundary without server text', () => {
  it('round-trips auth, op and imapflow errors', () => {
    expect(deserializeImapError(serializeImapError(new ImapAuthError('x')))).toBeInstanceOf(ImapAuthError);

    const op = deserializeImapError(serializeImapError(new ImapOpError(409, 'conflict', 'The mailbox changed', { reason: 'stale_message' })));
    expect(op).toBeInstanceOf(ImapOpError);
    expect(op).toMatchObject({ status: 409, code: 'conflict', message: 'The mailbox changed', details: { reason: 'stale_message' } });

    const raw = Object.assign(new Error('NO [UNAVAILABLE] secret server text'), {
      authenticationFailed: true,
      serverResponseCode: 'UNAVAILABLE',
      responseText: 'secret server text',
      code: 'ECONNRESET',
    });
    const serialized = serializeImapError(raw);
    expect(serialized).toEqual({ kind: 'imap', fields: { code: 'ECONNRESET', authenticationFailed: true, serverResponseCode: 'UNAVAILABLE' } });
    expect(JSON.stringify(serialized)).not.toContain('secret');
    expect(deserializeImapError(serialized).message).not.toContain('secret');
  });
});
