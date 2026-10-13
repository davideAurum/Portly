/**
 * Tests for the native messaging host native-host/launcher.mjs (docs/setup/autostart.md):
 * framing, origin checks, request validation, the health check, the schtasks runner and its
 * error mapping, and an end-to-end run through launcher.cmd exactly as Chrome starts it
 * (cmd.exe /d /s /c). Nothing here runs or changes a scheduled task: the task runner is always
 * a fake (in the end-to-end runs, scripts/tests/schtasks-stub.mjs replaces schtasks.exe), and the
 * only real schtasks.exe call is a read-only /query of a task that does not exist.
 *
 *   node scripts/check-native-host.mjs
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  HOST_NAME,
  MAX_MESSAGE_BYTES,
  TASK_PATH,
  checkHealth,
  classifyTaskRun,
  createTaskRunner,
  defaultSchtasksPath,
  encodeFrame,
  handleRequest,
  loadConfig,
  parseRequest,
  probeHealth,
  readFrame,
  run,
  safeDetail,
} from '../../native-host/launcher.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hostDir = path.join(repoRoot, 'native-host');
const testDir = path.join(repoRoot, 'scripts', 'tests');
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
const CONFIG = { allowedOrigins: [ORIGIN] };
const isWindows = process.platform === 'win32';

/** A frame: 4-byte LE length + bytes (JSON-encoded unless a Buffer/string is given). */
function frame(value, { length } = {}) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(length ?? body.length, 0);
  return Buffer.concat([header, body]);
}

/** Decodes every frame in a buffer; fails on trailing garbage. */
function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    assert.ok(buffer.length - offset >= 4, 'truncated length prefix in the output');
    const length = buffer.readUInt32LE(offset);
    assert.ok(buffer.length - offset - 4 >= length, 'truncated frame in the output');
    frames.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString('utf8')));
    offset += 4 + length;
  }
  return frames;
}

function collector() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { stream, bytes: () => Buffer.concat(chunks) };
}

