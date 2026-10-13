/**
 * Linear-time HTML handling for untrusted documents (§4.1 b, §4.4, §4.8): fetched pages (site
 * meta, favicon links), uploaded Netscape bookmark files and provider/feed event descriptions
 * (Google, Microsoft Graph, ICS/CalDAV).
 *
 * node-html-parser builds a whole tree and re-nests unclosed elements, which takes super-linear
 * time on hostile input (measured: 10 000 unclosed `<div>`s — 50 KB — keep it busy for about two
 * minutes, blocking every request of the server). Attacker-controlled documents are therefore
 * never handed to it whole. {@link scanTags} walks the document once instead:
 * - a tag is `<name …>` with no `<` or `>` inside, so a failed match stops at the next `<`;
 * - comments are skipped to `-->` (an unterminated comment ends the document, as in browsers);
 * - raw-text elements (script, style, title, textarea, …) are skipped to their end tag and their
 *   raw text is reported with the tag (an unterminated one runs to the end of the document).
 * Every search starts where the previous one ended, so the total work is O(n). Callers then parse
 * only the few tags they need, one at a time, with node-html-parser ({@link parseTag}), which is
 * linear for a single tag and does the attribute/entity decoding. {@link htmlToPlainText} turns a
 * document into plain text on top of the scanner, also in linear time.
 */
import { decodeHTML } from 'entities';
import { parse, type HTMLElement } from 'node-html-parser';

export interface HtmlTag {
  /** Lower-cased tag name (`!--` for a comment when comments are requested). */
  name: string;
  closing: boolean;
  /** Source of the tag itself, e.g. `<link rel="icon" href="/a.png">`. */
  source: string;
  /** Offset of the tag's `<`. */
  start: number;
  /** Offset just past the tag's `>` (for raw-text elements: past their end tag; comments: past `-->`). */
  end: number;
  /** Raw, undecoded text of a raw-text element (`<title>`, `<script>`, …). */
  text?: string;
}

export interface ScanOptions {
  /**
   * Also yield comments (name `!--`, `end` past the `-->`, or the end of the document for an
   * unterminated one) so callers that read the text between tags can skip them.
   */
  comments?: boolean;
}

/** Elements whose content is text, not markup (HTML "raw text" and "escapable raw text" elements). */
export const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'title',
  'textarea',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
]);

const TAG_SOURCE = '<(?:(!--)|(/?)([a-zA-Z][a-zA-Z0-9:_-]*)(?=[\\s/>])[^<>]*>)';

/** Yields the tags of `html` in document order (see module docs). */
export function* scanTags(
  html: string,
  rawText: ReadonlySet<string> = RAW_TEXT_ELEMENTS,
  options: ScanOptions = {},
): Generator<HtmlTag> {
  const re = new RegExp(TAG_SOURCE, 'g');
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    if (m[1]) {
      const close = html.indexOf('-->', m.index + 4);
      if (options.comments) {
        yield { name: '!--', closing: false, source: '<!--', start: m.index, end: close === -1 ? html.length : close + 3 };
      }
      if (close === -1) return;
      re.lastIndex = close + 3;
      continue;
    }
    const closing = m[2] === '/';
    const name = m[3]!.toLowerCase();
    const tag: HtmlTag = { name, closing, source: m[0], start: m.index, end: re.lastIndex };
    if (!closing && rawText.has(name)) {
      // `name` is one of the fixed raw-text element names (letters only).
      const endTag = new RegExp(`</${name}(?=[\\s/>])[^<>]*>`, 'gi');
      endTag.lastIndex = tag.end;
      const close = endTag.exec(html);
      if (!close) {
        tag.text = html.slice(tag.end);
        tag.end = html.length;
        yield tag;
        return;
      }
      tag.text = html.slice(tag.end, close.index);
      tag.end = endTag.lastIndex;
      re.lastIndex = tag.end;
    }
    yield tag;
  }
}

/** Parses one scanned start tag (attributes and entities decoded by node-html-parser), or null. */
export function parseTag(source: string): HTMLElement | null {
  const root = parse(source, { lowerCaseTagName: true, comment: false });
  for (const node of root.childNodes) {
    if (node.nodeType === 1) return node as HTMLElement;
  }
  return null;
}

/** Longest raw text span decoded for a title (titles are capped far below this). */
export const MAX_RAW_TEXT = 16 * 1024;

/** Markup inside a text span (inline tags) is dropped; the caller decodes entities. */
export function stripTags(raw: string): string {
  return raw.replace(/<[^<>]*>/g, '');
}

// ---------------------------------------------------------------------------
// HTML → plain text
// ---------------------------------------------------------------------------

/** Elements that start and end a line of text. */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html', 'legend',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);
/** Elements whose whole content is not text (raw-text elements are skipped by the scanner already). */
const HIDDEN_ELEMENTS: ReadonlySet<string> = new Set(['svg', 'math', 'template', 'object', 'select', 'datalist', 'map']);
/** Longest tag source parsed for a link's `href` (longer ones keep their text, lose the URL). */
const MAX_LINK_TAG = 8 * 1024;
/** At most this many links get their URL parsed (each is a small node-html-parser call). */
const MAX_PARSED_LINKS = 256;
/** Longest link text searched for its own URL. */
const MAX_LINK_TEXT_SEARCH = 16 * 1024;

