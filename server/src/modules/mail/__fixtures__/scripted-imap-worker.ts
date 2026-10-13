/**
 * A stand-in IMAP worker (imap-runner tests): instead of connecting it follows a script chosen by
 * `params.host`, to exercise the runner's message handling and its worker failure paths.
 * - `messages`: posts phases (one of them unknown), a connection error with an extra field, then
 *   a serialized error;
 * - `crash`: reports a phase, then throws (the runner sees the worker's 'error' event);
 * - `exit`: reports a phase, then exits without a result.
 */
import { parentPort, workerData } from 'node:worker_threads';

const { params } = workerData as { params: { host: string } };

switch (params.host) {
  case 'messages':
    parentPort?.postMessage({ phase: 'connect' });
    parentPort?.postMessage({ phase: 'not-a-phase' });
    parentPort?.postMessage({ phase: 'login' });
    parentPort?.postMessage({ connectionError: { code: 'ECONNRESET', tlsFailed: true, text: 'server said me@example.com' } });
    parentPort?.postMessage({ ok: false, error: { kind: 'imap', fields: { code: 'ECONNRESET' } } });
    break;
  case 'crash':
    parentPort?.postMessage({ phase: 'greeting' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    throw Object.assign(new Error('server said me@example.com at C:\\Users\\someone\\x'), { code: 'ERR_TEST_CRASH' });
  case 'exit':
    parentPort?.postMessage({ phase: 'fetch' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.exit(7);
    break;
  default:
    break;
}
