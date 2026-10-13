#!/usr/bin/env node
/**
 * Homebase native messaging host "com.homebase.launcher" (docs/setup/autostart.md).
 *
 * Chrome/Edge start it (through launcher.cmd) when the Homebase new-tab extension calls
 * chrome.runtime.sendNativeMessage('com.homebase.launcher', request). It handles exactly one
 * request and exits:
 *
 *   {"action":"ping"}               -> {"ok":true,"state":"pong","version":1}
 *   {"action":"start","port":5757}  -> {"ok":true,"state":"running"}   /api/health already answers
 *                                   -> {"ok":true,"state":"starting"}  "schtasks /run" succeeded (or
 *                                                                      said the task already runs)
 *   anything else / failures        -> {"ok":false,"state":"error","error":"task_missing" |
 *                                      "schtasks_failed" | "bad_request" | "bad_origin","detail":"..."}
 *
 * Wire format (both directions): 4-byte little-endian length, then that many bytes of UTF-8 JSON.
 * Requests over 64 KB are refused without reading them.
 *
 * The server is never started here. The only thing this host runs is
 * %SystemRoot%\System32\schtasks.exe /run /tn "\Homebase Server" (absolute path, no shell, fixed
 * arguments - nothing from the message reaches a command line), so the Task Scheduler service
 * creates the server process. Anything started as a child of this host would die with it:
 * Chrome's isolated-browser mode runs native hosts in a kill-on-close job object, and libuv puts
 * Node's own children in one as well. The task's "MultipleInstances IgnoreNew" setting and the
 * server's exit code 3 (port taken) make repeated or concurrent starts harmless.
 *
 * The caller's origin (argv[0] after the script, "chrome-extension://<id>/") must be listed in
 * config.json next to this file, written by scripts\install-autostart.ps1 from the extension's
 * pinned "key". Browsers already enforce allowed_origins; this is a second check.
 *
 * No dependencies. Every side effect is injectable for tests (scripts/tests/native-host-launcher.test.mjs).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST_NAME = 'com.homebase.launcher';
export const PROTOCOL_VERSION = 1;
/** Task Scheduler path of the task registered by scripts\install-autostart.ps1. */
export const TASK_PATH = '\\Homebase Server';
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const READ_TIMEOUT_MS = 5_000;
export const HEALTH_TIMEOUT_MS = 700;
export const SCHTASKS_TIMEOUT_MS = 10_000;
export const MAX_DETAIL_LENGTH = 200;
const MAX_HEALTH_BYTES = 16 * 1024;
const MAX_LOG_BYTES = 64 * 1024;
/** The only origins a config may allow: an extension ID is 32 letters a-p. */
export const ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}\/$/;
/** schtasks' text for ERROR_FILE_NOT_FOUND (English Windows) or the HRESULT itself. */
const TASK_MISSING_PATTERN = /cannot find the file specified|0x80070002/i;
/**
 * schtasks' text for SCHED_E_ALREADY_RUNNING (English Windows) or the HRESULT itself. With
 * "MultipleInstances IgnoreNew" a run request for a running task is normally accepted and ignored;
 * should schtasks report it as an error instead, the task is running, so Homebase is on its way.
 */
const ALREADY_RUNNING_PATTERN = /already running|0x8004131F/i;
const INSTALL_HINT = 'run scripts\\install-autostart.ps1';

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

