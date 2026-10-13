/**
 * CalDAV XML parse worker (§4.9, DOS-2): runs tsdav's own multistatus parsing (xml-js) on a
 * response body the main thread already fetched, so a hostile server's XML never costs the main
 * thread's event loop anything. Started by dav-xml.ts with `resourceLimits` and a wall-clock
 * timeout. A linear pre-scan rejects absurd nesting before xml-js sees it (unclosed nested
 * elements are what make xml-js slow).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { davRequest } from 'tsdav';
import { MAX_DAV_XML_DEPTH, xmlNestingDepth, type DavXmlJob, type DavXmlResult } from './dav-xml-scan.ts';

const job = workerData as DavXmlJob;

async function parse(): Promise<DavXmlResult> {
  if (xmlNestingDepth(job.text, MAX_DAV_XML_DEPTH) > MAX_DAV_XML_DEPTH) {
    return { ok: false, reason: 'limit', message: 'The CalDAV server sent XML that is nested too deeply' };
  }
  const responses = await davRequest({
    url: job.url,
    init: { method: 'GET', headers: {}, body: undefined },
    // The body was fetched (with every §4.8 check) on the main thread; hand it to tsdav as-is.
    fetch: (async () => {
      const response = new Response(job.text, { status: job.status, headers: { 'content-type': job.contentType } });
      Object.defineProperty(response, 'url', { value: job.url });
      return response;
    }) as typeof globalThis.fetch,
  });
  return {
    ok: true,
    responses: responses.map((r) => ({
      href: r.href,
      status: r.status,
      ok: r.ok,
      props: r.props,
    })),
  };
}

let result: DavXmlResult;
try {
  result = await parse();
} catch {
  result = { ok: false, reason: 'error', message: 'The CalDAV server sent an unexpected response' };
}
parentPort?.postMessage(result);