/** Runs launcher.run() with fakes; returns the response, the decoded output frames and the calls. */
async function runLauncher({ input, argv = [ORIGIN, '--parent-window=0'], config = CONFIG, healthy = false, taskResult, readTimeoutMs = 2000, endInput = false } = {}) {
  const stdin = new PassThrough();
  const out = collector();
  const calls = { health: [], task: 0, log: [] };
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-launcher-log-'));
  try {
    const promise = run({
      argv,
      stdin,
      stdout: out.stream,
      configPath: 'unused',
      logPath: path.join(logDir, 'launcher.log'),
      loadConfigImpl: () => {
        if (config instanceof Error) throw config;
        return config;
      },
      checkHealthImpl: async (port) => {
        calls.health.push(port);
        return healthy;
      },
      runTask: async () => {
        calls.task++;
        return taskResult ?? { error: null, stdout: 'SUCCESS: Attempted to run the scheduled task "\\Portly Server".', stderr: '' };
      },
      readTimeoutMs,
    });
    if (input !== undefined) stdin.write(input);
    if (endInput) stdin.end();
    const response = await promise;
    const frames = decodeFrames(out.bytes());
    const logFile = path.join(logDir, 'launcher.log');
    calls.log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : [];
    return { response, frames, calls };
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}

const TASK_MISSING = {
  error: Object.assign(new Error('Command failed'), { code: 1 }),
  stdout: '',
  stderr: 'ERROR: The system cannot find the file specified.\r\n',
};

// ---------------------------------------------------------------------------------------------

describe('framing', () => {
  it('encodes a 4-byte little-endian length followed by UTF-8 JSON', () => {
    const encoded = encodeFrame({ ok: true, state: 'pong', version: 1, text: 'h\u00e9' });
    const body = Buffer.from('{"ok":true,"state":"pong","version":1,"text":"h\u00e9"}', 'utf8');
    assert.equal(encoded.readUInt32LE(0), body.length);
    assert.deepEqual(encoded.subarray(4), body);
  });

  it('reads a frame delivered in one chunk and ignores bytes after it', async () => {
    const stream = new PassThrough();
    stream.write(Buffer.concat([frame({ action: 'ping' }), Buffer.from('trailing')]));
    const result = await readFrame(stream, { timeoutMs: 1000 });
    assert.equal(result.ok, true);
    assert.equal(result.body.toString('utf8'), '{"action":"ping"}');
  });

  it('reads a frame delivered one byte at a time (length prefix split too)', async () => {
    const stream = new PassThrough();
    const bytes = frame({ action: 'start', port: 5757 });
    const pending = readFrame(stream, { timeoutMs: 2000 });
    for (const byte of bytes) {
      stream.write(Buffer.from([byte]));
      await new Promise((resolve) => setImmediate(resolve));
    }
    const result = await pending;
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.body.toString('utf8')), { action: 'start', port: 5757 });
  });

  it('refuses an oversized frame from its length prefix without waiting for the body', async () => {
    const stream = new PassThrough();
    stream.write(frame('', { length: MAX_MESSAGE_BYTES + 1 }));
    const started = Date.now();
    const result = await readFrame(stream, { timeoutMs: 3000 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'oversized');
    assert.match(result.detail, /65537 bytes is larger than 65536/);
    assert.ok(Date.now() - started < 1000);
  });

  it('accepts a frame of exactly the maximum size', async () => {
    const stream = new PassThrough();
    const text = JSON.stringify({ action: 'ping', pad: '' });
    const padded = text.replace('""', `"${'x'.repeat(MAX_MESSAGE_BYTES - text.length)}"`);
    assert.equal(Buffer.byteLength(padded), MAX_MESSAGE_BYTES);
    stream.write(frame(padded));
    const result = await readFrame(stream, { timeoutMs: 1000 });
    assert.equal(result.ok, true);
    assert.equal(result.body.length, MAX_MESSAGE_BYTES);
  });

  it('reports a zero-length frame', async () => {
    const stream = new PassThrough();
    stream.write(frame('', { length: 0 }));
    const result = await readFrame(stream, { timeoutMs: 1000 });
    assert.deepEqual([result.ok, result.reason], [false, 'empty']);
  });

  it('reports input that ends inside the length prefix', async () => {
    const stream = new PassThrough();
    stream.end(Buffer.from([5, 0]));
    const result = await readFrame(stream, { timeoutMs: 1000 });
    assert.deepEqual([result.ok, result.reason], [false, 'short']);
    assert.match(result.detail, /2 of 4 length bytes/);
  });

  it('reports input that ends inside the body', async () => {
    const stream = new PassThrough();
    stream.end(frame('{"action":"ping"}').subarray(0, 10));
    const result = await readFrame(stream, { timeoutMs: 1000 });
    assert.deepEqual([result.ok, result.reason], [false, 'short']);
    assert.match(result.detail, /6 of 17 message bytes/);
  });

  it('reports empty input', async () => {
    const stream = new PassThrough();
    stream.end();
    const result = await readFrame(stream, { timeoutMs: 1000 });
    assert.deepEqual([result.ok, result.reason], [false, 'short']);
  });

  it('times out when the message never completes', async () => {
    const stream = new PassThrough();
    stream.write(frame('{"action":"ping"}').subarray(0, 6));
    const result = await readFrame(stream, { timeoutMs: 100 });
    assert.deepEqual([result.ok, result.reason], [false, 'timeout']);
  });

  it('reports a read error', async () => {
    const stream = new PassThrough();
    const pending = readFrame(stream, { timeoutMs: 1000 });
    stream.destroy(new Error('pipe broke'));
    const result = await pending;
    assert.equal(result.ok, false);
    assert.ok(['read_error', 'short'].includes(result.reason), result.reason);
  });
});

