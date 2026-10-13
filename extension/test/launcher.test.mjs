/** lib/launcher.js: the native-messaging client and its reading of the launcher contract. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LAUNCHER_HOST,
  PING_STATUS,
  START_KIND,
  START_KINDS_THAT_STOP,
  classifyNativeError,
  cleanDetail,
  createLauncher,
  interpretPingReply,
  interpretStartReply,
  sendNative,
  startRequest,
} from '../lib/launcher.js';
import { NATIVE_ERRORS, createNativeRuntime, createTimers, flush } from './helpers.mjs';

describe('requests', () => {
  it('match the shared contract exactly', () => {
    assert.equal(LAUNCHER_HOST, 'com.portly.launcher');
    assert.deepEqual(startRequest(5757), { action: 'start', port: 5757 });
    assert.throws(() => startRequest(80), RangeError);
    assert.throws(() => startRequest('5757'), RangeError);
  });
});

describe('sendNative', () => {
  it('uses the callback form and returns the response', async () => {
    const runtime = createNativeRuntime({ response: { ok: true, state: 'pong', version: 1 } });
    const reply = await sendNative(runtime, { action: 'ping' });
    assert.deepEqual(reply, { response: { ok: true, state: 'pong', version: 1 } });
    assert.deepEqual(runtime.calls, [{ host: 'com.portly.launcher', message: { action: 'ping' } }]);
  });

  it('reads runtime.lastError inside the callback', async () => {
    const runtime = createNativeRuntime({ error: NATIVE_ERRORS.notFound });
    assert.deepEqual(await sendNative(runtime, { action: 'ping' }), { error: NATIVE_ERRORS.notFound });
    assert.equal(runtime.lastError, undefined);
  });

  it('turns a synchronous throw into an error reply', async () => {
    const runtime = createNativeRuntime('throw');
    assert.deepEqual(await sendNative(runtime, { action: 'ping' }), {
      error: 'Error in invocation of runtime.sendNativeMessage',
    });
  });

  it('gives up after the timeout and ignores a late answer', async () => {
    const runtime = createNativeRuntime('hang');
    const timers = createTimers();
    const pending = sendNative(runtime, { action: 'ping' }, { timeoutMs: 1000, ...timers });
    await timers.advance(999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();
    assert.equal(settled, false);
    await timers.advance(1);
    assert.deepEqual(await pending, { error: 'The launcher did not answer in time.', timedOut: true });
    runtime.answer({ response: { ok: true, state: 'pong', version: 1 } });
    await flush();
    assert.equal(timers.pending, 0);
  });
});

describe('classifyNativeError', () => {
  it('maps the browser messages per the contract', () => {
    assert.equal(classifyNativeError(NATIVE_ERRORS.notFound), START_KIND.notInstalled);
    assert.equal(classifyNativeError(NATIVE_ERRORS.forbidden), START_KIND.mismatch);
    assert.equal(classifyNativeError(NATIVE_ERRORS.exited), START_KIND.maybe);
    assert.equal(classifyNativeError(NATIVE_ERRORS.failedToStart), START_KIND.maybe);
    assert.equal(classifyNativeError('Error when communicating with the native messaging host.'), START_KIND.maybe);
    assert.equal(classifyNativeError('SPECIFIED NATIVE MESSAGING HOST NOT FOUND.'), START_KIND.notInstalled);
  });
});

describe('interpretStartReply', () => {
  const cases = [
    [{ response: { ok: true, state: 'running' } }, { kind: 'running', code: null, detail: '' }],
    [{ response: { ok: true, state: 'starting' } }, { kind: 'starting', code: null, detail: '' }],
    [
      { response: { ok: false, state: 'error', error: 'task_missing', detail: 'The task "\\Portly Server" does not exist.' } },
      { kind: 'task_missing', code: 'task_missing', detail: 'The task "\\Portly Server" does not exist.' },
    ],
    [
      { response: { ok: false, state: 'error', error: 'schtasks_failed', detail: 'exit code 1' } },
      { kind: 'failed', code: 'schtasks_failed', detail: 'exit code 1' },
    ],
    [
      { response: { ok: false, state: 'error', error: 'bad_request', detail: 'port out of range' } },
      { kind: 'failed', code: 'bad_request', detail: 'port out of range' },
    ],
    [
      { response: { ok: false, state: 'error', error: 'bad_origin', detail: 'origin not allowed' } },
      { kind: 'mismatch', code: 'bad_origin', detail: 'origin not allowed' },
    ],
    [{ response: { ok: false, state: 'error', error: 'something_new' } }, { kind: 'failed', code: 'something_new', detail: '' }],
    [{ response: { ok: false } }, { kind: 'failed', code: 'unknown', detail: '' }],
    [{ error: NATIVE_ERRORS.notFound }, { kind: 'not_installed', code: 'not_installed', detail: NATIVE_ERRORS.notFound }],
    [{ error: NATIVE_ERRORS.forbidden }, { kind: 'mismatch', code: 'mismatch', detail: NATIVE_ERRORS.forbidden }],
    [{ error: NATIVE_ERRORS.exited }, { kind: 'maybe', code: 'host_error', detail: NATIVE_ERRORS.exited }],
    [{ error: NATIVE_ERRORS.failedToStart }, { kind: 'maybe', code: 'host_error', detail: NATIVE_ERRORS.failedToStart }],
    [{ error: 'late', timedOut: true }, { kind: 'maybe', code: 'timeout', detail: 'late' }],
  ];
  for (const [reply, expected] of cases) {
    it(`${JSON.stringify(reply)} → ${expected.kind}`, () => assert.deepEqual(interpretStartReply(reply), expected));
  }

  it('treats anything else as "maybe started" (keep polling)', () => {
    for (const response of [undefined, null, 'starting', [], { ok: true }, { ok: true, state: 'pong' }, { ok: 'yes' }]) {
      assert.equal(interpretStartReply({ response }).kind, START_KIND.maybe, JSON.stringify(response));
    }
  });

  it('stops polling only for outcomes where nothing was started', () => {
    assert.deepEqual([...START_KINDS_THAT_STOP].sort(), ['failed', 'mismatch', 'not_installed', 'task_missing']);
  });
});

describe('interpretPingReply', () => {
  it('reports installed with the protocol version', () => {
    assert.deepEqual(interpretPingReply({ response: { ok: true, state: 'pong', version: 1 } }), {
      status: PING_STATUS.installed,
      version: 1,
      detail: '',
    });
    assert.equal(interpretPingReply({ response: { ok: true, state: 'pong' } }).version, null);
  });

  it('reports not installed, mismatch and broken', () => {
    assert.equal(interpretPingReply({ error: NATIVE_ERRORS.notFound }).status, PING_STATUS.notInstalled);
    assert.equal(interpretPingReply({ error: NATIVE_ERRORS.forbidden }).status, PING_STATUS.mismatch);
    assert.equal(interpretPingReply({ response: { ok: false, state: 'error', error: 'bad_origin' } }).status, PING_STATUS.mismatch);
    assert.deepEqual(interpretPingReply({ error: NATIVE_ERRORS.exited }), {
      status: PING_STATUS.broken,
      version: null,
      detail: NATIVE_ERRORS.exited,
    });
    assert.deepEqual(interpretPingReply({ response: { ok: false, state: 'error', error: 'bad_request', detail: 'nope' } }), {
      status: PING_STATUS.broken,
      version: null,
      detail: 'bad_request: nope',
    });
    assert.equal(interpretPingReply({ response: 'pong' }).status, PING_STATUS.broken);
  });
});

describe('cleanDetail', () => {
  it('keeps one readable line of at most 200 characters', () => {
    assert.equal(cleanDetail('  a\r\n\tb\u0000c  '), 'a b c');
    assert.equal(cleanDetail('task\u202edeliaf\u2028next\u2066x\u2069'), 'task deliaf next x', 'bidi overrides and separators');
    assert.equal(cleanDetail(42), '');
    const long = cleanDetail('x'.repeat(500));
    assert.equal(long.length, 200);
    assert.ok(long.endsWith('…'));
  });
});

describe('createLauncher', () => {
  it('is null without runtime.sendNativeMessage', () => {
    assert.equal(createLauncher(undefined), null);
    assert.equal(createLauncher(null), null);
    assert.equal(createLauncher({ id: 'x' }), null);
  });

  it('start(port) sends {action:"start", port} and interprets the reply', async () => {
    const runtime = createNativeRuntime({ response: { ok: true, state: 'starting' } });
    const launcher = createLauncher(runtime);
    assert.deepEqual(await launcher.start(6001), { kind: 'starting', code: null, detail: '' });
    assert.deepEqual(runtime.calls, [{ host: 'com.portly.launcher', message: { action: 'start', port: 6001 } }]);
  });

  it('start() never sends an invalid port', async () => {
    const runtime = createNativeRuntime({ response: { ok: true, state: 'starting' } });
    const outcome = await createLauncher(runtime).start(80);
    assert.equal(outcome.kind, START_KIND.failed);
    assert.equal(outcome.code, 'bad_request');
    assert.equal(runtime.calls.length, 0);
  });

  it('ping() sends {action:"ping"} and times out after 10 s by default', async () => {
    const runtime = createNativeRuntime('hang');
    const timers = createTimers();
    const pending = createLauncher(runtime, timers).ping();
    assert.deepEqual(runtime.calls, [{ host: 'com.portly.launcher', message: { action: 'ping' } }]);
    await timers.advance(10000);
    assert.deepEqual(await pending, {
      status: PING_STATUS.broken,
      version: null,
      detail: 'The launcher did not answer in time.',
    });
  });
});
