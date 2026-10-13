/**
 * CalDAV requests whose XML answers are parsed off the main thread (§4.9, DOS-2).
 *
 * tsdav's `davRequest` both builds the request body (from our own trusted objects) and parses the
 * multistatus answer with xml-js — which is very slow on hostile input (unclosed nested elements
 * cost seconds per MB). {@link davCall} keeps tsdav building and sending the request on the main
 * thread through the account's safe transport (createDavFetch: credential origins, DOCTYPE
 * rejection, size caps), captures the answer text, and hands it to a worker that runs tsdav's own
 * parsing with `resourceLimits` and a wall-clock timeout. Href/origin checks stay with the caller.
 * The worker is spawned in the caller's log context (§3); a parse that ends without a
 * result (crash, exit, timeout, start failure) is logged by the parent with codes only.
 */
import { Worker } from 'node:worker_threads';
import { davRequest } from 'tsdav';
import type { Logger } from '../../../lib/logger.ts';
import { logWorkerFailure } from '../workers.ts';
import type { DavParsedResponse, DavXmlJob, DavXmlResult } from './dav-xml-scan.ts';

export type { DavParsedResponse } from './dav-xml-scan.ts';

export const DAV_XML_TIMEOUT_MS = 5_000;
export const DAV_XML_MAX_OLD_GENERATION_MB = 256;

const WORKER_URL = new URL('./dav-xml-worker.ts', import.meta.url);

export type DavXmlParser = (job: DavXmlJob) => Promise<DavXmlResult>;

export interface DavXmlParserOptions {
  timeoutMs?: number;
  maxOldGenerationSizeMb?: number;
  workerUrl?: URL;
  /** Logs parses that end without a result (`calendar worker failed`). */
  log?: Logger;
}

type DavXmlFailure = Extract<DavXmlResult, { ok: false }>;

function isDavXmlResult(value: unknown): value is DavXmlResult {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { ok?: unknown; responses?: unknown; reason?: unknown; message?: unknown };
  if (v.ok === true) return Array.isArray(v.responses);
  return v.ok === false && typeof v.reason === 'string' && typeof v.message === 'string';
}

export function createDavXmlParser(options: DavXmlParserOptions = {}): DavXmlParser {
  const timeoutMs = options.timeoutMs ?? DAV_XML_TIMEOUT_MS;
  const { log } = options;
  return (job) => {
    const started = Date.now();
    const failed = (result: DavXmlFailure, failure: { exitCode?: number; err?: unknown }): DavXmlFailure => {
      logWorkerFailure(log, 'dav-xml', { reason: result.reason, ...failure, ms: Date.now() - started, bytes: Buffer.byteLength(job.text) });
      return result;
    };
    return new Promise<DavXmlResult>((resolve) => {
      let settled = false;
      let worker: Worker;
      try {
        worker = new Worker(options.workerUrl ?? WORKER_URL, {
          workerData: job,
          resourceLimits: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb ?? DAV_XML_MAX_OLD_GENERATION_MB },
          stdout: true,
          stderr: true,
        });
      } catch (err) {
        resolve(failed({ ok: false, reason: 'error', message: 'The CalDAV response could not be read' }, { err }));
        return;
      }
      worker.stdout.resume();
      worker.stderr.resume();
      const finish = (result: DavXmlResult, failure?: { exitCode?: number; err?: unknown }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate().catch(() => {});
        resolve(failure !== undefined && !result.ok ? failed(result, failure) : result);
      };
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', message: 'The CalDAV server’s response took too long to read' }, {}), timeoutMs);
      timer.unref();
      worker.on('message', (message: unknown) => {
        if (isDavXmlResult(message)) finish(message);
      });
      worker.once('error', (err: Error & { code?: string }) =>
        finish(
          {
            ok: false,
            reason: err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'limit' : 'error',
            message: 'The CalDAV response could not be read',
          },
          { err },
        ),
      );
      worker.once('exit', (exitCode: number) => finish({ ok: false, reason: 'error', message: 'The CalDAV response could not be read' }, { exitCode }));
    });
  };
}

/** Parser without failure logging (callers without a logger). */
export const parseDavXmlInWorker: DavXmlParser = createDavXmlParser();

/** Thrown when the answer could not be parsed (message is generic, never server text). */
export class DavParseError extends Error {
  override name = 'DavParseError';
  readonly reason: 'limit' | 'timeout' | 'error';
  constructor(reason: 'limit' | 'timeout' | 'error', message: string) {
    super(message);
    this.reason = reason;
  }
}

export type DavRequestParams = Parameters<typeof davRequest>[0];

/**
 * `davRequest` with the answer parsed in a worker: tsdav builds and sends the request through
 * `params.fetch`; the answer text is captured and parsed by `parse` (default: a worker).
 */
export async function davCall(params: DavRequestParams & { fetch: typeof globalThis.fetch }, parse: DavXmlParser = parseDavXmlInWorker): Promise<DavParsedResponse[]> {
  const transport = params.fetch;
  let captured: DavXmlJob | null = null;
  await davRequest({
    ...params,
    fetch: (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const response = await transport(input, init);
      const text = await response.text();
      captured = {
        url: response.url || params.url,
        text,
        status: response.status,
        contentType: response.headers.get('content-type') ?? 'application/xml',
      };
      // An empty non-XML answer makes tsdav return at once without parsing anything here.
      return new Response(null, { status: response.status === 204 ? 204 : 200, headers: { 'content-type': 'text/plain' } });
    }) as typeof globalThis.fetch,
  });
  if (captured === null) throw new DavParseError('error', 'The CalDAV request was not sent');
  const result = await parse(captured);
  if (!result.ok) throw new DavParseError(result.reason, result.message);
  return result.responses;
}