describe('request validation', () => {
  const parse = (value) => parseRequest(Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));

  it('accepts ping and start with a port from 1024 to 65535', () => {
    assert.deepEqual(parse({ action: 'ping' }), { ok: true, request: { action: 'ping' } });
    assert.deepEqual(parse({ action: 'start', port: 5757 }), { ok: true, request: { action: 'start', port: 5757 } });
    assert.deepEqual(parse({ action: 'start', port: 1024 }).request, { action: 'start', port: 1024 });
    assert.deepEqual(parse({ action: 'start', port: 65535 }).request, { action: 'start', port: 65535 });
    assert.deepEqual(parse({ action: 'start', port: 5757, extra: 'ignored' }).request, { action: 'start', port: 5757 });
  });

  for (const [name, value, pattern] of [
    ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d]), /UTF-8/],
    ['invalid JSON', '{"action":', /not valid JSON/],
    ['a JSON array', '[1]', /JSON object/],
    ['JSON null', 'null', /JSON object/],
    ['a JSON string', '"ping"', /JSON object/],
    ['no action', {}, /action must be/],
    ['an unknown action', { action: 'stop' }, /action must be/],
    ['an action with different case', { action: 'START', port: 5757 }, /action must be/],
    ['an inherited action', '{"__proto__":{"action":"ping"}}', /action must be/],
    ['start without a port', { action: 'start' }, /port must be/],
    ['a port given as a string', { action: 'start', port: '5757' }, /port must be/],
    ['a fractional port', { action: 'start', port: 5757.5 }, /port must be/],
    ['port 1023', { action: 'start', port: 1023 }, /port must be/],
    ['port 65536', { action: 'start', port: 65536 }, /port must be/],
    ['a negative port', { action: 'start', port: -1 }, /port must be/],
    ['port null', { action: 'start', port: null }, /port must be/],
  ]) {
    it(`rejects ${name}`, () => {
      const result = parse(value);
      assert.equal(result.ok, false);
      assert.match(result.detail, pattern);
    });
  }
});