/** One line of printable text, at most MAX_DETAIL_LENGTH characters. */
export function safeDetail(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffd]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 3)}...` : text;
}

export function errorResponse(error, detail) {
  return { ok: false, state: 'error', error, detail: safeDetail(detail) };
}

// ---------------------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------------------

/** 4-byte little-endian length + UTF-8 JSON. */
export function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Reads one framed message. Resolves {ok: true, body} or {ok: false, reason, detail} with reason
 * 'empty' | 'oversized' | 'short' | 'timeout' | 'read_error'. Stops reading as soon as the frame
 * is complete (the browser keeps the pipe open) and never reads the body of an oversized frame.
 */
export function readFrame(stream, { maxBytes = MAX_MESSAGE_BYTES, timeoutMs = READ_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0);
    let expected = -1;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onError);
      if (typeof stream.pause === 'function') stream.pause();
      resolve(result);
    };
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')]);
      if (expected < 0 && buffered.length >= 4) {
        expected = buffered.readUInt32LE(0);
        if (expected === 0) {
          finish({ ok: false, reason: 'empty', detail: 'empty message' });
          return;
        }
        if (expected > maxBytes) {
          finish({ ok: false, reason: 'oversized', detail: `message of ${expected} bytes is larger than ${maxBytes} bytes` });
          return;
        }
      }
      if (expected > 0 && buffered.length >= 4 + expected) {
        finish({ ok: true, body: buffered.subarray(4, 4 + expected) });
      }
    };
    const onEnd = () => {
      const detail =
        expected < 0
          ? `input ended after ${buffered.length} of 4 length bytes`
          : `input ended after ${buffered.length - 4} of ${expected} message bytes`;
      finish({ ok: false, reason: 'short', detail });
    };
    const onError = (err) => finish({ ok: false, reason: 'read_error', detail: `could not read the request: ${err?.message ?? err}` });
    const timer = setTimeout(
      () => finish({ ok: false, reason: 'timeout', detail: `no complete request within ${timeoutMs} ms` }),
      timeoutMs,
    );

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('close', onEnd);
    stream.on('error', onError);
    if (typeof stream.resume === 'function') stream.resume();
  });
}

// ---------------------------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------------------------

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** {ok: true, request: {action: 'ping'} | {action: 'start', port}} or {ok: false, detail}. */
export function parseRequest(body) {
  let text;
  try {
    text = utf8.decode(body);
  } catch {
    return { ok: false, detail: 'the request is not valid UTF-8' };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, detail: 'the request is not valid JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, detail: 'the request must be a JSON object' };
  }
  const action = Object.hasOwn(value, 'action') ? value.action : undefined;
  if (action === 'ping') return { ok: true, request: { action: 'ping' } };
  if (action === 'start') {
    const port = Object.hasOwn(value, 'port') ? value.port : undefined;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
      return { ok: false, detail: 'port must be an integer from 1024 to 65535' };
    }
    return { ok: true, request: { action: 'start', port } };
  }
  return { ok: false, detail: 'action must be "start" or "ping"' };
}

// ---------------------------------------------------------------------------------------------
// Configuration (config.json next to this file, written by install-autostart.ps1)
// ---------------------------------------------------------------------------------------------

/** {allowedOrigins: string[]}; throws when the file is missing or malformed. */
export function loadConfig(file, readFile = fs.readFileSync) {
  const raw = JSON.parse(String(readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  const origins = raw !== null && typeof raw === 'object' ? raw.allowedOrigins : undefined;
  if (!Array.isArray(origins) || origins.length === 0 || !origins.every((o) => typeof o === 'string' && ORIGIN_PATTERN.test(o))) {
    throw new Error('allowedOrigins must list chrome-extension://<id>/ origins');
  }
  return { allowedOrigins: [...origins] };
}

// ---------------------------------------------------------------------------------------------
// Health check: GET http://127.0.0.1:<port>/api/health and http://localhost:<port>/api/health
// ---------------------------------------------------------------------------------------------

/** True when http://<host>:<port>/api/health answers 200 with a JSON object whose ok is true. */
export function probeHealth(host, port, { timeoutMs = HEALTH_TIMEOUT_MS, get = http.get } = {}) {
  return new Promise((resolve) => {
    let request;
    let done = false;
    const finish = (healthy) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        request?.destroy();
      } catch {
        // ignore
      }
      resolve(healthy);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      request = get({ host, port, path: '/api/health', agent: false, headers: { accept: 'application/json' } }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(false);
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_HEALTH_BYTES) finish(false);
          else chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(body !== null && typeof body === 'object' && body.ok === true);
          } catch {
            finish(false);
          }
        });
        response.on('error', () => finish(false));
      });
      request.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/** Probes 127.0.0.1 and localhost in parallel; true as soon as either answers as Homebase. */
export function checkHealth(port, { timeoutMs = HEALTH_TIMEOUT_MS, hosts = ['127.0.0.1', 'localhost'], probe = probeHealth } = {}) {
  return new Promise((resolve) => {
    let pending = hosts.length;
    if (pending === 0) {
      resolve(false);
      return;
    }
    for (const host of hosts) {
      Promise.resolve()
        .then(() => probe(host, port, { timeoutMs }))
        .catch(() => false)
        .then((healthy) => {
          if (healthy) resolve(true);
          else if (--pending === 0) resolve(false);
        });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// schtasks.exe /run /tn "\Homebase Server"
// ---------------------------------------------------------------------------------------------

/** %SystemRoot%\System32\schtasks.exe (only a drive-rooted SystemRoot/windir is accepted). */
export function defaultSchtasksPath(env = process.env) {
  const root = [env.SystemRoot, env.SYSTEMROOT, env.windir, env.WINDIR].find(
    (value) => typeof value === 'string' && /^[a-zA-Z]:\\[^"<>|?*\u0000-\u001f]*$/.test(value),
  );
  return path.win32.join(root ?? 'C:\\Windows', 'System32', 'schtasks.exe');
}

/**
 * Returns runTask(): runs schtasks by absolute path with fixed arguments (no shell, hidden
 * window) and resolves {error, stdout, stderr} - error is null on exit code 0.
 */
export function createTaskRunner({ execFileImpl = execFile, schtasksPath = defaultSchtasksPath(), timeoutMs = SCHTASKS_TIMEOUT_MS } = {}) {
  return () =>
    new Promise((resolve) => {
      try {
        execFileImpl(
          schtasksPath,
          ['/run', '/tn', TASK_PATH],
          { windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8' },
          (error, stdout, stderr) => resolve({ error: error ?? null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
        );
      } catch (error) {
        resolve({ error, stdout: '', stderr: '' });
      }
    });
}

/** Maps a schtasks result to the response. */
export function classifyTaskRun({ error, stdout = '', stderr = '' }) {
  if (!error) return { ok: true, state: 'starting' };
  const output = `${stderr}\n${stdout}`;
  if (error.code === 'ENOENT') return errorResponse('schtasks_failed', 'schtasks.exe was not found');
  if (error.killed || error.signal) return errorResponse('schtasks_failed', 'schtasks.exe did not finish in time');
  if (ALREADY_RUNNING_PATTERN.test(output)) return { ok: true, state: 'starting' };
  if (TASK_MISSING_PATTERN.test(output)) {
    return errorResponse('task_missing', `The "Homebase Server" scheduled task is not installed - ${INSTALL_HINT}`);
  }
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) return errorResponse('schtasks_failed', firstLine);
  const code = typeof error.code === 'number' ? `exit code ${error.code}` : safeDetail(error.message ?? error.code ?? 'unknown error');
  return errorResponse('schtasks_failed', `schtasks.exe failed (${code})`);
}

// ---------------------------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------------------------

/**
 * Handles one request. config is {allowedOrigins} or an Error (missing/unreadable config.json).
 * readMessage() resolves like readFrame(); checkHealth(port) resolves a boolean; runTask()
 * resolves like createTaskRunner()().
 */
export async function handleRequest({ origin, config, readMessage, checkHealth: isHealthy, runTask }) {
  if (!config || config instanceof Error) {
    return errorResponse('bad_origin', `the launcher configuration is missing or invalid - ${INSTALL_HINT}`);
  }
  if (typeof origin !== 'string' || !config.allowedOrigins.includes(origin)) {
    return errorResponse('bad_origin', `the caller is not the Homebase extension this launcher was installed for - ${INSTALL_HINT}`);
  }
  const frame = await readMessage();
  if (!frame.ok) return errorResponse('bad_request', frame.detail);
  const parsed = parseRequest(frame.body);
  if (!parsed.ok) return errorResponse('bad_request', parsed.detail);
  const { request } = parsed;
  if (request.action === 'ping') return { ok: true, state: 'pong', version: PROTOCOL_VERSION };
  if (await isHealthy(request.port)) return { ok: true, state: 'running' };
  return classifyTaskRun(await runTask());
}

function describeOutcome(response) {
  if (response.ok) return response.state;
  return `error ${response.error}: ${response.detail}`;
}

/** Appends one line to launcher.log (renamed to launcher.log.1 past 64 KB). Never throws. */
export function appendLog(file, line, fsImpl = fs) {
  if (!file) return;
  try {
    try {
      if (fsImpl.statSync(file).size > MAX_LOG_BYTES) fsImpl.renameSync(file, `${file}.1`);
    } catch {
      // no log yet
    }
    fsImpl.appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    // Logging is best effort.
  }
}

/**
 * Reads one request from stdin, writes exactly one framed response to stdout and resolves it.
 * Every dependency can be replaced (tests); the defaults are the real ones.
 */
export async function run({
  argv = process.argv.slice(2),
  stdin = process.stdin,
  stdout = process.stdout,
  baseDir = path.dirname(fileURLToPath(import.meta.url)),
  configPath = path.join(baseDir, 'config.json'),
  logPath = path.join(baseDir, 'launcher.log'),
  loadConfigImpl = loadConfig,
  checkHealthImpl = checkHealth,
  runTask = createTaskRunner(),
  readTimeoutMs = READ_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  const origin = argv[0];
  let config;
  try {
    config = loadConfigImpl(configPath);
  } catch (error) {
    config = error instanceof Error ? error : new Error(String(error));
  }
  let action = '-';
  let response;
  try {
    response = await handleRequest({
      origin,
      config,
      readMessage: async () => {
        const frame = await readFrame(stdin, { timeoutMs: readTimeoutMs });
        if (frame.ok) {
          const parsed = parseRequest(frame.body);
          if (parsed.ok) action = parsed.request.action === 'start' ? `start port=${parsed.request.port}` : parsed.request.action;
        }
        return frame;
      },
      checkHealth: (port) => checkHealthImpl(port),
      runTask,
    });
  } catch (error) {
    response = errorResponse('schtasks_failed', `launcher error: ${error instanceof Error ? error.message : String(error)}`);
  }
  const caller = typeof origin === 'string' ? safeDetail(origin).slice(0, 64) : '(none)';
  appendLog(logPath, `${now().toISOString()} ${caller} ${action} -> ${describeOutcome(response)}`);
  await new Promise((resolve) => {
    try {
      stdout.write(encodeFrame(response), () => resolve());
    } catch {
      resolve();
    }
  });
  return response;
}

function isMainModule() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync.native(entry).toLowerCase() === fs.realpathSync.native(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // The browser may close the pipes at any time (tab closed, browser quitting): an EPIPE then
  // must not become an uncaught exception with a stack trace.
  process.stdout.on('error', () => process.exit(0));
  process.stdin.on('error', () => {});
  // Never keep the browser's request hanging, whatever happens.
  const watchdog = setTimeout(() => process.exit(0), 30_000);
  run().finally(() => {
    clearTimeout(watchdog);
    process.exit(0);
  });
}
