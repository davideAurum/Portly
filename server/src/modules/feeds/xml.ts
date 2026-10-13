/**
 * A small, tolerant XML reader for untrusted feed documents (§4.1 d). It builds a tree of
 * elements in one forward pass:
 * - comments, processing instructions and `<!…>` declarations are skipped; a DOCTYPE with an
 *   internal subset (`<!DOCTYPE x [ … ]>`, where entity bombs live) is rejected — entities are
 *   never expanded beyond the predefined and numeric ones;
 * - CDATA sections become text verbatim; other text is entity-decoded with `entities`;
 * - a stray end tag closes the nearest open element of that name (or is ignored), so badly
 *   nested feeds still read; at most {@link MAX_DEPTH} levels are kept open, deeper elements are
 *   flattened into their ancestor (the work per end tag is bounded by the depth, so the pass
 *   stays linear);
 * - element and text counts are capped ({@link MAX_ELEMENTS}, {@link MAX_TEXT_PER_ELEMENT}).
 * Names are lower-cased; `atom:` prefixes are dropped so Atom reads the same with or without one.
 */
import { decodeXML } from 'entities';

export interface XmlElement {
  /** Lower-cased qualified name, e.g. `item`, `content:encoded`, `dc:date`. */
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Direct text content (decoded), capped. */
  text: string;
  /** Raw source of the element's content, kept only for Atom `type="xhtml"` (see {@link XmlOptions}). */
  inner?: string;
}

export class XmlError extends Error {
  override name = 'XmlError';
}

export const MAX_DEPTH = 64;
export const MAX_ELEMENTS = 100_000;
export const MAX_TEXT_PER_ELEMENT = 256 * 1024;

const NAME_END = /[\s/>]/;

function normalizeName(raw: string): string {
  const name = raw.toLowerCase();
  return name.startsWith('atom:') ? name.slice(5) : name;
}

/**
 * Index of the `>` ending the tag that starts at `lt` (a `>` inside a quoted attribute value does
 * not count), or -1. A `<` ends the search even inside quotes — XML attribute values cannot hold
 * one — so a broken tag is scanned only up to the next tag and the whole pass stays linear.
 */
function tagEnd(xml: string, lt: number): number {
  let quote = 0;
  for (let i = lt + 1; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (c === 60) return -1;
    if (quote !== 0) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return i;
    }
  }
  return -1;
}

const ATTR = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const m of source.matchAll(ATTR)) {
    const key = m[1]!.toLowerCase();
    if (key in attrs) continue;
    attrs[key] = decodeXML(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

function appendText(el: XmlElement, text: string): void {
  if (text === '' || el.text.length >= MAX_TEXT_PER_ELEMENT) return;
  const room = MAX_TEXT_PER_ELEMENT - el.text.length;
  el.text += text.length > room ? text.slice(0, room) : text;
}

/** Parses `xml` into a synthetic root element whose children are the document's top-level elements. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  /** Content start offset of open xhtml containers, parallel to `stack` (-1 when not tracked). */
  const innerStart: number[] = [-1];
  let elements = 0;
  let i = 0;
  const n = xml.length;

  while (i < n) {
    const lt = xml.indexOf('<', i);
    const top = stack[stack.length - 1]!;
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) appendText(top, decodeXML(xml.slice(i, textEnd)));
    if (lt === -1) break;

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      appendText(top, xml.slice(lt + 9, end === -1 ? n : end));
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      const decl = xml.slice(lt, end === -1 ? n : end);
      if (/^<!doctype/i.test(decl) && decl.includes('[')) throw new XmlError('DOCTYPE with an internal subset is not allowed');
      if (end === -1) break;
      i = end + 1;
      continue;
    }

    const end = tagEnd(xml, lt);
    if (end === -1) {
      // Not a tag: keep the `<` as text and carry on after it.
      appendText(top, '<');
      i = lt + 1;
      continue;
    }
    const closing = xml.charCodeAt(lt + 1) === 47; // '/'
    const body = xml.slice(lt + (closing ? 2 : 1), end);
    const nameEnd = body.search(NAME_END);
    const rawName = nameEnd === -1 ? body : body.slice(0, nameEnd);
    i = end + 1;
    if (rawName === '') continue;
    const name = normalizeName(rawName);

    if (closing) {
      // Close the nearest open element with this name (bounded by MAX_DEPTH); ignore strays.
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d]!.name === name) {
          const start = innerStart[d]!;
          if (start !== -1) stack[d]!.inner = xml.slice(start, lt);
          stack.length = d;
          innerStart.length = d;
          break;
        }
      }
      continue;
    }

    if (++elements > MAX_ELEMENTS) throw new XmlError('The document has too many elements');
    const selfClosing = body.endsWith('/');
    const el: XmlElement = { name, attrs: parseAttrs(body.slice(rawName.length, selfClosing ? -1 : undefined)), children: [], text: '' };
    top.children.push(el);
    if (!selfClosing && stack.length <= MAX_DEPTH) {
      stack.push(el);
      // Atom xhtml content keeps its markup so it can be converted to text as HTML.
      innerStart.push(el.attrs.type === 'xhtml' ? end + 1 : -1);
    }
  }
  return root;
}

/** First child with one of `names`. */
export function child(el: XmlElement, ...names: string[]): XmlElement | undefined {
  return el.children.find((c) => names.includes(c.name));
}

export function children(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => c.name === name);
}

/** Trimmed direct text of the first child with one of `names` ('' when absent). */
export function childText(el: XmlElement, ...names: string[]): string {
  for (const name of names) {
    const c = child(el, name);
    const text = c?.text.trim();
    if (text) return text;
  }
  return '';
}