describe('configuration', () => {
  it('loads allowedOrigins (a UTF-8 BOM is tolerated)', () => {
    const text = `\uFEFF${JSON.stringify({ version: 1, allowedOrigins: [ORIGIN] })}`;
    assert.deepEqual(loadConfig('x', () => text), { allowedOrigins: [ORIGIN] });
  });

  for (const [name, value] of [
    ['no allowedOrigins', { version: 1 }],
    ['an empty list', { allowedOrigins: [] }],
    ['a wildcard', { allowedOrigins: ['chrome-extension://*/'] }],
    ['a missing trailing slash', { allowedOrigins: [`chrome-extension://${EXTENSION_ID}`] }],
    ['an ID with letters outside a-p', { allowedOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnoz/'] }],
    ['an upper-case ID', { allowedOrigins: [`chrome-extension://${EXTENSION_ID.toUpperCase()}/`] }],
    ['a web origin', { allowedOrigins: ['https://example.com/'] }],
  ]) {
    it(`rejects ${name}`, () => {
      assert.throws(() => loadConfig('x', () => JSON.stringify(value)));
    });
  }

  it('throws when the file is missing', () => {
    assert.throws(() => loadConfig(path.join(os.tmpdir(), `portly-missing-${process.pid}.json`)));
  });
});

describe('origin checks', () => {
  it('answers bad_origin for an origin that is not allowed, before reading anything', async () => {
    const { response, frames, calls } = await runLauncher({ argv: ['chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/'] });
    assert.equal(response.error, 'bad_origin');
    assert.deepEqual(frames, [response]);
    assert.deepEqual([calls.health.length, calls.task], [0, 0]);
  });

  for (const [name, argv] of [
    ['no origin argument', []],
    ['an origin without the trailing slash', [`chrome-extension://${EXTENSION_ID}`]],
    ['an upper-case origin', [ORIGIN.toUpperCase()]],
    ['the parent-window flag in place of the origin', ['--parent-window=0', ORIGIN]],
  ]) {
    it(`rejects ${name}`, async () => {
      const { response, calls } = await runLauncher({ argv, input: frame({ action: 'start', port: 5757 }) });
      assert.deepEqual([response.ok, response.state, response.error], [false, 'error', 'bad_origin']);
      assert.equal(calls.task, 0);
    });
  }

  it('answers bad_origin when config.json is missing or invalid', async () => {
    const { response } = await runLauncher({ config: new Error('ENOENT'), input: frame({ action: 'ping' }) });
    assert.equal(response.error, 'bad_origin');
    assert.match(response.detail, /install-autostart\.ps1/);
  });

  it('handleRequest treats a missing config as bad_origin', async () => {
    const response = await handleRequest({ origin: ORIGIN, config: null, readMessage: async () => assert.fail('must not read') });
    assert.equal(response.error, 'bad_origin');
  });
});

describe('requests', () => {
  it('answers ping with pong and protocol version 1 without checking health or running the task', async () => {
    const { response, frames, calls } = await runLauncher({ input: frame({ action: 'ping' }) });
    assert.deepEqual(response, { ok: true, state: 'pong', version: 1 });
    assert.deepEqual(frames, [response]);
    assert.deepEqual([calls.health.length, calls.task], [0, 0]);
    assert.ok(calls.log[0].endsWith(` ${ORIGIN} ping -> pong`), calls.log[0]);
  });

  it('answers running when Portly already answers, without running the task', async () => {
    const { response, calls } = await runLauncher({ input: frame({ action: 'start', port: 5800 }), healthy: true });
    assert.deepEqual(response, { ok: true, state: 'running' });
    assert.deepEqual(calls.health, [5800]);
    assert.equal(calls.task, 0);
  });

  it('runs the task once and answers starting when Portly is not up', async () => {
    const { response, frames, calls } = await runLauncher({ input: frame({ action: 'start', port: 5757 }) });
    assert.deepEqual(response, { ok: true, state: 'starting' });
    assert.deepEqual(frames, [response]);
    assert.deepEqual(calls.health, [5757]);
    assert.equal(calls.task, 1);
    assert.match(calls.log[0], / start port=5757 -> starting$/);
  });

  it('answers task_missing when the scheduled task does not exist', async () => {
    const { response } = await runLauncher({ input: frame({ action: 'start', port: 5757 }), taskResult: TASK_MISSING });
    assert.deepEqual([response.ok, response.state, response.error], [false, 'error', 'task_missing']);
    assert.match(response.detail, /install-autostart\.ps1/);
  });

  it('answers schtasks_failed with the first line of the output', async () => {
    const { response } = await runLauncher({
      input: frame({ action: 'start', port: 5757 }),
      taskResult: { error: Object.assign(new Error('Command failed'), { code: 1 }), stdout: '', stderr: '\r\nERROR: Access is denied.\r\n' },
    });
    assert.deepEqual(response, { ok: false, state: 'error', error: 'schtasks_failed', detail: 'ERROR: Access is denied.' });
  });

  it('answers bad_request for an invalid request and never runs the task', async () => {
    for (const input of [frame({ action: 'start', port: 80 }), frame('nope'), frame('', { length: MAX_MESSAGE_BYTES + 1 })]) {
      const { response, frames, calls } = await runLauncher({ input });
      assert.equal(response.error, 'bad_request');
      assert.equal(frames.length, 1);
      assert.equal(calls.task, 0);
    }
  });

  it('answers bad_request for a short read', async () => {
    const { response } = await runLauncher({ input: frame({ action: 'ping' }).subarray(0, 7), endInput: true });
    assert.equal(response.error, 'bad_request');
    assert.match(response.detail, /input ended/);
  });

  it('answers bad_request when no request arrives in time', async () => {
    const { response } = await runLauncher({ readTimeoutMs: 100 });
    assert.equal(response.error, 'bad_request');
    assert.match(response.detail, /no complete request/);
  });

  it('turns an unexpected exception into one error response', async () => {
    const stdin = new PassThrough();
    const out = collector();
    stdin.write(frame({ action: 'start', port: 5757 }));
    const response = await run({
      argv: [ORIGIN],
      stdin,
      stdout: out.stream,
      logPath: null,
      loadConfigImpl: () => CONFIG,
      checkHealthImpl: async () => {
        throw new Error('boom');
      },
      runTask: async () => assert.fail('must not run'),
    });
    assert.deepEqual(response, { ok: false, state: 'error', error: 'schtasks_failed', detail: 'launcher error: boom' });
    assert.deepEqual(decodeFrames(out.bytes()), [response]);
  });
});

describe('schtasks', () => {
  it('runs %SystemRoot%\\System32\\schtasks.exe /run /tn "\\Portly Server" with no shell and a hidden window', async () => {
    const seen = [];
    const runner = createTaskRunner({
      schtasksPath: defaultSchtasksPath({ SystemRoot: 'D:\\Windows' }),
      execFileImpl: (file, args, options, callback) => {
        seen.push({ file, args, options });
        callback(null, 'SUCCESS: Attempted to run the scheduled task "\\Portly Server".\r\n', '');
      },
    });
    const result = await runner();
    assert.equal(result.error, null);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].file, 'D:\\Windows\\System32\\schtasks.exe');
    assert.deepEqual(seen[0].args, ['/run', '/tn', '\\Portly Server']);
    assert.equal(TASK_PATH, '\\Portly Server');
    assert.equal(seen[0].options.windowsHide, true);
    assert.equal(seen[0].options.shell, false);
    assert.equal(seen[0].options.timeout, 10_000);
    assert.deepEqual(classifyTaskRun(result), { ok: true, state: 'starting' });
  });

  it('only uses a drive-rooted SystemRoot', () => {
    assert.equal(defaultSchtasksPath({ SystemRoot: 'C:\\WINDOWS' }), 'C:\\WINDOWS\\System32\\schtasks.exe');
    assert.equal(defaultSchtasksPath({ windir: 'E:\\Win' }), 'E:\\Win\\System32\\schtasks.exe');
    assert.equal(defaultSchtasksPath({ SystemRoot: 'relative\\dir' }), 'C:\\Windows\\System32\\schtasks.exe');
    assert.equal(defaultSchtasksPath({ SystemRoot: '\\\\server\\share' }), 'C:\\Windows\\System32\\schtasks.exe');
    assert.equal(defaultSchtasksPath({}), 'C:\\Windows\\System32\\schtasks.exe');
  });

  it('resolves (does not throw) when execFile throws synchronously', async () => {
    const runner = createTaskRunner({
      execFileImpl: () => {
        throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
      },
    });
    const result = await runner();
    assert.equal(classifyTaskRun(result).error, 'schtasks_failed');
  });

  it('maps schtasks results', () => {
    assert.equal(classifyTaskRun(TASK_MISSING).error, 'task_missing');
    assert.equal(classifyTaskRun({ error: { code: 1 }, stdout: 'ERROR: 0x80070002', stderr: '' }).error, 'task_missing');
    assert.deepEqual(classifyTaskRun({ error: { code: 'ENOENT' } }), {
      ok: false,
      state: 'error',
      error: 'schtasks_failed',
      detail: 'schtasks.exe was not found',
    });
    assert.equal(classifyTaskRun({ error: { killed: true, signal: 'SIGTERM' } }).detail, 'schtasks.exe did not finish in time');
    assert.equal(classifyTaskRun({ error: { code: 2 }, stdout: '', stderr: '' }).detail, 'schtasks.exe failed (exit code 2)');
    assert.equal(classifyTaskRun({ error: { code: 1 }, stdout: '', stderr: 'ERROR: The task has been disabled.' }).error, 'schtasks_failed');
  });

  it('treats "already running" from schtasks as starting (the task is up; Portly is on its way)', () => {
    const starting = { ok: true, state: 'starting' };
    assert.deepEqual(classifyTaskRun({ error: { code: 1 }, stdout: '', stderr: 'ERROR: An instance of this task is already running.' }), starting);
    assert.deepEqual(classifyTaskRun({ error: { code: 1 }, stdout: 'ERROR: 0x8004131F', stderr: '' }), starting);
    assert.deepEqual(classifyTaskRun({ error: { code: 1 }, stdout: 'error: 0x8004131f', stderr: '' }), starting);
  });

  it('keeps details short and on one line', () => {
    assert.equal(safeDetail('a\r\nb\u0000c\u2028d\ufffde'), 'a b c d e');
    assert.equal(safeDetail('x'.repeat(500)).length, 200);
    assert.equal(safeDetail(undefined), '');
  });

  it('recognizes the real "task not found" output of schtasks.exe on this machine (read-only /query)', { skip: !isWindows }, async () => {
    const missingTask = `\\Portly-check-missing-${process.pid}-${Date.now()}`;
    const result = await new Promise((resolve) => {
      execFile(defaultSchtasksPath(), ['/query', '/tn', missingTask], { windowsHide: true, timeout: 10_000 }, (error, stdout, stderr) =>
        resolve({ error, stdout: String(stdout), stderr: String(stderr) }),
      );
    });
    assert.ok(result.error, 'querying a task that does not exist must fail');
    if (!/^ERROR:/m.test(`${result.stderr}${result.stdout}`)) {
      // Localized Windows: the message is translated, so only the generic mapping applies.
      assert.equal(classifyTaskRun(result).ok, false);
      return;
    }
    assert.equal(classifyTaskRun(result).error, 'task_missing', `${result.stderr}${result.stdout}`);
  });
});

