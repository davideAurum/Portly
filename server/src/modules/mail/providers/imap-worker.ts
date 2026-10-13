/**
 * IMAP session worker (see imap-runner.ts): connects with imapflow, runs one job and posts
 * `{ok: true, output}` or `{ok: false, error}` (a {@link SerializedImapError}). On the way it posts
 * `{phase}` for each step the session enters and `{connectionError: fields}` for imapflow's
 * connection-level 'error' events (codes and flags only, {@link imapErrorFields}). Every server
 * response is parsed on this thread, never on the server's main thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createImapClient } from './imap-client.ts';
import {
  imapErrorFields,
  runImapJob,
  runImapSession,
  serializeImapError,
  type ImapConnectionParams,
  type ImapJob,
  type ImapPhase,
} from './imap-session.ts';

const { params, job } = workerData as { params: ImapConnectionParams; job: ImapJob };

const onPhase = (phase: ImapPhase): void => parentPort?.postMessage({ phase });
const onConnectionError = (err: Error): void => parentPort?.postMessage({ connectionError: imapErrorFields(err) });

try {
  const output = await runImapSession(createImapClient, params, { onPhase, onConnectionError }, (client, report) => runImapJob(client, job, report));
  parentPort?.postMessage({ ok: true, output });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: serializeImapError(err) });
}