export interface PlainTextOptions {
  /**
   * Stop converting once about this many characters of text were produced (the caller caps the
   * result precisely). Default 64 K.
   */
  maxChars?: number;
  /** Longest input read (the rest is ignored). Default 1 M characters. */
  maxInputChars?: number;
  /** Append ` (url)` to link text that does not already show its http(s) URL. Default true. */
  linkUrls?: boolean;
}

/** Characters trimmed at the ends of converted lines (space, tab, NBSP). */
export function isLineSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0xa0;
}

/** Trims spaces/tabs/NBSPs at both ends by index scanning (never a backtracking `\s+$` regex). */
export function trimLineSpace(line: string): string {
  let start = 0;
  let end = line.length;
  while (start < end && isLineSpace(line.charCodeAt(start))) start++;
  while (end > start && isLineSpace(line.charCodeAt(end - 1))) end--;
  return start === 0 && end === line.length ? line : line.slice(start, end);
}

/** Line-trims, then drops blank lines at the start and end (linear). */
function finishText(text: string): string {
  const lines = text.split('\n').map(trimLineSpace);
  let first = 0;
  let last = lines.length;
  while (first < last && lines[first] === '') first++;
  while (last > first && lines[last - 1] === '') last--;
  return lines.slice(first, last).join('\n');
}

/**
 * HTML → plain text in linear time (see module docs): entities decoded with `entities`, `<br>`
 * and block elements (`<p>`, `<div>`, `<li>`, `<tr>`, headings, …) become line breaks, list items
 * get "• ", table cells are separated by spaces, links keep their text and append their http(s)
 * URL when it is not already shown (the first 256 links), script/style/head/svg content is
 * dropped, whitespace runs collapse to one space (line breaks kept inside `<pre>`), and lines are
 * trimmed. Blank-line runs are left to the caller. Never builds a tree and never uses a DOM.
 */
export function htmlToPlainText(html: string, options: PlainTextOptions = {}): string {
  const maxChars = options.maxChars ?? 64 * 1024;
  const maxInput = options.maxInputChars ?? 1024 * 1024;
  const linkUrls = options.linkUrls ?? true;
  const input = html.length > maxInput ? html.slice(0, maxInput) : html;

  const out: string[] = [];
  let length = 0;
  let lastChar = '\n';
  let hidden = 0;
  let inHead = false;
  let pre = 0;
  let link: { href: string | null; from: number } | null = null;
  let parsedLinks = 0;

  const push = (text: string): void => {
    if (text === '') return;
    out.push(text);
    length += text.length;
    lastChar = text[text.length - 1]!;
  };
  const newline = (): void => {
    if (lastChar !== '\n') push('\n');
  };
  const emitText = (raw: string): void => {
    if (hidden > 0 || inHead || raw === '') return;
    // Markup declarations and processing instructions (`<!DOCTYPE …>`, `<![CDATA[`, `<?xml …?>`)
    // are not text; `[^<>]*` keeps every attempt within one declaration.
    let text = decodeHTML(raw.replace(/<[!?][^<>]*>/g, ''));
    if (pre > 0) {
      text = text.replace(/\r\n?/g, '\n');
    } else {
      text = text.replace(/[ \t\r\n\f]+/g, ' ');
      if (lastChar === '\n' || lastChar === ' ') text = text.replace(/^ /, '');
    }
    push(text);
  };
  const linkTextSince = (from: number): string => out.slice(from).join('').trim();

  let position = 0;
  for (const tag of scanTags(input, RAW_TEXT_ELEMENTS, { comments: true })) {
    emitText(input.slice(position, tag.start));
    position = tag.end;
    if (length > maxChars) break;
    const { name } = tag;
    if (name === '!--' || RAW_TEXT_ELEMENTS.has(name)) continue;

    if (name === 'head') {
      inHead = !tag.closing;
      continue;
    }
    if (name === 'body' && !tag.closing) inHead = false;
    if (HIDDEN_ELEMENTS.has(name)) {
      if (tag.closing) hidden = Math.max(0, hidden - 1);
      else if (!/\/\s*>$/.test(tag.source)) hidden++;
      continue;
    }
    if (hidden > 0 || inHead) continue;

    if (name === 'br') {
      push('\n');
      continue;
    }
    if (name === 'pre') pre = tag.closing ? Math.max(0, pre - 1) : pre + 1;
    if (name === 'a' && linkUrls) {
      if (!tag.closing) {
        let href: string | null = null;
        if (tag.source.length <= MAX_LINK_TAG && parsedLinks++ < MAX_PARSED_LINKS) {
          const value = parseTag(tag.source)?.getAttribute('href')?.trim();
          if (value && /^https?:\/\//i.test(value)) href = value;
        }
        link = { href, from: out.length };
      } else if (link) {
        const text = linkTextSince(link.from);
        // (Very long link texts are not searched; the URL is simply appended.)
        const { href } = link;
        if (href && href !== text && !(text.length <= MAX_LINK_TEXT_SEARCH && text.includes(href))) push(` (${href})`);
        link = null;
      }
      continue;
    }
    if ((name === 'td' || name === 'th') && tag.closing) {
      if (lastChar !== '\n' && lastChar !== ' ') push(' ');
      continue;
    }
    if (BLOCK_ELEMENTS.has(name)) {
      newline();
      if (name === 'li' && !tag.closing) push('• ');
    }
  }
  if (length <= maxChars) emitText(input.slice(position));
  return finishText(out.join(''));
}