describe('health check', () => {
  const servers = {};
  before(async () => {
    const listen = (handler) =>
      new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
      });
    const json = (status, body) => (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    servers.ok = await listen((req, res) => {
      if (req.url !== '/api/health') {
        res.writeHead(404);
        res.end();
        return;
      }
      json(200, { ok: true, version: '9.9.9', vault: 'ready' })(req, res);
    });
    servers.notOk = await listen(json(200, { ok: false }));
    servers.okString = await listen(json(200, { ok: 'true' }));
    servers.error = await listen(json(503, { ok: true }));
    servers.html = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Other app</title>');
    });
    servers.huge = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`{"ok":true,"pad":"${'x'.repeat(64 * 1024)}"}`);
    });
    servers.hang = await listen(() => {
      // never answers
    });
  });
  after(() => {
    for (const server of Object.values(servers)) {
      server.closeAllConnections?.();
      server.close();
    }
  });
  const portOf = (name) => servers[name].address().port;

  it('accepts a Portly answer on 127.0.0.1', async () => {
    assert.equal(await probeHealth('127.0.0.1', portOf('ok')), true);
    assert.equal(await checkHealth(portOf('ok')), true);
  });

  for (const name of ['notOk', 'okString', 'error', 'html', 'huge']) {
    it(`rejects ${name}`, async () => {
      assert.equal(await checkHealth(portOf(name)), false);
    });
  }

  it('gives up after the timeout', async () => {
    const started = Date.now();
    assert.equal(await checkHealth(portOf('hang'), { timeoutMs: 300 }), false);
    assert.ok(Date.now() - started < 2000);
  });

  it('reports a closed port as not running within the timeout', async () => {
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const started = Date.now();
    assert.equal(await checkHealth(port), false);
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  });

  it('answers true as soon as one host answers, and false when every probe fails', async () => {
    const order = [];
    const probe = (host) =>
      new Promise((resolve) => {
        order.push(host);
        setTimeout(() => resolve(host === 'localhost'), host === 'localhost' ? 10 : 500);
      });
    const started = Date.now();
    assert.equal(await checkHealth(5757, { probe }), true);
    assert.ok(Date.now() - started < 400);
    assert.deepEqual(order, ['127.0.0.1', 'localhost']);
    assert.equal(await checkHealth(5757, { probe: async () => false }), false);
    assert.equal(await checkHealth(5757, { probe: async () => Promise.reject(new Error('x')) }), false);
  });
});

