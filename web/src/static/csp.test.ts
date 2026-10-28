/**
 * The Content-Security-Policy of the browser-only build (`staticCsp()` in web/vite.config.ts):
 * `connect-src` lists exactly the origins the in-browser backend calls.
 */
import { describe, expect, it } from 'vitest';
import { staticCsp } from '../../vite.config.ts';

function directive(csp: string, name: string): string[] {
  const found = csp.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name);
  return found?.slice(1) ?? [];
}

describe('static build CSP', () => {
  it("lets the page reach GitHub's API for launch pad sync, and no other GitHub host", () => {
    const connect = directive(staticCsp(''), 'connect-src');
    // Files over 1 MB come from the blob API, so no raw or download host is needed.
    expect(connect.filter((source) => source.includes('github'))).toEqual(['https://api.github.com']);
  });

  it('keeps the providers it already allowed and adds the local server only when set', () => {
    const connect = directive(staticCsp(''), 'connect-src');
    expect(connect).toEqual(expect.arrayContaining(["'self'", 'https://api.todoist.com', 'https://graph.microsoft.com']));
    expect(connect).not.toContain('http://127.0.0.1:5757');
    expect(directive(staticCsp('http://127.0.0.1:5757'), 'connect-src')).toContain('http://127.0.0.1:5757');
    expect(directive(staticCsp(''), 'img-src').filter((source) => source.includes('github'))).toEqual([]);
  });
});
