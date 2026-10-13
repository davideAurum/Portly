/**
 * Shared types of the CalDAV XML parse worker (dav-xml.ts / dav-xml-worker.ts) and a linear-time
 * nesting-depth scan run before xml-js (worker-safe: no imports).
 */

/** Deeper XML is rejected before parsing (legitimate multistatus documents nest < 20 levels). */
export const MAX_DAV_XML_DEPTH = 256;

export interface DavXmlJob {
  /** Request URL (tsdav reports it as the href of non-multistatus answers). */
  url: string;
  text: string;
  status: number;
  contentType: string;
}

/** tsdav's `DAVResponse` without `raw` (the whole parsed document). */
export interface DavParsedResponse {
  href?: string | undefined;
  status: number;
  ok: boolean;
  props?: Record<string, any> | undefined;
}

export type DavXmlResult =
  | { ok: true; responses: DavParsedResponse[] }
  | { ok: false; reason: 'limit' | 'timeout' | 'error'; message: string };

/**
 * Maximum element nesting depth of `xml`; stops as soon as it exceeds `limit`. One forward pass
 * (comments, CDATA, processing instructions and quoted attribute values are skipped), so it is
 * linear in the input whatever the input is.
 */
export function xmlNestingDepth(xml: string, limit = Number.POSITIVE_INFINITY): number {
  const n = xml.length;
  let depth = 0;
  let max = 0;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    const closing = xml.charCodeAt(lt + 1) === 47; // '/'
    let j = lt + 1;
    let quote = 0;
    while (j < n) {
      const c = xml.charCodeAt(j);
      if (quote !== 0) {
        if (c === quote) quote = 0;
      } else if (c === 34 || c === 39) {
        quote = c;
      } else if (c === 62) {
        break; // '>'
      }
      j++;
    }
    if (j >= n) break;
    const selfClosing = !closing && xml.charCodeAt(j - 1) === 47;
    if (closing) {
      depth = Math.max(0, depth - 1);
    } else if (!selfClosing) {
      depth++;
      if (depth > max) {
        max = depth;
        if (max > limit) return max;
      }
    }
    i = j + 1;
  }
  return max;
}
