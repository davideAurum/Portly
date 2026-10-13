import { describe, expect, it } from 'vitest';
import { MAX_RAW_TEXT, RAW_TEXT_ELEMENTS, htmlToPlainText, parseTag, scanTags, stripTags, trimLineSpace } from './htmlScan.ts';

/** Runs `fn` and returns its result and duration (ms). */
function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

describe('scanTags', () => {
  it('yields tags in order, raw-text elements with their text, and comments only on request', () => {
    const html = '<p class="a">x<!-- <b>hidden</b> --><script>if (a < b) {}</script></p>';
    const tags = [...scanTags(html)].map((t) => [t.name, t.closing, t.text ?? null]);
    expect(tags).toEqual([
      ['p', false, null],
      ['script', false, 'if (a < b) {}'],
      ['p', true, null],
    ]);
    const withComments = [...scanTags(html, undefined, { comments: true })].map((t) => t.name);
    expect(withComments).toEqual(['p', '!--', 'script', 'p']);
    const unterminated = [...scanTags('<b>x</b><!-- open', undefined, { comments: true })];
    expect(unterminated.at(-1)).toMatchObject({ name: '!--', end: '<b>x</b><!-- open'.length });
    // Without the comments option an unterminated comment simply ends the scan.
    expect([...scanTags('<b>x</b><!-- open <i>')].map((t) => t.name)).toEqual(['b', 'b']);
  });

  it('reports offsets and sources, lower-cases names and treats a lone "<" as text', () => {
    const html = 'a < b <DT><A HREF="x">t</A>';
    const tags = [...scanTags(html)];
    expect(tags.map((t) => [t.name, t.closing, t.source, t.start, t.end])).toEqual([
      ['dt', false, '<DT>', 6, 10],
      ['a', false, '<A HREF="x">', 10, 22],
      ['a', true, '</A>', 23, 27],
    ]);
  });

  it('runs an unterminated raw-text element to the end and honours a custom raw-text set', () => {
    const [title] = [...scanTags('<title>never <b>closed')];
    expect(title).toMatchObject({ name: 'title', text: 'never <b>closed', end: '<title>never <b>closed'.length });
    // With `b` treated as raw text, its inner tags are not scanned.
    const custom = [...scanTags('<b><i>x</i></b><u></u>', new Set(['b']))].map((t) => [t.name, t.text ?? null]);
    expect(custom).toEqual([
      ['b', '<i>x</i>'],
      ['u', null],
      ['u', null],
    ]);
    expect(RAW_TEXT_ELEMENTS.has('script')).toBe(true);
    expect(MAX_RAW_TEXT).toBe(16 * 1024);
  });

  it('stays linear on hostile markup', () => {
    const started = performance.now();
    for (const doc of ['<a '.repeat(200_000), '<!--'.repeat(200_000), '<p x="'.repeat(100_000), '<'.repeat(500_000), `<title>${'<title>'.repeat(100_000)}`]) {
      let count = 0;
      for (const _tag of scanTags(doc, undefined, { comments: true })) count++;
      expect(count).toBeGreaterThanOrEqual(0);
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('parseTag / stripTags', () => {
  it('decodes attributes and entities of a single tag', () => {
    const el = parseTag('<A HREF="https://x.example/?a=1&amp;b=2" ADD_DATE=\'1\' data-x>');
    expect(el?.tagName.toLowerCase()).toBe('a');
    expect(el?.getAttribute('href')).toBe('https://x.example/?a=1&b=2');
    expect(el?.getAttribute('add_date')).toBe('1');
    expect(parseTag('<link rel="icon" href=/fav.ico>')?.getAttribute('href')).toBe('/fav.ico');
    expect(parseTag('just text')).toBeNull();
    expect(parseTag('')).toBeNull();
  });

  it('stripTags drops inline markup but keeps entities for the caller', () => {
    expect(stripTags('With <b>bold</b> text &amp; more')).toBe('With bold text &amp; more');
    expect(stripTags('a < b')).toBe('a < b');
    expect(stripTags('<i>x</i><br/>')).toBe('x');
  });
});

describe('htmlToPlainText', () => {
  it('turns block elements, <br> and list items into lines and decodes entities', () => {
    expect(htmlToPlainText('<p>Hello&nbsp;<b>world</b></p><div>2 &lt; 3 &amp;&amp; 4 &gt; 1</div>')).toBe('Hello\u00a0world\n2 < 3 && 4 > 1');
    expect(htmlToPlainText('line 1<br>line 2<br/>line 3')).toBe('line 1\nline 2\nline 3');
    expect(htmlToPlainText('<ul><li>One</li><li>Two <i>italic</i></li></ul>')).toBe('• One\n• Two italic');
    expect(htmlToPlainText('<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>')).toBe('A B\nC');
    expect(htmlToPlainText('  lots   of \n\n  spaces\t here ')).toBe('lots of spaces here');
    // <pre> keeps its line breaks (lines are trimmed like every other line).
    expect(htmlToPlainText('<pre>keep\n  these\n\nlines</pre>')).toBe('keep\nthese\n\nlines');
  });

  it('drops script/style/head/svg content, comments and markup declarations', () => {
    const doc = [
      '<!DOCTYPE html><?xml version="1.0"?>',
      '<html><head><meta charset="utf-8"><title>T</title><style>p { color: red }</style></head>',
      '<body><p>Visible</p><script>alert(1)</script><!-- note --><svg><text>drawing</text></svg><p>After</p></body></html>',
    ].join('');
    expect(htmlToPlainText(doc)).toBe('Visible\nAfter');
    expect(htmlToPlainText('<p>a</p><!-- unterminated <p>b</p>')).toBe('a');
  });

  it('keeps link text and appends http(s) URLs that are not already shown', () => {
    expect(htmlToPlainText('<a href="https://meet.example.com/x">Join</a>')).toBe('Join (https://meet.example.com/x)');
    expect(htmlToPlainText('<a href="https://example.com/">https://example.com/</a>')).toBe('https://example.com/');
    expect(htmlToPlainText('<a href="javascript:alert(1)">x</a>')).toBe('x');
    expect(htmlToPlainText('<a href="https://a.example/?x=1&amp;y=2">q</a>')).toBe('q (https://a.example/?x=1&y=2)');
    expect(htmlToPlainText('<a href="https://example.com/">x</a>', { linkUrls: false })).toBe('x');
    // Only the first 256 links are parsed for their URL (bounded work on link-stuffed markup).
    const many = htmlToPlainText('<a href="https://l.example/">x</a> '.repeat(300));
    expect(many.split('(https://l.example/)')).toHaveLength(257);
  });

  it('treats a lone "<" as text', () => {
    expect(htmlToPlainText('a < b and c<d')).toBe('a < b and c<d');
  });

  it('stops after about maxChars of output and reads at most maxInputChars', () => {
    const long = '<p>' + 'word '.repeat(10_000) + '</p><p>tail</p>';
    const out = htmlToPlainText(long, { maxChars: 1_000 });
    expect(out.length).toBeGreaterThanOrEqual(1_000);
    expect(out).not.toContain('tail');
    expect(htmlToPlainText('abcdef<p>ghi</p>', { maxInputChars: 3 })).toBe('abc');
  });

  it('runs in linear time on hostile markup (10k unclosed tags well under 200 ms)', () => {
    // node-html-parser needed about two minutes for 10 000 unclosed <div>s (50 KB).
    const divs = timed(() => htmlToPlainText(`start${'<div>'.repeat(10_000)}end`));
    expect(divs.value).toBe('start\nend');
    expect(divs.ms).toBeLessThan(200);

    const hostile = [
      '<div>'.repeat(200_000),
      '<a '.repeat(200_000),
      '<!--'.repeat(200_000),
      '<p x="'.repeat(100_000),
      '<'.repeat(500_000),
      `<a href="https://x.example/">${'<b>'.repeat(100_000)}`,
      `<title>${'<title>'.repeat(100_000)}`,
      `${' '.repeat(300_000)}x`,
      '<br>'.repeat(200_000) + 'x',
      `<pre>${' \n'.repeat(200_000)}x</pre>`,
      '&amp'.repeat(200_000),
      '<a href="https://x.example/">'.repeat(30_000),
    ];
    for (const doc of hostile) {
      const { ms } = timed(() => htmlToPlainText(doc));
      expect(ms, doc.slice(0, 20)).toBeLessThan(1_000);
    }
  });
});

describe('trimLineSpace', () => {
  it('trims spaces, tabs and NBSPs at both ends only', () => {
    expect(trimLineSpace(' \t\u00a0a b\u00a0 ')).toBe('a b');
    expect(trimLineSpace('   ')).toBe('');
    expect(trimLineSpace('x')).toBe('x');
  });
});