// ---------------------------------------------------------------------------------------------

describe('launcher.cmd end to end (cmd.exe /d /s /c, as Chrome runs native hosts)', { skip: !isWindows }, () => {
  let dir;
  let server;
  let stubLog;
  /** A port where nothing listens (taken from the OS, then released). */
  let closedPort;
  before(async () => {
    stubLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portly-schtasks-stub-')), 'calls.jsonl');
    closedPort = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    // Spaces, an ampersand, parentheses, a caret and a non-ASCII letter: the folder sits in the
    // user's profile, whose name may contain any of them ("Jos\u00e9 (Work)").
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly native-host & t\u00e9st (1) ^x '));
    fs.copyFileSync(path.join(hostDir, 'launcher.mjs'), path.join(dir, 'launcher.mjs'));
    const template = fs.readFileSync(path.join(hostDir, 'launcher.cmd'), 'utf8');
    assert.equal(template.split('{{NODE_EXE}}').length, 2, 'the template has exactly one {{NODE_EXE}} placeholder');
    fs.writeFileSync(path.join(dir, 'launcher.cmd'), template.replace('{{NODE_EXE}}', process.execPath.replaceAll('%', '%%')), 'latin1');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1, allowedOrigins: [ORIGIN] }));
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });
  after(() => {
    server?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (stubLog) fs.rmSync(path.dirname(stubLog), { recursive: true, force: true });
  });

  /** The schtasks.exe calls the launcher made in the last callHost() (through the stub). */
  function schtasksCalls() {
    if (!fs.existsSync(stubLog)) return [];
    return fs
      .readFileSync(stubLog, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  }

  /**
   * Starts launcher.cmd like Chrome, writes one frame and keeps stdin open (as Chrome does).
   * schtasks.exe is always replaced by scripts/tests/schtasks-stub.mjs (preloaded through
   * NODE_OPTIONS, which reaches node through launcher.cmd like the browser's environment), so a
   * test never runs the real "Portly Server" task; `schtasks` picks the stub's answer.
   */
  function callHost(origin, message, { endInput = false, schtasks = 'success' } = {}) {
    fs.rmSync(stubLog, { force: true });
    return new Promise((resolve, reject) => {
      const cmdPath = path.join(dir, 'launcher.cmd');
      const env = { ...process.env };
      for (const name of Object.keys(env)) if (name.toUpperCase() === 'NODE_OPTIONS') delete env[name];
      env.NODE_OPTIONS = `--import=${pathToFileURL(path.join(testDir, 'schtasks-stub.mjs')).href}`;
      env.PORTLY_TEST_SCHTASKS = schtasks;
      env.PORTLY_TEST_SCHTASKS_LOG = stubLog;
      const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${cmdPath}" ${origin} --parent-window=0"`], {
        windowsVerbatimArguments: true,
        windowsHide: true,
        env,
      });
      const out = [];
      const err = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('the host did not exit within 15 s'));
      }, 15_000);
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.stderr.on('data', (chunk) => err.push(chunk));
      child.on('error', reject);
      child.on('exit', (code) => {
        clearTimeout(timer);
        child.stdin.destroy();
        resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
      });
      child.stdin.on('error', () => {});
      if (endInput) child.stdin.end(message);
      else child.stdin.write(message);
    });
  }

  it('answers ping with exactly one frame and nothing else on stdout, then exits 0', async () => {
    const result = await callHost(ORIGIN, frame({ action: 'ping' }));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(decodeFrames(result.stdout), [{ ok: true, state: 'pong', version: 1 }]);
    assert.match(fs.readFileSync(path.join(dir, 'launcher.log'), 'utf8'), / ping -> pong/);
  });

  it('answers running for a port where Portly answers, without running schtasks', async () => {
    const result = await callHost(ORIGIN, frame({ action: 'start', port: server.address().port }));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(decodeFrames(result.stdout), [{ ok: true, state: 'running' }]);
    assert.deepEqual(schtasksCalls(), []);
  });

  it('runs %SystemRoot%\\System32\\schtasks.exe /run /tn "\\Portly Server" and answers starting when nothing answers yet', async () => {
    const result = await callHost(ORIGIN, frame({ action: 'start', port: closedPort }));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(decodeFrames(result.stdout), [{ ok: true, state: 'starting' }]);
    const calls = schtasksCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file.toLowerCase(), defaultSchtasksPath().toLowerCase());
    assert.match(calls[0].file, /^[A-Za-z]:\\.+\\System32\\schtasks\.exe$/i);
    assert.deepEqual(calls[0].args, ['/run', '/tn', TASK_PATH]);
    assert.match(fs.readFileSync(path.join(dir, 'launcher.log'), 'utf8'), new RegExp(` start port=${closedPort} -> starting`));
  });

  it('answers task_missing when schtasks reports that the task does not exist', async () => {
    const result = await callHost(ORIGIN, frame({ action: 'start', port: closedPort }), { schtasks: 'missing' });
    assert.equal(result.code, 0, result.stderr);
    const frames = decodeFrames(result.stdout);
    assert.equal(frames.length, 1);
    assert.deepEqual([frames[0].ok, frames[0].state, frames[0].error], [false, 'error', 'task_missing']);
    assert.equal(schtasksCalls().length, 1);
  });

  it('answers schtasks_failed with schtasks.exe\'s message when it refuses', async () => {
    const result = await callHost(ORIGIN, frame({ action: 'start', port: closedPort }), { schtasks: 'denied' });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(decodeFrames(result.stdout), [{ ok: false, state: 'error', error: 'schtasks_failed', detail: 'ERROR: Access is denied.' }]);
  });

  it('refuses another extension without reading its request or running schtasks', async () => {
    const result = await callHost('chrome-extension://pppppppppppppppppppppppppppppppp/', frame({ action: 'start', port: closedPort }));
    assert.equal(result.code, 0, result.stderr);
    const [response] = decodeFrames(result.stdout);
    assert.equal(response.error, 'bad_origin');
    assert.deepEqual(schtasksCalls(), []);
  });

  it('answers bad_request and exits 0 when the browser closes stdin before a whole request', async () => {
    const result = await callHost(ORIGIN, frame({ action: 'ping' }).subarray(0, 6), { endInput: true });
    assert.equal(result.code, 0, result.stderr);
    const frames = decodeFrames(result.stdout);
    assert.equal(frames.length, 1);
    assert.deepEqual([frames[0].ok, frames[0].error], [false, 'bad_request']);
    assert.equal(result.stderr, '');
  });

  it('is named com.portly.launcher', () => {
    assert.equal(HOST_NAME, 'com.portly.launcher');
  });
});
